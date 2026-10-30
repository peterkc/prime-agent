import { ChildProcess, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type * as Net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import type * as StopConfirm from "../src/cli/daemon-stop-confirm.js";
import { promptYesNo } from "../src/cli/daemon-stop-confirm.js";
import { handlePublicCommand } from "../src/cli/public-command.js";
import { repositorySocketPath } from "../src/cli/repository-daemon.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.js";
import { sessionMovePaths } from "../src/core/session-move.js";
import { resolveSessionPath } from "../src/core/session-resolver.js";
import { enrollmentPath } from "../src/modes/daemon/cotal/enrollment.js";
import { DAEMON_PROTOCOL_INFO, type DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../src/modes/daemon/daemon-socket.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { spawnHidden } from "../src/utils/child-process.js";

vi.mock("node:net", async (original) => ({
	...(await original<typeof Net>()),
	createConnection: (path: string) => connect(path),
}));
vi.mock("../src/utils/child-process.js", () => ({ spawnHidden: vi.fn() }));
vi.mock("../src/cli/daemon-stop-confirm.js", async (original) => ({
	...(await original<typeof StopConfirm>()),
	promptYesNo: vi.fn(),
}));

let home: string;
let f: ReturnType<typeof fixture>;
let sourceState: "capable" | "absent" | "old" | "schema" | "unreadable" | "invalid-list" | "no-hello";
let roster: object[];
let mesh: "updated" | "not_enrolled" | "failed";
let method: "trash" | "unlink";
let meshReason: string;
let recovered: object[];
let moveFailure: boolean | "before-send";
let blockingJobId: string | undefined;
let targetRunning: boolean;
let holdMove: boolean;
let moveReceived: () => void;
let heldReply: () => void;
const connected: string[] = [];
const requests: { socket: string; command: DaemonCommand }[] = [];
const sockets = new Set<Duplex>();
const originalCwd = process.cwd();
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function session(path: string, id = "session-1", name = "moving", header: Partial<SessionHeader> = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${[
			{
				type: "session",
				id,
				version: CURRENT_SESSION_VERSION,
				timestamp: "2026-01-01T00:00:00Z",
				cwd: join(home, "source"),
				rlmDepth: 0,
				...header,
			},
			{ type: "session_info", id: "name", parentId: null, timestamp: "2026-01-01T00:00:01Z", name },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}
function fixture() {
	const source = join(home, "source");
	const target = join(home, "target's folder");
	for (const folder of [source, target]) {
		mkdirSync(folder);
		execFileSync("git", ["init", "--quiet", folder]);
	}
	const sourceDir = join(source, ".prime/agent/sessions");
	const targetDir = join(target, ".prime/agent/sessions");
	const sourceFile = join(sourceDir, "saved.jsonl");
	session(sourceFile);
	const checked = sessionMovePaths({
		sessionId: "session-1",
		agentDir: home,
		sourceSessionDir: sourceDir,
		targetSessionDir: targetDir,
		sourceFile,
	});
	if (!checked.ok) throw new Error(checked.reason);
	const paths = checked.value;
	mkdirSync(paths.sourceArtifacts, { recursive: true });
	writeFileSync(join(paths.sourceArtifacts, "keep.txt"), "keep");
	const enrollment = enrollmentPath(join(home, "mesh"), "session-1");
	mkdirSync(dirname(enrollment), { recursive: true });
	writeFileSync(enrollment, "enrolled");
	const log = join(home, "client-errors.log");
	writeFileSync(log, "unchanged launch log");
	return {
		source,
		target,
		sourceDir,
		targetDir,
		sourceFile,
		paths,
		sourceSocket: repositorySocketPath(source),
		targetSocket: repositorySocketPath(target),
	};
}
class WireSocket extends Duplex {
	constructor(readonly path: string) {
		super();
	}
	_read(): void {}
	_write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
		const envelope = JSON.parse(chunk.toString());
		const command: DaemonCommand = envelope.command ?? envelope;
		requests.push({ socket: this.path, command });
		if (command.type !== "ack_result") {
			const response =
				command.type === "move_saved_session"
					? moved(command)
					: sourceState === "unreadable"
						? { success: false, error: "roster unavailable" }
						: { success: true, data: { sessions: sourceState === "invalid-list" ? null : roster } };
			const reply = () =>
				this.push(`${JSON.stringify({ type: "response", id: envelope.id, command: command.type, ...response })}\n`);
			if (command.type === "move_saved_session" && holdMove) {
				heldReply = reply;
				moveReceived();
			} else reply();
			if (command.type === "list" && moveFailure === "before-send") this.destroy();
		}
		done();
	}
}
function connect(path: string): Duplex {
	connected.push(path);
	const socket = new WireSocket(path);
	sockets.add(socket);
	queueMicrotask(() => {
		if ((path === f.sourceSocket && sourceState === "absent") || (path === f.targetSocket && !targetRunning)) {
			socket.emit("error", Object.assign(new Error(`connect ENOENT ${path}`), { code: "ENOENT" }));
			return;
		}
		socket.emit("connect");
		if (sourceState === "no-hello") {
			socket.destroy();
			return;
		}
		socket.push(
			`${JSON.stringify({
				type: "daemon_hello",
				protocol: DAEMON_PROTOCOL_INFO,
				schemaRevision: sourceState === "schema" ? 35 : 36,
				serverCapabilities: sourceState === "old" ? [] : ["session_move"],
				clientId: "fake",
				socketPath: path,
			})}\n`,
		);
	});
	return socket;
}
function moved(command: Extract<DaemonCommand, { type: "move_saved_session" }>) {
	if (moveFailure) return { success: false, error: "move refused", data: { recovered } };
	const entries = readFileSync(command.sessionPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const targetFile = join(command.targetSessionDir, `${entries[0].id}.jsonl`);
	entries[0].cwd = command.targetCwd;
	writeFileSync(targetFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	rmSync(command.sessionPath);
	if (mesh !== "failed") rmSync(f.paths.sourceArtifacts, { recursive: true });
	return {
		success: true,
		data: {
			moved: true,
			targetFile,
			original: {
				deleted: mesh !== "failed",
				method: mesh === "failed" ? undefined : method,
				backups:
					mesh === "failed"
						? [
								{ path: f.paths.sourceBackup, reason: "mesh failed" },
								{ path: f.paths.sourceArtifacts, reason: "mesh failed" },
							]
						: [],
			},
			mesh: { status: mesh, ...(mesh === "failed" ? { step: "directory", reason: meshReason } : {}) },
			messages: ["Session moved"],
			recovered,
			recoveryPending: mesh === "failed",
		},
	};
}
function tree(folder: string = home): object {
	const rows: Record<string, unknown> = {};
	function walk(path: string): void {
		const meta = lstatSync(path);
		rows[relative(home, path)] = [
			meta.mode,
			meta.size,
			meta.mtimeMs,
			meta.isFile() ? readFileSync(path).toString("base64") : null,
		];
		if (meta.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
	}
	walk(folder);
	return rows;
}
function output(): string {
	return vi.mocked(console.log).mock.calls.flat().join("\n");
}
function errors(): string {
	return vi.mocked(console.error).mock.calls.flat().join("\n") + output();
}
function readOnly(before: object, env: object): void {
	expect(tree()).toEqual(before);
	expect(process.env).toEqual(env);
	expect(spawnHidden).not.toHaveBeenCalled();
	for (const { command } of requests) expect(command).toEqual({ type: "list", id: expect.any(String) });
	expect(connected.filter((socket) => socket !== f.sourceSocket)).toEqual([]);
}
async function run(extra: string[] = [], selector = "moving", folder = f.target): Promise<void> {
	await handlePublicCommand(["move", selector, folder, ...extra]);
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "move-cli-")));
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv(ENV_SESSION_DIR, join(home, "inherited-session-dir"));
	sourceState = "capable";
	targetRunning = true;
	roster = [];
	mesh = "updated";
	method = "unlink";
	meshReason = "record refused";
	recovered = [];
	moveFailure = false;
	blockingJobId = undefined;
	holdMove = false;
	connected.length = 0;
	requests.length = 0;
	process.exitCode = undefined;
	Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(promptYesNo).mockResolvedValue(false);
	vi.mocked(spawnHidden).mockImplementation(() => {
		sourceState = "capable";
		return new ChildProcess();
	});
	f = fixture();
	process.chdir(f.source);
});
afterEach(() => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	process.chdir(originalCwd);
	process.exitCode = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	rmSync(home, { recursive: true, force: true });
});
const refusals = [
	["missing", "No session found"],
	["ambiguous", "Ambiguous"],
	["external", "not a direct child"],
	["child", "RLM child"],
	["children", "RLM children"],
	["legacy-children", "RLM children"],
	["artifact-child", "RLM children"],
	["active", "scheduled job"],
	["paused", "scheduled job"],
	["journal", "waiting for recovery"],
	["version", "upgrade"],
	["parent", "upgrade"],
	["unsafe", "Unsafe session ID"],
	["hidden", "Unsafe session ID"],
	["dotted", "moves require mesh-compatible IDs"],
	["escape", "not a direct child"],
	["old", "session_move"],
	["schema", "session_move"],
	["unreadable", "roster unavailable"],
	["invalid-list", "invalid session list"],
	["no-hello", "source daemon"],
	["same", "same"],
	["missing-folder", "ENOENT"],
	["file-folder", "not a directory"],
	["target-id", "already holds"],
	["target-file", "already exists"],
	["artifacts", "already exists"],
	["renamed", "named moving"],
	["open", "currently active"],
] as const;
async function refusal(kind: string): Promise<[string, string]> {
	let selector = "moving",
		folder = f.target;
	if (kind === "missing") selector = "unknown";
	if (kind === "ambiguous") session(join(f.sourceDir, "second.jsonl"), "other");
	if (kind === "external") {
		selector = join(home, "outside.jsonl");
		session(selector);
	}
	if (["child", "version", "parent", "unsafe", "hidden", "dotted"].includes(kind))
		session(
			f.sourceFile,
			kind === "unsafe" ? "a/b" : kind === "hidden" ? ".hidden" : kind === "dotted" ? "session.1" : "session-1",
			"moving",
			kind === "child"
				? { rlmDepth: 1 }
				: kind === "version"
					? { version: 2 }
					: kind === "parent"
						? { parentSession: "parent", rlmDepth: undefined }
						: {},
		);
	if (kind === "artifact-child") session(join(f.paths.sourceArtifacts, "unregistered.data"), "child");
	if (kind === "children" || kind === "legacy-children") {
		const child = join(f.paths.sourceArtifacts, "child.jsonl");
		session(child, "child");
		if (kind === "children")
			await new RlmSpawnLedger(home, f.sourceDir).appendSpawn({
				childId: "child",
				parent: f.sourceFile,
				child,
				depth: 1,
				name: "child",
			});
		else
			writeFileSync(
				join(f.paths.sourceArtifacts, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: "child",
					sessionName: "child",
					sessionFile: child,
					status: "completed",
				})}\n`,
			);
	}
	if (kind === "active" || kind === "paused") {
		const jobs = AgentCronJobStore.forSessionArtifacts();
		jobs.registerSessionArtifact("session-1", f.paths.sourceArtifacts);
		const job = await jobs.create({
			sessionId: "session-1",
			activeSessionId: "session-1",
			sessionFile: f.sourceFile,
			cwd: f.source,
			prompt: "test",
			source: "heartbeat",
			scheduleText: "in 1 day",
		});
		if (kind === "paused") await jobs.manageHeartbeat("session-1", job.id, "pause");
		blockingJobId = job.id;
	}
	if (kind === "journal") {
		mkdirSync(dirname(f.paths.journalPath));
		writeFileSync(f.paths.journalPath, "{}");
	}
	if (kind === "escape") {
		const outside = join(home, "outside");
		mkdirSync(outside);
		rmSync(f.paths.sourceArtifacts, { recursive: true });
		symlinkSync(outside, f.paths.sourceArtifacts);
	}
	if (["old", "schema", "unreadable", "invalid-list", "no-hello"].includes(kind))
		sourceState = kind as typeof sourceState;
	if (kind === "same") folder = f.source;
	if (kind === "missing-folder") folder = join(home, "missing");
	if (kind === "file-folder") folder = f.sourceFile;
	if (kind === "target-id" || kind === "target-file")
		session(join(f.targetDir, kind === "target-id" ? "other.jsonl" : "session-1.jsonl"));
	if (kind === "artifacts") mkdirSync(f.paths.targetArtifacts, { recursive: true });
	if (kind === "renamed") {
		const path = join(f.targetDir, "other.jsonl");
		session(path, "other", "old");
		writeFileSync(
			path,
			readFileSync(path, "utf8") +
				JSON.stringify({
					type: "session_info",
					id: "later",
					parentId: "name",
					timestamp: "2026-01-01T00:00:02Z",
					name: "moving",
				}) +
				"\n",
		);
	}
	if (kind === "open")
		roster = [{ id: "active", activeSessionId: "active", sessionId: "session-1", sessionFile: f.sourceFile }];
	return [selector, folder];
}
describe("session move command", () => {
	it.each([false, true].flatMap((failed) => [false, true].map((json) => ({ failed, json }))))(
		"F6 recovery output survives failed=$failed json=$json",
		async ({ failed, json }) => {
			moveFailure = failed;
			recovered = [
				{
					status: "moved",
					messages: ["Finished earlier move"],
					backups: [{ path: "/backup.moved", reason: "delete by hand" }],
				},
			];
			await run(["--yes", ...(json ? ["--json"] : [])]);
			expect(process.exitCode).toBe(failed ? 1 : undefined);
			if (json) expect(JSON.parse(output()).recovered).toEqual(recovered);
			else
				for (const text of ["Recovered move: moved", "Finished earlier move", "/backup.moved", "delete by hand"])
					expect(output()).toContain(text);
		},
	);
	it.each(["delayed", "disconnect", "timeout", "before-send"])(
		"F2 move reply %s distinguishes sent and unsent requests",
		async (mode) => {
			holdMove = true;
			if (mode === "before-send") moveFailure = mode;
			const received = new Promise<void>((resolve) => {
				moveReceived = resolve;
			});
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const moving = run(["--yes"]);
			try {
				if (mode !== "before-send") await received;
				if (mode === "disconnect") for (const socket of sockets) socket.destroy();
				else if (mode !== "before-send")
					await vi.advanceTimersByTimeAsync(mode === "timeout" ? 24 * 60 * 60 * 1000 : 30_001);
				if (mode === "delayed") heldReply();
				await moving;
				expect(process.exitCode).toBe(mode === "delayed" ? undefined : 1);
				expect(errors()).toContain(
					mode === "delayed" ? "Moved" : mode === "before-send" ? "Nothing moved" : "Move result is unknown",
				);
				if (mode === "before-send")
					expect(requests.some(({ command }) => command.type === "move_saved_session")).toBe(false);
				if (mode !== "delayed" && mode !== "before-send") {
					for (const text of [f.target, "--dry-run again"]) expect(errors()).toContain(text);
					expect(errors()).not.toMatch(/nothing moved/i);
				}
			} finally {
				if (mode !== "before-send") heldReply();
				await moving;
				vi.useRealTimers();
			}
		},
	);
	it.each(
		[[], ["--dry-run"], ["--dry-run", "--json"]].flatMap((flags) =>
			refusals.map(([kind, reason]) => ({ flags, kind, reason })),
		),
	)("AC-20/AC-28 refuses $kind ($flags) without any change", async ({ flags, kind, reason }) => {
		const [selector, folder] = await refusal(kind);
		const before = tree(),
			env = { ...process.env };
		await run(flags.length ? flags : ["--yes"], selector, folder);
		expect(process.exitCode).toBe(1);
		expect(errors()).toContain(reason);
		if (blockingJobId) expect(errors()).toContain(`cancel these jobs first: ${blockingJobId}`);
		if (flags.includes("--json"))
			expect(JSON.parse(output())).toMatchObject({ dryRun: true, error: expect.stringContaining(reason) });
		readOnly(before, env);
		expect(promptYesNo).not.toHaveBeenCalled();
	});
	it.each(["declined", "declined-json", "no-terminal"])("AC-20 refuses %s before preparation", async (kind) => {
		Object.defineProperty(process.stdin, "isTTY", { value: kind.startsWith("declined"), configurable: true });
		const before = tree(),
			env = { ...process.env };
		vi.mocked(promptYesNo).mockImplementation(async () => {
			for (const text of [
				f.sourceFile,
				f.paths.targetFile,
				f.paths.sourceArtifacts,
				"Trash",
				"unlinked if trash is missing",
				"artifact folder is removed",
			])
				expect(errors()).toContain(text);
			return false;
		});
		await run(kind === "declined-json" ? ["--json"] : []);
		expect(process.exitCode).toBe(1);
		const error = kind === "declined-json" ? JSON.parse(output()).error : errors();
		expect(error).toContain(kind.startsWith("declined") ? "declined" : "--yes");
		readOnly(before, env);
	});
	it.each([
		["absent", false],
		["capable", false],
		["capable", true],
	] as const)(
		"AC-28 dry run reads %s source (outside repo=%s) and never prompts, starts or writes",
		async (state, outside) => {
			sourceState = state;
			const before = tree(),
				env = { ...process.env };
			await run(["--dry-run"], "moving", outside ? home : f.target);
			expect(process.exitCode).toBeUndefined();
			for (const text of [
				"moving",
				"session-1",
				outside ? join(home, "inherited-session-dir/session-1.jsonl") : f.paths.targetFile,
				f.sourceFile,
				f.paths.sourceArtifacts,
				"Mesh: enrolled",
				"no process has the session open",
				"--resume session-1",
			])
				expect(output()).toContain(text);
			expect(promptYesNo).not.toHaveBeenCalled();
			readOnly(before, env);
		},
	);
	it("AC-28 JSON dry run has the preview fields and no side effects", async () => {
		const before = tree(),
			env = { ...process.env };
		await run(["--dry-run", "--json"]);
		expect(JSON.parse(output())).toMatchObject({
			dryRun: true,
			sessionId: "session-1",
			name: "moving",
			targetFile: f.paths.targetFile,
			original: { file: f.sourceFile, artifacts: f.paths.sourceArtifacts },
			mesh: { enrolled: true },
			recheck: expect.stringContaining("no process has the session open"),
		});
		expect(promptYesNo).not.toHaveBeenCalled();
		readOnly(before, env);
	});
	it.each([
		["absent", "session-1"],
		["running", "session-1"],
		["running", "-session-1"],
		["persisted", "session-1"],
		["environment", "session-1"],
	])("AC-21/AC-22/AC-23 move never contacts %s target; printed ID %s resumes saved-only", async (state, id) => {
		targetRunning = state === "running";
		session(f.sourceFile, id);
		const targetDir =
			state === "persisted"
				? join(home, "custom")
				: state === "environment"
					? join(home, "inherited-session-dir")
					: f.targetDir;
		if (state === "persisted") {
			const key = createHash("sha256").update(f.targetSocket).digest("hex").slice(0, 12);
			const folder = join(home, "daemon-workers", key);
			mkdirSync(folder, { recursive: true });
			writeFileSync(
				join(folder, "supervisor-config"),
				JSON.stringify({
					version: 1,
					socketPath: f.targetSocket,
					defaultSessionConfig: { agentDir: home, sessionDir: targetDir },
				}),
			);
		}
		const folder = state === "environment" ? home : f.target;
		await run(["--yes", "--json"], "moving", folder);
		const result = JSON.parse(output());
		const targetFile = join(targetDir, `${id}.jsonl`);
		expect(process.exitCode).toBeUndefined();
		expect(result).toMatchObject({
			moved: true,
			name: "moving",
			sessionId: id,
			targetFile,
			original: { deleted: true, method: "unlink", backups: [] },
			mesh: { status: "updated" },
		});
		const resume = id.startsWith("-") ? `--resume=${id}` : `--resume ${id}`;
		expect(result.openCommand).toBe(`cd '${folder.replaceAll("'", `'"'"'`)}' && prime-agent ${resume}`);
		const parsed = parseArgs(result.openCommand.split(" && prime-agent ")[1].split(" "));
		expect(parsed.resume).toBe(id);
		expect(await resolveSessionPath(String(parsed.resume), folder, targetDir)).toMatchObject({ path: targetFile });
		expect(connected).not.toContain(state === "environment" ? defaultDaemonSocketPath() : f.targetSocket);
		if (state === "persisted") expect(existsSync(f.targetDir)).toBe(false);
		expect(spawnHidden).not.toHaveBeenCalled();
		if (state !== "environment" && state !== "persisted")
			expect(readFileSync(join(f.target, ".git/info/exclude"), "utf8")).toContain("/.prime/agent/sessions/");
	});
	it("AC-22 starts an absent source through the non-replacing launch path", async () => {
		sourceState = "absent";
		await run(["--yes", "--json"]);
		expect(process.exitCode).toBeUndefined();
		expect(spawnHidden).toHaveBeenCalledTimes(1);
		const [, args, config] = vi.mocked(spawnHidden).mock.calls[0]!;
		expect(args).toEqual(
			expect.arrayContaining(["--mode", "daemon", "--daemon-socket", f.sourceSocket, "--session-dir", f.sourceDir]),
		);
		expect(config).toMatchObject({ cwd: f.source });
		expect(connected).not.toContain(f.targetSocket);
		expect(requests.map(({ command }) => command.type)).not.toEqual(expect.arrayContaining(["shutdown", "restart"]));
	});
	it("#55 failed source launch leaves the target repository unchanged", async () => {
		sourceState = "absent";
		const before = tree();
		vi.mocked(spawnHidden).mockImplementation(() => {
			throw new Error("launch refused");
		});
		await run(["--yes"]);
		expect(process.exitCode).toBe(1);
		expect(errors()).toContain("launch refused");
		expect(tree()).toEqual(before);
	});
	it.each(["trash", "unlink", "not_enrolled", "failed", "journal"] as const)(
		"AC-23 prints deletion and mesh outcome %s with the open command",
		async (outcome) => {
			if (outcome === "trash" || outcome === "unlink") method = outcome;
			else mesh = outcome === "journal" ? "failed" : outcome;
			if (outcome === "journal") meshReason = "Mesh records were not written: committed journal write refused";
			await run(["--yes"]);
			expect(process.exitCode).toBeUndefined();
			for (const text of ["moving", "session-1", f.paths.targetFile, "--resume session-1", "hosts"])
				expect(output()).toContain(text);
			expect(output()).toContain(
				outcome === "trash"
					? "trashed"
					: outcome === "unlink"
						? "unlinked"
						: outcome === "not_enrolled"
							? "not enrolled"
							: meshReason,
			);
			if (mesh === "failed")
				for (const text of [
					"next start or move",
					"backup to delete by hand",
					f.paths.sourceArtifacts,
					f.paths.sourceBackup,
				])
					expect(output()).toContain(text);
		},
	);
});
