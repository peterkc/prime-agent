import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.js";
import {
	acquireSessionMoveLeases,
	type SessionMoveJournal,
	type SessionMoveReport,
	sessionMovePaths,
} from "../src/core/session-move.js";
import * as enrollment from "../src/modes/daemon/cotal/enrollment.js";
import { type MeshEndpointOptions, MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonCommandEnvelope,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import * as atomic from "../src/utils/atomic-file.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../src/utils/atomic-file.js", async (original) => ({ ...(await original<typeof atomic>()) }));
vi.mock("@cotal-ai/core", async (original) => ({
	...(await original<typeof core>()),
	CotalEndpoint: function (options: core.EndpointOptions) {
		if (!new.target) throw new TypeError("CotalEndpoint requires new");
		return new Endpoint(options);
	},
}));
class Endpoint extends EventEmitter {
	static instances: Endpoint[] = [];
	readonly start = vi.fn(async () => undefined);
	readonly stop = vi.fn(async () => undefined);
	readonly provisionDmInbox = vi.fn(async () => undefined);
	readonly provisionDlvInbox = vi.fn(async () => undefined);
	readonly reissueAcl = vi.fn(async () => undefined);
	constructor(readonly options: core.EndpointOptions) {
		super();
		Endpoint.instances.push(this);
	}
}
interface Harness {
	handoffMeshMessage: MeshEndpointOptions["handoff"];
	mesh: MeshEndpoints;
	workers: Map<string, unknown>;
	roster(): { write(entry: object): void };
	recoverSessionMoves(): Promise<SessionMoveReport[]>;
	cleanupSupervisorResources(): Promise<void>;
}
const roots: string[] = [];
const supervisors: DaemonSupervisor[] = [];
const clients: DaemonClient[] = [];
const startupReports = new WeakMap<DaemonSupervisor, SessionMoveReport[]>();
function harness(supervisor: DaemonSupervisor): Harness {
	return supervisor as unknown as Harness;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const supervisor of supervisors.splice(0).reverse()) await harness(supervisor).cleanupSupervisorResources();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	Endpoint.instances = [];
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function start(
	root: string,
	sessionDir: string,
	socket: string,
	descriptorDir = join(root, `workers-${supervisors.length}`),
) {
	const supervisor = new DaemonSupervisor(socket, {
		defaultSessionConfig: { agentDir: root, cwd: root, sessionDir },
		descriptorDir,
	});
	supervisors.push(supervisor);
	const recovery = vi.spyOn(harness(supervisor), "recoverSessionMoves");
	await supervisor.start();
	startupReports.set(supervisor, await recovery.mock.results[0]!.value);
	recovery.mockRestore();
	return supervisor;
}
async function fixture(startNow = true, id: string = randomUUID()) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "prime-move-")));
	roots.push(root);
	vi.stubEnv(ENV_AGENT_DIR, root);
	vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", join(root, "owners"));
	fs.mkdirSync(join(root, "bin"));
	vi.stubEnv("PATH", join(root, "bin"));
	fs.writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
	const sourceDir = join(root, "source", "sessions");
	const targetDir = join(root, "target", "sessions");
	fs.mkdirSync(sourceDir, { recursive: true });
	fs.mkdirSync(targetDir, { recursive: true });
	const sourceFile = join(sourceDir, `${id}.jsonl`);
	fs.writeFileSync(
		sourceFile,
		`${JSON.stringify({ type: "session", id, version: CURRENT_SESSION_VERSION, cwd: root, timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: "session_info", id: "name", parentId: null, timestamp: new Date().toISOString(), name: "moving" })}\n`,
	);
	const checked = sessionMovePaths({
		sessionId: id,
		agentDir: root,
		sourceSessionDir: sourceDir,
		sourceFile,
		targetSessionDir: targetDir,
	});
	if (!checked.ok) throw new Error(checked.reason);
	const paths = checked.value;
	fs.mkdirSync(paths.sourceArtifacts, { recursive: true });
	fs.writeFileSync(join(paths.sourceArtifacts, "keep.txt"), "artifact");
	const meshRoot = join(root, "mesh");
	fs.mkdirSync(meshRoot);
	fs.writeFileSync(join(meshRoot, "mesh.json"), JSON.stringify({ space: "prime", server: "nats://127.0.0.1:1" }));
	fs.writeFileSync(
		join(meshRoot, "signer.json"),
		JSON.stringify(core.stripSpaceAuth(await core.createSpaceAuth("prime"))),
		{ mode: 0o600 },
	);
	const socket = join(root, "source.sock");
	const targetSocket = join(root, "target.sock");
	await enrollment.publishDirectory(meshRoot, enrollment.ensureEnrollmentRecord(meshRoot, id, sourceFile), socket);
	const supervisor = startNow ? await start(root, sourceDir, socket) : undefined;
	if (supervisor) await harness(supervisor).mesh.openSession(id, sourceFile);
	const command = {
		type: "move_saved_session" as const,
		sessionPath: sourceFile,
		targetSessionDir: targetDir,
		targetCwd: join(root, "target"),
		targetSocket,
	};
	return { root, paths, meshRoot, id, sourceDir, targetDir, socket, targetSocket, supervisor, command };
}
async function dispatch(
	f: Awaited<ReturnType<typeof fixture>>,
	command: DaemonCommand = f.command,
): Promise<DaemonResponse> {
	const client = new DaemonClient(f.socket);
	clients.push(client);
	await client.connect();
	await client.waitForHello();
	return client.request(command);
}
function freeLeases(paths: Awaited<ReturnType<typeof fixture>>["paths"]) {
	const lease = acquireSessionMoveLeases(paths, paths.agentDir);
	lease.release();
}
function freeClaim(f: Awaited<ReturnType<typeof fixture>>) {
	const claim = enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.targetFile);
	claim.release();
}
function writeJournal(f: Awaited<ReturnType<typeof fixture>>, phase: SessionMoveJournal["phase"], published = false) {
	const bytes = fs.readFileSync(f.paths.sourceFile);
	const journal: SessionMoveJournal = {
		...f.paths,
		version: 1,
		phase,
		endpointSuspended: true,
		artifactsPresent: true,
		createdDirectories: [],
		targetCwd: f.command.targetCwd,
		targetSocket: f.targetSocket,
		fileBytes: bytes.length,
		fileSha256: createHash("sha256").update(bytes).digest("hex"),
	};
	fs.mkdirSync(join(f.root, "session-moves"), { recursive: true });
	if (published) fs.renameSync(f.paths.sourceFile, f.paths.targetFile);
	else if (phase !== "suspending") {
		fs.copyFileSync(f.paths.sourceFile, f.paths.fileTemporary);
		fs.mkdirSync(f.paths.targetArtifactRoot, { recursive: true });
		fs.cpSync(f.paths.sourceArtifacts, f.paths.artifactTemporary, { recursive: true });
		const { dev, ino } = fs.lstatSync(f.paths.artifactTemporary, { bigint: true });
		Object.assign(journal, { artifactIdentity: `${dev}:${ino}` });
		if (phase === "committing" || phase === "committed") {
			fs.renameSync(f.paths.sourceFile, f.paths.sourceBackup);
			fs.renameSync(f.paths.artifactTemporary, f.paths.targetArtifacts);
		}
	}
	fs.writeFileSync(f.paths.journalPath, JSON.stringify(journal));
	return journal;
}
describe("supervisor session move", () => {
	it.each(
		["win32", "darwin"].flatMap((platform) =>
			["directory", "file"].flatMap((kind) => ["relocation", "mesh"].map((scope) => ({ platform, kind, scope }))),
		),
	)("F11 $platform $kind $scope fsync keeps the platform failure boundary", async ({ platform, kind, scope }) => {
		const f = await fixture();
		const sync = fs.fsyncSync,
			open = fs.openSync;
		const handles = new Map<number, string>();
		const record = enrollment.enrollmentPath(f.meshRoot, f.id);
		const fault =
			scope === "mesh"
				? kind === "directory"
					? dirname(record)
					: record
				: kind === "directory"
					? f.root
					: join(f.paths.artifactTemporary, "keep.txt");
		vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
		vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
			const fd = open(path, flags, mode);
			handles.set(fd, String(path));
			return fd;
		});
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (handles.get(fd) === fault) throw new Error("fsync refused");
			return sync(fd);
		});
		const response = await dispatch(f);
		const supported = platform === "win32" && kind === "directory";
		if (supported || scope === "mesh")
			expect(response).toMatchObject({
				success: true,
				data: { moved: true, mesh: { status: supported ? "updated" : "failed" } },
			});
		else expect(response).toMatchObject({ success: false });
		if (!supported) expect(JSON.stringify(response)).toContain("fsync refused");
	});
	it.each([true, false])("F6 move success=%s reports only its own recovery pass", async (valid) => {
		const f = await fixture(false);
		writeJournal(f, "suspending");
		await start(f.root, f.sourceDir, f.socket);
		writeJournal(f, "copying");
		const command = valid ? f.command : { ...f.command, targetSessionDir: f.sourceDir };
		const first = await dispatch(f, command);
		expect(first).toMatchObject({ success: valid, data: { recovered: [{ status: "rolled_back" }] } });
		expect((first.data as { recovered: unknown[] }).recovered).toHaveLength(1);
		expect(await dispatch(f, command)).toMatchObject({ success: false, data: { recovered: [] } });
	});

	it("AC-15 move waits for the actual paused handoff and prevents a late worker wake", async () => {
		const f = await fixture();
		const sup = harness(f.supervisor!);
		const handoff = deferred();
		const entered = deferred();
		const stopped = deferred();
		const deliver = sup.handoffMeshMessage.bind(sup);
		vi.spyOn(sup, "handoffMeshMessage").mockImplementation(async (...args) => {
			entered.resolve();
			await handoff.promise;
			return deliver(...args);
		});
		const endpoint = Endpoint.instances.find(
			(instance) => instance.options.card?.id === enrollment.readEnrollment(f.meshRoot, f.id).identity.id,
		)!;
		endpoint.stop.mockImplementationOnce(async () => {
			stopped.resolve();
		});
		endpoint.emit(
			"message",
			{ id: "held", parts: [{ kind: "text", text: "hello" }], from: { id: "local.sender", name: "sender" } },
			{ durable: true, ack: vi.fn() },
			{ kind: "dm" },
		);
		await entered.promise;
		const moving = dispatch(f);
		let response: DaemonResponse;
		try {
			await stopped.promise;
			vi.useFakeTimers();
			await vi.advanceTimersByTimeAsync(0);
			expect(fs.existsSync(f.paths.targetFile)).toBe(false);
			expect(JSON.parse(fs.readFileSync(f.paths.journalPath, "utf8")).phase).toBe("suspending");
			expect(() => enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.sourceFile)).toThrow();
		} finally {
			handoff.resolve();
			vi.useRealTimers();
			response = await moving;
		}
		expect(response).toMatchObject({ success: true, data: { moved: true } });
		expect(sup.workers.size).toBe(0);
		freeClaim(f);
		freeLeases(f.paths);
	});
	it.each([randomUUID(), "session.1"])("AC-13/#55 dispatch moves enrolled ID %s and releases custody", async (id) => {
		const f = await fixture(true, id);
		const response = await dispatch(f);
		expect(response).toMatchObject({
			success: true,
			data: {
				moved: true,
				sessionId: f.id,
				targetFile: f.paths.targetFile,
				original: { deleted: true, method: "unlink" },
				mesh: { status: "updated" },
			},
		});
		expect(fs.existsSync(f.paths.sourceFile)).toBe(false);
		expect(fs.existsSync(f.paths.sourceBackup)).toBe(false);
		expect(fs.existsSync(f.paths.sourceArtifacts)).toBe(false);
		expect(fs.existsSync(f.paths.journalPath)).toBe(false);
		expect(fs.readFileSync(join(f.paths.targetArtifacts, "keep.txt"), "utf8")).toBe("artifact");
		expect(enrollment.readEnrollment(f.meshRoot, f.id).sessionFile).toBe(f.paths.targetFile);
		expect(enrollment.readDirectory(f.meshRoot, f.id)?.homeSocket).toBe(f.targetSocket);
		freeClaim(f);
		freeLeases(f.paths);
	});
	it.each(["native", "cotal", "unavailable"])(
		"moves an unenrolled session with %s mesh configuration",
		async (transport) => {
			const f = await fixture(false);
			fs.unlinkSync(enrollment.enrollmentPath(f.meshRoot, f.id));
			fs.unlinkSync(enrollment.directoryPath(f.meshRoot, f.id));
			fs.writeFileSync(
				join(f.root, "settings.json"),
				JSON.stringify({ agentMessageTransport: transport === "native" ? "native" : "cotal" }),
			);
			if (transport === "unavailable") fs.writeFileSync(join(f.meshRoot, "signer.json"), "{}");
			await start(f.root, f.sourceDir, f.socket);
			expect(await dispatch(f)).toMatchObject({
				success: true,
				data: { moved: true, mesh: { status: "not_enrolled" } },
			});
			expect(fs.existsSync(f.paths.targetFile)).toBe(true);
			freeLeases(f.paths);
		},
	);
	it.each([
		["open", "currently active"],
		["worker", "worker is recovering"],
		["lease", "open or being written elsewhere"],
		["child", "RLM child session"],
		["children", "RLM children"],
		["artifact-child", "RLM children"],
		["active", "active or paused scheduled job"],
		["paused", "active or paused scheduled job"],
		["foreign", "claimed by another daemon"],
		["replacement", "replacement is pending"],
		["refused", "space and server are required"],
		["target-id", "already holds session"],
		["target-name", "named moving"],
	])("AC-14 refuses %s without changing session or mesh records", async (state, reason) => {
		const f = await fixture(state !== "foreign" && state !== "refused");
		const before = fs.readFileSync(f.paths.sourceFile);
		let claim: ReturnType<typeof enrollment.claimEnrollment> | undefined;
		let jobId: string | undefined;
		if (state === "foreign" || state === "refused") {
			if (state === "foreign") claim = enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.sourceFile);
			else fs.writeFileSync(join(f.meshRoot, "mesh.json"), "{}");
			f.supervisor = await start(f.root, f.sourceDir, f.socket);
		}
		const sup = harness(f.supervisor!);
		if (state === "lease")
			claim = acquireSessionLease(f.paths.sourceFile, f.root, { [SESSION_LEASES_ENABLED_ENV]: "1" }) ?? undefined;
		if (state === "open")
			sup.roster().write({
				agentId: f.id,
				summary: {
					id: f.id,
					activeSessionId: "open",
					sessionId: f.id,
					sessionFile: f.paths.sourceFile,
					cwd: f.root,
				},
			});
		if (state === "worker")
			sup.workers.set("owner", {
				descriptor: {
					workerId: "owner",
					lifecycle: "recovering",
					sessionFile: f.paths.sourceFile,
					createCommand: {},
				},
			});
		if (state === "child")
			fs.writeFileSync(f.paths.sourceFile, before.toString().replace('"version":', '"rlmDepth":1,"version":'));
		if (state === "artifact-child") fs.copyFileSync(f.paths.sourceFile, join(f.paths.sourceArtifacts, "child.data"));
		if (state === "children") {
			const child = join(f.paths.sourceArtifacts, "child.jsonl");
			fs.copyFileSync(f.paths.sourceFile, child);
			await new RlmSpawnLedger(f.root, f.sourceDir).appendSpawn({
				childId: "child",
				parent: f.paths.sourceFile,
				child,
				depth: 1,
				name: "child",
			});
		}
		if (state === "active" || state === "paused") {
			const store = AgentCronJobStore.forSessionArtifacts();
			store.registerSessionArtifact(f.id, f.paths.sourceArtifacts);
			const job = await store.create({
				sessionId: f.id,
				activeSessionId: f.id,
				sessionFile: f.paths.sourceFile,
				cwd: f.root,
				prompt: "never wake",
				source: "heartbeat",
				scheduleText: "in 1 day",
			});
			if (state === "paused") await store.manageHeartbeat(f.id, job.id, "pause");
			expect(store.list()[0]?.status).toBe(state);
			jobId = job.id;
		}
		if (state === "replacement") await sup.mesh.beginReplacement(f.id, {}, "test-replacement");
		if (state.startsWith("target-"))
			fs.writeFileSync(
				join(f.targetDir, "other.jsonl"),
				state === "target-id" ? before : before.toString().replace(f.id, randomUUID()),
			);
		const source = fs.readFileSync(f.paths.sourceFile);
		const record = fs.readFileSync(enrollment.enrollmentPath(f.meshRoot, f.id));
		const directory = fs.readFileSync(enrollment.directoryPath(f.meshRoot, f.id));
		const claims = vi.spyOn(enrollment, "claimEnrollment");
		try {
			const refused = await dispatch(f);
			expect(refused).toMatchObject({ success: false, error: expect.stringContaining(reason) });
			if (jobId)
				expect(refused).toMatchObject({ error: expect.stringContaining(`cancel these jobs first: ${jobId}`) });
			expect(fs.readFileSync(f.paths.sourceFile)).toEqual(source);
			expect(fs.readFileSync(enrollment.enrollmentPath(f.meshRoot, f.id))).toEqual(record);
			expect(fs.readFileSync(enrollment.directoryPath(f.meshRoot, f.id))).toEqual(directory);
			expect(fs.existsSync(f.paths.targetFile)).toBe(false);
			expect(fs.existsSync(f.paths.journalPath)).toBe(false);
			if (state === "replacement") expect(claims).not.toHaveBeenCalled();
		} finally {
			claim?.release();
			sup.workers.clear();
			freeLeases(f.paths);
		}
	});
	it.each([false, true])("AC-16/#55 restart=%s preserves mesh custody", async (restart) => {
		const f = await fixture(!restart);
		if (restart) {
			writeJournal(f, "committing");
			const held = acquireSessionMoveLeases(f.paths, f.root);
			try {
				f.supervisor = await start(f.root, f.sourceDir, f.socket);
				await harness(f.supervisor).mesh.start();
				expect(Endpoint.instances.filter((instance) => instance.options.card?.kind === "agent")).toHaveLength(0);
			} finally {
				held.release();
			}
		} else {
			const endpoint = Endpoint.instances.find((instance) => instance.options.card?.kind === "agent")!;
			endpoint.stop.mockRejectedValue(new Error("stop failed"));
			const failed = await dispatch(f);
			expect(failed).toMatchObject({ success: false, error: expect.stringContaining("recovery is pending") });
			expect(() => enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.sourceFile)).toThrow();
		}
		expect(fs.existsSync(f.paths.sourceFile)).toBe(!restart);
		expect(fs.existsSync(f.paths.journalPath)).toBe(true);
		expect(fs.existsSync(f.paths.targetFile)).toBe(false);
		freeLeases(f.paths);
		const later = await dispatch(f, { ...f.command, targetSessionDir: f.sourceDir });
		const status = restart ? "rolled_back" : "pending";
		expect(later).toMatchObject({ success: false, data: { recovered: [{ status }] } });
		expect(fs.existsSync(f.paths.journalPath)).toBe(!restart);
		const resumed = Endpoint.instances.filter((instance) => instance.options.card?.kind === "agent");
		expect(resumed).toHaveLength(1);
		if (!restart) expect(() => enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.sourceFile)).toThrow();
		expect(resumed.at(-1)!.start).toHaveBeenCalledOnce();
	});
	it.each(["enrollment", "directory", "journal", "enrollment-only"])(
		"AC-17 %s failure after publication keeps committed journal and originals",
		async (step) => {
			const f = await fixture();
			const failedStep = step === "enrollment-only" ? "enrollment" : step;
			if (step === "journal") {
				const write = atomic.writeFileAtomicSync;
				vi.spyOn(atomic, "writeFileAtomicSync").mockImplementation((path, data, options) => {
					if (path === f.paths.journalPath && JSON.parse(data).phase === "committed")
						throw new Error("record refused");
					return write(path, data, options);
				});
			} else
				vi.spyOn(
					enrollment,
					failedStep === "enrollment" ? "updateEnrollmentPath" : "publishDirectory",
				).mockRejectedValueOnce(new Error("record refused"));
			expect(await dispatch(f)).toMatchObject({
				success: true,
				data: {
					moved: true,
					mesh: {
						status: "failed",
						step: failedStep === "journal" ? "enrollment" : failedStep,
						reason: expect.stringContaining("record refused"),
					},
				},
			});
			expect(JSON.parse(fs.readFileSync(f.paths.journalPath, "utf8")).phase).toBe(
				step === "journal" ? "committing" : "committed",
			);
			expect(fs.existsSync(f.paths.sourceBackup)).toBe(true);
			expect(fs.existsSync(f.paths.sourceArtifacts)).toBe(true);
			freeLeases(f.paths);
			freeClaim(f);
			if (step === "enrollment-only")
				await enrollment.publishDirectory(
					f.meshRoot,
					{ ...enrollment.readEnrollment(f.meshRoot, f.id), sessionFile: f.paths.targetFile },
					f.targetSocket,
				);
			const correctPath =
				step === "directory"
					? enrollment.enrollmentPath(f.meshRoot, f.id)
					: enrollment.directoryPath(f.meshRoot, f.id);
			const before = fs.readFileSync(correctPath);
			expect(await harness(f.supervisor!).recoverSessionMoves()).toMatchObject([
				{ status: "moved", backups: [{ path: f.paths.sourceBackup }, { path: f.paths.sourceArtifacts }] },
			]);
			expect(enrollment.readEnrollment(f.meshRoot, f.id).sessionFile).toBe(f.paths.targetFile);
			if (step === "directory" || step === "enrollment-only") expect(fs.readFileSync(correctPath)).toEqual(before);
			expect(enrollment.readDirectory(f.meshRoot, f.id)?.homeSocket).toBe(f.targetSocket);
		},
	);
	it("AC-17 journal cleanup failure is not reported as a mesh failure", async () => {
		const f = await fixture();
		const unlink = fs.unlinkSync;
		vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
			if (path === f.paths.journalPath) throw new Error("journal removal refused");
			return unlink(path);
		});
		expect(await dispatch(f)).toMatchObject({
			success: true,
			data: {
				moved: true,
				recoveryPending: true,
				mesh: { status: "updated" },
				original: { deleted: true },
				messages: expect.arrayContaining(["journal removal refused"]),
			},
		});
		freeLeases(f.paths);
		freeClaim(f);
	});
	it.each(["file", "artifacts"])("AC-17 failed %s removal keeps and reports the remaining original", async (step) => {
		const f = await fixture();
		if (step === "file") {
			const trash = join(f.root, "bin", "trash");
			fs.writeFileSync(trash, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		} else {
			const remove = fs.rmSync;
			vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
				if (path === f.paths.sourceArtifacts) throw new Error("artifact removal refused");
				return remove(path, options);
			});
		}
		expect(await dispatch(f)).toMatchObject({
			success: true,
			data: {
				moved: true,
				mesh: { status: "updated" },
				original: {
					deleted: false,
					backups: expect.arrayContaining([expect.objectContaining({ path: f.paths.sourceArtifacts })]),
				},
			},
		});
		expect(fs.existsSync(f.paths.sourceBackup)).toBe(step === "file");
		expect(fs.existsSync(f.paths.sourceArtifacts)).toBe(true);
		expect(fs.existsSync(f.paths.journalPath)).toBe(false);
		freeLeases(f.paths);
		freeClaim(f);
	});
	it.each(["suspending", "copying", "committing", "committed", "skipped"] as const)(
		"AC-18 startup recovers %s before adopting its descriptor or hosting mesh",
		async (phase) => {
			const f = await fixture(false);
			writeJournal(f, phase === "skipped" ? "suspending" : phase);
			const held = phase === "skipped" ? acquireSessionMoveLeases(f.paths, f.root) : undefined;
			const adopt = vi
				.spyOn(
					DaemonSupervisor.prototype as unknown as { adoptOrRecoverWorker(): Promise<void> },
					"adoptOrRecoverWorker",
				)
				.mockResolvedValue();
			const descriptors = join(f.root, "workers-0");
			fs.mkdirSync(descriptors);
			fs.writeFileSync(
				join(descriptors, "stale.json"),
				JSON.stringify({
					version: 2,
					workerId: "stale",
					pid: process.pid,
					supervisorSocketPath: f.socket,
					socketPath: join(f.root, "worker.sock"),
					authenticationToken: "unused",
					rootActiveSessionId: "stale",
					sessionFile: f.paths.sourceFile,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					consecutiveFailures: 0,
					createCommand: { type: "create", sessionPath: f.paths.sourceFile },
				}),
			);
			const resume = vi.spyOn(MeshEndpoints.prototype, "resumeSession");
			try {
				const fStarted = await start(f.root, f.sourceDir, f.socket);
				expect(harness(fStarted).workers.size).toBe(phase === "skipped" ? 1 : 0);
				expect(resume).not.toHaveBeenCalled();
				expect(startupReports.get(fStarted)).toMatchObject([
					{ status: phase === "skipped" ? "skipped" : "rolled_back", sourceFile: f.paths.sourceFile },
				]);
				expect(fs.existsSync(join(descriptors, "stale.json"))).toBe(phase === "skipped");
				expect(fs.existsSync(f.paths.journalPath)).toBe(phase === "skipped");
				expect(fs.existsSync(f.paths.sourceFile)).toBe(true);
				await harness(fStarted).cleanupSupervisorResources();
				const second = await start(f.root, f.sourceDir, f.socket, descriptors);
				expect(harness(second).workers.size).toBe(phase === "skipped" ? 1 : 0);
				expect(adopt).toHaveBeenCalledTimes(phase === "skipped" ? 2 : 0);
			} finally {
				held?.release();
			}
		},
	);
	it("AC-27/AC-31 target open repairs records; source recovery never deletes either backup and repeats as a no-op", async () => {
		const f = await fixture();
		const failure = vi.spyOn(enrollment, "updateEnrollmentPath").mockRejectedValueOnce(new Error("record refused"));
		expect(await dispatch(f)).toMatchObject({ success: true, data: { moved: true } });
		failure.mockRestore();
		const target = await start(f.root, f.targetDir, f.targetSocket);
		SessionManager.open(f.paths.targetFile, f.targetDir);
		await harness(target).mesh.openSession(f.id, f.paths.targetFile);
		expect(enrollment.readEnrollment(f.meshRoot, f.id).sessionFile).toBe(f.paths.targetFile);
		expect(enrollment.readDirectory(f.meshRoot, f.id)?.homeSocket).toBe(f.targetSocket);
		await harness(f.supervisor!).cleanupSupervisorResources();
		const remove = vi.spyOn(fs, "rmSync");
		const restarted = await start(f.root, f.sourceDir, f.socket);
		expect(remove).not.toHaveBeenCalledWith(f.paths.sourceArtifacts, expect.anything());
		const reports = startupReports.get(restarted);
		expect(reports).toMatchObject([
			{ status: "moved", backups: [{ path: f.paths.sourceBackup }, { path: f.paths.sourceArtifacts }] },
		]);
		expect(fs.existsSync(f.paths.sourceBackup)).toBe(true);
		expect(fs.existsSync(f.paths.sourceArtifacts)).toBe(true);
		expect(fs.existsSync(f.paths.journalPath)).toBe(false);
		expect(() => enrollment.claimEnrollment(f.meshRoot, f.id, f.paths.targetFile)).toThrow();
		expect(await harness(restarted).recoverSessionMoves()).toEqual([]);
	});

	it("AC-19 old protocol-7 client lists on new daemon without the move capability", async () => {
		const f = await fixture();
		const client = new DaemonClient(f.socket);
		clients.push(client);
		await client.connect();
		const hello = await client.waitForHello();
		expect(hello.schemaRevision).toBe(36);
		expect(hello.serverCapabilities).toContain("session_move");
		const wire = createDaemonCommandEnvelope({ type: "list" }, "old-client", "old-client", 7);
		const response = await new Promise<DaemonResponse>((done) => {
			const off = client.onMessage((message) => {
				if (message.type === "response" && message.id === wire.id) {
					off();
					done(message);
				}
			});
			const socket = Reflect.get(client, "socket") as Socket;
			socket.write(serializeJsonLine(wire));
		});
		expect(response).toMatchObject({ success: true, data: { sessions: [] } });
	});
});
