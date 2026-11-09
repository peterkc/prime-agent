import * as cp from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryDaemon } from "../src/cli/repository-daemon.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonCommandNotSentError } from "../src/modes/daemon/daemon-client.js";

const daemonClientMock = vi.hoisted(() => {
	type Listener = (message: { type: string; activeSessionId?: string; event?: { type: string } }) => void;
	type CloseListener = (error: Error) => void;
	type Command = {
		type: string;
		name?: string;
		activeSessionId?: string;
		targetActiveSessionId?: string;
		fromActiveSessionId?: string;
		deliveryMode?: string;
		message?: string;
		schedule?: string;
		prompt?: string;
		includeInactive?: boolean;
		all?: boolean;
		sessionPath?: string;
		config?: {
			extensionFlagValues?: Record<string, boolean | string>;
			initialGoal?: { objective: string; tokenBudget?: number };
		};
	};
	type Response =
		| { type: "response"; command: string; success: true; data?: unknown }
		| { type: "response"; command: string; success: false; error: string; errorInfo?: { code: string } };

	const instances: MockDaemonClient[] = [];
	const behavior = {
		promptSucceeds: false,
		emitStaleAgentEndOnAttach: false,
		connectFails: false,
		sessions: [] as Array<Record<string, unknown>>,
		savedSessions: [] as Array<Record<string, unknown>>,
		deleteError: undefined as string | undefined,
		deleteResult: { ok: true, method: "trash" } as { ok: boolean; method?: string; error?: string },
		/** Optional live-session summary returned by the mocked create request. */
		createdSession: undefined as Record<string, unknown> | undefined,
		notifyCapable: true,
		notifyData: undefined as unknown,
		notifyError: undefined as Error | undefined,
		notifyEnvelopeFailure: undefined as Extract<Response, { success: false }> | undefined,
	};

	class MockDaemonClient {
		readonly messageListeners = new Set<Listener>();
		readonly closeListeners = new Set<CloseListener>();
		readonly requests: Command[] = [];
		readonly notifyRequests: Array<{ timeoutMs?: number; options?: { recoverable?: boolean } }> = [];

		async waitForHello() {
			return {
				protocol: { name: "prime-agent.daemon", version: 7 },
				schemaRevision: behavior.notifyCapable ? 37 : 36,
				serverCapabilities: behavior.notifyCapable ? ["mesh_notify"] : ["session_move"],
			};
		}
		messageListenerCountAtClose: number | undefined;
		closeListenerCountAtClose: number | undefined;

		constructor(readonly socketPath: string) {
			instances.push(this);
		}

		async connect(): Promise<void> {
			if (behavior.connectFails) throw new Error("mock connect failed");
		}

		async request(command: Command, timeoutMs?: number, options?: { recoverable?: boolean }): Promise<Response> {
			this.requests.push(command);
			if (command.type === "mesh_notify") {
				this.notifyRequests.push({ timeoutMs, options });
				if (behavior.notifyError) throw behavior.notifyError;
				if (behavior.notifyEnvelopeFailure) return behavior.notifyEnvelopeFailure;
				return { type: "response", command: command.type, success: true, data: behavior.notifyData };
			}
			if (command.type === "list") {
				return { type: "response", command: command.type, success: true, data: { sessions: behavior.sessions } };
			}
			if (command.type === "list_saved_sessions")
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { sessions: behavior.savedSessions },
				};
			if (command.type === "delete_saved_session") {
				if (behavior.deleteError)
					return { type: "response", command: command.type, success: false, error: behavior.deleteError };
				if (behavior.deleteResult.ok)
					behavior.savedSessions = behavior.savedSessions.filter(
						(session) => session.path !== command.sessionPath,
					);
				return { type: "response", command: command.type, success: true, data: behavior.deleteResult };
			}
			if (command.type === "create" && behavior.createdSession !== undefined) {
				return { type: "response", command: command.type, success: true, data: behavior.createdSession };
			}
			if (command.type === "attach" && behavior.emitStaleAgentEndOnAttach) {
				this.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });
			}
			if (command.type === "prompt") {
				if (behavior.promptSucceeds) {
					return { type: "response", command: command.type, success: true };
				}
				return { type: "response", command: command.type, success: false, error: "prompt failed" };
			}
			return { type: "response", command: command.type, success: true };
		}

		onMessage(listener: Listener): () => void {
			this.messageListeners.add(listener);
			return () => {
				this.messageListeners.delete(listener);
			};
		}

		onClose(listener: CloseListener): () => void {
			this.closeListeners.add(listener);
			return () => {
				this.closeListeners.delete(listener);
			};
		}

		emitMessage(message: Parameters<Listener>[0]): void {
			for (const listener of [...this.messageListeners]) {
				listener(message);
			}
		}

		close(): void {
			this.messageListenerCountAtClose = this.messageListeners.size;
			this.closeListenerCountAtClose = this.closeListeners.size;
			for (const listener of [...this.closeListeners]) {
				listener(new Error("closed"));
			}
		}
	}

	return { MockDaemonClient, behavior, instances };
});

