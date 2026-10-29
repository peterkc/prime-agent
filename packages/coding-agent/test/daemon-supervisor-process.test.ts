import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSpaceAuth, stripSpaceAuth } from "@cotal-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getCronJobsPath } from "../src/config.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";
import {
	acquireSessionLease,
	canonicalSessionPath,
	getPsProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";
import { getSessionArtifactPathForFile, readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentRoster } from "../src/modes/daemon/agent-roster.js";
import { claimEnrollment } from "../src/modes/daemon/cotal/enrollment.js";
import { DaemonClient, getDaemonSocketCloseReason } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { deleteDaemonSavedSession } from "../src/modes/daemon/saved-session-catalog.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const blockingProcessPath = resolve(__dirname, "fixtures/blocking-process.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const daemonSockets = new Set<string>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
const PROCESS_STRESS_WORKERS = Number.parseInt(process.env.PRIME_AGENT_STRESS_WORKERS ?? "10", 10);

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown" }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	// Await owned exits before rmSync: a dying worker's log writer otherwise races it into ENOTEMPTY.
	const childExits = await Promise.allSettled([...children].map((child) => waitForExit(child)));
	children.clear();
	for (const root of tempDirs) {
		const path = join(root, "agent", "worker-pids.jsonl");
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean))
			workerPids.add((JSON.parse(line) as { pid: number }).pid);
	}
	for (const pid of workerPids) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {
			// Already gone.
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}
	const workerExits = await Promise.allSettled([...workerPids].map((pid) => waitForProcessGone(pid)));
	workerPids.clear();
	const failures = [...childExits, ...workerExits].filter((result) => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map((result) => result.reason),
			"Fixture cleanup failed",
		);
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-daemon-supervisor-test-"));
	tempDirs.push(directory);
	return directory;
}

function spawnSupervisor(
	agentDir: string,
	socketPath: string,
	cwd: string,
	extraArgs: readonly string[] = [],
	extraEnv: NodeJS.ProcessEnv = {},
	entrypoint = cliPath,
): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(
		process.execPath,
		entrypoint === cliPath
			? [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline", ...extraArgs]
			: ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), entrypoint, socketPath, cwd],
		{
			cwd,
			env: {
				...process.env,
				...extraEnv,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

function readDaemonLogs(agentDir: string): string {
	const logsDir = join(agentDir, "logs");
	try {
		return readdirSync(logsDir)
			.map((name) => `${name}:\n${readFileSync(join(logsDir, name), "utf8")}`)
			.join("\n");
	} catch {
		return "no daemon logs";
	}
}

function readWorkerDescriptor(agentDir: string): DaemonWorkerDescriptor {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const descriptorDirectory = join(workersRoot, directory);
		for (const name of readdirSync(descriptorDirectory)) {
			if (name.endsWith(".json")) {
				return JSON.parse(readFileSync(join(descriptorDirectory, name), "utf8")) as DaemonWorkerDescriptor;
			}
		}
	}
	throw new Error("Worker descriptor was not persisted");
}

function countWorkerDescriptors(agentDir: string): number {
	const workersRoot = join(agentDir, "daemon-workers");
	try {
		return readdirSync(workersRoot).reduce((count, directory) => {
			return count + readdirSync(join(workersRoot, directory)).filter((name) => name.endsWith(".json")).length;
		}, 0);
	} catch {
		return 0;
	}
}

async function waitForWorkerStopTombstone(agentDir: string): Promise<DaemonWorkerDescriptor> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const descriptor = readWorkerDescriptor(agentDir);
			if (descriptor.stopRequestedAt) {
				return descriptor;
			}
		} catch {
			// The descriptor directory may still be appearing.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Worker stop tombstone was not persisted");
}

function readSupervisorConfig(agentDir: string): { defaultSessionConfig?: { sessionDir?: string; noTools?: boolean } } {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const path = join(workersRoot, directory, "supervisor-config");
		try {
			return JSON.parse(readFileSync(path, "utf8")) as {
				defaultSessionConfig?: { sessionDir?: string; noTools?: boolean };
			};
		} catch {
			// Continue looking for the descriptor directory for this daemon socket.
		}
	}
	throw new Error("Supervisor config was not persisted");
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			const diagnostics = childDiagnostics.get(child);
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})\n` +
					`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	const diagnostics = child ? childDiagnostics.get(child) : undefined;
	throw new Error(
		`Timed out waiting for supervisor: ${String(lastError)}\n` +
			`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
	);
}

async function waitForSocketGone(socketPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(100);
		} catch {
			client.close();
			return;
		}
		client.close();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error("Daemon supervisor socket remained available after shutdown");
}

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function requireSessionList(responseData: unknown): SessionSummary[] {
	if (!responseData || typeof responseData !== "object" || !("sessions" in responseData)) {
		throw new Error("Missing daemon session list");
	}
	const sessions = (responseData as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Invalid daemon session list");
	}
	return sessions as SessionSummary[];
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

async function waitForCondition(predicate: () => boolean, failureMessage: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(failureMessage);
}

function quoteShellArgument(argument: string): string {
	return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

async function startBlockingBash(client: DaemonClient, activeSessionId: string, readyPath: string): Promise<void> {
	const command = [process.execPath, blockingProcessPath, readyPath].map(quoteShellArgument).join(" ");
	const response = await client.request({ type: "execute_bash", activeSessionId, command });
	if (!response.success) {
		throw new Error(response.error);
	}
	await waitForCondition(() => existsSync(readyPath), `Blocking bash process did not become ready: ${readyPath}`);
}

function waitForSupervisorReady(child: ChildProcess, socketPath: string): Promise<void> {
	return new Promise((resolveReady, reject) => {
		function finish(error?: Error): void {
			child.stderr?.off("data", ready);
			child.off("exit", exited);
			if (error) reject(error);
			else resolveReady();
		}
		function ready(): void {
			if (childDiagnostics.get(child)?.stderr.includes(`listening on ${socketPath}`)) finish();
		}
		function exited(): void {
			finish(new Error(`Supervisor exited before readiness: ${childDiagnostics.get(child)?.stderr}`));
		}
		child.stderr?.on("data", ready);
		child.once("exit", exited);
		ready();
	});
}

describe("daemon supervisor resident workers", () => {
	it.each([true, false, "client joins pending"] as const)(
		"TM-14 TM-15 TM-19 real supervisor relays a native form only when all UI clients are capable: %s",
		async (scenario) => {
			const allCapable = scenario === true;
			const root = tempDir();
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(projectDir, { recursive: true });
			const socketPath = join(tmpdir(), `prime-form-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
			const extensionPath = join(root, "form-extension.ts");
			const questionnaireSource = resolve(__dirname, "../src/core/tools/questionnaire.ts");
			writeFileSync(
				extensionPath,
				`import { createQuestionnaireToolDefinition } from ${JSON.stringify(questionnaireSource)};
export default function(pi) {
 pi.registerCommand("native-form", { description: "Test form", handler: async (_args, ctx) => {
  const tool = createQuestionnaireToolDefinition(ctx.cwd, { entries: () => ctx.sessionManager.getBranch(), appendEntry: (data) => pi.appendEntry("questionnaire_retry_state", data), needsInput: () => {} });
  const result = await tool.execute("relay", { questions: [
   { id: "scope", prompt: "Choose scope", options: [{ value: "small", label: "Small" }], allowOther: false },
   { id: "priority", prompt: "Choose priority", options: [{ value: "now", label: "Now" }] }
  ] }, undefined, undefined, ctx);
  ctx.ui.notify(JSON.stringify(result.details));
 } });
}`,
			);
			const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
			const client = new DaemonClient(socketPath);
			const watcher = new DaemonClient(socketPath);
			const requests: Extract<DaemonOutbound, { type: "extension_ui_request" }>[] = [];
			const responses: Promise<unknown>[] = [];
			async function attachWatcher(activeSessionId: string): Promise<void> {
				await watcher.connect();
				await watcher.waitForHello();
				const attached = await watcher.request({
					type: "attach",
					activeSessionId,
					supportsExtensionUi: true,
					capabilities: ["extension_ui"],
				});
				if (!attached.success) throw new Error(attached.error);
			}
			const unsubscribe = client.onMessage((message) => {
				if (message.type !== "extension_ui_request") return;
				requests.push(message);
				if (message.method === "questionnaire" && scenario === "client joins pending")
					responses.push(attachWatcher(message.activeSessionId));
				else if (message.method === "questionnaire" || message.method === "select")
					responses.push(
						client.request({
							type: "extension_ui_response",
							activeSessionId: message.activeSessionId,
							requestId: message.id,
							response:
								message.method === "questionnaire"
									? {
											status: "submitted",
											answers: {
												scope: { value: "small", wasCustom: false },
												priority: { value: "later", wasCustom: true },
											},
										}
									: { value: (message.payload.options as string[])[0] },
						}),
					);
			});
			try {
				await waitForSupervisorReady(supervisor, socketPath);
				await client.connect();
				await client.waitForHello();
				const created = await client.request({
					type: "create",
					config: {
						cwd: projectDir,
						agentDir,
						sessionDir: join(root, "sessions"),
						extensions: [extensionPath],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
					},
				});
				if (!created.success) throw new Error(created.error);
				const summary = requireSummary(created.data);
				const activeSessionId = summary.activeSessionId ?? summary.id;
				const attached = await client.request({
					type: "attach",
					activeSessionId,
					supportsExtensionUi: true,
					capabilities: ["extension_ui", "questionnaire_ui"],
				});
				if (!attached.success) throw new Error(attached.error);
				if (scenario === false) await attachWatcher(activeSessionId);
				const completed = await client.request({
					type: "prompt_and_wait",
					activeSessionId,
					message: "/native-form",
				});
				if (!completed.success) throw new Error(completed.error);
				await Promise.all(responses);
				expect(requests.filter((request) => request.method === "questionnaire")).toHaveLength(
					scenario === false ? 0 : 1,
				);
				expect(requests.filter((request) => request.method === "select")).toHaveLength(allCapable ? 0 : 3);
				const notification = requests.find((request) => request.method === "notify");
				if (!notification) throw new Error("Form result was not reported");
				expect(JSON.parse(String(notification.payload.message))).toMatchObject({
					cancelled: false,
					answers: [
						{ id: "scope", value: "small", wasCustom: false },
						{ id: "priority", value: allCapable ? "later" : "now", wasCustom: allCapable },
					],
				});
			} finally {
				unsubscribe();
				watcher.close();
				await client.request({ type: "shutdown", force: true });
				client.close();
				await waitForExit(supervisor);
			}
		},
	);

	it("accepts the canonical socket path when launched with duplicate slashes", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, `${root}//daemon.sock`, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const response = await client.request({ type: "list" });

		expect(response.success).toBe(true);
		expect(requireSessionList(response.success ? response.data : undefined)).toHaveLength(0);
		await client.request({ type: "shutdown", force: true });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("creates top-level sessions at depth zero when the supervisor inherits a child depth", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-depth-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, [], { RLM_DEPTH: "1" });
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) throw new Error(created.error);
		const summary = requireSummary(created.data);
		if (!summary.workerPid || !summary.sessionFile) throw new Error("Worker did not expose its session identity");
		workerPids.add(summary.workerPid);

		expect(summary).toMatchObject({ runtimeKind: "top-level", rlmDepth: 0 });
		expect(await readSessionInfo(summary.sessionFile)).toMatchObject({ rlmDepth: 0, parentSessionPath: undefined });

		await client.request({ type: "shutdown" });
		client.close();
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("restarts an adopted pre-roster worker from the current binary", async () => {
		const directory = tempDir();
		const agentDir = join(directory, "agent");
		const projectDir = join(directory, "project");
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(projectDir, { recursive: true });
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: "pre-roster fixture", timestamp: 1 });
		manager.flushNow();
		const sessionPath = manager.getSessionFile();
		const sessionId = manager.getSessionId();
		if (!sessionPath) throw new Error("Fixture session did not persist");

		// A long-lived stand-in process plays the pre-roster worker's pid.
		const legacyProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
		children.add(legacyProcess);
		if (!legacyProcess.pid) throw new Error("Missing legacy process pid");

		// A fake worker socket that authenticates without advertising the roster capability.
		const workerSocketPath = join(directory, "legacy-worker.sock");
		const fakeWorker = createServer((socket) => {
			const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
			socket.write(
				encodePrivateFrame<DaemonWorkerFrameHeader>(
					{ kind: "outbound", outboundType: "daemon_hello" },
					Buffer.from(`${JSON.stringify({ type: "daemon_hello" })}\n`),
				),
			);
			socket.on("data", (chunk: Buffer) => {
				for (const frame of decoder.push(chunk)) {
					if (frame.header.kind !== "command") continue;
					const command = JSON.parse(frame.payload.toString("utf8")) as { id: string; type: string };
					const data =
						command.type === "list"
							? {
									sessions: [
										{
											id: "legacy-root-active",
											activeSessionId: "legacy-root-active",
											sessionId,
											sessionFile: sessionPath,
											lifecycle: "live",
											activity: "idle",
											isSessionActive: false,
											cwd: projectDir,
											isStreaming: false,
											isCompacting: false,
											attachedClients: 0,
											messageCount: 1,
											sessionActions: { queuedCount: 0, steering: [], followUps: [] },
										},
									],
								}
							: {};
					socket.write(
						encodePrivateFrame<DaemonWorkerFrameHeader>(
							{ kind: "outbound", outboundType: "response", requestId: frame.header.requestId },
							Buffer.from(
								`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
							),
						),
					);
				}
			});
		});
		const socketPath = join(directory, "daemon.sock");
		await new Promise<void>((resolveListen) => fakeWorker.listen(workerSocketPath, resolveListen));
		const descriptorDir = join(
			agentDir,
			"daemon-workers",
			createHash("sha256").update(socketPath).digest("hex").slice(0, 12),
		);
		mkdirSync(descriptorDir, { recursive: true });
		const now = new Date().toISOString();
		writeFileSync(
			join(descriptorDir, "legacy-worker.json"),
			`${JSON.stringify({
				version: 2,
				workerId: "legacy-worker",
				pid: legacyProcess.pid,
				socketPath: workerSocketPath,
				recoveryJournalPath: join(descriptorDir, "legacy-worker.recovery.jsonl"),
				supervisorSocketPath: socketPath,
				authenticationToken: "legacy-token",
				rootActiveSessionId: "legacy-root-active",
				rootSessionId: sessionId,
				sessionFile: sessionPath,
				sessionDir,
				createdAt: now,
				updatedAt: now,
				lifecycle: "ready",
				createCommand: { type: "create", sessionPath },
				consecutiveFailures: 0,
			})}\n`,
		);

		// Once the supervisor kills the old pid, its socket goes quiet exactly like a dead worker's.
		legacyProcess.once("exit", () => {
			fakeWorker.close();
			rmSync(workerSocketPath, { force: true });
		});
		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		let restarted: SessionSummary | undefined;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const listed = await client.request({ type: "list" });
			restarted = requireSessionList(listed.success ? listed.data : undefined).find(
				(candidate) => candidate.sessionId === sessionId,
			);
			if (restarted?.workerState === "ready" && restarted.workerPid !== undefined) break;
			restarted = undefined;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
		if (!restarted?.workerPid) {
			throw new Error(`Pre-roster worker was not restarted:\n${readDaemonLogs(agentDir)}`);
		}
		workerPids.add(restarted.workerPid);
		// A fresh current-binary worker owns the reloaded idle session; the fake pre-roster pid is not adopted.
		expect(restarted.workerPid).not.toBe(legacyProcess.pid);
		expect(restarted.isSessionActive).toBe(false);
		// The seeded user message plus the harness digest injected on resume.
		expect(restarted.messageCount).toBe(2);
		await waitForProcessGone(legacyProcess.pid);
		fakeWorker.close();
		client.close();
	}, 90_000);

	it("lists, creates, and attaches passive children through their owning worker", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-passive-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const parentManager = SessionManager.create(projectDir, sessionDir);
		parentManager.appendMessage({ role: "user", content: "parent fixture", timestamp: 1 });
		parentManager.flushNow();
		const parentSessionFile = parentManager.getSessionFile();
		const parentArtifactDir = parentManager.getSessionArtifactDir();
		if (!parentSessionFile || !parentArtifactDir) throw new Error("Missing parent fixture paths");

		const makeChild = (childId: string, sessionName: string, timestamp: number) => {
			const childSessionDir = join(parentArtifactDir, childId);
			const manager = SessionManager.create(projectDir, childSessionDir);
			manager.newSession({ parentSession: parentSessionFile });
			manager.appendSessionInfo(sessionName);
			manager.appendMessage({ role: "user", content: `completed ${childId} fixture`, timestamp });
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing child fixture path");
			return { childId, sessionName, childSessionDir, manager, sessionFile };
		};
		const child = makeChild("passive-child", "passive-child-worker", 2);
		const createChild = makeChild("passive-create-child", "passive-create-worker", 3);
		writeFileSync(
			join(parentArtifactDir, "rlm-subagents.jsonl"),
			`${[child, createChild]
				.map((fixture) =>
					JSON.stringify({
						type: "rlm_subagent",
						childId: fixture.childId,
						sessionName: fixture.sessionName,
						sessionDir: fixture.childSessionDir,
						sessionFile: fixture.sessionFile,
						parentSessionId: parentManager.getSessionId(),
						parentSessionFile,
						rlmDepth: 1,
						rlmMaxDepth: 4,
						rlmParentNodeId: fixture.childId,
						status: "completed",
						createdAt: 1,
						updatedAt: "2026-01-01T00:00:00.000Z",
					}),
				)
				.join("\n")}
`,
		);

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: parentSessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(created.success).toBe(true);
		const parentSummary = requireSummary(created.success ? created.data : undefined);
		if (!parentSummary.workerPid) throw new Error("Parent worker did not expose its pid");
		workerPids.add(parentSummary.workerPid);

		const beforeAttach = await client.request({ type: "list" });
		expect(beforeAttach.success).toBe(true);
		const passiveSummary = requireSessionList(beforeAttach.success ? beforeAttach.data : undefined).find(
			(summary) => summary.sessionFile === child.sessionFile,
		);
		expect(passiveSummary).toMatchObject({
			sessionId: child.manager.getSessionId(),
			sessionName: "passive-child-worker",
			runtimeKind: "subagent",
			rlmChildId: child.childId,
			workerPid: parentSummary.workerPid,
		});
		expect(passiveSummary?.activeSessionId).toBeUndefined();

		const createdChild = await client.request({
			type: "create",
			sessionPath: createChild.sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!createdChild.success) throw new Error(createdChild.error);
		expect(requireSummary(createdChild.data)).toMatchObject({
			workerPid: parentSummary.workerPid,
			rlmChildId: createChild.childId,
		});
		expect(countWorkerDescriptors(agentDir)).toBe(1);

		const attached = await client.request({
			type: "attach",
			activeSessionId: child.manager.getSessionId(),
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
		});
		if (!attached.success) throw new Error(attached.error);

		const afterAttach = await client.request({ type: "list" });
		const hydratedSummary = requireSessionList(afterAttach.success ? afterAttach.data : undefined).find(
			(summary) => summary.sessionFile === child.sessionFile,
		);
		expect(hydratedSummary).toMatchObject({
			activeSessionId: expect.any(String),
			workerPid: parentSummary.workerPid,
			rlmChildId: child.childId,
		});
		expect(countWorkerDescriptors(agentDir)).toBe(1);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("keeps client-owned workers hidden and removes them without archiving", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-owned-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "owned worker fixture", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const launchEnvSentinel = `owned-env-${randomUUID()}`;
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			launchEnv: { PRIME_AGENT_OWNED_TEST: launchEnvSentinel },
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(created.success).toBe(true);
		const summary = requireSummary(created.success ? created.data : undefined);
		if (!summary.workerPid || !summary.activeSessionId) {
			throw new Error("Client-owned worker did not expose its process identity");
		}
		workerPids.add(summary.workerPid);

		const publicList = await client.request({ type: "list" });
		expect(publicList.success).toBe(true);
		expect(requireSessionList(publicList.success ? publicList.data : undefined)).toEqual([]);
		const internalList = await client.request({ type: "list", includeClientOwned: true });
		expect(internalList.success).toBe(true);
		expect(requireSessionList(internalList.success ? internalList.data : undefined)).toHaveLength(1);
		const otherClient = await connectEventually(socketPath);
		const deniedList = await otherClient.request({ type: "list", includeClientOwned: true });
		expect(deniedList).toMatchObject({
			success: true,
			data: { sessions: [], busyClientOwnedSessionCount: 0 },
		});
		const privateSelector = summary.sessionId.slice(-8);
		const deniedAttach = await otherClient.request({ type: "attach", activeSessionId: privateSelector });
		expect(deniedAttach).toMatchObject({
			success: false,
			error: `Unknown active session: ${privateSelector}`,
		});
		const deniedCron = await otherClient.request({
			type: "cron_add",
			activeSessionId: summary.activeSessionId,
			schedule: "every 1h",
			prompt: "unauthorized",
		});
		expect(deniedCron).toMatchObject({
			success: false,
			error: `Unknown active session: ${summary.activeSessionId}`,
		});
		otherClient.close();
		const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
			ownedSession: true,
			supportsExtensionUi: false,
		});
		await expect(connection.listHeartbeats()).resolves.toEqual([]);
		await expect(connection.listCronJobs()).resolves.toEqual([]);
		const cronResponse = await client.request({
			type: "cron_add",
			activeSessionId: summary.activeSessionId,
			schedule: "every 1h",
			prompt: "check status",
		});
		if (!cronResponse.success || !cronResponse.data || typeof cronResponse.data !== "object") {
			throw new Error(cronResponse.success ? "Cron response was missing its job" : cronResponse.error);
		}
		const cronJob = (cronResponse.data as { job: { id: string } }).job;
		await expect(connection.listCronJobs()).resolves.toEqual([expect.objectContaining({ id: cronJob.id })]);
		await expect(connection.cancelCronJob(cronJob.id)).resolves.toMatchObject({ id: cronJob.id });

		const descriptor = readWorkerDescriptor(agentDir);
		expect(descriptor.ownerClientId).toEqual(expect.any(String));
		expect(JSON.stringify(descriptor)).not.toContain(launchEnvSentinel);
		expect(descriptor.createCommand).not.toHaveProperty("launchEnv");
		expect(descriptor.createCommand).not.toHaveProperty("lifecycle");

		await connection.dispose();
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Client-owned worker descriptor was not removed",
		);
		expect((await readSessionInfo(sessionFile))?.state?.status).not.toBe("archived");

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("releases an adopted client-owned worker when disposal races supervisor replacement", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(tmpdir(), `prime-supervisor-owned-adopt-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			lifecycle: "client_owned",
			noSession: true,
			launchEnv: { TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
			config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid || !summary.activeSessionId) {
			throw new Error("Client-owned worker did not expose its process identity");
		}
		workerPids.add(summary.workerPid);
		const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
			closeClientOnDispose: true,
			ownedSession: true,
			recoverDaemon: async () => {},
			supportsExtensionUi: false,
		});

		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		await connection.dispose();

		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Adopted client-owned worker descriptor was not removed",
		);
		const replacementClient = await connectEventually(socketPath);
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("delivers native sibling messages but refuses a copy held by another live owner", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-root-message-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(
			agentDir,
			socketPath,
			projectDir,
			[],
			{},
			resolve(__dirname, "fixtures/mesh-supervisor.ts"),
		);
		const client = await connectEventually(socketPath, supervisor);
		const createRoot = async (name: string) => {
			const response = await client.request({
				type: "create",
				name,
				config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
			});
			expect(response.success).toBe(true);
			return requireSummary(response.success ? response.data : undefined);
		};
		const source = await createRoot("source-root");
		const target = await createRoot("target-root");
		expect(source.workerPid).not.toBe(target.workerPid);
		await startBlockingBash(client, target.activeSessionId ?? target.id, join(root, "target-root-blocker.ready"));

		const response = await client.request({
			type: "send_message",
			fromActiveSessionId: source.activeSessionId ?? source.id,
			targetActiveSessionId: target.activeSessionId ?? target.id,
			message: "hello sibling root",
			agentOrigin: true,
		});
		expect(response.success, JSON.stringify(response)).toBe(true);
		expect(response).toMatchObject({
			success: true,
			data: {
				source: "agent_message",
				target: { activeSessionId: target.activeSessionId ?? target.id },
				message: "hello sibling root",
				deliveryStatus: "queued",
			},
		});
		const manager = SessionManager.create(projectDir, join(root, "G"));
		manager.appendSessionInfo("copied-target");
		manager.appendMessage({ role: "user", content: "saved", timestamp: 1 });
		manager.flushNow();
		const livePath = manager.getSessionFile()!;
		const savedPath = join(sessionDir, basename(livePath));
		copyFileSync(livePath, savedPath);
		const before = readFileSync(livePath, "utf8");
		const lease = acquireSessionLease(livePath, agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
		const workerCount = countWorkerDescriptors(agentDir);
		const send = (targetActiveSessionId: string) =>
			client.request({
				type: "send_message",
				fromActiveSessionId: source.activeSessionId!,
				targetActiveSessionId,
				message: "native hello",
				agentOrigin: true,
			});
		try {
			const refusal = { success: false, error: expect.stringContaining(canonicalSessionPath(livePath)) };
			expect(await send("copied-target")).toMatchObject(refusal);
			expect(await send(manager.getSessionId())).toMatchObject(refusal);
			expect(countWorkerDescriptors(agentDir)).toBe(workerCount);
			expect(readFileSync(savedPath, "utf8")).toBe(before);
			expect(readFileSync(livePath, "utf8")).toBe(before);
			lease!.release();
			const delivered = await send(manager.getSessionId());
			expect(delivered.success).toBe(true);
			expect(delivered).toHaveProperty("data.message", "native hello");
		} finally {
			lease!.release();
		}
		const shutdown = await client.request({ type: "shutdown" }, 10_000);
		expect(shutdown.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("cancels an archived session heartbeat without spawning a worker", { tags: ["process-stress"] }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-archived-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "do not revive me", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		sessionManager.appendSessionState({ status: "archived" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}
		const cronStore = new AgentCronJobStore(getCronJobsPath(agentDir));
		const heartbeat = await cronStore.createHeartbeat({
			activeSessionId: "old-active-session",
			sessionId: sessionManager.getSessionId(),
			sessionFile,
			cwd: projectDir,
			scheduleText: "every 10s",
			prompt: "continue old work",
			now: new Date(Date.now() - 20_000),
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const migratedStore = AgentCronJobStore.forSessionArtifacts();
		migratedStore.registerSessionArtifact(sessionManager.getSessionId(), sessionManager.getSessionArtifactDir()!);
		await waitForCondition(
			() => migratedStore.list().find((job) => job.id === heartbeat.id)?.status === "cancelled",
			"Archived heartbeat was not cancelled",
		);

		expect(countWorkerDescriptors(agentDir)).toBe(0);
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("cancels an orphan heartbeat instead of recreating a descriptorless active session", {
		tags: ["process-stress"],
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-orphan-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "old scheduled work", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}
		const cronStore = new AgentCronJobStore(getCronJobsPath(agentDir));
		const heartbeat = await cronStore.createHeartbeat({
			activeSessionId: "deleted-worker",
			sessionId: sessionManager.getSessionId(),
			sessionFile,
			cwd: projectDir,
			scheduleText: "every 10s",
			prompt: "continue old work",
			now: new Date(Date.now() - 20_000),
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const migratedStore = AgentCronJobStore.forSessionArtifacts();
		migratedStore.registerSessionArtifact(sessionManager.getSessionId(), sessionManager.getSessionArtifactDir()!);
		await waitForCondition(
			() => migratedStore.list().find((job) => job.id === heartbeat.id)?.status === "cancelled",
			"Orphan heartbeat was not cancelled",
		);

		expect(countWorkerDescriptors(agentDir)).toBe(0);
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("restarts an empty supervisor without requiring a resident worker", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(root, "custom-sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-restart-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, ["--session-dir", sessionDir, "--no-tools"]);
		const client = await connectEventually(socketPath, supervisor);
		const restarted = await client.request({ type: "restart" });
		expect(restarted.success).toBe(true);
		client.close();
		await waitForExit(supervisor);
		children.delete(supervisor);

		const replacementClient = await connectEventually(socketPath);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		const persistedConfig = readSupervisorConfig(agentDir);
		expect(persistedConfig).toMatchObject({ defaultSessionConfig: { sessionDir } });
		expect(persistedConfig.defaultSessionConfig).not.toHaveProperty("noTools");
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	});

	it("exits and frees its socket when a client never ends its side", async () => {
		const agentDir = join(tempDir(), "agent");
		const socketPath = join(tmpdir(), `prime-supervisor-half-open-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		const supervisor = spawnSupervisor(agentDir, socketPath, tmpdir());
		const client = await connectEventually(socketPath, supervisor);
		const halfOpen = createConnection({ path: socketPath, allowHalfOpen: true });
		try {
			await once(halfOpen, "data");
			expect((await client.request({ type: "shutdown" })).success).toBe(true);
			await waitForExit(supervisor);
			(await connectEventually(socketPath, spawnSupervisor(agentDir, socketPath, tmpdir()))).close();
		} finally {
			halfOpen.destroy();
			client.close();
		}
	});

	it("survives a worker process spawn error", { tags: ["process-stress"] }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const missingCwd = join(root, "missing-project");
		const socketPath = join(tmpdir(), `prime-supervisor-spawn-error-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const failed = await client.request({
			type: "create",
			config: { cwd: missingCwd, agentDir, noTools: true, noExtensions: true },
		});

		expect(failed).toMatchObject({ success: false });
		expect(supervisor.exitCode).toBeNull();
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toEqual([]);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("archives resident roots and cancels their heartbeats on explicit daemon shutdown", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-shutdown-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "stop with daemon", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const heartbeatResponse = await client.request({
			type: "heartbeat_set",
			activeSessionId: summary.activeSessionId ?? summary.id,
			schedule: "every 1h",
			prompt: "continue old work",
		});
		if (!heartbeatResponse.success || !heartbeatResponse.data || typeof heartbeatResponse.data !== "object") {
			throw new Error(heartbeatResponse.success ? "Heartbeat response was missing data" : heartbeatResponse.error);
		}
		const heartbeat = (heartbeatResponse.data as { heartbeat: { id: string } }).heartbeat;
		const cronStore = AgentCronJobStore.forSessionArtifacts();
		cronStore.registerSessionArtifact(summary.sessionId, sessionManager.getSessionArtifactDir()!);
		const observer = await connectEventually(socketPath, supervisor);
		const observerClosed = new Promise<Error>((resolveClose) => observer.onClose(resolveClose));

		expect((await client.request({ type: "shutdown" })).success).toBe(true);
		client.close();
		expect(getDaemonSocketCloseReason(await observerClosed)).toBe("shutdown");
		observer.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		expect(countWorkerDescriptors(agentDir)).toBe(0);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });
		expect(cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({ status: "cancelled" });

		const replacement = spawnSupervisor(agentDir, socketPath, projectDir);
		const replacementClient = await connectEventually(socketPath, replacement);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	}, 30_000);

	it("finalizes a timed-out worker stop by force-stopping the process and removing its registration", {
		tags: ["process-stress"],
		timeout: 45_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-stop-finalize-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "finalize me", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;

		// A suspended worker cannot exit within the stop deadline, so the stop
		// times out and used to leave a tombstoned registration behind forever.
		process.kill(summary.workerPid, "SIGSTOP");
		const stopResult = await client.request({ type: "complete_owned_session", activeSessionId }, 30_000);
		expect(stopResult).toMatchObject({
			success: false,
			error: expect.stringContaining("did not stop"),
		});
		const tombstone = readWorkerDescriptor(agentDir);
		expect(tombstone.stopRequestedAt).toEqual(expect.any(String));

		// The supervisor finishes the interrupted stop on its own: it escalates
		// to SIGKILL, waits for the process to die, and removes the registration.
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Timed-out worker stop was not finalized",
			20_000,
		);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("resumes a saved session immediately after a worker stop fails and the process dies", {
		tags: ["process-stress"],
		timeout: 45_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-resume-heal-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "resume me", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;

		// A suspended worker forces the stop past its deadline, leaving a
		// tombstoned registration for a process that dies moments later.
		process.kill(summary.workerPid, "SIGSTOP");
		const stopResult = await client.request({ type: "complete_owned_session", activeSessionId }, 30_000);
		expect(stopResult).toMatchObject({
			success: false,
			error: expect.stringContaining("did not stop"),
		});
		process.kill(summary.workerPid, "SIGKILL");
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);

		// Resuming the saved transcript must not be blocked by the stale
		// registration. Whichever cleanup wins the race — the background stop
		// finalizer or the resume-time reclaim (each covered deterministically
		// by unit tests) — the user-visible guarantee is the same: the resume
		// below must succeed with a fresh worker.
		const resumed = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(resumed.success).toBe(true);
		const resumedSummary = requireSummary(resumed.success ? resumed.data : undefined);
		expect(resumedSummary.sessionId).toBe(summary.sessionId);
		expect(resumedSummary.workerPid).not.toBe(summary.workerPid);
		expect(resumedSummary.workerState).toBe("ready");
		if (resumedSummary.workerPid) {
			workerPids.add(resumedSummary.workerPid);
		}

		const attached = await client.request({
			type: "attach",
			activeSessionId: resumedSummary.activeSessionId ?? resumedSummary.id,
		});
		expect(attached.success).toBe(true);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
		if (resumedSummary.workerPid) {
			await waitForProcessGone(resumedSummary.workerPid);
			workerPids.delete(resumedSummary.workerPid);
		}
	});

	it("does not resurrect an intentionally stopped root when the supervisor dies during kill", {
		tags: ["process-stress"],
		timeout: 30_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-stop-race-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "stop me", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const firstSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, firstSupervisor);
		const firstSupervisorPid = client.hello?.supervisorPid;
		if (!firstSupervisorPid) {
			throw new Error("Daemon hello did not expose its supervisor pid");
		}
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;
		const heartbeatResponse = await client.request({
			type: "heartbeat_set",
			activeSessionId,
			schedule: "every 1h",
			prompt: "continue old work",
		});
		if (!heartbeatResponse.success || !heartbeatResponse.data || typeof heartbeatResponse.data !== "object") {
			throw new Error(heartbeatResponse.success ? "Heartbeat response was missing data" : heartbeatResponse.error);
		}
		const heartbeat = (heartbeatResponse.data as { heartbeat: { id: string } }).heartbeat;
		const cronStore = AgentCronJobStore.forSessionArtifacts();
		cronStore.registerSessionArtifact(summary.sessionId, sessionManager.getSessionArtifactDir()!);
		process.kill(summary.workerPid, "SIGSTOP");
		const killResult = client.request({ type: "kill", activeSessionId }).catch((error: unknown) => error);
		const tombstone = await waitForWorkerStopTombstone(agentDir);
		expect(tombstone.stopRequestedAt).toEqual(expect.any(String));
		expect(tombstone.archiveOnStop).toBe(true);

		process.kill(firstSupervisorPid, "SIGKILL");
		await waitForExit(firstSupervisor);
		children.delete(firstSupervisor);
		client.close();
		await expect(killResult).resolves.toBeInstanceOf(Error);

		const replacementSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const replacementClient = await connectEventually(socketPath, replacementSupervisor);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		const sessions = requireSessionList(listed.success ? listed.data : undefined);
		expect(sessions.filter((session) => session.activeSessionId || session.workerPid)).toEqual([]);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Intentional worker stop descriptor was not removed",
		);
		expect(countWorkerDescriptors(agentDir)).toBe(0);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });
		expect(cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({ status: "cancelled" });

		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	});

	it("hosts and adopts isolated worker processes", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-smoke-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionFiles = Array.from({ length: 2 }, (_, index) => {
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: `smoke root ${index}`, timestamp: index + 1 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			return sessionFile;
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await Promise.all(
			sessionFiles.map((sessionPath) =>
				client.request({
					type: "create",
					sessionPath,
					config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
				}),
			),
		);
		const summaries = created.map((response) => {
			if (!response.success) {
				throw new Error(response.error);
			}
			return requireSummary(response.data);
		});
		const pids = summaries.map((summary) => summary.workerPid);
		expect(new Set(pids).size).toBe(2);
		expect(pids).not.toContain(supervisor.pid);
		for (const pid of pids) {
			if (!pid) {
				throw new Error("Resident root did not expose a worker pid");
			}
			workerPids.add(pid);
		}

		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toHaveLength(2);
		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		client.close();

		const replacementClient = await connectEventually(socketPath);
		const adopted = await replacementClient.request({ type: "list" });
		expect(adopted.success).toBe(true);
		expect(
			new Set(requireSessionList(adopted.success ? adopted.data : undefined).map((summary) => summary.workerPid)),
		).toEqual(new Set(pids));
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
		await Promise.all(
			pids.map(async (pid) => {
				if (pid) {
					await waitForProcessGone(pid);
					workerPids.delete(pid);
				}
			}),
		);
	}, 60_000);

	it("hosts resident roots in isolated worker processes without a session cap", {
		tags: ["process-stress"],
		timeout: 180_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-many-roots-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionFiles = Array.from({ length: PROCESS_STRESS_WORKERS }, (_, index) => {
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: `root ${index}`, timestamp: index + 1 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			return sessionFile;
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const externalLease = acquireSessionLease(sessionFiles[0], agentDir, {
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "external-owner",
		});
		const conflict = await client.request({
			type: "create",
			sessionPath: sessionFiles[0],
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(conflict).toMatchObject({
			success: false,
			errorInfo: { code: "session_already_active", activeSessionId: "external-owner" },
		});
		const emptyAfterConflict = await client.request({ type: "list" });
		expect(requireSessionList(emptyAfterConflict.success ? emptyAfterConflict.data : undefined)).toHaveLength(0);
		externalLease?.release();
		const created = await Promise.all(
			sessionFiles.map((sessionPath) =>
				client.request({
					type: "create",
					sessionPath,
					config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
				}),
			),
		);
		const summaries = created.map((response) => {
			if (!response.success) {
				throw new Error(response.error);
			}
			return requireSummary(response.data);
		});
		const pids = summaries.map((summary) => summary.workerPid);
		expect(new Set(pids).size).toBe(PROCESS_STRESS_WORKERS);
		expect(pids).not.toContain(supervisor.pid);
		for (const pid of pids) {
			if (!pid) {
				throw new Error("Resident root did not expose a worker pid");
			}
			workerPids.add(pid);
		}
		const firstActiveSessionId = summaries[0]!.activeSessionId ?? summaries[0]!.id;
		const addedCron = await client.request({
			type: "cron_add",
			activeSessionId: firstActiveSessionId,
			schedule: "every 1h",
			prompt: "check status",
		});
		expect(addedCron.success).toBe(true);
		const cronJob = (addedCron.success ? addedCron.data : undefined) as { job?: { id?: string } } | undefined;
		if (!cronJob?.job?.id) {
			throw new Error("Supervisor did not persist the cron job");
		}
		const listedCron = await client.request({ type: "cron_list", activeSessionId: firstActiveSessionId });
		expect(listedCron).toMatchObject({ success: true, data: { jobs: [{ id: cronJob.job.id }] } });
		const cancelledCron = await client.request({ type: "cron_cancel", jobId: cronJob.job.id });
		expect(cancelledCron.success).toBe(true);
		const activeSessionIds = summaries.map((summary) => summary.activeSessionId ?? summary.id);
		await Promise.all(
			activeSessionIds.map((activeSessionId, index) =>
				startBlockingBash(client, activeSessionId, join(root, `stress-blocker-${index}.ready`)),
			),
		);
		const heartbeats = await Promise.all(
			activeSessionIds.map((activeSessionId, index) =>
				client.request({
					type: "heartbeat_set",
					activeSessionId,
					schedule: "every 10s",
					prompt: `heartbeat ${index}`,
				}),
			),
		);
		expect(heartbeats.every((response) => response.success)).toBe(true);
		await waitForCondition(
			() => {
				const stores = summaries.map((summary, index) => {
					const store = AgentCronJobStore.forSessionArtifacts();
					store.registerSessionArtifact(
						summary.sessionId,
						join(dirname(dirname(sessionFiles[index]!)), "session-artifacts", summary.sessionId),
					);
					return store;
				});
				return stores.every((store) => store.list().some((job) => job.lastSkippedAt !== undefined));
			},
			"Session workers did not advance their heartbeats independently",
			15_000,
		);

		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toHaveLength(PROCESS_STRESS_WORKERS);
		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		client.close();
		const replacementClient = await connectEventually(socketPath);
		const adopted = await replacementClient.request({ type: "list" });
		expect(adopted.success).toBe(true);
		expect(
			new Set(requireSessionList(adopted.success ? adopted.data : undefined).map((summary) => summary.workerPid)),
		).toEqual(new Set(pids));
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
		await Promise.all(
			pids.map(async (pid) => {
				if (pid) {
					await waitForProcessGone(pid);
					workerPids.delete(pid);
				}
			}),
		);
	});

	it("isolates a root, streams a chunked snapshot, and adopts the same worker after restart", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		const largePrompt = `large:${"x".repeat(600 * 1024)}`;
		sessionManager.appendMessage({ role: "user", content: largePrompt, timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const firstSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, firstSupervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: {
				cwd: projectDir,
				agentDir,
				sessionDir,
				noTools: true,
				noExtensions: true,
			},
		});
		if (!created.success) {
			const diagnostics = childDiagnostics.get(firstSupervisor);
			throw new Error(
				`${created.error}\nsupervisor stdout:\n${diagnostics?.stdout ?? ""}\nsupervisor stderr:\n${diagnostics?.stderr ?? ""}\n${readDaemonLogs(agentDir)}`,
			);
		}
		expect(created.success).toBe(true);
		const createdSummary = requireSummary(created.data);
		expect(createdSummary.workerState).toBe("ready");
		expect(createdSummary.workerPid).not.toBe(firstSupervisor.pid);
		if (!createdSummary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(createdSummary.workerPid);

		const connection = await DaemonAgentConnection.attach(
			client,
			createdSummary.activeSessionId ?? createdSummary.id,
			{ recoverDaemon: async () => {} },
		);
		const connectionEvents: string[] = [];
		const replacementMessageCounts: number[] = [];
		connection.subscribe((event) => {
			connectionEvents.push(event.type === "connection_status" ? `${event.type}:${event.status}` : event.type);
			if (event.type === "session_replaced") {
				// Count conversation messages only; every session carries a harness digest.
				replacementMessageCounts.push(
					event.messages.filter(
						(message) =>
							!(
								message.role === "custom" &&
								(message as { customType?: string }).customType === "harness_digest"
							),
					).length,
				);
			}
		});
		const snapshot = await connection.getInitialSnapshot();
		const snapshotConversation = snapshot.messages.filter(
			(message) =>
				!(message.role === "custom" && (message as { customType?: string }).customType === "harness_digest"),
		);
		expect(snapshotConversation).toHaveLength(2);
		expect(snapshotConversation[0]).toMatchObject({ role: "user", content: largePrompt });

		const activeSessionId = createdSummary.activeSessionId ?? createdSummary.id;
		const createdNew = await client.request({ type: "new_session", activeSessionId });
		expect(createdNew.success).toBe(true);
		const emptyReplacementDeadline = Date.now() + 5000;
		while (!replacementMessageCounts.includes(0) && Date.now() < emptyReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts).toContain(0);
		const switchedBack = await client.request({ type: "switch_session", activeSessionId, sessionPath: sessionFile });
		expect(switchedBack.success).toBe(true);
		// The switch reports the file it resolved, so a client that sent a relative
		// path can still correlate the replacement snapshot it waits on.
		expect(switchedBack.success ? switchedBack.data : undefined).toMatchObject({
			cancelled: false,
			sessionFile,
		});
		const restoredReplacementDeadline = Date.now() + 5000;
		while (replacementMessageCounts.at(-1) !== 2 && Date.now() < restoredReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts.at(-1)).toBe(2);

		firstSupervisor.kill("SIGTERM");
		await waitForExit(firstSupervisor);
		children.delete(firstSupervisor);

		const reconnectDeadline = Date.now() + 15_000;
		while (!connectionEvents.includes("connection_status:connected") && Date.now() < reconnectDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		expect(connectionEvents).toContain("connection_status:reconnecting");
		// The direct worker link held through the supervisor swap, so no resync is warranted.
		expect(connectionEvents).not.toContain("session_resynced");
		expect(connectionEvents).toContain("connection_status:connected");
		expect(connectionEvents).not.toContain("closed");
		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: createdSummary.activeSessionId,
			sessionId: createdSummary.sessionId,
		});
		const listed = await client.request({ type: "list", all: true, sessionDir });
		expect(listed.success).toBe(true);
		if (!listed.success) {
			throw new Error(listed.error);
		}
		const adopted = requireSessionList(listed.data).find(
			(summary) => (summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
		);
		expect(adopted).toMatchObject({
			workerState: "ready",
			workerPid: createdSummary.workerPid,
		});

		const descriptor = readWorkerDescriptor(agentDir);
		await startBlockingBash(client, activeSessionId, join(root, "orphan-blocker.ready"));
		if (!descriptor.orphanProcessJournalPath) {
			throw new Error("Resident worker did not persist its orphan-process journal path");
		}
		let orphanPids: number[] = [];
		const orphanDeadline = Date.now() + 5000;
		while (orphanPids.length === 0 && Date.now() < orphanDeadline) {
			orphanPids = readActiveOrphanProcesses(descriptor.orphanProcessJournalPath, descriptor.pid).map(
				(orphan) => orphan.pid,
			);
			if (orphanPids.length === 0) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
		expect(orphanPids.length).toBeGreaterThan(0);
		for (const pid of orphanPids) {
			workerPids.add(pid);
		}
		process.kill(createdSummary.workerPid, "SIGKILL");
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
		await Promise.all(orphanPids.map((pid) => waitForProcessGone(pid)));
		for (const pid of orphanPids) {
			workerPids.delete(pid);
		}

		let failed: SessionSummary | undefined;
		const recoveryDeadline = Date.now() + 20_000;
		while (Date.now() < recoveryDeadline) {
			const response = await client.request({ type: "list" });
			if (response.success) {
				failed = requireSessionList(response.data).find(
					(summary) =>
						(summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
				);
				if (failed?.workerState === "failed") break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		expect(failed).toMatchObject({ workerState: "failed", activeSessionId: createdSummary.activeSessionId });
		await connection.dispose();

		const reopened = await client.request({
			type: "create",
			sessionPath: sessionFile,
			continueRecent: false,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
			launchEnv: { PRIME_AGENT_TEST_FRESH_CONTEXT: "1" },
		});
		if (!reopened.success) throw new Error(reopened.error);
		const recovered = requireSummary(reopened.data);
		if (!recovered.workerPid) throw new Error("Recovered worker did not expose its pid");
		workerPids.add(recovered.workerPid);
		const recoveredConnection = await DaemonAgentConnection.attach(
			client,
			recovered.activeSessionId ?? recovered.id,
			{ recoverDaemon: async () => {} },
		);
		const recoveredSnapshot = await recoveredConnection.getInitialSnapshot();
		expect(recoveredSnapshot.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
			]),
		);
		await expect(recoveredConnection.getState()).resolves.toMatchObject({ sessionId: createdSummary.sessionId });

		await recoveredConnection.dispose();
		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(recovered.workerPid);
		workerPids.delete(recovered.workerPid);
	});

	it("runs a session-artifact cron job while the supervisor is being replaced", {
		tags: ["process-stress"],
		timeout: 30_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-worker-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "scheduled work", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		const artifactDir = sessionManager.getSessionArtifactDir();
		if (!sessionFile || !artifactDir) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		await startBlockingBash(client, summary.activeSessionId ?? summary.id, join(root, "heartbeat-blocker.ready"));
		const scheduled = await client.request({
			type: "heartbeat_set",
			activeSessionId: summary.activeSessionId ?? summary.id,
			schedule: "every 10s",
			prompt: "continue without the supervisor",
		});
		if (!scheduled.success || !scheduled.data || typeof scheduled.data !== "object") {
			throw new Error(scheduled.success ? "Heartbeat response was missing its job" : scheduled.error);
		}
		const job = (scheduled.data as { heartbeat: { id: string } }).heartbeat;

		client.close();
		supervisor.kill("SIGKILL");
		await waitForExit(supervisor);
		children.delete(supervisor);

		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionManager.getSessionId(), artifactDir);
		await waitForCondition(
			() => store.list().find((candidate) => candidate.id === job.id)?.lastSkippedAt !== undefined,
			"Resident worker did not advance its heartbeat without the supervisor",
			15_000,
		);
		expect(store.list().find((candidate) => candidate.id === job.id)).toBeDefined();

		const replacement = await connectEventually(socketPath);
		await replacement.request({ type: "shutdown" });
		replacement.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
	});

	it("exits an orphaned session worker when no replacement supervisor can come up", { timeout: 120_000 }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "supervisor-registry");
		// The socket path must stay short: macOS rejects listen() with EINVAL
		// past the sun_path limit, and the per-test temp dir nests too deep.
		const socketDir = mkdtempSync(join(tmpdir(), "prime-orphan-gc-"));
		tempDirs.push(socketDir);
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(socketDir, "supervisor.sock");
		mkdirSync(projectDir, { recursive: true });

		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: "orphan gc fixture", timestamp: 1 });
		manager.flushNow();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Missing fixture session path");

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, [], {
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: registryDir,
			PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS: "3000",
		});
		// Cold tsx startup can exceed the shared helper's 15s readiness deadline.
		let client: DaemonClient | undefined;
		const readyDeadline = Date.now() + 60_000;
		while (client === undefined && Date.now() < readyDeadline) {
			if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
				const diagnostics = childDiagnostics.get(supervisor);
				throw new Error(
					`Supervisor exited before becoming ready\nstdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
				);
			}
			const candidate = new DaemonClient(socketPath);
			try {
				await candidate.connect(250);
				await candidate.waitForHello(1000);
				client = candidate;
			} catch {
				candidate.close();
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
			}
		}
		if (!client) throw new Error("Supervisor did not become ready in time");
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) throw new Error(created.error);
		const summary = requireSummary(created.data);
		if (!summary.workerPid) throw new Error("Session worker did not spawn");
		workerPids.add(summary.workerPid);

		// SIGKILL the registry-recorded supervisor pid: the spawned child can be
		// a tsx wrapper, and killing the wrapper alone leaves the supervisor
		// listening on its socket, so the worker would never orphan.
		const ownerDirectories = readdirSync(registryDir).filter((name) => name.endsWith(".owner"));
		expect(ownerDirectories).toHaveLength(1);
		const owner = JSON.parse(readFileSync(join(registryDir, ownerDirectories[0], "owner.json"), "utf8")) as {
			pid?: number;
		};
		if (!owner.pid) throw new Error("Supervisor owner record is missing its pid");
		const supervisorPid = owner.pid;
		const workerPid = summary.workerPid;
		client.close();

		// A read-only socket directory makes every replacement-launch attempt
		// fail (lock/bind EACCES): the real-world orphan precondition where a
		// worker cannot bring its supervisor back.
		chmodSync(socketDir, 0o555);
		try {
			process.kill(supervisorPid, "SIGKILL");
			await waitForCondition(
				() => {
					try {
						process.kill(workerPid, 0);
						return false;
					} catch (error) {
						return (error as NodeJS.ErrnoException).code === "ESRCH";
					}
				},
				"Orphaned session worker did not exit after the supervisor-lost window",
				60_000,
			);
		} finally {
			chmodSync(socketDir, 0o755);
		}
		workerPids.delete(workerPid);
	});
});

describe("issue #879 stable daemon process identity across timezone changes", () => {
	it("pins the portable process query to UTC across caller timezone changes", () => {
		const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
		const query = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
			calls.push({ command, args, env: options?.env });
			return options?.env?.TZ === "UTC" ? "Sat Aug 29 20:55:18 2026\n" : "Sat Aug 29 16:55:18 2026\n";
		};
		const originalTimezone = process.env.TZ;
		let before: string | undefined;
		let after: string | undefined;
		try {
			process.env.TZ = "America/Los_Angeles";
			before = getPsProcessStartId(42, query);
			process.env.TZ = "America/New_York";
			after = getPsProcessStartId(42, query);
		} finally {
			if (originalTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimezone;
		}

		expect(before).toBe("ps:Sat Aug 29 20:55:18 2026");
		expect(after).toBe(before);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toMatchObject({
				command: "ps",
				args: ["-p", "42", "-o", "lstart="],
				env: { LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
			});
		}
	});
});

function meshSignal(child: ChildProcess, type: string, id?: string): Promise<void> {
	return new Promise((resolveSignal, reject) => {
		function finish(error?: Error): void {
			child.stdout?.off("data", inspect);
			child.stderr?.off("data", inspect);
			child.off("exit", exited);
			if (error) reject(error);
			else resolveSignal();
		}
		function inspect(): void {
			const diagnostics = childDiagnostics.get(child);
			const matched = `${diagnostics?.stdout ?? ""}\n${diagnostics?.stderr ?? ""}`
				.split("\n")
				.filter(Boolean)
				.some((line) => {
					try {
						const value = JSON.parse(line);
						if (type === "log")
							return (
								value.component === "coding-agent.daemon-supervisor" &&
								typeof value.msg === "string" &&
								id !== undefined &&
								value.msg.includes(id)
							);
						return value.type === type && (id === undefined || value.id === id);
					} catch {
						return false;
					}
				});
			if (matched) finish();
		}
		function exited(): void {
			finish(new Error(`Fixture exited: ${childDiagnostics.get(child)?.stderr}`));
		}
		child.stdout?.on("data", inspect);
		child.stderr?.on("data", inspect);
		child.once("exit", exited);
		inspect();
	});
}

function meshPath(path: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => {
			watcher.close();
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			watcher.close();
			reject(new Error("Mesh file wait cancelled"));
		};
		const watcher = watch(dirname(path), () => {
			if (existsSync(path)) finish();
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else if (existsSync(path)) finish();
	});
}

async function meshFixture() {
	const root = tempDir();
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "mesh"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
	writeFileSync(join(agentDir, "mesh", "mesh.json"), JSON.stringify({ space: "prime", server: "nats://127.0.0.1:1" }));
	writeFileSync(
		join(agentDir, "mesh", "signer.json"),
		JSON.stringify(stripSpaceAuth(await createSpaceAuth("prime"))),
		{ mode: 0o600 },
	);
	const start = async (socket: string, sessionDir?: string) => {
		const child = spawnSupervisor(
			agentDir,
			socket,
			root,
			[],
			{ PRIME_MESH_TEST_SESSION_DIR: sessionDir },
			resolve(__dirname, "fixtures/mesh-supervisor.ts"),
		);
		await meshSignal(child, "ready");
		const client = new DaemonClient(socket);
		await client.connect();
		await client.waitForHello();
		return { child, client };
	};
	const request = async (client: DaemonClient, command: DaemonCommand) => {
		const response = await client.request(command);
		if (!response.success) throw new Error(response.error);
		return response.data;
	};
	const create = async (owner: Awaited<ReturnType<typeof start>>, name: string) => {
		const summary = requireSummary(await request(owner.client, { type: "create", name }));
		if (summary.workerPid) workerPids.add(summary.workerPid);
		await meshSignal(owner.child, "endpoint", summary.sessionId);
		return summary;
	};
	return { root, agentDir, start, request, create };
}

describe("mesh supervisor compatibility", () => {
	it("mesh-notify stores once across daemons, renders gate-watcher without a role and refuses a second live host", async () => {
		const f = await meshFixture();
		const sender = await f.start(join(f.root, "sender.sock"));
		const receiver = await f.start(join(f.root, "receiver.sock"));
		try {
			const target = await f.create(receiver, "reviewer");
			expect(sender.client.supportsServerCapability("mesh_notify")).toBe(true);
			const result = (await f.request(sender.client, {
				type: "mesh_notify",
				target: "ReViEwEr",
				message: "No reply expected.",
			})) as { outcome: string; receipt: { sequence: number; cotalId: string } };
			expect(result).toMatchObject({ outcome: "stored", receipt: { sequence: 1, cotalId: expect.any(String) } });
			await meshSignal(receiver.child, "ack", result.receipt.cotalId);
			const entries = readFileSync(target.sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const received = entries.filter(
				(entry) => entry.type === "custom_message" && entry.details?.id === `agentmsg_${result.receipt.cotalId}`,
			);
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({
				content: "[agent-message from gate-watcher]\n\nPossibly repeated agent message.\n\nNo reply expected.",
				details: { from: { sessionName: "gate-watcher", clientId: expect.stringMatching(/^local\.U/) } },
			});
			expect(received[0].details.fromRelationship).toBeUndefined();
			expect(received[0].details.from.sessionId).toBeUndefined();
			expect(countWorkerDescriptors(f.agentDir)).toBe(1);
			expect(
				(childDiagnostics.get(sender.child)?.stdout ?? "")
					.split("\n")
					.filter((line) => line.includes('"type":"notification-published"')),
			).toHaveLength(1);
			expect(
				await f.request(receiver.client, { type: "mesh_notify", target: target.sessionId, message: "blocked" }),
			).toMatchObject({ outcome: "failed", error: expect.stringContaining("already active") });
			expect(childDiagnostics.get(receiver.child)?.stdout).not.toContain('"type":"notification-published"');
		} finally {
			sender.client.close();
			receiver.client.close();
		}
	});

	it.each(["rename", "unknown", "directory-error", "missing", "saved"] as const)(
		"AC-36 AC-38 uses production handoff after %s",
		async (mode) => {
			const f = await meshFixture();
			const holder = await f.start(join(f.root, "holder.sock"));
			try {
				const sender = await f.create(holder, "old-sender");
				const target = await f.create(holder, "target");
				const before = JSON.parse(
					readFileSync(join(f.agentDir, "mesh", "enrollments", `${sender.sessionId}.json`), "utf8"),
				);
				if (mode === "rename")
					await f.request(holder.client, {
						type: "set_session_name",
						activeSessionId: sender.activeSessionId!,
						name: "new-sender",
					});
				if (mode === "missing" || mode === "saved")
					await f.request(holder.client, { type: "kill", activeSessionId: target.activeSessionId! });
				if (mode === "missing") rmSync(target.sessionFile!);
				const workerCount = countWorkerDescriptors(f.agentDir);
				if (mode === "unknown" || mode === "directory-error")
					writeFileSync(join(f.agentDir, `hold-pulls-${target.sessionId}`), "held");
				for (let n = 0; n < (mode === "missing" ? 2 : 1); n++) {
					const stored = (await f.request(holder.client, {
						type: "mesh_send",
						fromActiveSessionId: sender.activeSessionId!,
						targetSessionId: target.sessionId,
						message: "handoff",
					})) as { cotalId: string };
					if (mode === "unknown" || mode === "directory-error") {
						if (mode === "unknown") rmSync(join(f.agentDir, "mesh", "directory", `${sender.sessionId}.json`));
						else chmodSync(join(f.agentDir, "mesh", "directory"), 0o100);
						rmSync(join(f.agentDir, `hold-pulls-${target.sessionId}`));
						process.kill(holder.child.pid!, "SIGUSR2");
					}
					if (mode === "missing") {
						await meshSignal(holder.child, "handoff-refused", stored.cotalId);
						await meshSignal(holder.child, "log", `Cotal ID ${stored.cotalId}, delivery count 2: handoff failed`);
						expect(countWorkerDescriptors(f.agentDir)).toBe(workerCount);
						expect(existsSync(target.sessionFile!)).toBe(false);
						expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
						expect(childDiagnostics.get(holder.child)?.stderr).toContain(
							`session file is missing: ${canonicalSessionPath(target.sessionFile!)}`,
						);
					} else {
						if (mode === "directory-error")
							await Promise.race([
								meshSignal(holder.child, "ack", stored.cotalId),
								meshSignal(holder.child, "handoff-refused", stored.cotalId).then(() => {
									throw new Error("Directory lookup prevented delivery");
								}),
							]);
						else await meshSignal(holder.child, "ack", stored.cotalId);
						const entries = readFileSync(target.sessionFile!, "utf8")
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line));
						const received = entries.filter(
							(entry) => entry.type === "custom_message" && entry.details?.id === `agentmsg_${stored.cotalId}`,
						);
						expect(received).toHaveLength(1);
						expect(received[0].details.from).toMatchObject({
							sessionName: mode === "rename" ? "new-sender" : "old-sender",
							...(mode === "unknown" || mode === "directory-error" ? {} : { sessionId: sender.sessionId }),
						});
						if (mode === "unknown" || mode === "directory-error")
							expect(received[0].details.from.sessionId).toBeUndefined();
						if (mode === "saved") expect(countWorkerDescriptors(f.agentDir)).toBe(workerCount + 1);
					}
				}
				expect(
					JSON.parse(readFileSync(join(f.agentDir, "mesh", "enrollments", `${sender.sessionId}.json`), "utf8")),
				).toEqual(before);
				const diagnostics = childDiagnostics.get(holder.child)?.stderr ?? "";
				expect(diagnostics).not.toContain(before.identity.seed);
			} finally {
				chmodSync(join(f.agentDir, "mesh", "directory"), 0o700);
				holder.client.close();
			}
		},
	);

	it.each(["local", "legacy", "foreign", "stopped"] as const)(
		"AC-34 deletes a retained real child by its exact path (%s)",
		async (mode) => {
			const legacy = mode === "legacy";
			const f = await meshFixture();
			const folder = join(f.agentDir, "sessions");
			const parents = [SessionManager.create(f.root, folder), SessionManager.create(f.root, folder)];
			const ledger = new RlmSpawnLedger(f.agentDir, folder);
			const children = [];
			for (const [i, parent] of parents.entries()) {
				parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
				parent.flushNow();
				const childDir = join(parent.getSessionArtifactDir()!, "same");
				const child = SessionManager.create(f.root, childDir);
				child.newSession({ parentSession: parent.getSessionFile()! });
				child.appendSessionInfo(`child-${i}`);
				child.appendMessage({ role: "user", content: "retained", timestamp: 2 });
				child.flushNow();
				children.push(child);
				writeFileSync(
					join(parent.getSessionArtifactDir()!, "rlm-subagents.jsonl"),
					`${JSON.stringify({ type: "rlm_subagent", childId: "same", sessionName: `child-${i}`, sessionDir: childDir, sessionFile: child.getSessionFile(), parentSessionId: parent.getSessionId(), parentSessionFile: parent.getSessionFile(), rlmDepth: 1, status: "completed", createdAt: 1, updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
				);
				if (!legacy || i === 1)
					await ledger.appendSpawn({
						childId: "same",
						parent: parent.getSessionFile()!,
						child: child.getSessionFile()!,
						depth: 1,
						name: `child-${i}`,
					});
			}
			const child = children[0]!;
			const other = children[1]!;
			let holder = await f.start(join(f.root, "holder.sock"));
			let foreign: Awaited<ReturnType<typeof f.start>> | undefined;
			const foreignFolder = join(f.agentDir, "foreign-sessions");
			try {
				const parent = requireSummary(
					await f.request(holder.client, { type: "create", sessionPath: parents[0]!.getSessionFile()! }),
				);
				if (parent.workerPid) workerPids.add(parent.workerPid);
				if (legacy) {
					const opened = requireSummary(
						await f.request(holder.client, { type: "create", sessionPath: child.getSessionFile()! }),
					);
					if (opened.workerPid) workerPids.add(opened.workerPid);
				}
				const otherParent = requireSummary(
					await f.request(holder.client, { type: "create", sessionPath: parents[1]!.getSessionFile()! }),
				);
				if (otherParent.workerPid) workerPids.add(otherParent.workerPid);
				for (const manager of children) await meshSignal(holder.child, "endpoint", manager.getSessionId());
				const meshRoot = join(f.agentDir, "mesh");
				const otherRecord = readFileSync(join(meshRoot, "enrollments", `${other.getSessionId()}.json`), "utf8");
				if (mode === "foreign") {
					holder.child.kill("SIGKILL");
					await waitForExit(holder.child);
					holder.client.close();
					foreign = await f.start(join(f.root, "foreign.sock"), foreignFolder);
					const opened = requireSummary(
						await f.request(foreign.client, {
							type: "create",
							sessionPath: child.getSessionFile()!,
							config: { sessionDir: foreignFolder },
						}),
					);
					if (opened.workerPid) workerPids.add(opened.workerPid);
					await meshSignal(foreign.child, "endpoint", child.getSessionId());
					holder = await f.start(join(f.root, "holder.sock"));
				}
				const before = readFileSync(child.getSessionFile()!);
				if (mode === "stopped") {
					await f.request(holder.client, { type: "shutdown" });
					holder.client.close();
					await waitForExit(holder.child);
					await ledger.appendDelete({ childId: "same", child: child.getSessionFile()!, reason: "user" });
					holder = await f.start(join(f.root, "holder.sock"));
				} else if (legacy) {
					writeFileSync(
						join(f.agentDir, "legacy-delete.json"),
						JSON.stringify({ parent: parent.sessionId, child: "same" }),
					);
					process.kill(parent.workerPid!, "SIGUSR1");
				} else
					expect(
						await f.request(holder.client, {
							type: "delete_rlm_subagent",
							activeSessionId: parent.activeSessionId!,
							childId: "same",
						}),
					).toEqual({ deleted: true });
				await meshSignal(
					holder.child,
					mode === "foreign" ? "log" : "removed",
					mode === "foreign"
						? `Mesh session ${child.getSessionId()}: inbox removal skipped; claimed by another daemon`
						: child.getSessionId(),
				);
				for (const dir of ["directory", "enrollments"])
					expect(existsSync(join(meshRoot, dir, `${child.getSessionId()}.json`))).toBe(false);
				if (mode !== "foreign") {
					const order = readFileSync(join(f.agentDir, "cleanup-order.jsonl"), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
						.filter((event) => event.id === child.getSessionId())
						.map((event) => event.type);
					expect(order).toEqual(["stop", "remove"]);
				} else {
					for (const stream of ["dm", "dlv"])
						expect(existsSync(join(f.agentDir, `${stream}-${child.getSessionId()}`))).toBe(true);
					expect(
						(childDiagnostics.get(holder.child)?.stderr ?? "").split(
							JSON.stringify(
								`Mesh session ${child.getSessionId()}: inbox removal skipped; claimed by another daemon`,
							),
						),
					).toHaveLength(2);
				}
				expect(readFileSync(child.getSessionFile()!)).toEqual(before);
				expect(readFileSync(join(meshRoot, "enrollments", `${other.getSessionId()}.json`), "utf8")).toBe(
					otherRecord,
				);
				for (const stream of ["dm", "dlv"])
					expect(existsSync(join(f.agentDir, `${stream}-${other.getSessionId()}`))).toBe(true);
				if (mode !== "foreign") {
					const claim = claimEnrollment(meshRoot, child.getSessionId(), child.getSessionFile()!);
					claim.release();
				}
				const sender = mode === "stopped" ? await f.create(holder, "after-restart") : parent;
				expect(
					await holder.client.request({
						type: "mesh_send",
						fromActiveSessionId: sender.activeSessionId!,
						targetSessionId: "child-0",
						message: "gone",
					}),
				).toMatchObject({ success: false, error: expect.stringContaining("Unknown mesh target") });
				if (mode !== "stopped")
					await f.request(holder.client, {
						type: "delete_rlm_subagent",
						activeSessionId: parent.activeSessionId!,
						childId: "same",
					});
				await f.request(holder.client, { type: "shutdown" });
				holder.client.close();
				await waitForExit(holder.child);
				holder = await f.start(join(f.root, "holder.sock"));
				for (const dir of ["directory", "enrollments"])
					expect(existsSync(join(meshRoot, dir, `${child.getSessionId()}.json`))).toBe(false);
				if (foreign) {
					foreign.child.kill("SIGKILL");
					await waitForExit(foreign.child);
					foreign.client.close();
					foreign = await f.start(join(f.root, "foreign.sock"), foreignFolder);
					await meshSignal(foreign.child, "log", `Mesh session ${child.getSessionId()}: enrollment failed:`);
					for (const dir of ["directory", "enrollments"])
						expect(existsSync(join(meshRoot, dir, `${child.getSessionId()}.json`))).toBe(false);
					expect(existsSync(join(f.agentDir, "removals.jsonl"))).toBe(false);
				} else expect(readFileSync(join(f.agentDir, "removals.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
			} finally {
				holder.client.close();
				foreign?.client.close();
			}
		},
	);

	it("AC-34 reconciles child roster removals but never a top-level removal", async () => {
		const f = await meshFixture();
		const folder = join(f.agentDir, "sessions");
		const parent = SessionManager.create(f.root, folder);
		parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
		parent.flushNow();
		const childDir = join(parent.getSessionArtifactDir()!, "child");
		const child = SessionManager.create(f.root, childDir);
		child.newSession({ parentSession: parent.getSessionFile()! });
		child.appendSessionInfo("child");
		child.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		child.flushNow();
		writeFileSync(
			join(parent.getSessionArtifactDir()!, "rlm-subagents.jsonl"),
			`${JSON.stringify({ type: "rlm_subagent", childId: "child", sessionName: "child", sessionDir: childDir, sessionFile: child.getSessionFile(), parentSessionId: parent.getSessionId(), parentSessionFile: parent.getSessionFile(), rlmDepth: 1, status: "completed", createdAt: 1, updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
		);
		await new RlmSpawnLedger(f.agentDir, folder).appendSpawn({
			childId: "child",
			parent: parent.getSessionFile()!,
			child: child.getSessionFile()!,
			depth: 1,
			name: "child",
		});
		const holder = await f.start(join(f.root, "holder.sock"));
		let unsubscribe = () => {};
		try {
			await meshSignal(holder.child, "log", "Mesh home enrollment:");
			const opened = requireSummary(
				await f.request(holder.client, { type: "create", sessionPath: parent.getSessionFile()! }),
			);
			if (opened.workerPid) workerPids.add(opened.workerPid);
			await meshSignal(holder.child, "endpoint", child.getSessionId());
			const top = await f.create(holder, "top-level");
			await f.request(holder.client, { type: "roster_subscribe" });
			const removed = new Promise<void>((resolveRemoved) => {
				unsubscribe = holder.client.onMessage((event) => {
					if (event.type === "roster_update" && event.removed?.includes(top.sessionId!)) resolveRemoved();
				});
			});
			const bad = new RlmSpawnLedger(f.agentDir, join(f.agentDir, "broken"));
			mkdirSync(dirname(bad.ledgerPath), { recursive: true });
			writeFileSync(bad.ledgerPath, "malformed\n");
			await f.request(holder.client, { type: "kill", activeSessionId: top.activeSessionId! });
			await removed;
			// A different ledger error identifies the child-triggered pass, not a stale top-level failure.
			writeFileSync(bad.ledgerPath, "{}\n");
			expect(
				await f.request(holder.client, {
					type: "delete_rlm_subagent",
					activeSessionId: opened.activeSessionId!,
					childId: "child",
				}),
			).toEqual({ deleted: true });
			await meshSignal(holder.child, "log", "missing v/at");
			const failures = (childDiagnostics.get(holder.child)?.stderr ?? "")
				.split("\n")
				.filter((line) => line.startsWith("Mesh RLM deletion reconciliation failed:"));
			expect(failures).toHaveLength(1);
			expect(childDiagnostics.get(holder.child)?.stderr).toContain(bad.ledgerPath);
		} finally {
			unsubscribe();
			holder.client.close();
		}
	});

	// test-policy: allow explicit-test-timeout -- Same-ID rebind rows start real supervisors and workers (11 to 19 s alone at seed 17); lead timing showed PR 6 does not slow the product path. fork-pr-check runs six files in parallel, so the 30 s default expired under machine load. The timer only bounds failure; every wait awaits a concrete event.
	it.each([
		"import",
		"overwrite",
		"move",
		"queued",
		"started",
		"buffered",
		"cancelled",
		"postcopy",
		"postcopy-open",
		"crash-before-copy",
		"unpublished",
		"cross-id",
		"same-daemon-holder",
		"holder",
		"no-offer",
		"old-worker",
	] as const)("rebinds a real worker without losing or repeating a delivery (%s)", { timeout: 60e3 }, async (mode) => {
		const f = await meshFixture();
		const postcopy = mode === "postcopy" || mode === "postcopy-open";
		mkdirSync(join(f.agentDir, "extensions"));
		writeFileSync(
			join(f.agentDir, "extensions", "rebind.ts"),
			`
				import { existsSync, writeFileSync, watch } from "node:fs";
				import { join } from "node:path";
				export default function(pi) {
					const root = process.env.PRIME_AGENT_CODING_AGENT_DIR;
					pi.on("message_end", async (event) => {
						const path = join(root, "hold-event");
						if (event.message.role !== "custom" || event.message.customType !== "agent_message" || !existsSync(path)) return;
						writeFileSync(join(root, "event-held"), "held");
						await new Promise(resolve => { const w = watch(root, () => { if (!existsSync(path)) { w.close(); resolve(); } }); });
					});
					pi.on("session_before_switch", async () => {
						const path = join(root, "hold-before-copy");
						if (existsSync(path)) {
							writeFileSync(join(root, "before-copy-held"), "held");
							await new Promise(resolve => { const w = watch(root, () => { if (!existsSync(path)) { w.close(); resolve(); } }); });
						}
						return existsSync(join(root, "cancel-before-copy")) ? { cancel: true } : undefined;
					});
				}
			`,
		);
		if (mode === "no-offer") writeFileSync(join(f.agentDir, "no-barrier"), "old");
		const holder = await f.start(join(f.root, "holder.sock"));
		const cleanup = new AbortController();
		try {
			const sender = await f.create(holder, "sender");
			if (mode === "old-worker") writeFileSync(join(f.agentDir, "legacy-worker"), "legacy");
			const target = await f.create(holder, "target");
			const activeSessionId = target.activeSessionId;
			if (!activeSessionId) throw new Error("Missing active target");
			const recordPath = join(f.agentDir, "mesh", "enrollments", `${target.sessionId}.json`);
			const before = JSON.parse(readFileSync(recordPath, "utf8"));
			if (mode === "old-worker") {
				const stored = (await f.request(holder.client, {
					type: "mesh_send",
					fromActiveSessionId: sender.activeSessionId!,
					targetSessionId: target.sessionId!,
					message: "legacy",
				})) as { cotalId: string };
				await Promise.race([
					meshSignal(holder.child, "handoff-refused", stored.cotalId),
					meshSignal(holder.child, "accepted", stored.cotalId).then(() =>
						expect.fail("Legacy worker accepted a mesh handoff"),
					),
				]);
				expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
				expect(readFileSync(target.sessionFile!, "utf8")).not.toContain(stored.cotalId);
				expect(
					await holder.client.request({
						type: "send_message",
						targetActiveSessionId: sender.activeSessionId!,
						fromActiveSessionId: activeSessionId,
						message: "native",
						agentOrigin: true,
					}),
				).toMatchObject({ success: false, error: expect.stringContaining("restart that session") });
				return;
			}
			if (mode === "unpublished") {
				const unpublished = join(f.root, "unpublished.jsonl");
				copyFileSync(target.sessionFile!, unpublished);
				writeFileSync(join(f.agentDir, "hold-turn"), "hold");
				await f.request(holder.client, { type: "prompt", activeSessionId, message: "hold" });
				await meshPath(join(f.agentDir, "turn-held"), cleanup.signal);
				const held = (await f.request(holder.client, {
					type: "mesh_send",
					fromActiveSessionId: sender.activeSessionId!,
					targetSessionId: target.sessionId!,
					message: "held before publication",
				})) as { cotalId: string };
				await meshSignal(holder.child, "accepted", held.cotalId);
				const attempt = {
					type: "mesh_replace" as const,
					fromActiveSessionId: activeSessionId,
					sessionId: target.sessionId!,
					sessionFile: unpublished,
					token: randomUUID(),
				};
				await f.request(holder.client, { ...attempt, phase: "begin", overwrite: true });
				expect(await holder.client.request({ ...attempt, phase: "completed" })).toMatchObject({
					success: false,
					error: expect.stringContaining("has not published the replacement file"),
				});
				const next = { ...attempt, sessionFile: target.sessionFile!, token: randomUUID() };
				expect(await f.request(holder.client, { ...next, phase: "begin", overwrite: true })).toMatchObject({
					required: true,
					token: next.token,
				});
				await f.request(holder.client, { ...next, phase: "cancelled" });
				await meshSignal(holder.child, "rebound", target.sessionId);
				expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(before);
				rmSync(join(f.agentDir, "hold-turn"));
				await meshSignal(holder.child, "ack", held.cotalId);
				expect(readFileSync(target.sessionFile!, "utf8").split(`agentmsg_${held.cotalId}`)).toHaveLength(2);
				expect(readFileSync(unpublished, "utf8")).not.toContain(held.cotalId);
				return;
			}
			if (mode === "cross-id") {
				const saved = await f.create(holder, "saved-import");
				const savedRecordPath = join(f.agentDir, "mesh", "enrollments", `${saved.sessionId}.json`);
				const savedRecord = JSON.parse(readFileSync(savedRecordPath, "utf8"));
				const incoming = join(f.root, "cross-id.jsonl");
				copyFileSync(saved.sessionFile!, incoming);
				await f.request(holder.client, { type: "kill", activeSessionId: saved.activeSessionId! });
				writeFileSync(join(f.agentDir, "hold-turn"), "hold");
				await f.request(holder.client, { type: "prompt", activeSessionId, message: "hold" });
				await meshPath(join(f.agentDir, "turn-held"), cleanup.signal);
				const queued = (await f.request(holder.client, {
					type: "mesh_send",
					fromActiveSessionId: sender.activeSessionId!,
					targetSessionId: target.sessionId!,
					message: "closed on import",
				})) as { cotalId: string };
				await meshSignal(holder.child, "accepted", queued.cotalId);
				await f.request(holder.client, { type: "import_jsonl", activeSessionId, inputPath: incoming });
				await meshSignal(holder.child, "ack", queued.cotalId);
				await meshSignal(holder.child, "log", `Cotal ID ${queued.cotalId}, delivery count 2: dropped closed`);
				const destination = join(dirname(target.sessionFile!), "cross-id.jsonl");
				expect(readFileSync(target.sessionFile!, "utf8")).not.toContain(queued.cotalId);
				expect(readFileSync(destination, "utf8")).not.toContain(queued.cotalId);
				expect(JSON.parse(readFileSync(savedRecordPath, "utf8"))).toEqual({
					...savedRecord,
					sessionFile: canonicalSessionPath(destination),
				});
				expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(before);
				rmSync(join(f.agentDir, "hold-turn"));
				const next = (await f.request(holder.client, {
					type: "mesh_send",
					fromActiveSessionId: sender.activeSessionId!,
					targetSessionId: saved.sessionId!,
					message: "new target",
				})) as { cotalId: string };
				await meshSignal(holder.child, "ack", next.cotalId);
				expect(readFileSync(destination, "utf8").split(next.cotalId)).toHaveLength(2);
				return;
			}
			if (mode === "holder" || mode === "no-offer" || mode === "same-daemon-holder") {
				const input = join(f.root, "refused.jsonl");
				copyFileSync(target.sessionFile!, input);
				SessionManager.open(input).appendSessionInfo("must-not-copy");
				const other = mode === "holder" ? await f.start(join(f.root, "other.sock")) : holder;
				try {
					const importing =
						mode === "holder"
							? await f.create(other, "importer")
							: mode === "same-daemon-holder"
								? sender
								: target;
					const original = readFileSync(importing.sessionFile!, "utf8");
					const response = await other.client.request({
						type: "import_jsonl",
						activeSessionId: importing.activeSessionId!,
						inputPath: input,
					});
					expect(response).toMatchObject({
						success: false,
						error: expect.stringContaining(
							mode === "holder"
								? "claimed by another daemon"
								: mode === "same-daemon-holder"
									? "another holder"
									: "does not offer",
						),
					});
					expect(readFileSync(importing.sessionFile!, "utf8")).toBe(original);
					expect(existsSync(join(dirname(importing.sessionFile!), "refused.jsonl"))).toBe(false);
					expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(before);
				} finally {
					if (other !== holder) other.client.close();
				}
				return;
			}
			const incomingDir = join(f.root, "incoming");
			mkdirSync(incomingDir);
			const samePath = !["import", "move"].includes(mode);
			const incoming = join(incomingDir, samePath ? target.sessionFile!.split("/").at(-1)! : "different.jsonl");
			copyFileSync(target.sessionFile!, incoming);
			SessionManager.open(incoming).appendSessionInfo("replacement");
			writeFileSync(join(f.agentDir, "hold-turn"), "hold");
			if (mode === "started") writeFileSync(join(f.agentDir, "hold-event"), "hold");
			if (
				mode === "queued" ||
				mode === "import" ||
				mode === "move" ||
				mode === "overwrite" ||
				mode === "cancelled" ||
				mode === "crash-before-copy"
			) {
				await f.request(holder.client, { type: "prompt", activeSessionId, message: "hold" });
				await meshPath(join(f.agentDir, "turn-held"), cleanup.signal);
			}
			if (postcopy) writeFileSync(join(f.agentDir, "hold-acks"), "hold");
			if (postcopy) rmSync(join(f.agentDir, "hold-turn"));
			const stored = (await f.request(holder.client, {
				type: "mesh_send",
				fromActiveSessionId: sender.activeSessionId!,
				targetSessionId: target.sessionId!,
				message: "held",
			})) as { cotalId: string };
			await meshSignal(holder.child, postcopy ? "before-ack" : "accepted", stored.cotalId);
			if (mode === "started") await meshPath(join(f.agentDir, "event-held"), cleanup.signal);
			if (mode === "buffered") await meshPath(join(f.agentDir, "turn-held"), cleanup.signal);
			const count = (file: string) =>
				readFileSync(file, "utf8")
					.split("\n")
					.filter((line) => line.includes(`agentmsg_${stored.cotalId}`)).length;
			if (mode === "buffered" || mode === "started") expect(count(target.sessionFile!)).toBe(0);
			if (mode === "cancelled") writeFileSync(join(f.agentDir, "cancel-before-copy"), "cancel");
			if (mode === "crash-before-copy") writeFileSync(join(f.agentDir, "hold-before-copy"), "hold");
			if (postcopy) {
				const lines = readFileSync(incoming, "utf8").trimEnd().split("\n");
				lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cwd: join(f.root, "missing-cwd") });
				writeFileSync(incoming, `${lines.join("\n")}\n`);
			}
			let destination = join(dirname(target.sessionFile!), incoming.split("/").at(-1)!);
			if (mode === "move") {
				destination = join(f.root, "moved.jsonl");
				renameSync(target.sessionFile!, destination);
			}
			const replacing = holder.client.request(
				mode === "move"
					? { type: "switch_session", activeSessionId, sessionPath: destination }
					: { type: "import_jsonl", activeSessionId, inputPath: incoming },
			);
			await meshSignal(holder.child, "endpoint-stopped", target.sessionId);
			if (mode === "started") rmSync(join(f.agentDir, "hold-event"));
			if (mode === "crash-before-copy") {
				await meshPath(join(f.agentDir, "before-copy-held"), cleanup.signal);
				if (!target.workerPid) throw new Error("Missing worker PID");
				process.kill(target.workerPid, "SIGKILL");
				expect(await replacing).toMatchObject({ success: false });
				await meshSignal(holder.child, "worker-failed", String(target.workerPid));
				rmSync(join(f.agentDir, "hold-before-copy"));
				rmSync(join(f.agentDir, "hold-turn"));
				const opened = requireSummary(
					await f.request(holder.client, {
						type: "create",
						sessionPath: target.sessionFile!,
						launchEnv: {},
						config: { cwd: f.root },
					}),
				);
				if (opened.workerPid) workerPids.add(opened.workerPid);
				await meshSignal(holder.child, "rebound", target.sessionId);
				await meshSignal(holder.child, "ack", stored.cotalId);
				expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(before);
				expect(count(target.sessionFile!)).toBe(1);
				expect(readFileSync(join(f.agentDir, "acks.jsonl"), "utf8").split(stored.cotalId)).toHaveLength(2);
				return;
			}
			const result = await replacing;
			if (postcopy) {
				expect(result).toMatchObject({ success: false, error: expect.stringContaining("missing-cwd") });
				expect(count(destination)).toBe(0);
				expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
				rmSync(join(f.agentDir, "hold-acks"));
				if (mode === "postcopy-open") {
					await f.request(holder.client, { type: "kill", activeSessionId });
					const opened = requireSummary(
						await f.request(holder.client, { type: "create", sessionPath: destination, config: { cwd: f.root } }),
					);
					if (opened.workerPid) workerPids.add(opened.workerPid);
				} else {
					await f.request(holder.client, {
						type: "switch_session",
						activeSessionId,
						sessionPath: destination,
						cwdOverride: f.root,
					});
				}
			} else {
				if (!result.success) throw new Error(result.error);
				expect(result).toMatchObject({ success: true });
			}
			if (mode === "cancelled") {
				if (!result.success) throw new Error(result.error);
				destination = target.sessionFile!;
				expect((result.data as { cancelled: boolean }).cancelled).toBe(true);
			}
			const after = JSON.parse(readFileSync(recordPath, "utf8"));
			expect(after).toEqual({ ...before, sessionFile: canonicalSessionPath(destination) });
			if (!postcopy) {
				expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
				rmSync(join(f.agentDir, "hold-turn"));
			}
			await meshSignal(holder.child, "ack", stored.cotalId);
			expect(count(destination)).toBe(1);
			expect(
				readFileSync(join(f.agentDir, "ack-disk.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toContainEqual({ id: stored.cotalId, covered: true });
			const second = (await f.request(holder.client, {
				type: "mesh_send",
				fromActiveSessionId: sender.activeSessionId!,
				targetSessionId: target.sessionId!,
				message: "second",
			})) as { cotalId: string };
			await meshSignal(holder.child, "ack", second.cotalId);
			expect(readFileSync(destination, "utf8").split(second.cotalId)).toHaveLength(2);
			if (!samePath && mode !== "move") expect(count(target.sessionFile!)).toBe(0);
			await f.request(holder.client, { type: "shutdown" });
			holder.client.close();
			await waitForExit(holder.child);
			const restarted = await f.start(join(f.root, "holder.sock"));
			try {
				await meshSignal(restarted.child, "endpoint", target.sessionId);
				expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(after);
			} finally {
				restarted.client.close();
			}
		} finally {
			cleanup.abort();
			for (const file of [
				"hold-turn",
				"hold-event",
				"fail-after-copy",
				"cancel-before-copy",
				"hold-acks",
				"hold-before-copy",
			])
				rmSync(join(f.agentDir, file), { force: true });
			holder.client.close();
		}
	});
	it("AC-37 names a foreign claim before changing files or runtime", async () => {
		const f = await meshFixture();
		const holder = await f.start(join(f.root, "holder.sock"));
		const other = await f.start(join(f.root, "other.sock"));
		try {
			const target = await f.create(holder, "target");
			const importer = await f.create(other, "importer");
			const before = readFileSync(importer.sessionFile!);
			const recordPath = join(f.agentDir, "mesh", "enrollments", `${target.sessionId}.json`);
			const record = readFileSync(recordPath, "utf8");
			expect(
				await other.client.request({
					type: "mesh_replace",
					fromActiveSessionId: importer.activeSessionId!,
					sessionId: target.sessionId,
					sessionFile: target.sessionFile!,
					overwrite: true,
					token: randomUUID(),
					phase: "begin",
				}),
			).toMatchObject({ success: false, error: `Session ${target.sessionId}: claimed by another daemon` });
			expect(readFileSync(importer.sessionFile!)).toEqual(before);
			expect(readFileSync(recordPath, "utf8")).toBe(record);
			expect(
				await f.request(other.client, { type: "get_state", activeSessionId: importer.activeSessionId! }),
			).toMatchObject({ sessionFile: importer.sessionFile, workerPid: importer.workerPid });
		} finally {
			holder.client.close();
			other.client.close();
		}
	});

	// test-policy: allow explicit-test-timeout -- The current-path switch starts real supervisors and workers (11 to 19 s alone at seed 17); lead timing showed PR 6 does not slow the product path. fork-pr-check runs six files in parallel, so the 30 s default expired under machine load. The timer only bounds failure; every wait awaits a concrete event.
	it("switches a real worker to its current enrolled file without losing context", { timeout: 60_000 }, async () => {
		const f = await meshFixture();
		const holder = await f.start(join(f.root, "holder.sock"));
		const cleanup = new AbortController();
		try {
			const sender = await f.create(holder, "sender");
			const target = await f.create(holder, "target");
			const activeSessionId = target.activeSessionId!;
			const recordPath = join(f.agentDir, "mesh", "enrollments", `${target.sessionId}.json`);
			const before = readFileSync(recordPath, "utf8");
			writeFileSync(join(f.agentDir, "hold-turn"), "hold");
			await f.request(holder.client, { type: "prompt", activeSessionId, message: "hold before mesh admission" });
			await meshPath(join(f.agentDir, "turn-held"), cleanup.signal);
			const stored = (await f.request(holder.client, {
				type: "mesh_send",
				fromActiveSessionId: sender.activeSessionId!,
				targetSessionId: target.sessionId!,
				message: "current-path context",
			})) as { cotalId: string };
			await meshSignal(holder.child, "accepted", stored.cotalId);
			expect(readFileSync(target.sessionFile!, "utf8")).not.toContain(stored.cotalId);
			const switching = f.request(holder.client, {
				type: "switch_session",
				activeSessionId,
				sessionPath: target.sessionFile!,
			});
			await meshSignal(holder.child, "endpoint-stopped", target.sessionId);
			expect(await switching).toMatchObject({ cancelled: false, sessionFile: target.sessionFile });
			expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
			rmSync(join(f.agentDir, "hold-turn"));
			await meshSignal(holder.child, "ack", stored.cotalId);
			expect(readFileSync(target.sessionFile!, "utf8").split(`agentmsg_${stored.cotalId}`)).toHaveLength(2);
			expect(await f.request(holder.client, { type: "get_messages", activeSessionId })).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "custom", customType: "agent_message" }),
				]),
			});
			expect(readFileSync(recordPath, "utf8")).toBe(before);
			expect(
				readFileSync(join(f.agentDir, "ack-disk.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toContainEqual({ id: stored.cotalId, covered: true });
		} finally {
			cleanup.abort();
			rmSync(join(f.agentDir, "hold-turn"), { force: true });
			holder.client.close();
		}
	});
	it("AC-18 fileless rename calls no directory write and logs no failure", async () => {
		const root = tempDir();
		const supervisor = new DaemonSupervisor(join(root, "fileless.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
		});
		const rename = vi.fn(async () => {
			throw new Error("Fileless write must not run");
		});
		const log = vi.fn();
		const internals = supervisor as unknown as {
			mesh: unknown;
			log: typeof log;
			renameMeshSession(id: string, file?: string): Promise<void>;
		};
		internals.mesh = { rename };
		internals.log = log;
		await internals.renameMeshSession("fileless");
		expect(rename).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it.each([
		"holder",
		"other",
		"stopped",
		"partial",
		"publication-race",
		"symlink-standalone",
		"symlink-forwarded",
	] as const)(
		"AC-18 deletes through %s without settling the queued message",
		async (mode) => {
			const f = await meshFixture();
			const socket = join(f.root, "holder.sock");
			let holder = await f.start(socket);
			const other = await f.start(join(f.root, "other.sock"));
			try {
				const target = await f.create(holder, "delete-target");
				const sender = await f.create(other, "sender");
				await f.request(holder.client, { type: "kill", activeSessionId: target.activeSessionId! });
				const meshRoot = join(f.agentDir, "mesh");
				const record = JSON.parse(readFileSync(join(meshRoot, "enrollments", `${target.sessionId}.json`), "utf8"));
				writeFileSync(join(f.agentDir, `hold-pulls-${target.sessionId}`), "held");
				const stored = (await f.request(other.client, {
					type: "mesh_send",
					fromActiveSessionId: sender.activeSessionId!,
					targetSessionId: "delete-target",
					message: "must stay unacknowledged",
				})) as { cotalId: string };
				if (mode === "partial") writeFileSync(join(f.agentDir, "partial-removal"), "armed");
				if (mode === "stopped" || mode === "publication-race") {
					holder.child.kill("SIGKILL");
					await waitForExit(holder.child);
					holder.client.close();
					if (mode === "publication-race") {
						writeFileSync(join(f.agentDir, `pause-publication-${target.sessionId}`), "armed");
						holder = await f.start(socket);
						await meshSignal(holder.child, "publication-paused", target.sessionId);
					}
				}
				const deleting = mode === "holder" || mode === "partial" ? holder : other;
				const isSymlink = mode === "symlink-standalone" || mode === "symlink-forwarded";
				const deletedFile = isSymlink ? join(dirname(target.sessionFile!), "alias.jsonl") : target.sessionFile!;
				if (isSymlink) symlinkSync(target.sessionFile!, deletedFile);
				const command = {
					type: "delete_saved_session" as const,
					sessionPath: deletedFile,
					...(mode === "other" || mode === "symlink-forwarded"
						? { activeSessionId: sender.activeSessionId! }
						: {}),
				};
				const artifact = join(getSessionArtifactPathForFile(target.sessionFile!), "delete-proof");
				mkdirSync(dirname(artifact), { recursive: true });
				writeFileSync(artifact, "keep until delete");
				const paths = [deletedFile, target.sessionFile!, artifact];
				for (const dir of ["directory", "enrollments"]) paths.push(join(meshRoot, dir, `${target.sessionId}.json`));
				const before = paths.map((path) => readFileSync(path));
				const lease = acquireSessionLease(target.sessionFile!, f.agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
				try {
					const context = command.activeSessionId ? { activeSessionId: command.activeSessionId } : { cwd: f.root };
					await expect(deleteDaemonSavedSession(deleting.client, context, deletedFile)).rejects.toThrow(
						"open in another session or process. Close it there first",
					);
					expect(paths.map((path) => readFileSync(path))).toEqual(before);
					for (const stream of ["dm", "dlv"])
						expect(existsSync(join(f.agentDir, `${stream}-${target.sessionId}`))).toBe(true);
				} finally {
					lease?.release();
				}
				expect(await f.request(deleting.client, command)).toMatchObject({ ok: true });
				acquireSessionLease(target.sessionFile!, f.agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" })?.release();
				if (isSymlink) {
					expect(existsSync(deletedFile)).toBe(false);
					expect(existsSync(target.sessionFile!)).toBe(true);
					for (const dir of ["directory", "enrollments"])
						expect(existsSync(join(meshRoot, dir, `${target.sessionId}.json`))).toBe(true);
					for (const stream of ["dm", "dlv"])
						expect(existsSync(join(f.agentDir, `${stream}-${target.sessionId}`))).toBe(true);
					expect(existsSync(join(f.agentDir, "mailbox", `${stored.cotalId}.json`))).toBe(true);
					expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
					return;
				}
				for (const dir of ["directory", "enrollments"])
					expect(existsSync(join(meshRoot, dir, `${target.sessionId}.json`))).toBe(false);
				expect(
					await other.client.request({
						type: "mesh_send",
						fromActiveSessionId: sender.activeSessionId!,
						targetSessionId: "delete-target",
						message: "unknown",
					}),
				).toMatchObject({ success: false, error: expect.stringContaining("Unknown mesh target") });
				if (mode === "other") {
					expect(
						(childDiagnostics.get(other.child)?.stderr ?? "").split(
							JSON.stringify(
								`Mesh session ${target.sessionId}: inbox removal skipped; claimed by another daemon`,
							),
						).length - 1,
					).toBe(1);
					expect(existsSync(join(f.agentDir, `dm-${target.sessionId}`))).toBe(true);
					rmSync(join(f.agentDir, `hold-pulls-${target.sessionId}`));
					writeFileSync(join(f.agentDir, "mailbox", "trigger"), "event");
					await meshSignal(holder.child, "removed", target.sessionId);
				}
				if (mode === "stopped") {
					holder = await f.start(socket);
					for (const dir of ["directory", "enrollments"])
						expect(existsSync(join(meshRoot, dir, `${target.sessionId}.json`))).toBe(false);
				}
				if (mode === "publication-race") {
					rmSync(join(f.agentDir, `pause-publication-${target.sessionId}`));
					await meshSignal(holder.child, "log", `Mesh session ${target.sessionId}:`);
					expect(existsSync(join(meshRoot, "directory", `${target.sessionId}.json`))).toBe(false);
				} else {
					const removals = readFileSync(join(f.agentDir, "removals.jsonl"), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line));
					const order = readFileSync(join(f.agentDir, "cleanup-order.jsonl"), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
						.filter((event) => event.id === target.sessionId)
						.map((event) => event.type);
					expect(order).toEqual(mode === "stopped" ? ["remove"] : ["stop", "remove"]);
					if (mode === "partial")
						expect(
							(childDiagnostics.get(holder.child)?.stderr ?? "").split(
								`Mesh session ${target.sessionId}: inbox removal failed`,
							).length - 1,
						).toBe(1);
					expect(removals).toEqual([
						{ sessionId: target.sessionId, identity: record.identity.id, uid: record.lifecycleUid },
					]);
					expect(existsSync(join(f.agentDir, `dm-${target.sessionId}`))).toBe(false);
					expect(existsSync(join(f.agentDir, `dlv-${target.sessionId}`))).toBe(mode === "partial");
					if (mode === "holder" || mode === "other" || mode === "partial")
						await meshSignal(holder.child, "endpoint-stopped", target.sessionId);
				}
				expect(existsSync(join(f.agentDir, "mailbox", `${stored.cotalId}.json`))).toBe(true);
				expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
				const claim = claimEnrollment(meshRoot, target.sessionId, target.sessionFile!);
				claim.release();
			} finally {
				holder.client.close();
				other.client.close();
			}
		},
		// test-policy: allow explicit-test-timeout -- AC-18 starts two supervisors and two workers per row (15.5 s alone); fork-pr-check runs five files in parallel, so the 30 s default expired under load. The timer only bounds failure; every wait awaits a concrete event.
		60_000,
	);

	it("AC-22 keeps one transcript entry when the supervisor dies after persistence before ack", async () => {
		const f = await meshFixture();
		const socket = join(f.root, "holder.sock");
		let holder = await f.start(socket);
		try {
			const sender = await f.create(holder, "sender");
			const target = await f.create(holder, "target");
			writeFileSync(join(f.agentDir, "kill-before-ack"), "armed");
			const stored = (await f.request(holder.client, {
				type: "mesh_send",
				fromActiveSessionId: sender.activeSessionId!,
				targetSessionId: target.sessionId,
				message: "stable across ack loss",
			})) as { id: string; cotalId: string };
			await meshSignal(holder.child, "before-ack", stored.cotalId);
			await waitForExit(holder.child);
			holder.client.close();
			const copies = () =>
				readFileSync(target.sessionFile!, "utf8")
					.split("\n")
					.filter((line) => line.includes(stored.id));
			expect(copies()).toHaveLength(1);
			expect(existsSync(join(f.agentDir, "acks.jsonl"))).toBe(false);
			rmSync(join(f.agentDir, "kill-before-ack"));
			holder = await f.start(socket);
			await meshSignal(holder.child, "ack", stored.cotalId);
			await f.request(holder.client, { type: "wait_for_idle", activeSessionId: target.activeSessionId! });
			expect(copies()).toHaveLength(1);
			expect(
				readFileSync(join(f.agentDir, "acks.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).id),
			).toEqual([stored.cotalId]);
		} finally {
			holder.client.close();
		}
	});

	it.each(["saved", "live", "other", "live-saved", "directory-error"] as const)(
		"AC-25 changes directory addressing after a %s rename and holder restart",
		async (path) => {
			const f = await meshFixture();
			const socket = join(f.root, "holder.sock");
			let holder = await f.start(socket);
			const other = await f.start(join(f.root, "other.sock"));
			try {
				const target = await f.create(holder, "old-name");
				const sender = await f.create(other, "sender");
				if (path === "saved")
					await f.request(holder.client, { type: "kill", activeSessionId: target.activeSessionId! });
				const before = JSON.parse(
					readFileSync(join(f.agentDir, "mesh", "directory", `${target.sessionId}.json`), "utf8"),
				);
				if (path === "directory-error")
					writeFileSync(
						join(f.agentDir, "mesh", "directory", `${target.sessionId}.json`),
						"private-json-fragment",
					);
				await f.request(
					path === "other" ? other.client : holder.client,
					path === "live"
						? { type: "set_session_name", activeSessionId: target.activeSessionId!, name: "new-name" }
						: {
								type: "rename_saved_session",
								sessionPath: target.sessionFile!,
								name: "new-name",
								...(path === "live-saved" ? { activeSessionId: target.activeSessionId! } : {}),
							},
				);
				if (path === "directory-error") {
					expect((await readSessionInfo(target.sessionFile!))?.name).toBe("new-name");
					await meshSignal(holder.child, "log", target.sessionId);
					expect(childDiagnostics.get(holder.child)?.stderr).not.toContain("private-json-fragment");
					return;
				}
				const entry = JSON.parse(
					readFileSync(join(f.agentDir, "mesh", "directory", `${target.sessionId}.json`), "utf8"),
				);
				expect(entry).toEqual({ ...before, name: "new-name" });
				const send = (name: string) =>
					other.client.request({
						type: "mesh_send",
						fromActiveSessionId: sender.activeSessionId!,
						targetSessionId: name,
						message: "renamed target",
					});
				for (const restart of [false, true]) {
					if (restart) {
						holder.child.kill("SIGKILL");
						await waitForExit(holder.child);
						holder.client.close();
						holder = await f.start(socket);
					}
					expect(await send("old-name")).toMatchObject({
						success: false,
						error: expect.stringContaining("Unknown mesh target"),
					});
					const response = await send("new-name");
					expect(response.success).toBe(true);
					if (!response.success) throw new Error(response.error);
					const stored = response.data as { id: string; cotalId: string };
					await meshSignal(holder.child, "ack", stored.cotalId);
					expect(
						readFileSync(target.sessionFile!, "utf8")
							.split("\n")
							.filter((line) => line.includes(stored.id)),
					).toHaveLength(1);
				}
			} finally {
				holder.client.close();
				other.client.close();
			}
		},
	);

	beforeEach(() => vi.stubEnv(ENV_AGENT_DIR, tempDir())); // Supervisor logs follow this variable.
	afterEach(() => vi.unstubAllEnvs());
	it("publishes a stored mesh receipt to any directory target, rejects self and hands off a parent message without awaiting enrollment", async () => {
		const root = tempDir();
		const socketPath = join(root, "mesh.sock");
		const supervisor = new DaemonSupervisor(socketPath, { defaultSessionConfig: { agentDir: root, cwd: root } });
		const internals = supervisor as unknown as {
			mesh: unknown;
			workers: Map<string, unknown>;
			roster(): AgentRoster;
			handoffMeshMessage(
				record: { sessionFile: string; sessionId: string },
				message: unknown,
				count: number,
				bind: (recipient: object) => void,
				open: () => boolean,
				attemptToken: string,
			): Promise<void>;
			cleanupSupervisorResources(): Promise<void>;
		};
		await supervisor.start();
		const client = new DaemonClient(socketPath);
		let releaseEnrollment!: () => void;
		const enrolling = new Promise<void>((resolveEnroll) => {
			releaseEnrollment = resolveEnroll;
		});
		const send = vi.fn(async () => ({ deliveryStatus: "stored", cotalId: "published", sequence: 42 }));
		const enroll = vi.fn(() => enrolling);
		internals.mesh = {
			send,
			resolveAddress: (selector: string) => {
				if (selector === "missing" || selector === "ambiguous")
					throw new Error(`Message was not stored: ${selector} target`);
				return selector;
			},
			enroll,
			reconcileDeletedChildren: async () => undefined,
			start: async () => undefined,
			stop: async () => undefined,
			directoryEntryForPrincipal: () => ({ sessionId: "parent", name: "parent" }),
		};
		const requestWorker = vi.fn(async (_command: unknown, _timeout: number) => ({ success: true }));
		const recipient = { requestWorker };
		const targetFile = join(root, "target.jsonl");
		const parentFile = join(root, "parent.jsonl");
		writeFileSync(targetFile, "{}");
		const sourceSummary = {
			id: "source",
			activeSessionId: "source",
			sessionId: "parent",
			sessionFile: parentFile,
			cwd: root,
			rlmDepth: 0,
		};
		const targetSummary = {
			id: "target",
			activeSessionId: "target",
			sessionId: "child",
			sessionFile: targetFile,
			cwd: root,
			rlmDepth: 1,
			parentSessionId: "parent",
		};
		const worker = {
			descriptor: {
				workerId: "w",
				rootActiveSessionId: "source",
				lifecycle: "ready",
				createCommand: { type: "create" },
			},
			client: recipient,
			meshDeliveryCapable: true,
			meshReplacementCapable: true,
			summaries: new Map([
				["source", sourceSummary],
				["target", targetSummary],
			]),
		};
		internals.workers.set("w", worker);
		for (const summary of [
			sourceSummary,
			targetSummary,
			{
				...targetSummary,
				id: "stranger",
				activeSessionId: "stranger",
				sessionId: "stranger",
				sessionFile: join(root, "stranger.jsonl"),
				parentSessionId: "another",
			},
		])
			internals.roster().write({ agentId: summary.id, summary } as never, "w");
		const message = {
			id: "incoming",
			from: { id: "local.parent", name: "parent" },
			parts: [{ kind: "text", text: " hello " }],
		};
		try {
			await client.connect();
			const command = {
				type: "mesh_send",
				fromActiveSessionId: "source",
				targetSessionId: "child",
				message: " hello ",
			} as const;
			expect(await client.request(command)).toMatchObject({
				success: true,
				data: { deliveryStatus: "stored", cotalId: "published", sequence: 42 },
			});
			expect(send).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ sessionId: "parent" }),
				"child",
				"hello",
			);
			expect(await client.request({ ...command, targetSessionId: "parent" })).toMatchObject({
				success: false,
				error: expect.stringContaining("cannot target the sending session"),
			});
			expect(await client.request({ ...command, targetSessionId: "stranger" })).toMatchObject({ success: true });
			expect(send).toHaveBeenCalledTimes(2);
			for (const targetSessionId of ["missing", "ambiguous"])
				expect(await client.request({ ...command, targetSessionId })).toMatchObject({
					success: false,
					error: expect.stringContaining("Message was not stored:"),
				});
			expect(send).toHaveBeenCalledTimes(2);
			const bind = vi.fn();
			await internals.handoffMeshMessage(
				{ sessionFile: targetFile, sessionId: "child" },
				message,
				2,
				bind,
				() => true,
				"attempt",
			);
			expect(bind).toHaveBeenCalledExactlyOnceWith(recipient);
			expect(requestWorker).toHaveBeenCalledExactlyOnceWith(
				{
					type: "worker_deliver_message",
					targetActiveSessionId: "target",
					message: "hello",
					sender: { sessionId: "parent", sessionName: "parent", clientId: "local.parent" },
					fromRelationship: "parent",
					cotal: { id: "incoming", deliveryCount: 2, attemptToken: "attempt" },
				},
				86_400_000,
			);
			expect(enroll).toHaveBeenCalledExactlyOnceWith("parent", parentFile);
			const catalog = (supervisor as unknown as { catalog: { list: () => Promise<unknown[]> } }).catalog;
			const scan = vi.spyOn(catalog, "list").mockRejectedValue(new Error("catalog unavailable"));
			await internals.handoffMeshMessage(
				{ sessionFile: targetFile, sessionId: "child" },
				message,
				2,
				bind,
				() => true,
				"attempt",
			);
			expect(scan).not.toHaveBeenCalled();
			const resolver = vi.spyOn(
				internals.mesh as { directoryEntryForPrincipal: () => { sessionId: string; name: string } | undefined },
				"directoryEntryForPrincipal",
			);
			for (const lookup of ["unresolved", "error"]) {
				resolver.mockReturnValue(undefined);
				if (lookup === "error") {
					resolver.mockImplementation(() => {
						throw new Error("directory unavailable");
					});
				}
				await internals.handoffMeshMessage(
					{ sessionFile: targetFile, sessionId: "child" },
					message,
					2,
					bind,
					() => true,
					"attempt",
				);
				expect(requestWorker.mock.calls.at(-1)?.[0]).toMatchObject({
					fromRelationship: undefined,
					sender: { sessionId: undefined, sessionName: "parent" },
				});
			}
			expect(requestWorker).toHaveBeenCalledTimes(4);
			resolver.mockReturnValue(undefined);
			await expect(
				internals.handoffMeshMessage(
					{ sessionFile: targetFile, sessionId: "child" },
					message,
					2,
					bind,
					() => false,
					"attempt",
				),
			).rejects.toThrow("closed before handoff");
			expect(requestWorker).toHaveBeenCalledTimes(4);
			resolver.mockRestore();
			scan.mockRestore();
			expect(enroll).toHaveBeenCalledTimes(5);
		} finally {
			releaseEnrollment();
			client.close();
			internals.workers.clear();
			await internals.cleanupSupervisorResources();
		}
	});

	it("F12 F14 enrolls queued-to-bound and adopted children, with direct reopen and one failure log on launch", async () => {
		const root = tempDir();
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
		});
		const summary = { id: "a", activeSessionId: "a", sessionId: "saved", sessionFile: "saved.jsonl" };
		const worker = {
			descriptor: {
				workerId: "w",
				rootActiveSessionId: "a",
				rootSessionId: "saved",
				lifecycle: "ready",
				sessionFile: "saved.jsonl",
				createCommand: { type: "create" },
			},
			summaries: new Map([["a", summary]]),
			client: {},
		};
		const internals = supervisor as unknown as {
			mesh: unknown;
			workers: Map<string, unknown>;
			log(message: string): void;
			roster(): unknown;
			writeRosterEntry(entry: unknown, worker?: unknown, label?: undefined, queueMeshEnrollment?: boolean): unknown;
			enrollMeshSession(sessionId: string, file?: string): Promise<void>;
			seedRosterLedger(): Promise<void>;
			applyWorkerRosterSnapshot(worker: unknown, delta: unknown): Promise<void>;
			rlmSpawnLedger(): unknown;
			hydratedSeedEntry(entry: unknown): Promise<unknown>;
			reuseWorkerForCreate(worker: unknown, owner: undefined, path: string): Promise<unknown>;
		};
		const enroll = vi
			.fn()
			.mockRejectedValueOnce(new Error("child refused"))
			.mockRejectedValueOnce(new Error("provisioning refused"))
			.mockResolvedValue(undefined);
		const roster = new AgentRoster((path) => path);
		internals.roster = () => roster;
		internals.writeRosterEntry({ agentId: "a", summary }, worker);
		const enqueueEnrollment = vi.fn((id: string, file?: string) => enroll(id, file));
		internals.mesh = { enroll, enqueueEnrollment };
		internals.log = vi.fn();
		internals.workers.set("w", worker);
		const child = {
			agentId: "child",
			summary: {
				...summary,
				id: "child",
				sessionId: "child-saved",
				sessionFile: "child.jsonl",
				runtimeKind: "subagent",
				parentActiveSessionId: "a",
			},
		};
		internals.writeRosterEntry(
			{ ...child, queuedChild: true, summary: { ...child.summary, sessionFile: undefined } },
			worker,
		);
		expect(enroll).not.toHaveBeenCalled();
		for (let n = 0; n < 3; n++) {
			internals.writeRosterEntry(child, worker);
			internals.writeRosterEntry({ agentId: "a", summary }, worker);
		}
		expect(enroll).toHaveBeenCalledExactlyOnceWith("child-saved", "child.jsonl");
		await expect(internals.reuseWorkerForCreate(worker, undefined, "saved.jsonl")).resolves.toBe(worker);
		expect(internals.log).toHaveBeenCalledWith(
			expect.stringContaining("Mesh session child-saved: enrollment failed: Error: child refused"),
		);
		expect(internals.log).toHaveBeenCalledWith(expect.stringContaining("provisioning refused"));
		internals.writeRosterEntry(child, worker);
		expect(enroll).toHaveBeenCalledTimes(2);
		await internals.reuseWorkerForCreate(worker, undefined, "saved.jsonl");
		expect(enroll).toHaveBeenCalledTimes(3);
		expect(enroll).toHaveBeenLastCalledWith("saved", "saved.jsonl");
		const movedChild = { ...child, summary: { ...child.summary, sessionFile: "child-next.jsonl" } };
		internals.writeRosterEntry(movedChild, worker);
		expect(enqueueEnrollment).toHaveBeenLastCalledWith("child-saved", "child-next.jsonl");
		internals.writeRosterEntry({ ...movedChild, summary: { ...movedChild.summary, sessionId: "switched" } }, worker);
		expect(enqueueEnrollment).toHaveBeenLastCalledWith("switched", "child-next.jsonl");
		expect(enqueueEnrollment).toHaveBeenCalledTimes(3);
		internals.rlmSpawnLedger = () => ({
			liveEdges: async () => [{ parent: "saved.jsonl", child: "adopted.jsonl", depth: 1, childId: "adopted" }],
		});
		internals.hydratedSeedEntry = async (entry) => entry;
		await internals.seedRosterLedger();
		expect(enqueueEnrollment).toHaveBeenLastCalledWith("adopted", "adopted.jsonl");
		internals.rlmSpawnLedger = () => ({
			liveEdges: async () => [{ parent: "saved.jsonl", child: "snapshot.jsonl", depth: 1, childId: "snapshot" }],
		});
		enqueueEnrollment.mockClear();
		await internals.applyWorkerRosterSnapshot(worker, {
			type: "roster_delta",
			snapshot: true,
			entries: [{ agentId: "a", summary }],
		});
		expect(enqueueEnrollment).toHaveBeenCalledExactlyOnceWith("snapshot", "snapshot.jsonl");
		const passive = roster.bySessionFile("snapshot.jsonl")!;
		expect(passive.summary).toMatchObject({ sessionId: "snapshot", sessionFile: "snapshot.jsonl" });
		internals.writeRosterEntry({ ...passive, summary: { ...passive.summary, isSessionActive: true } }, worker);
		expect(enqueueEnrollment).toHaveBeenCalledTimes(1);
		enqueueEnrollment.mockClear();
		enroll.mockClear().mockRejectedValue(new Error("launch refused"));
		vi.mocked(internals.log).mockClear();
		roster.delete("a");
		for (let attempt = 0; attempt < 2; attempt++) {
			internals.writeRosterEntry({ agentId: "a", summary }, worker, undefined, false);
			await internals.enrollMeshSession(summary.sessionId, summary.sessionFile);
		}
		expect(enqueueEnrollment).not.toHaveBeenCalled();
		expect(enroll).toHaveBeenCalledTimes(2);
		expect(internals.log).toHaveBeenCalledTimes(2);
		for (const [message] of vi.mocked(internals.log).mock.calls) expect(message).toContain("launch refused");
		let release!: () => void;
		enroll.mockImplementationOnce(
			() =>
				new Promise<void>((resolveEnroll) => {
					release = resolveEnroll;
				}),
		);
		let reused = false;
		const opening = internals.reuseWorkerForCreate(worker, undefined, "saved.jsonl").then(() => {
			reused = true;
		});
		try {
			await Promise.resolve();
			expect(reused).toBe(true);
		} finally {
			release();
			await opening;
		}
	});

	it.each(["shutdown", "reject-shutdown", "cleanup"])("orders mesh stop and teardown (%s)", async (mode) => {
		const root = tempDir();
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
		});
		const internals = supervisor as unknown as {
			mesh: unknown;
			shuttingDown: boolean;
			workers: Map<string, unknown>;
			clients: Set<unknown>;
			descriptorDir: string;
			stopWorker(): Promise<void>;
			log(message: string): void;
			cleanupSupervisorResources(): Promise<void>;
			shutdown(
				code: number,
				stopWorkers: boolean,
				relaunch: boolean,
				force: boolean,
				reason: "shutdown",
			): Promise<never>;
		};
		const events: string[] = [];
		let finish: () => void = () => undefined;
		mkdirSync(internals.descriptorDir, { recursive: true });
		internals.mesh = {
			stop: async () => {
				events.push("mesh-start");
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				events.push("mesh-finished");
				if (mode !== "shutdown") throw new Error("mesh stop failed");
			},
		};
		if (mode !== "shutdown") {
			internals.log = () => {
				throw new Error("log sink failed");
			};
			vi.spyOn(console, "error").mockImplementation(() => undefined);
		}
		if (mode !== "cleanup") internals.workers.set("worker", {});
		internals.stopWorker = async () => {
			events.push("worker-stop");
		};
		const destroy = vi.fn();
		internals.clients.add({
			id: "test",
			attachedActiveSessionIds: new Set(),
			detachInput: vi.fn(),
			socket: {
				write: (data: string) => {
					events.push(JSON.parse(data).type);
				},
				end: vi.fn(),
				destroy,
			},
		});
		const exited = new Error("isolated exit");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exited;
		});
		const stopped =
			mode === "cleanup"
				? internals.cleanupSupervisorResources()
				: internals.shutdown(0, true, false, false, "shutdown");
		try {
			expect(internals.shuttingDown).toBe(true);
			expect(events).toEqual(["mesh-start"]);
			finish();
			if (mode === "cleanup") {
				await stopped;
				expect(destroy).toHaveBeenCalledTimes(1);
			} else {
				await expect(stopped).rejects.toBe(exited);
				expect(events).toEqual(["mesh-start", "mesh-finished", "daemon_closing", "worker-stop"]);
			}
		} finally {
			finish();
			await stopped.catch(() => undefined);
			exit.mockRestore();
			vi.restoreAllMocks();
		}
	});

	it.each([true, false, undefined, "legacy-replacement"] as const)(
		"guards native and mesh compatibility for origin=%s",
		checkWorkerCompatibility,
	);

	async function checkWorkerCompatibility(origin: boolean | undefined | "legacy-replacement") {
		const agentOrigin = typeof origin === "boolean" ? origin : origin === "legacy-replacement" ? true : undefined;
		const root = tempDir();
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
		});
		const confirm = vi.fn();
		const dropped = vi.fn();
		const publish = vi.fn();
		const recipient = { requestWorker: vi.fn() };
		const worker = {
			client: recipient,
			meshDeliveryCapable: origin === "legacy-replacement",
			meshReplacementCapable: origin !== "legacy-replacement",
			descriptor: { workerId: "worker" },
		};
		const internals = supervisor as unknown as {
			mesh: unknown;
			shuttingDown: boolean;
			clearRosterStaleness(): void;
			createOrReuseWorker(): Promise<unknown>;
			handoffMeshMessage(
				record: { sessionFile: string; sessionId: string },
				message: unknown,
				count: number,
				bind: (recipient: object) => void,
				open: () => boolean,
				attemptToken: string,
			): Promise<void>;
			findWorkerForClient(): Promise<unknown>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			handleWorkerFrame(worker: unknown, frame: unknown, source: unknown): void;
		};
		internals.mesh = { confirmPersisted: confirm, confirmDropped: dropped, send: publish };
		internals.clearRosterStaleness = () => undefined;
		internals.findWorkerForClient = async () => ({
			worker,
			summary: { id: "a", sessionId: "a", sessionFile: "a.jsonl" },
		});
		await expect(
			internals.handleCommand({} as DaemonSocketClient, {
				type: "send_message",
				targetActiveSessionId: "b",
				message: "hello",
				agentOrigin,
			}),
		).rejects.toThrow(
			agentOrigin === true
				? "restart that session"
				: 'agent messages from daemon clients are not supported while agentMessageTransport is "cotal"',
		);
		await expect(
			internals.handleCommand({} as DaemonSocketClient, {
				type: "mesh_send",
				fromActiveSessionId: "a",
				targetSessionId: "b",
				message: "hello",
			}),
		).rejects.toThrow("restart that session");
		expect(publish).not.toHaveBeenCalled();
		internals.createOrReuseWorker = async () => worker;
		const legacyFile = join(root, "a.jsonl");
		writeFileSync(legacyFile, "{}");
		const bind = vi.fn();
		await expect(
			internals.handoffMeshMessage(
				{ sessionFile: legacyFile, sessionId: "a" },
				{ id: "legacy", from: { id: "local.sender", name: "sender" }, parts: [{ kind: "text", text: "hello" }] },
				1,
				bind,
				() => true,
				"attempt",
			),
		).rejects.toThrow("Restart that session");
		expect(bind).not.toHaveBeenCalled();
		expect(recipient.requestWorker).not.toHaveBeenCalled();
		const frame = {
			header: { kind: "outbound", outboundType: "agent_message_persisted" },
			payload: Buffer.from(
				JSON.stringify({ type: "agent_message_persisted", cotalId: "message", attemptToken: "attempt" }),
			),
		};
		internals.handleWorkerFrame(worker, frame, recipient);
		expect(confirm).not.toHaveBeenCalled();
		worker.meshDeliveryCapable = true;
		worker.meshReplacementCapable = true;
		internals.handleWorkerFrame(worker, frame, {});
		expect(confirm).not.toHaveBeenCalled();
		internals.shuttingDown = true;
		internals.handleWorkerFrame(worker, frame, recipient);
		expect(confirm).not.toHaveBeenCalled();
		internals.shuttingDown = false;
		internals.handleWorkerFrame(worker, frame, recipient);
		expect(confirm).toHaveBeenCalledExactlyOnceWith("message", recipient, "attempt");
		const drop = {
			header: { kind: "outbound", outboundType: "agent_message_dropped" },
			payload: Buffer.from(
				JSON.stringify({
					type: "agent_message_dropped",
					cotalId: "message",
					attemptToken: "attempt",
					reason: "cleared",
				}),
			),
		};
		worker.meshDeliveryCapable = false;
		internals.handleWorkerFrame(worker, drop, recipient);
		worker.meshDeliveryCapable = true;
		internals.handleWorkerFrame(worker, drop, {});
		internals.shuttingDown = true;
		internals.handleWorkerFrame(worker, drop, recipient);
		internals.shuttingDown = false;
		internals.handleWorkerFrame(
			worker,
			{
				...drop,
				payload: Buffer.from(
					JSON.stringify({
						type: "agent_message_dropped",
						cotalId: "message",
						attemptToken: "attempt",
						reason: "invalid",
					}),
				),
			},
			recipient,
		);
		expect(dropped).not.toHaveBeenCalled();
		for (const reason of ["cleared", "closed", "other"]) {
			internals.handleWorkerFrame(
				worker,
				{
					...drop,
					payload: Buffer.from(
						JSON.stringify({
							type: "agent_message_dropped",
							cotalId: "message",
							attemptToken: "attempt",
							reason,
						}),
					),
				},
				recipient,
			);
			expect(dropped).toHaveBeenLastCalledWith("message", recipient, reason, "attempt");
		}
		expect(dropped).toHaveBeenCalledTimes(3);
	}
});