vi.mock("../src/modes/daemon/daemon-client.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DaemonClient: daemonClientMock.MockDaemonClient,
}));

const spawnMock = vi.hoisted(() => {
	const calls: string[][] = [];
	return {
		calls,
		mockSpawn: (...args: unknown[]) => {
			calls.push(args[1] as string[]);
			return {
				unref: () => {},
				kill: () => {},
				pid: 99999,
				stdout: null,
				stderr: null,
				stdin: null,
				on: () => {},
				once: () => {},
			};
		},
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return { ...original, spawn: spawnMock.mockSpawn as never };
});

import { getCommandSpec } from "../src/cli/command-registry.js";
import { handleDaemonCommand } from "../src/cli/daemon-command.js";

describe("daemon command", () => {
	const notifyArgs = ["daemon", "notify", "--daemon-socket", "/tmp/notify.sock"];
	const receipt = {
		id: "agentmsg_one",
		source: "agent_message",
		target: { activeSessionId: "b", sessionId: "b" },
		from: { sessionName: "gate-watcher", clientId: "local.sender" },
		message: "hello",
		deliveryStatus: "stored",
		sequence: 1,
		cotalId: "one",
	};

	it.each<[string, string, string?, string?]>([
		["stored", "stored"],
		["failed", "failed"],
		["unknown", "unknown"],
		["timeout", "unknown"],
		["close", "unknown"],
		["malformed", "unknown"],
		["bad-receipt", "unknown"],
		["journal", "unknown", "mesh_notify", "command_result_uncertain"],
		["update_restarting", "failed", "mesh_notify", "update_restarting"],
		["command_not_dispatched", "failed", "mesh_notify", "command_not_dispatched"],
		["dispatch", "failed", "dispatch"],
		["parse", "failed", "parse"],
		["wrong-label-not-dispatched", "unknown", "list", "command_not_dispatched"],
		["wrong-label-restarting", "unknown", "list", "update_restarting"],
		["unrecognized", "unknown", "mesh_notify", "unrecognized"],
		["untyped", "unknown", "mesh_notify"],
		["not-sent", "failed"],
		["old-daemon", "failed"],
		["connect", "failed"],
	])("mesh-notify JSON and exit code for %s", async (outcome, expected, command, code) => {
		daemonClientMock.behavior.notifyData =
			outcome === "stored"
				? { outcome, receipt }
				: outcome === "bad-receipt"
					? { outcome: "stored", receipt: { sequence: "1" } }
					: ["failed", "unknown"].includes(outcome)
						? { outcome, error: "visible reason" }
						: null;
		if (outcome === "timeout" || outcome === "close") daemonClientMock.behavior.notifyError = new Error(outcome);
		if (command)
			daemonClientMock.behavior.notifyEnvelopeFailure = {
				type: "response",
				command,
				success: false,
				error: "shutting down; retry the command",
				...(code ? { errorInfo: { code } } : {}),
			};
		if (outcome === "not-sent")
			daemonClientMock.behavior.notifyError = new DaemonCommandNotSentError("not connected");
		if (outcome === "old-daemon") daemonClientMock.behavior.notifyCapable = false;
		if (outcome === "connect") daemonClientMock.behavior.connectFails = true;
		const spawns = spawnMock.calls.length;
		await handleDaemonCommand([...notifyArgs, "--json", "b", "--", "hello"]);
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(console.error).not.toHaveBeenCalled();
		const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0]));
		expect(printed.outcome).toBe(expected);
		if (expected === "stored") expect(printed).toEqual({ outcome: "stored", receipt });
		else if (outcome === "old-daemon")
			expect(printed.error).toContain(
				"The running Prime Agent daemon does not support mesh_notify; restart the daemon",
			);
		else expect(printed.error).toEqual(expect.any(String));
		expect(process.exitCode).toBe(expected === "stored" ? 0 : expected === "failed" ? 1 : 2);
		const client = daemonClientMock.instances[0]!;
		expect(client.requests).toHaveLength(outcome === "old-daemon" || outcome === "connect" ? 0 : 1);
		if (client.requests.length)
			expect(client.notifyRequests).toEqual([{ timeoutMs: 35_000, options: { recoverable: false } }]);
		expect(spawnMock.calls).toHaveLength(spawns);
	});

	it.each([
		["--json", "--json", "b", "--", "hello"],
		["--daemon-socket", "a", "--daemon-socket", "b", "--json", "b", "--", "hello"],
		["--json", "b", "--from", "a", "--", "hello"],
		["--json", "--bogus", "b", "--", "hello"],
		["--json", "b", "extra", "--", "hello"],
		["--json", "--", "hello"],
		["--json", "b", "hello"],
		["--json", "b", "--", " "],
		["--json", "*", "--", "hello"],
		["--json", "b", "--", "x".repeat(16385)],
	])("mesh-notify rejects usage before connecting %#", async (...args) => {
		await handleDaemonCommand(["daemon", "notify", ...args]);
		expect(process.exitCode).toBe(1);
		expect(daemonClientMock.instances).toHaveLength(0);
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0])).outcome).toBe("failed");
		expect(String(vi.mocked(console.log).mock.calls[0]![0])).not.toContain("Message was not stored:");
	});

	it.each(["stored", "failed", "unknown"])(
		"mesh-notify human %s uses the right stream and preserves literal --json",
		async (outcome) => {
			daemonClientMock.behavior.notifyData =
				outcome === "stored" ? { outcome, receipt } : { outcome, error: "visible reason" };
			await handleDaemonCommand([...notifyArgs, "b", "--", "--json", "literal"]);
			const client = daemonClientMock.instances[0]!;
			expect(client.requests).toEqual([{ type: "mesh_notify", target: "b", message: "--json literal" }]);
			expect(console[outcome === "stored" ? "log" : "error"]).toHaveBeenCalledExactlyOnceWith(
				outcome === "stored" ? "Stored for b" : "visible reason",
			);
			expect(console[outcome === "stored" ? "error" : "log"]).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(outcome === "stored" ? 0 : outcome === "failed" ? 1 : 2);
		},
	);

	// Table-driven argv parsing: every row runs `daemon --socket <socket> <argv>` and pins the first
	// request the CLI puts on the wire.
	it.each([
		[
			"keeps the create session name after an unknown boolean extension flag",
			["create", "--unknown-typo", "my-session"],
			{ type: "create", name: "my-session", config: { extensionFlagValues: { "unknown-typo": true } } },
		],
		[
			"parses extension flag values with equals without consuming the create name",
			["create", "--ticket=123", "my-session"],
			{ type: "create", name: "my-session", config: { extensionFlagValues: { ticket: "123" } } },
		],
		[
			"keeps bare --resume values as session id selectors",
			["create", "--resume", "abc123"],
			{ type: "create", sessionPath: "abc123" },
		],
		[
			"passes --goal and --goal-token-budget to the create config",
			["create", "--goal", "Write tests", "--goal-token-budget", "50000", "my-session"],
			{
				type: "create",
				name: "my-session",
				config: { initialGoal: { objective: "Write tests", tokenBudget: 50000 } },
			},
		],
		[
			"supports the send separator after the target for flag-like message text",
			["send", "worker", "--", "--from", "literal", "--steer"],
			{
				type: "send_message",
				targetActiveSessionId: "worker",
				fromActiveSessionId: undefined,
				message: "--from literal --steer",
			},
		],
		[
			"supports the send separator before a flag-like target or message",
			["send", "--", "--target-like", "--from", "literal"],
			{ type: "send_message", targetActiveSessionId: "--target-like", message: "--from literal" },
		],
		[
			"parses send message text from an explicit --message value",
			["send", "--from", "planner", "worker", "--message", "please keep --from literal --steer"],
			{
				type: "send_message",
				targetActiveSessionId: "worker",
				fromActiveSessionId: "planner",
				message: "please keep --from literal --steer",
			},
		],
		[
			"preserves the cron add separator before the scheduled prompt",
			["cron", "add", "active-1", "in 5m", "--", "check status"],
			{ type: "cron_add", activeSessionId: "active-1", schedule: "in 5m", prompt: "check status" },
		],
	])("%s", async (_name, argv, expected) => {
		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv])).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests[0]).toMatchObject(expected);
	});

	it.each(getCommandSpec(["send"])!.options!.map((o) => o.split(" ")))(
		"send accepts listed %s",
		async (flag, value) => {
			const argv = ["send", flag, ...(value === "<agent>" ? ["planner"] : []), "worker", "hello"];
			await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv]);
			expect(daemonClientMock.instances[0]?.requests[0]).toMatchObject({ type: "send_message", message: "hello" });
		},
	);

	// Rejected argv must never reach the daemon: a half-parsed command would run the wrong thing.
	it.each([
		["rejects unknown send options instead of folding them into the message", ["send", "worker", "--bogus", "hello"]],
		["rejects extra agent-messages status arguments", ["agent-messages", "pause", "active-1"]],
		["rejects an empty --goal in daemon create", ["create", "--goal", "  ", "my-session"]],
		[
			"rejects --goal-token-budget without --goal in daemon create",
			["create", "--goal-token-budget", "50000", "my-session"],
		],
	])("%s", async (_name, argv) => {
		await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv]);

		expect(daemonClientMock.instances[0]?.requests ?? []).toEqual([]);
	});

	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		process.exitCode = undefined;
		daemonClientMock.instances.length = 0;
		daemonClientMock.behavior.promptSucceeds = false;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = false;
		daemonClientMock.behavior.connectFails = false;
		daemonClientMock.behavior.sessions = [];
		daemonClientMock.behavior.savedSessions = [];
		daemonClientMock.behavior.deleteError = undefined;
		daemonClientMock.behavior.deleteResult = { ok: true, method: "trash" };
		daemonClientMock.behavior.createdSession = undefined;
		daemonClientMock.behavior.notifyCapable = true;
		daemonClientMock.behavior.notifyData = undefined;
		daemonClientMock.behavior.notifyError = undefined;
		daemonClientMock.behavior.notifyEnvelopeFailure = undefined;
		consoleErrorMessages = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
			consoleErrorMessages.push(...messages);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it.each([
		["list", ["--json"], true],
		["sessions", [], true],
		["list", ["--all"], false],
		["list", ["--daemon-socket", "explicit.sock", "--json"], false],
		["list", ["--json"], false],
	])("TM-10/TM-18 %s %j missing=%s", async (command, flags, missing) => {
		const temp = mkdtempSync(join(tmpdir(), "pa-list-"));
		const env = { ...process.env };
		vi.spyOn(process, "cwd").mockReturnValue(temp);
		try {
			cp.execFileSync("git", ["init"], { cwd: temp });
			const socket = flags.includes("--daemon-socket")
				? join(temp, "explicit.sock")
				: repositoryDaemon(temp)!.socketPath;
			daemonClientMock.behavior.connectFails =
				missing || flags.includes("--all") || flags.includes("--daemon-socket");
			const git = vi.spyOn(cp, "spawnSync");
			const spawns = spawnMock.calls.length;
			await handleDaemonCommand(["daemon", command, ...flags]);
			expect(spawnMock.calls).toHaveLength(spawns);
			if (flags.includes("--daemon-socket")) expect(git).not.toHaveBeenCalled();
			expect(daemonClientMock.instances[0]?.socketPath).toBe(socket);
			expect(process.exitCode).toBe(!missing && daemonClientMock.behavior.connectFails ? 1 : undefined);
			if (missing)
				expect(console.log).toHaveBeenCalledWith(
					flags.includes("--json") ? '{\n  "sessions": []\n}' : "No active agents.",
				);
		} finally {
			process.env = env;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	describe("saved-session delete", () => {
		const sessionId = "12345678-1234-1234-1234-123456abcdef";
		let folder: string;
		let sessionPath: string;
		let enrollment: string;
		let directory: string;
		let control: string;
		beforeEach(() => {
			folder = mkdtempSync(join(tmpdir(), "delete-"));
			const meshHome = join(folder, "mesh");
			for (const part of ["enrollments", "directory", "bin"]) mkdirSync(join(meshHome, part), { recursive: true });
			sessionPath = join(folder, "saved.jsonl");
			writeFileSync(sessionPath, "saved transcript");
			enrollment = join(meshHome, "enrollments", `${sessionId}.json`);
			directory = join(meshHome, "directory", `${sessionId}.json`);
			writeFileSync(
				directory,
				JSON.stringify({ sessionId, name: "saved", principal: "local.test", homeSocket: "home" }),
			);
			writeFileSync(
				enrollment,
				JSON.stringify({
					sessionId,
					sessionFile: sessionPath,
					identity: { id: "test" },
					lifecycleUid: "a".repeat(26),
				}),
			);
			writeFileSync(
				join(meshHome, "mesh.json"),
				JSON.stringify({ space: "prime", server: "nats://127.0.0.1:4222" }),
			);
			control = join(folder, "control.json");
			writeFileSync(control, JSON.stringify({ pending: 0, ackPending: 0 }));
			writeFileSync(
				join(meshHome, "bin", "cotal"),
				`#!${process.execPath}
const { readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const settings = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
const config = settings.sessions?.[process.argv[4]] ?? settings;
if (config.change) writeFileSync(${JSON.stringify(enrollment)}, "{}");
if (config.leave) unlinkSync(${JSON.stringify(enrollment)});
if (config.directory) writeFileSync(${JSON.stringify(directory)}, "{}");
if (config.fail) process.exit(1);
console.log(config.invalid ? "bad counts" : JSON.stringify(config));
`,
				{ mode: 0o700 },
			);
			vi.stubEnv(ENV_AGENT_DIR, folder);
			vi.stubEnv("PATH", join(meshHome, "bin"));
			daemonClientMock.behavior.savedSessions = [
				{
					path: sessionPath,
					id: sessionId,
					name: "saved",
					cwd: folder,
					created: "2026-01-01",
					modified: "2026-01-01",
					messageCount: 1,
					firstMessage: "hello",
					allMessagesText: "hello",
				},
			];
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			rmSync(folder, { recursive: true, force: true });
		});
		function enroll(id: string, path: string) {
			const record = JSON.parse(readFileSync(enrollment, "utf8"));
			writeFileSync(
				join(folder, "mesh", "enrollments", `${id}.json`),
				JSON.stringify({ ...record, sessionId: id, sessionFile: path }),
			);
		}
		function deletions() {
			return daemonClientMock.instances
				.flatMap((client) => client.requests)
				.filter((command) => command.type === "delete_saved_session");
		}
		async function run(selector = "saved", ...flags: string[]) {
			await handleDaemonCommand(["daemon", "--socket", join(folder, "daemon.sock"), "delete", selector, ...flags]);
		}
		it.each(["name", "prefix", "never-enrolled", "json"])("deletes a closed session (%s)", async (kind) => {
			if (kind === "never-enrolled") {
				rmSync(enrollment);
				rmSync(directory);
				rmSync(join(folder, "mesh", "bin", "cotal"));
			}
			if (kind === "never-enrolled") {
				vi.stubEnv("HOME", folder);
				vi.stubEnv(ENV_AGENT_DIR, "");
				vi.spyOn(process, "cwd").mockReturnValue(folder);
				await handleDaemonCommand(["daemon", "delete", "saved"]);
			} else await run(kind === "prefix" ? "12345678" : "saved", ...(kind === "json" ? ["--json"] : []));
			expect(deletions()).toEqual([{ type: "delete_saved_session", sessionPath }]);
			expect(process.exitCode ?? 0).toBe(0);
			expect(String(vi.mocked(console.log).mock.calls[0]![0])).toContain("saved");
			expect(console.error).not.toHaveBeenCalled();
			await run();
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toContain("No session found matching 'saved'");
			expect(deletions()).toHaveLength(1);
		});
		it.each(["id", "symlink"])("refuses a live session (%s)", async (match) => {
			const alias = join(folder, "alias.jsonl");
			symlinkSync(sessionPath, alias);
			daemonClientMock.behavior.sessions = [
				{ ...makeSessionSummary("active", match === "id" ? sessionId : "other", "saved"), sessionFile: alias },
			];
			await run();
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toContain("stop it first");
			expect(deletions()).toEqual([]);
		});
		it.each([
			[3, 2],
			[0, 5],
			[5, 0],
		])("refuses %i pending plus %i ackPending", async (pending, ackPending) => {
			writeFileSync(control, JSON.stringify({ pending, ackPending }));
			await run();
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toContain("5 unacknowledged mesh messages");
			expect(deletions()).toEqual([]);
		});
		it.each(["pending", "unreadable", "grandchild", "zero", "unrelated"])(
			"checks descendant mesh queues (%s)",
			async (kind) => {
				const saved = daemonClientMock.behavior.savedSessions[0]!;
				const alias = join(folder, "parent-alias.jsonl");
				symlinkSync(sessionPath, alias);
				const child = {
					...saved,
					id: "child",
					name: "child",
					path: join(folder, "child.jsonl"),
					parentSessionPath: alias,
					rlmDepth: 1,
				};
				const grandchild = {
					...child,
					id: "grandchild",
					name: "grandchild",
					path: join(folder, "grandchild.jsonl"),
					parentSessionPath: child.path,
					rlmDepth: 2,
				};
				for (const member of [child, grandchild]) {
					writeFileSync(member.path, "closed child transcript");
					enroll(member.id, member.path);
				}
				if (kind === "unrelated") child.parentSessionPath = join(folder, "other-root.jsonl");
				daemonClientMock.behavior.savedSessions.push(grandchild, child, { ...child });
				const blocked = kind === "grandchild" ? "grandchild" : "child";
				writeFileSync(
					control,
					JSON.stringify({
						pending: 0,
						ackPending: 0,
						sessions: {
							[blocked]: { pending: kind === "zero" ? 0 : 1, ackPending: 0, fail: kind === "unreadable" },
						},
					}),
				);
				await run();
				const refused = kind !== "zero" && kind !== "unrelated";
				expect(process.exitCode ?? 0).toBe(refused ? 1 : 0);
				expect(deletions()).toEqual(refused ? [] : [{ type: "delete_saved_session", sessionPath }]);
				if (refused) expect(consoleErrorMessages.join(" ")).toContain(`Cannot delete ${blocked}:`);
			},
		);
		it.each(["agent-dir", "socket", "socket-alias"])(
			"refuses absent enrollment with an override (%s)",
			async (kind) => {
				rmSync(enrollment);
				rmSync(directory);
				vi.stubEnv("HOME", folder);
				if (kind !== "agent-dir") vi.stubEnv(ENV_AGENT_DIR, "");
				vi.spyOn(process, "cwd").mockReturnValue(folder);
				await handleDaemonCommand([
					"daemon",
					...(kind === "agent-dir"
						? []
						: [kind === "socket" ? "--daemon-socket" : "--socket", join(folder, "daemon.sock")]),
					"delete",
					"saved",
				]);
				expect(process.exitCode).toBe(1);
				expect(deletions()).toEqual([]);
				expect(consoleErrorMessages.join(" ")).toContain("mesh enrollment is absent with an overridden");
			},
		);
		it.each(["unknown", "ambiguous", "suffix", "child"])("uses saved catalog resolution (%s)", async (kind) => {
			const saved = daemonClientMock.behavior.savedSessions[0]!;
			if (kind === "ambiguous") daemonClientMock.behavior.savedSessions.push({ ...saved, id: "12345678-other" });
			if (kind === "child") saved.rlmDepth = 1;
			await run(kind === "unknown" ? "missing" : kind === "suffix" ? "abcdef" : "saved");
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toContain(
				kind === "ambiguous" ? 'Ambiguous session selector "saved"' : "No session found matching",
			);
			expect(deletions()).toEqual([]);
		});
		it("does not confuse a saved ID prefix with another session's stop-style suffix", async () => {
			const otherPath = join(folder, "other.jsonl");
			daemonClientMock.behavior.savedSessions.push({
				...daemonClientMock.behavior.savedSessions[0]!,
				id: "abcdef00-other",
				name: "other",
				path: otherPath,
			});
			enroll("abcdef00-other", otherPath);
			await run("abcdef");
			expect(process.exitCode ?? 0).toBe(0);
			expect(deletions()).toEqual([{ type: "delete_saved_session", sessionPath: otherPath }]);
		});
		it.each(["active-refusal", "unreachable", "file-failure"])("shows daemon failure (%s)", async (kind) => {
			if (kind === "active-refusal")
				daemonClientMock.behavior.deleteError = "Cannot delete the currently active session";
			if (kind === "unreachable") daemonClientMock.behavior.connectFails = true;
			if (kind === "file-failure")
				daemonClientMock.behavior.deleteResult = { ok: false, error: "delete permission denied" };
			await run();
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toContain(
				kind === "unreachable"
					? "mock connect failed"
					: kind === "file-failure"
						? "delete permission denied"
						: "Cannot delete the currently active session",
			);
			expect(console.log).not.toHaveBeenCalled();
			expect(deletions()).toHaveLength(kind === "unreachable" ? 0 : 1);
		});
		it.each([
			"fail",
			"invalid",
			"change",
			"leave",
			"directory",
			"dangling",
			"missing-enrollment",
			"bad-enrollment",
			"bad-config",
			"bad-directory",
			"dangling-directory",
		])("refuses unreadable or changing mesh state (%s)", async (kind) => {
			writeFileSync(control, JSON.stringify({ pending: 0, ackPending: 0, [kind]: true }));
			if (kind === "dangling") {
				rmSync(enrollment);
				symlinkSync(join(folder, "missing"), enrollment);
			}
			if (kind === "missing-enrollment") {
				rmSync(enrollment);
				writeFileSync(directory, "{}");
			}
			if (kind === "bad-enrollment") writeFileSync(enrollment, "{bad");
			if (kind === "bad-directory") writeFileSync(directory, "{bad");
			if (kind === "dangling-directory") {
				rmSync(directory);
				symlinkSync(join(folder, "missing"), directory);
			}
			if (kind === "bad-config") writeFileSync(join(folder, "mesh", "mesh.json"), "{}");
			await run();
			expect(process.exitCode).toBe(1);
			expect(consoleErrorMessages.join(" ")).toMatch(/mesh|Mesh|counts|ENOENT/);
			expect(deletions()).toEqual([]);
		});
	});

	it("ignores stale agent_end events before a daemon prompt starts", async () => {
		daemonClientMock.behavior.promptSucceeds = true;
		daemonClientMock.behavior.emitStaleAgentEndOnAttach = true;
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"prompt",
			"active-1",
			"hello",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach", "prompt"]);

		let resolved = false;
		void command.then(() => {
			resolved = true;
		});
		await flushPromises();
		expect(resolved).toBe(false);

		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_start" } });
		client?.emitMessage({ type: "session_event", activeSessionId: "active-1", event: { type: "agent_end" } });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("ends json attach when the session closes", async () => {
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"--json",
			"attach",
			"active-1",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach"]);

		client?.emitMessage({ type: "session_closed", activeSessionId: "active-1" });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});

	it("chooses a terminating non-colliding default name past the safe-integer range", async () => {
		const unsafeIntegerName = "9007199254740992";
		daemonClientMock.behavior.sessions = [makeSessionSummary("active-1", "session-1", unsafeIntegerName)];

		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock"])).resolves.toBe(true);

		const client = daemonClientMock.instances[1];
		expect(client?.requests[0]).toEqual({ type: "list", all: true });
		expect(client?.requests[1]).toMatchObject({ type: "create", name: "1" });
		expect(client?.requests[1]?.name).not.toBe(unsafeIntegerName);
	});

	it("resolves agent names before filtering scheduled prompts", async () => {
		daemonClientMock.behavior.sessions = [makeSessionSummary("active-1", "session-1", "alpha")];

		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "--json", "cron", "list", "alpha"]),
		).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([
			{ type: "list" },
			{ type: "cron_list", activeSessionId: "active-1", includeInactive: false },
		]);
	});

	const ALPHA_ROSTER = [makeSessionSummary("active-1", "session-1", "alpha")];
	it.each<[string, string[], boolean, boolean, Array<Record<string, unknown>>]>([
		["prints the sessions operator table", ["sessions"], false, false, ALPHA_ROSTER],
		["passes --all and dumps raw summaries with --json", ["--json", "sessions", "--all"], true, true, ALPHA_ROSTER],
		["reports an empty roster without a table", ["sessions"], false, false, []],
	])("%s", async (_name, argv, all, json, sessions) => {
		daemonClientMock.behavior.sessions = sessions;
		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", ...argv])).resolves.toBe(true);

		expect(daemonClientMock.instances[0]?.requests).toEqual([{ type: "list", all }]);
		const logged = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		if (json) {
			expect(JSON.parse(logged)).toEqual({ sessions });
		} else if (sessions.length === 0) {
			expect(logged).toBe("No active agents.");
		} else {
			expect(logged).toContain("alpha");
		}
	});

	it("rejects unknown sessions options", async () => {
		await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "sessions", "--bogus"]);
		expect(process.exitCode).toBe(1);
		expect(consoleErrorMessages.join(" ")).toContain("Unknown sessions option: --bogus");
	});

	it("does not leak --goal/--goal-token-budget into daemon startup args", async () => {
		// Force canConnectToDaemon to fail so runStart is exercised.
		daemonClientMock.behavior.connectFails = true;
		spawnMock.calls.length = 0;

		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent-goal-leak-test.sock",
			"start",
			"--goal",
			"Leak test goal",
			"--goal-token-budget",
			"100",
		]);

		expect(spawnMock.calls.length).toBe(1);
		const spawnArgs = spawnMock.calls[0]!;
		// The goal flags must NOT appear in the daemon startup args.
		expect(spawnArgs).not.toContain("--goal");
		expect(spawnArgs).not.toContain("Leak test goal");
		expect(spawnArgs).not.toContain("--goal-token-budget");
		expect(spawnArgs).not.toContain("100");
	});

	it("does not leak goal into default config for a subsequent no-goal create", async () => {
		// First create with goal — config has initialGoal.
		await handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"create",
			"--goal",
			"Write tests",
			"--goal-token-budget",
			"50000",
			"first",
		]);
		expect(daemonClientMock.instances.at(-1)?.requests[0]).toMatchObject({
			type: "create",
			config: { initialGoal: { objective: "Write tests", tokenBudget: 50000 } },
		});

		// Second create without goal — config must NOT have initialGoal.
		await handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "create", "second"]);
		const secondConfig = daemonClientMock.instances.at(-1)?.requests[0]?.config;
		expect(secondConfig?.initialGoal).toBeUndefined();
	});

	it("prints the created session for non-interactive --json open instead of attaching", async () => {
		daemonClientMock.behavior.createdSession = makeSessionSummary("active-open-1", "session-open-1", "open-1");
		const logCalls: unknown[][] = [];
		vi.spyOn(console, "log").mockImplementation((...messages: unknown[]) => {
			logCalls.push(messages);
		});

		await expect(handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "--json"])).resolves.toBe(true);

		// No attach-guard error: the machine-readable path prints the summary and exits.
		expect(process.exitCode).toBeUndefined();
		expect(consoleErrorMessages).toEqual([]);
		const client = daemonClientMock.instances.at(-1);
		expect(client?.requests.some((request) => request.type === "attach")).toBe(false);
		expect(logCalls.length).toBe(1);
		expect(() => JSON.parse(String(logCalls[0]?.[0]))).not.toThrow();
	});
});

function makeSessionSummary(activeSessionId: string, sessionId: string, sessionName: string): Record<string, unknown> {
	return {
		id: activeSessionId,
		activeSessionId,
		sessionId,
		sessionName,
		cwd: "/tmp/project",
		lifecycle: "ready",
		activity: "idle",
		isSessionActive: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
