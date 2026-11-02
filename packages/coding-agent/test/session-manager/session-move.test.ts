import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { findAgentTraceFiles } from "../../src/core/agent-traces.js";
import {
	acquireSessionDeleteLeases,
	deleteSessionFile,
	sessionArtifactFiles,
} from "../../src/core/session-file-actions.js";
import {
	acquireSessionLease,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
} from "../../src/core/session-lease.js";
import {
	appendCustomMessageToExistingFile,
	appendSessionInfoToExistingFile,
	appendSessionStateToExistingFile,
	type FileEntry,
	loadEntriesFromFile,
	SessionManager,
} from "../../src/core/session-manager.js";
import {
	acquireSessionMoveLeases,
	recoverSessionMove,
	relocateSession,
	rollbackSessionMove,
	type SessionMoveCallbacks,
	type SessionMoveJournal,
	type SessionMoveRecoveryCallbacks,
	sessionMovePaths,
	transformSessionMoveEntries,
	verifySessionMoveCopy,
} from "../../src/core/session-move.js";
import { restartOf, serializeSessionEntries, withRotationRestart } from "../../src/core/session-rotation-state.js";
import { sessionArchivePath } from "../../src/core/session-storage-paths.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { AgentsViewMode } from "../../src/modes/agents-view/agents-view-mode.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import { writeFileAtomicSync } from "../../src/utils/atomic-file.js";
import { spawnHidden } from "../../src/utils/child-process.js";
import { assistantMsg, userMsg } from "../utilities.js";

let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "session-move-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function jsonl(entries: readonly FileEntry[]): string {
	return serializeSessionEntries(entries);
}
function readEntries(path: string): FileEntry[] {
	return loadEntriesFromFile(path);
}
function fixture() {
	const sourceSessionDir = join(home, "source", "sessions");
	const targetSessionDir = join(home, "target", "sessions");
	const agentDir = join(home, "agent");
	const targetCwd = join(home, "repo");
	for (const path of [sourceSessionDir, targetSessionDir, agentDir, targetCwd]) mkdirSync(path, { recursive: true });
	const built = sessionMovePaths({
		sessionId: "session-1",
		sourceSessionDir,
		targetSessionDir,
		agentDir,
		sourceFile: join(sourceSessionDir, "session-1.jsonl"),
	});
	if (!built.ok) throw new Error(built.reason);
	const paths = built.value;
	const entries = [
		{
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01",
			cwd: home,
			parentSession: "parent.jsonl",
			rlmDepth: 0,
			git: { branch: "old" },
		},
		{ type: "session_info", id: "one", parentId: null, timestamp: "t1", name: "Named" },
		{ type: "git_state", id: "git-one", parentId: "one", timestamp: "t2", git: { branch: "old" } },
		{ type: "git_state", id: "git-two", parentId: "git-one", timestamp: "t3", git: { branch: "old" } },
		{
			type: "custom",
			id: "kept",
			parentId: "git-two",
			timestamp: "t4",
			customType: "fixture",
			data: { keep: [1, 2] },
		},
		{ type: "git_state", id: "trailing", parentId: "kept", timestamp: "t5", git: { branch: "old" } },
	] as const satisfies readonly FileEntry[];
	const expected = [
		{ ...entries[0], cwd: targetCwd, git: undefined },
		entries[1],
		{ ...entries[4], parentId: "one" },
	] as const satisfies readonly FileEntry[];
	writeFileSync(paths.sourceFile, jsonl(entries));
	mkdirSync(join(paths.sourceArtifacts, "nested"), { recursive: true });
	writeFileSync(join(paths.sourceArtifacts, "nested", "file.bin"), Buffer.from([1, 2, 3, 4]));
	const enrollment = join(agentDir, "enrollment.json");
	const directory = join(agentDir, "directory.json");
	writeFileSync(enrollment, JSON.stringify({ path: paths.sourceFile }));
	writeFileSync(directory, JSON.stringify({ socket: "old.sock" }));
	const events: string[] = [];
	const callbacks: { -readonly [K in keyof SessionMoveCallbacks]: SessionMoveCallbacks[K] } = {
		suspend: async () => {
			events.push("suspend");
			return true;
		},
		resume: async () => {
			events.push("resume");
		},
		writeMeshRecords: async (journal, writes) => {
			events.push("mesh");
			if (writes.enrollment)
				writeFileAtomicSync(enrollment, JSON.stringify({ path: journal.targetFile }), {
					fsync: true,
					fsyncDir: true,
				});
			if (writes.directory)
				writeFileAtomicSync(directory, JSON.stringify({ socket: journal.targetSocket }), {
					fsync: true,
					fsyncDir: true,
				});
		},
		releaseClaim: () => {
			events.push("release claim");
		},
		releaseLeases: () => {
			events.push("release leases");
		},
	};
	const recovery: { -readonly [K in keyof SessionMoveRecoveryCallbacks]: SessionMoveRecoveryCallbacks[K] } = {
		acquireLeases: (journal) => acquireSessionMoveLeases(journal, agentDir),
		readEnrollmentPath: () => JSON.parse(readFileSync(enrollment, "utf8")).path,
		readDirectorySocket: () => JSON.parse(readFileSync(directory, "utf8")).socket,
		acquireClaim: async () => {
			events.push("claim");
			return true;
		},
		writeMeshRecords: callbacks.writeMeshRecords,
		releaseClaim: callbacks.releaseClaim,
	};
	return { paths, entries, expected, targetCwd, events, callbacks, recovery, enrollment, directory };
}
type Fixture = ReturnType<typeof fixture>;
function journalState(
	f: Fixture,
	phase: SessionMoveJournal["phase"],
	state: "empty" | "file" | "artifacts" | "renamed" | "promoted" | "published" = "file",
): SessionMoveJournal {
	const bytes = Buffer.from(jsonl(f.expected));
	const journal: SessionMoveJournal = {
		...f.paths,
		version: 1,
		targetCwd: f.targetCwd,
		targetSocket: "new.sock",
		endpointSuspended: true,
		phase,
		artifactsPresent: true,
		createdDirectories: [],
		fileBytes: bytes.length,
		fileSha256: hash(bytes),
	};
	mkdirSync(dirname(journal.journalPath), { recursive: true });
	if (state !== "empty") writeFileSync(journal.fileTemporary, bytes);
	if (["artifacts", "renamed", "promoted", "published"].includes(state))
		cpSync(journal.sourceArtifacts, journal.artifactTemporary, { recursive: true });
	if (existsSync(journal.artifactTemporary)) {
		const { dev, ino } = lstatSync(journal.artifactTemporary, { bigint: true });
		Object.assign(journal, { artifactIdentity: `${dev}:${ino}` });
	}
	writeFileSync(journal.journalPath, JSON.stringify(journal));
	if (["renamed", "promoted", "published"].includes(state)) renameSync(journal.sourceFile, journal.sourceBackup);
	if (["promoted", "published"].includes(state)) renameSync(journal.artifactTemporary, journal.targetArtifacts);
	if (state === "published") renameSync(journal.fileTemporary, journal.targetFile);
	return journal;
}
function recover(f: Fixture) {
	return recoverSessionMove({ ...f.paths, callbacks: f.recovery });
}
async function move(f: Fixture) {
	const leases = acquireSessionMoveLeases(f.paths, f.paths.agentDir);
	const releaseLeases = f.callbacks.releaseLeases;
	return relocateSession({
		paths: f.paths,
		targetCwd: f.targetCwd,
		targetSocket: "new.sock",
		callbacks: {
			...f.callbacks,
			releaseLeases: async () => {
				leases.release();
				await releaseLeases();
			},
		},
	});
}
function noTrash() {
	const bin = join(home, "empty-bin");
	mkdirSync(bin);
	vi.stubEnv("PATH", bin);
}
function fakeTrash(f: Fixture, mode: "success" | "failure" | "broken-interpreter", lateWrite = false) {
	const bin = join(home, "bin");
	mkdirSync(bin);
	const script =
		mode === "broken-interpreter"
			? "#!/missing-interpreter\n"
			: `#!${process.execPath}\nconst fs = require('node:fs');\n${mode === "success" ? `if (!fs.existsSync(${JSON.stringify(f.paths.sourceArtifacts)})) process.exit(7); ${lateWrite ? `fs.writeFileSync(${JSON.stringify(join(f.paths.sourceArtifacts, "late"))}, "new artifact");` : ""} fs.renameSync(process.argv[2], ${JSON.stringify(join(home, "trashed"))});` : "process.stderr.write('refused'); process.exitCode = 9;"}\n`;
	writeFileSync(join(bin, "trash"), script, { mode: 0o755 });
	vi.stubEnv("PATH", bin);
}
function untouchedSource(f: Fixture) {
	expect(readEntries(f.paths.sourceFile)).toEqual(f.entries);
	for (const path of [
		f.paths.sourceBackup,
		f.paths.fileTemporary,
		f.paths.artifactTemporary,
		f.paths.targetFile,
		f.paths.targetArtifacts,
		f.paths.journalPath,
	])
		expect(existsSync(path)).toBe(false);
}

describe("session relocation", () => {
	it.each(["deactivate", "in-process rename", "daemon rename"])(
		"F10 %s refuses a saved file held by another lease",
		async (writer) => {
			const f = fixture();
			const before = readFileSync(f.paths.sourceFile);
			const leases = acquireSessionMoveLeases(f.paths, f.paths.agentDir);
			try {
				if (writer === "deactivate") {
					const status = vi.fn();
					const view = Object.assign(Object.create(AgentsViewMode.prototype), {
						options: { config: { agentDir: f.paths.agentDir } },
						pendingDeleteAgent: { identity: "saved", sessionFile: f.paths.sourceFile },
						inactiveAgentIdentities: new Set(),
						setStatusMessage: status,
						clearDeleteConfirmation: vi.fn(),
						refreshSessions: vi.fn(),
						refreshSavedSessionsIfLoaded: vi.fn(),
					});
					await Reflect.get(view, "deactivatePendingAgent").call(view);
					expect(status).toHaveBeenLastCalledWith(expect.stringContaining("open or being moved"));
				} else if (writer === "in-process rename") {
					const connection = Object.create(InProcessAgentConnection.prototype) as InProcessAgentConnection;
					Reflect.set(connection, "runtimeHost", { session: {}, services: { agentDir: f.paths.agentDir } });
					await expect(connection.renameSavedSession(f.paths.sourceFile, "new")).rejects.toThrow(
						"open or being moved",
					);
				} else {
					const daemon = new AgentDaemon(join(home, "unused.sock"), {
						createRuntime: vi.fn(async () => {
							throw new Error("Unexpected runtime creation");
						}),
						defaultSessionConfig: {
							agentDir: f.paths.agentDir,
							cwd: f.targetCwd,
							sessionDir: f.paths.sourceSessionDir,
						},
					});
					const command = { type: "rename_saved_session", sessionPath: f.paths.sourceFile, name: "new" };
					await expect(Reflect.get(daemon, "handleCommand").call(daemon, {}, command)).rejects.toThrow(
						"open or being moved",
					);
				}
				expect(readFileSync(f.paths.sourceFile)).toEqual(before);
			} finally {
				leases.release();
			}
		},
	);

	it("AC-1 keeps the ID and header fields, transforms entries and the trailing git leaf, and copies artifact digests", async () => {
		const f = fixture();
		execFileSync("git", ["init", "--initial-branch=relocated", f.targetCwd]);
		execFileSync("git", ["-C", f.targetCwd, "remote", "add", "origin", "https://example.com/team/repo.git"]);
		const expected = [
			{ ...f.expected[0], git: { branch: "relocated", repoUrl: "https://example.com/team/repo.git" } },
			...f.expected.slice(1),
		];
		const inputBefore = structuredClone(f.entries);
		expect(
			transformSessionMoveEntries(f.entries, f.targetCwd, {
				branch: "relocated",
				repoUrl: "https://example.com/team/repo.git",
			}),
		).toEqual(expected);
		expect(f.entries).toEqual(inputBefore);
		const writeRecords = f.callbacks.writeMeshRecords;
		f.callbacks.writeMeshRecords = async (journal, writes) => {
			const durable = JSON.parse(readFileSync(journal.journalPath, "utf8"));
			expect(durable).toMatchObject({
				phase: "committed",
				endpointSuspended: true,
				fileBytes: readFileSync(journal.targetFile).length,
				fileSha256: hash(readFileSync(journal.targetFile)),
			});
			expect(existsSync(journal.sourceFile)).toBe(false);
			expect(existsSync(journal.sourceBackup)).toBe(true);
			expect(existsSync(journal.fileTemporary)).toBe(false);
			await writeRecords(journal, writes);
		};
		const result = await move(f);
		expect(result.status).toBe("moved");
		expect(readEntries(f.paths.targetFile)).toEqual(expected);
		expect(SessionManager.open(f.paths.targetFile).getLeafId()).toBe("kept");
		expect(readFileSync(join(f.paths.targetArtifacts, "nested", "file.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));
		expect(f.events).toEqual(["suspend", "mesh", "release claim", "release leases"]);
	});
	it.each(["entry", "artifact"] as const)("AC-2 rejects changed target %s bytes before any commit", (kind) => {
		const f = fixture();
		const j = journalState(f, "copying", "artifacts");
		if (kind === "entry")
			writeFileSync(j.fileTemporary, jsonl([{ ...f.expected[0], cwd: "/wrong" }, ...f.expected.slice(1)]));
		else writeFileSync(join(j.artifactTemporary, "nested", "file.bin"), Buffer.from([4, 3, 2, 1]));
		const checked = verifySessionMoveCopy(j, f.entries, undefined);
		expect(checked.ok).toBe(false);
		expect(readEntries(j.sourceFile)).toEqual(f.entries);
		expect(existsSync(j.targetFile)).toBe(false);
	});
	// test-policy: allow conditional-or-disabled-test -- fake trash needs POSIX shebang execution; Fork CI runs Ubuntu
	it.skipIf(process.platform === "win32").each(["success", "missing", "failure", "broken-interpreter"] as const)(
		"AC-3 trash %s removes artifacts only after the backup file is gone",
		async (mode) => {
			const f = fixture();
			if (mode === "missing") noTrash();
			else fakeTrash(f, mode);
			const result = await move(f);
			expect(result.status).toBe("moved");
			const kept = mode === "failure" || mode === "broken-interpreter";
			expect(result.originalMethod).toBe(kept ? undefined : mode === "success" ? "trash" : "unlink");
			expect(existsSync(f.paths.sourceBackup)).toBe(kept);
			expect(existsSync(f.paths.sourceArtifacts)).toBe(kept);
			expect(result.backups.map((backup) => backup.path)).toEqual(
				kept ? [f.paths.sourceBackup, f.paths.sourceArtifacts] : [],
			);
			expect(existsSync(join(home, "trashed"))).toBe(mode === "success");
			expect(existsSync(f.paths.journalPath)).toBe(false);
		},
	);
	it.each([
		{ step: "suspending journal", phase: "suspending", state: "empty" },
		{ step: "copying journal", phase: "copying", state: "empty" },
		{ step: "file temporary", phase: "copying", state: "file" },
		{ step: "artifact temporary", phase: "copying", state: "artifacts" },
		{ step: "committing journal", phase: "committing", state: "artifacts" },
		{ step: "source rename", phase: "committing", state: "renamed" },
		{ step: "artifact promotion", phase: "committing", state: "promoted" },
		{ step: "committed without target", phase: "committed", state: "promoted" },
		{ step: "symlinked agent directory", phase: "copying", state: "file" },
	] as const)("AC-4/AC-6/#55 recovers real pre-commit state $step twice", async ({ step, phase, state }) => {
		const f = fixture();
		journalState(f, phase, state);
		if (step === "symlinked agent directory") {
			const agentDir = join(home, "agent-alias");
			symlinkSync(f.paths.agentDir, agentDir, "dir");
			Object.assign(f.paths, { agentDir, journalPath: join(agentDir, "session-moves", "session-1.json") });
		}
		f.recovery.resume = f.callbacks.resume;
		expect((await recover(f)).status).toBe("rolled_back");
		expect(f.events).toEqual(["resume"]);
		untouchedSource(f);
		expect((await recover(f)).status).toBe("absent");
	});
	it.each(["suspend", "late-symlink", "preflight-child", "late-child"] as const)(
		"AC-4/#55 relocation refuses %s and preserves source artifacts",
		async (step) => {
			const f = fixture();
			const child = join(f.paths.sourceArtifacts, "nested", "child.jsonl");
			if (step === "preflight-child") writeFileSync(child, jsonl(f.entries));
			f.callbacks.suspend = async () => {
				if (step === "suspend") throw new Error("suspend failed");
				if (step === "late-child") writeFileSync(child, jsonl(f.entries));
				else if (step === "late-symlink") symlinkSync(f.paths.sourceFile, join(f.paths.sourceArtifacts, "link"));
				return true;
			};
			const result = await move(f);
			expect(result.status).toBe("rolled_back");
			if (step !== "preflight-child") expect(f.events).toContain("resume");
			if (step.endsWith("child")) expect(readEntries(child)).toEqual(f.entries);
			untouchedSource(f);
		},
	);
	it.each([false, true])("#55 rollback preserves foreign artifacts (source=%s)", async (artifactsPresent) => {
		const f = fixture();
		if (!artifactsPresent) rmSync(f.paths.sourceArtifacts, { recursive: true });
		const j = { ...journalState(f, "committing", artifactsPresent ? "artifacts" : "file"), artifactsPresent };
		mkdirSync(j.targetArtifacts, { recursive: true });
		writeFileSync(join(j.targetArtifacts, "foreign"), "keep");
		writeFileSync(j.journalPath, JSON.stringify(j));
		expect((await recover(f)).status).toBe("rolled_back");
		expect(readFileSync(join(j.targetArtifacts, "foreign"), "utf8")).toBe("keep");
		expect(readEntries(j.sourceFile)).toEqual(f.entries);
		expect((await recover(f)).status).toBe("absent");
	});
	it("AC-5 keeps the journal and foreign source when undo restore fails", async () => {
		const f = fixture();
		const j = journalState(f, "committing", "promoted");
		writeFileSync(j.sourceFile, "other writer");
		const result = await rollbackSessionMove(j, f.callbacks.resume);
		expect(result.status).toBe("pending");
		expect(result.messages.join(" ")).toContain("recovery is pending");
		expect(existsSync(j.journalPath)).toBe(true);
		expect(readFileSync(j.sourceFile, "utf8")).toBe("other writer");
	});
	it.each(["suspending", "copying", "committing", "committed", "appended"] as const)(
		"AC-7/#55 published target wins over %s state and recovery preserves both original backups",
		async (phase) => {
			const f = fixture();
			const j = journalState(f, phase === "appended" ? "committed" : phase, "published");
			if (phase === "appended") writeFileSync(j.targetFile, "\n", { flag: "a" });
			expect((await rollbackSessionMove(j)).status).toBe("pending");
			const result = await recover(f);
			expect(result.status).toBe("moved");
			expect(existsSync(j.sourceFile)).toBe(false);
			expect(readEntries(j.sourceBackup)).toEqual(f.entries);
			expect(result.backups.map((backup) => backup.path)).toEqual([j.sourceBackup, j.sourceArtifacts]);
			expect(readEntries(j.targetFile)).toEqual(JSON.parse(JSON.stringify(f.expected)));
			expect(readdirSync(f.paths.sourceSessionDir).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
			expect((await recover(f)).status).toBe("absent");
		},
	);
	it.each(
		["", "not-json\n", '{"type":"session","id":"foreign"}\n', '{"type":"session"}\n', "{}\n"].concat([
			"truncated prefix",
			"changed prefix",
			"fileBytes",
			"fileSha256",
		]),
	)("AC-8/#55 keeps an invalid published target %j and changes no files", async (content) => {
		const f = fixture();
		const j = journalState(f, "committing", "promoted");
		if (content === "fileBytes" || content === "fileSha256") {
			writeFileSync(j.journalPath, JSON.stringify({ ...j, [content]: undefined }));
			content = jsonl(f.expected);
		}
		if (content === "truncated prefix") content = jsonl(f.expected).slice(0, -1);
		if (content === "changed prefix") content = jsonl(f.expected).replace("Named", "Other");
		writeFileSync(j.targetFile, content);
		const paths = [j.journalPath, j.sourceBackup, f.enrollment, f.directory];
		const before = paths.map((path) => readFileSync(path));
		const result = await recover(f);
		expect(result).toMatchObject({ status: "pending", messages: [expect.stringMatching(/header|prefix|SHA-256/)] });
		expect(f.events).toEqual([]);
		expect(paths.map((path) => readFileSync(path))).toEqual(before);
		expect(readFileSync(j.targetFile, "utf8")).toBe(content);
		expect(existsSync(j.sourceArtifacts)).toBe(true);
	});
	it("AC-9 skips rollback when another process holds a journal file lease", async () => {
		const f = fixture();
		const j = journalState(f, "copying", "artifacts");
		const moduleUrl = new URL("../../src/core/session-lease.ts", import.meta.url).href;
		const script = `import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV } from ${JSON.stringify(moduleUrl)}; const lease = acquireSessionLease(process.argv[1], process.argv[2], { [SESSION_LEASES_ENABLED_ENV]: '1' }); process.on('message', () => { lease.release(); process.exit(0); }); process.send('held');`;
		const child = spawnHidden(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script, j.sourceFile, j.agentDir],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		const exited = once(child, "exit");
		try {
			expect(await once(child, "message")).toEqual(["held", undefined]);
			const before = readFileSync(j.journalPath);
			const result = await recover(f);
			expect(result.status).toBe("skipped");
			expect(readFileSync(j.journalPath)).toEqual(before);
			expect(existsSync(j.fileTemporary)).toBe(true);
			expect(existsSync(j.artifactTemporary)).toBe(true);
		} finally {
			child.send("release");
			await exited;
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
	});
	it("AC-10 skips a published journal when the needed enrollment claim is held elsewhere", async () => {
		const f = fixture();
		const j = journalState(f, "committing", "published");
		f.recovery.acquireClaim = async () => false;
		expect((await recover(f)).status).toBe("skipped");
		expect(existsSync(j.journalPath)).toBe(true);
		expect(f.events).toEqual([]);
	});
	it.each([".moved", ".moving"])(
		"AC-11 open, openAsync, setSessionFile and offline writers refuse %s without changing bytes or manager state",
		async (suffix) => {
			const f = fixture();
			const path = `${f.paths.sourceFile}${suffix}`;
			writeFileSync(path, jsonl(f.entries));
			const bytes = readFileSync(path);
			const manager = SessionManager.create(home, f.paths.targetSessionDir);
			const originalPath = manager.getSessionFile();
			const originalId = manager.getSessionId();
			expect(() => SessionManager.open(path)).toThrow(/move backup or temporary/);
			await expect(SessionManager.openAsync(path)).rejects.toThrow(/move backup or temporary/);
			expect(() => manager.setSessionFile(path)).toThrow(/move backup or temporary/);
			for (const append of [
				() => appendSessionInfoToExistingFile(path, "name", f.paths.agentDir),
				() => appendSessionStateToExistingFile(path, { status: "archived" }, f.paths.agentDir),
				() => appendCustomMessageToExistingFile(path, "notice", "body", false, undefined, f.paths.agentDir),
			])
				expect(append).toThrow(/move backup or temporary/);
			expect(readFileSync(path)).toEqual(bytes);
			expect(manager.getSessionFile()).toBe(originalPath);
			expect(manager.getSessionId()).toBe(originalId);
			expect(existsSync(join(f.paths.agentDir, "session-leases"))).toBe(false);
		},
	);
	it.each([2, 3])("AC-12 a move lease blocks offline writes for version %s, including fallback", (version) => {
		const f = fixture();
		writeFileSync(f.paths.sourceFile, jsonl([{ ...f.entries[0], version }, ...f.entries.slice(1)]));
		const before = readFileSync(f.paths.sourceFile);
		const leases = acquireSessionMoveLeases(f.paths, f.paths.agentDir);
		try {
			expect(() => appendSessionInfoToExistingFile(f.paths.sourceFile, "new", f.paths.agentDir)).toThrow(
				/open or being moved/,
			);
			expect(readFileSync(f.paths.sourceFile)).toEqual(before);
		} finally {
			leases.release();
		}
		const open = SessionManager.open;
		const opened = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
			expect(() => acquireSessionMoveLeases(f.paths, f.paths.agentDir)).toThrow(SessionAlreadyActiveError);
			return open(...args);
		});
		appendSessionInfoToExistingFile(f.paths.sourceFile, "new", f.paths.agentDir);
		expect(opened).toHaveBeenCalledTimes(version === 2 ? 1 : 0);
		expect(readEntries(f.paths.sourceFile).at(-1)).toMatchObject({ name: "new", parentId: "trailing" });
	});
	// test-policy: allow conditional-or-disabled-test -- cleanup-race coverage executes a POSIX fake trash; Fork CI runs Ubuntu
	it.skipIf(process.platform === "win32").each(["prefix", "path", "artifacts", "during-removal"] as const)(
		"AC-29 normal relocation keeps originals and reports a failed %s check",
		async (kind) => {
			const f = fixture();
			noTrash();
			const outside = join(home, "unrelated");
			mkdirSync(outside);
			writeFileSync(join(outside, "keep"), "safe");
			const writeRecords = f.callbacks.writeMeshRecords;
			f.callbacks.writeMeshRecords = async (journal, writes) => {
				await writeRecords(journal, writes);
				if (kind === "prefix")
					writeFileSync(journal.targetFile, jsonl(f.expected).replace(f.targetCwd, "/changed"));
				else if (kind === "path") Object.assign(journal, { sourceArtifacts: outside });
				else if (kind === "artifacts") writeFileSync(join(journal.sourceArtifacts, "late"), "new artifact");
				else fakeTrash(f, "success", true);
			};
			const result = await move(f);
			expect(result.status).toBe("moved");
			expect(result.backups.length).toBeGreaterThan(0);
			expect(result.messages.join(" ")).toMatch(
				kind === "prefix"
					? /prefix changed/
					: kind === "path"
						? /Invalid journal path/
						: /Source artifacts changed/,
			);
			expect(existsSync(f.paths.sourceBackup)).toBe(kind !== "during-removal");
			expect(existsSync(f.paths.sourceArtifacts)).toBe(true);
			expect(readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
			expect(existsSync(f.paths.journalPath)).toBe(false);
		},
	);
	it.each(["../escape", "a/b", "..", ".hidden"])(
		"AC-30 refuses unsafe ID %s before deriving or writing paths",
		async (sessionId) => {
			const f = fixture();
			const paths = { ...f.paths, sessionId };
			expect(sessionMovePaths(paths).ok).toBe(false);
			const result = await relocateSession({
				paths,
				targetCwd: f.targetCwd,
				targetSocket: "socket",
				callbacks: f.callbacks,
			});
			expect(result.status).toBe("rolled_back");
			untouchedSource(f);
			expect(f.events).toEqual(["release claim", "release leases"]);
		},
	);
	const escapedFields = [
		"sessionId",
		"artifactIdentity",
		"sourceArtifacts",
		"targetFile",
		"fileTemporary",
		"artifactTemporary",
		"sourceBackup",
		"journalPath",
		"journal alias",
	] as const;
	it.each(escapedFields.flatMap((field) => (["promoted", "published"] as const).map((state) => ({ field, state }))))(
		"AC-30/#55 recovery keeps a journal with escaped or aliased $field in $state state and removes nothing",
		async ({ field, state }) => {
			const f = fixture();
			const j = journalState(f, "committing", state);
			const outside = join(home, "outside");
			writeFileSync(outside, "do not remove");
			if (field === "journal alias") {
				const journalPath = join(dirname(j.journalPath), "a.json");
				symlinkSync(j.journalPath, journalPath);
				Object.assign(f.paths, { journalPath });
			} else writeFileSync(j.journalPath, JSON.stringify({ ...j, [field]: outside }));
			const before = readFileSync(j.journalPath);
			expect((await recover(f)).status).toBe("pending");
			expect(readFileSync(j.journalPath)).toEqual(before);
			expect(readFileSync(outside, "utf8")).toBe("do not remove");
			expect(lstatSync(f.paths.journalPath).isSymbolicLink()).toBe(field === "journal alias");
			expect(existsSync(j.sourceBackup)).toBe(true);
			expect(existsSync(j.targetFile)).toBe(state === "published");
			expect(f.events).toEqual([]);
		},
	);
});
function segmentedFixture() {
	const f = fixture();
	const id = "11111111-1111-4111-8111-111111111111";
	const built = sessionMovePaths({
		...f.paths,
		sessionId: id,
		sourceFile: join(f.paths.sourceSessionDir, `${id}.jsonl`),
	});
	if (!built.ok) throw new Error(built.reason);
	renameSync(f.paths.sourceFile, built.value.sourceFile);
	Object.assign(f.paths, built.value);
	const header = { type: "session", version: 3, id, timestamp: "2026-01-01", cwd: home, rlmDepth: 0 } as const;
	const old = { type: "message", id: "old", parentId: null, timestamp: "t1", message: userMsg("original") } as const;
	const answer = { ...old, id: "answer", parentId: "old", timestamp: "t2", message: assistantMsg("original reply") };
	const kept = { type: "message", id: "kept", parentId: "answer", timestamp: "t3", message: userMsg("kept") } as const;
	const leaf = { ...answer, id: "leaf", parentId: "kept", timestamp: "t4", message: assistantMsg("last") } as const;
	const compact = {
		type: "compaction",
		id: "compact",
		parentId: "leaf",
		timestamp: "t5",
		summary: "summary",
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	} as const;
	const original = [header, old, answer, kept, leaf, compact];
	const archive = sessionArchivePath(f.paths.sourceFile, id, 0);
	mkdirSync(dirname(archive), { recursive: true });
	const archiveBytes = Buffer.from(jsonl(original));
	writeFileSync(archive, archiveBytes);
	const reference = { segment: 0, bytes: archiveBytes.length, sha256: hash(archiveBytes) };
	const accounted = { ...answer, message: { ...answer.message, content: [] } };
	const segmentedHeader = withRotationRestart(
		{
			...header,
			rotation: {
				version: 1,
				segment: 1,
				archives: [reference],
				restart: { version: 1, count: 0, sha256: hash(Buffer.alloc(0)) },
				compactionId: "compact",
				accounting: { messageCount: 2 },
			},
		},
		{
			originalParents: { kept: "answer" },
			firstMessage: "original",
			accounting: [{ kind: "assistant", entry: accounted, accountingParentId: null }],
		},
	);
	writeFileSync(f.paths.sourceFile, jsonl([segmentedHeader, { ...kept, parentId: null }, leaf, compact]));
	return { ...f, archive, old };
}
async function moveCrash(f: ReturnType<typeof segmentedFixture>, point: string) {
	const moveUrl = new URL("../../src/core/session-move.ts", import.meta.url).href;
	const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {relocateSession,acquireSessionMoveLeases} from ${JSON.stringify(moveUrl)};
const [paths,cwd,point]=JSON.parse(process.argv[1]); const rename=fs.renameSync;
fs.renameSync=(from,to)=>{ const archive=to.endsWith('/archive/'+paths.sessionId);
const active=to===paths.targetFile; const redirect=to===paths.sourceFile+'.relocated';
const hit=point.startsWith('archive')?archive:point.startsWith('active')?active:redirect;
if(hit&&point.endsWith('before'))process.exit(73); rename(from,to); if(hit&&point.endsWith('after'))process.exit(73); };
syncBuiltinESMExports(); const leases=acquireSessionMoveLeases(paths,paths.agentDir);
await relocateSession({paths,targetCwd:cwd,targetSocket:'new.sock',callbacks:{suspend:async()=>true,resume:async()=>{},writeMeshRecords:async()=>{},releaseClaim:()=>{},releaseLeases:()=>leases.release()}}); process.exit(74);`;
	const child = spawnHidden(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([f.paths, f.targetCwd, point])],
		{ stdio: "ignore" },
	);
	expect((await once(child, "exit"))[0]).toBe(73);
}
async function recoverFresh(f: ReturnType<typeof segmentedFixture>) {
	const url = new URL("../../src/core/session-move.ts", import.meta.url).href;
	const script = `import {recoverSessionMove,acquireSessionMoveLeases} from ${JSON.stringify(url)};
const paths=JSON.parse(process.argv[1]);const result=await recoverSessionMove({...paths,callbacks:{acquireLeases:j=>acquireSessionMoveLeases(j,j.agentDir),readEnrollmentPath:j=>j.targetFile,readDirectorySocket:j=>j.targetSocket,acquireClaim:()=>true,writeMeshRecords:async()=>{},releaseClaim:()=>{}}});process.stdout.write(JSON.stringify(result));`;
	return JSON.parse(
		execFileSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(f.paths)],
			{ encoding: "utf8" },
		),
	) as { status: string; messages: string[] };
}
describe("archive lifecycle", () => {
	it.each(["archive-before", "archive-after", "active-after", "redirect-before", "redirect-after"])(
		"recovers a fresh process at %s without changing archive bytes or later appends",
		async (point) => {
			const f = segmentedFixture();
			const bytes = readFileSync(f.archive);
			const source = readFileSync(f.paths.sourceFile);
			await moveCrash(f, point);
			const committed = point.startsWith("active") || point.startsWith("redirect");
			expect(await findAgentTraceFiles(f.paths.targetSessionDir)).toEqual(committed ? [f.paths.targetFile] : []);
			if (committed) SessionManager.open(f.paths.targetFile).appendCustomEntry("late", { keep: true });
			const appended = committed ? readFileSync(f.paths.targetFile) : undefined;
			expect((await recoverFresh(f)).status).toBe(committed ? "moved" : "rolled_back");
			expect(
				readFileSync(committed ? sessionArchivePath(f.paths.targetFile, f.paths.sessionId, 0) : f.archive),
			).toEqual(bytes);
			if (committed) {
				expect(readFileSync(f.paths.targetFile)).toEqual(appended);
				expect(SessionManager.open(f.paths.targetFile).getEntry("old")).toEqual(f.old);
				expect(JSON.parse(readFileSync(`${f.paths.sourceFile}.relocated`, "utf8"))).toEqual({
					version: 1,
					sessionId: f.paths.sessionId,
					target: f.paths.targetFile,
				});
			} else {
				expect(readFileSync(f.paths.sourceFile)).toEqual(source);
				expect(existsSync(`${f.paths.sourceFile}.relocated`)).toBe(false);
			}
			expect((await recoverFresh(f)).status).toBe("absent");
		},
	);
	it.each(["forkFrom", "createBranchedSession"] as const)(
		"keeps bounded %s and fork-of-fork evidence across source moves, then reports permanent deletion",
		async (kind) => {
			const f = segmentedFixture();
			noTrash();
			const bytes = readFileSync(f.archive);
			const originalFile = f.paths.sourceFile;
			const source = SessionManager.open(f.paths.sourceFile);
			const fork =
				kind === "forkFrom"
					? SessionManager.forkFrom(f.paths.sourceFile, home, f.paths.sourceSessionDir)
					: SessionManager.open(source.createBranchedSession(source.getLeafId()!)!);
			const nested = SessionManager.forkFrom(fork.getSessionFile()!, home, f.paths.sourceSessionDir);
			const late = SessionManager.open(f.paths.sourceFile).appendMessage(userMsg("post-fork"));
			expect((await move(f)).status).toBe("moved");
			const after = SessionManager.forkFrom(f.paths.targetFile, home, f.paths.sourceSessionDir);
			const finalDir = join(home, "final", "sessions");
			mkdirSync(finalDir, { recursive: true });
			const again = sessionMovePaths({
				...f.paths,
				sourceSessionDir: f.paths.targetSessionDir,
				sourceFile: f.paths.targetFile,
				targetSessionDir: finalDir,
			});
			if (!again.ok) throw new Error(again.reason);
			Object.assign(f.paths, again.value);
			expect((await move(f)).status).toBe("moved");
			for (const child of [fork, nested, after]) {
				expect(child.getEntry("old")).toEqual(f.old);
				expect(child.isEntryOnBranch("old")).toBe(true);
				expect(child.getEntries().some((entry) => entry.id === "old")).toBe(false);
				expect(child.getTree().some((node) => node.entry.id === "old")).toBe(false);
				expect(existsSync(dirname(sessionArchivePath(child.getSessionFile()!, child.getSessionId(), 0)))).toBe(
					false,
				);
			}
			expect(fork.getEntry(late)).toBeUndefined();
			expect(nested.isEntryOnBranch(late)).toBe(false);
			expect(readFileSync(sessionArchivePath(f.paths.targetFile, f.paths.sessionId, 0))).toEqual(bytes);
			const ownBytes = readFileSync(fork.getSessionFile()!);
			const ownHeader = fork.getHeader()!;
			const ownRotation = ownHeader.rotation!;
			const ownArchive = sessionArchivePath(fork.getSessionFile()!, fork.getSessionId(), ownRotation.segment);
			mkdirSync(dirname(ownArchive), { recursive: true });
			writeFileSync(ownArchive, ownBytes);
			const reference = { segment: ownRotation.segment, bytes: ownBytes.length, sha256: hash(ownBytes) };
			const rotation = { ...ownRotation, segment: ownRotation.segment + 1, archives: [reference] };
			const archivedHeader = withRotationRestart({ ...ownHeader, rotation }, restartOf(ownHeader)!);
			writeFileSync(fork.getSessionFile()!, jsonl([archivedHeader, ...fork.getEntries()]));
			fork.setSessionFile(fork.getSessionFile()!);
			const connection = Object.create(InProcessAgentConnection.prototype) as InProcessAgentConnection;
			Reflect.set(connection, "runtimeHost", { services: { agentDir: f.paths.agentDir } });
			expect((await connection.deleteSavedSession(f.paths.targetFile)).ok).toBe(true);
			expect(existsSync(`${f.paths.sourceFile}.relocated`)).toBe(false);
			expect(existsSync(`${originalFile}.relocated`)).toBe(false);
			for (const child of [fork, nested, after]) {
				expect(child.getEntry("kept")?.id).toBe("kept");
				expect(() => child.getEntry("old")).toThrow(/permanent deletion/);
				const local = child.appendCustomEntry("usable", { keep: true });
				expect(child.getEntry(local)?.id).toBe(local);
				expect(child.isEntryOnBranch(local)).toBe(true);
				const header = child.getHeader()!;
				const files = readdirSync(child.getSessionDir());
				if (header.rotation!.archives.length) {
					const bytes = readFileSync(child.getSessionFile()!);
					expect(() => child.createBranchedSession(local)).toThrow(/permanent deletion/);
					expect(readFileSync(child.getSessionFile()!)).toEqual(bytes);
					expect(readdirSync(child.getSessionDir())).toEqual(files);
				} else {
					const cold = SessionManager.open(child.createBranchedSession(local)!);
					expect(cold.getHeader()).toMatchObject({
						parentSession: header.parentSession,
						rotation: header.rotation,
					});
					expect(cold.isEntryOnBranch(local)).toBe(true);
					expect(() => cold.getEntry("old")).toThrow(/permanent deletion/);
				}
			}
		},
	);
	it.each(["valid", "corrupt", "missing"])(
		"refuses %s archives and lexical/symlink aliases in move and raw delete",
		async (state) => {
			const f = segmentedFixture();
			if (state === "corrupt") writeFileSync(f.archive, "not-json");
			if (state === "missing") rmSync(f.archive);
			const alias = join(home, "archive-alias");
			symlinkSync(dirname(f.archive), alias, "dir");
			const paths = [
				f.archive,
				join(dirname(f.archive), "..", f.paths.sessionId, "0.jsonl"),
				join(alias, "0.jsonl"),
			];
			const before = existsSync(f.archive) ? readFileSync(f.archive) : undefined;
			for (const path of paths) {
				expect((await deleteSessionFile(path)).ok).toBe(false);
				expect(sessionMovePaths({ ...f.paths, sourceFile: path }).ok).toBe(false);
				expect(
					(
						await relocateSession({
							paths: { ...f.paths, sourceFile: path },
							targetCwd: f.targetCwd,
							targetSocket: "new.sock",
							callbacks: f.callbacks,
						})
					).status,
				).toBe("rolled_back");
			}
			expect(existsSync(f.archive) ? readFileSync(f.archive) : undefined).toEqual(before);
			expect(readdirSync(dirname(f.archive))).toEqual(state === "missing" ? [] : ["0.jsonl"]);
			expect(existsSync(join(f.paths.agentDir, "session-leases"))).toBe(false);
		},
	);
	it.each([
		"success",
		"transcript-failure",
		"cleanup-failure",
		"cleanup-json",
		"dead-temp",
		"finder-file",
		"late-failure",
		"redirect",
		"missing-redirect",
		"live-temp",
	])(
		"validates evidence before saved deletion and reports %s without removing another session archive",
		async (state) => {
			const f = segmentedFixture();
			noTrash();
			const other = join(dirname(dirname(f.archive)), "22222222-2222-4222-8222-222222222222");
			mkdirSync(other);
			writeFileSync(join(other, "0.jsonl"), "other");
			if (state === "cleanup-json") writeFileSync(f.archive, "{");
			if (state === "dead-temp")
				writeFileSync(join(dirname(f.archive), "2.jsonl.999999.11111111-1111-4111-8111-111111111111.tmp"), "torn");
			if (state === "finder-file") writeFileSync(join(dirname(f.archive), ".DS_Store"), "finder");
			mkdirSync(f.paths.sourceArtifacts, { recursive: true });
			writeFileSync(join(f.paths.sourceArtifacts, "keep"), "artifact");
			if (state === "live-temp")
				writeFileSync(`${f.archive}.${process.pid}.11111111-1111-4111-8111-111111111111.tmp`, "live");
			if (state === "redirect" || state === "missing-redirect") {
				const source = SessionManager.open(f.paths.sourceFile);
				source.getHeader()!.previousSessionPaths = [join(home, "previous.jsonl")];
				if (state === "redirect") writeFileSync(join(home, "previous.jsonl.relocated"), "{");
				writeFileSync(f.paths.sourceFile, jsonl([source.getHeader()!, ...source.getEntries()]));
			}
			const before = readFileSync(f.archive);
			if (state === "transcript-failure") {
				vi.spyOn(fsPromises, "unlink").mockRejectedValue(new Error("unlink refused"));
				syncBuiltinESMExports();
			}
			if (state === "cleanup-failure") symlinkSync(other, join(dirname(f.archive), "foreign"), "dir");
			const sourceBytes = readFileSync(f.paths.sourceFile);
			const reservation = acquireSessionDeleteLeases(f.paths.sourceFile, f.paths.agentDir);
			let removed = false;
			try {
				const result = await deleteSessionFile(f.paths.sourceFile, {
					afterFileRemoved: () => {
						removed = true;
						expect(existsSync(f.paths.sourceFile)).toBe(false);
						expect(readFileSync(f.archive)).toEqual(before);
						if (state === "late-failure") writeFileSync(join(dirname(f.archive), "late-unknown"), "keep");
					},
				});
				const refused = ["cleanup-failure", "cleanup-json", "redirect", "live-temp"].includes(state);
				expect(result.ok).toBe(!refused && state !== "transcript-failure" && state !== "late-failure");
				if (refused) expect(readFileSync(f.paths.sourceFile).equals(sourceBytes)).toBe(true);
				if (!result.ok) {
					expect(result.error).toMatch(
						state === "transcript-failure"
							? /unlink refused/
							: state === "late-failure"
								? /transcript removed; cleanup incomplete/
								: /Cannot delete/,
					);
					if (state !== "transcript-failure") expect(result.error).toContain(dirname(f.archive));
				}
			} finally {
				reservation.release();
			}
			const kept = ["transcript-failure", "cleanup-failure", "cleanup-json", "redirect", "live-temp"].includes(
				state,
			);
			expect(removed).toBe(!kept);
			expect(existsSync(f.paths.sourceArtifacts)).toBe(kept);
			expect(existsSync(f.archive)).toBe(kept || state === "late-failure");
			expect(readFileSync(join(other, "0.jsonl"), "utf8")).toBe("other");
		},
	);
	it("reserves in-process saved deletion against a live canonical writer and permits it after release", async () => {
		const f = segmentedFixture();
		noTrash();
		const connection = Object.create(InProcessAgentConnection.prototype) as InProcessAgentConnection;
		Reflect.set(connection, "runtimeHost", { services: { agentDir: f.paths.agentDir } });
		const lease = acquireSessionLease(f.paths.sourceFile, f.paths.agentDir, {
			PRIME_AGENT_INTERNAL_SESSION_LEASES: "1",
		});
		try {
			await expect(connection.deleteSavedSession(f.paths.sourceFile)).rejects.toThrow(SessionAlreadyActiveError);
			expect(existsSync(f.archive)).toBe(true);
		} finally {
			lease?.release();
		}
		expect((await connection.deleteSavedSession(f.paths.sourceFile)).ok).toBe(true);
		expect(existsSync(f.archive)).toBe(false);
	});
	it.each(["digest", "identity", "incomplete", "path", "version"])(
		"keeps both archive sets when committed recovery cannot prove %s",
		async (kind) => {
			const f = segmentedFixture();
			await moveCrash(f, "active-after");
			const journal = JSON.parse(readFileSync(f.paths.journalPath, "utf8"));
			if (kind === "digest") writeFileSync(sessionArchivePath(f.paths.targetFile, f.paths.sessionId, 0), "damaged");
			else if (kind === "identity") journal.archiveMove.identity = "0:0";
			else if (kind === "incomplete") delete journal.archiveMove.sourceIdentity;
			else if (kind === "path") journal.archiveMove.source = home;
			else journal.archiveMove.version = 2;
			writeFileSync(f.paths.journalPath, JSON.stringify(journal));
			const before = readFileSync(f.paths.journalPath);
			expect((await recoverFresh(f)).status).toBe("pending");
			expect(readFileSync(f.paths.journalPath)).toEqual(before);
			expect(existsSync(f.archive)).toBe(true);
			expect(existsSync(sessionArchivePath(f.paths.targetFile, f.paths.sessionId, 0))).toBe(true);
		},
	);
	it("refuses a rollback temporary redirected to another session archive even with its copied directory identity", async () => {
		const f = segmentedFixture();
		await moveCrash(f, "archive-before");
		const journal = JSON.parse(readFileSync(f.paths.journalPath, "utf8"));
		const other = join(dirname(journal.archiveMove.target), "22222222-2222-4222-8222-222222222222");
		mkdirSync(other);
		const file = join(other, "0.jsonl");
		writeFileSync(
			file,
			readFileSync(f.archive, "utf8").replace(f.paths.sessionId, "22222222-2222-4222-8222-222222222222"),
		);
		const bytes = readFileSync(file);
		const stat = lstatSync(other, { bigint: true });
		journal.archiveMove.temporary = other;
		journal.archiveMove.identity = `${stat.dev}:${stat.ino}`;
		writeFileSync(f.paths.journalPath, JSON.stringify(journal));
		expect((await recoverFresh(f)).status).toBe("pending");
		expect(readFileSync(file)).toEqual(bytes);
		expect(existsSync(f.archive)).toBe(true);
	});
	it("moves an inherited-only fork without copying its parent's archives", async () => {
		const f = segmentedFixture();
		noTrash();
		const parent = f.paths.sourceFile;
		const fork = SessionManager.forkFrom(parent, home, f.paths.sourceSessionDir);
		const paths = sessionMovePaths({
			...f.paths,
			sessionId: fork.getSessionId(),
			sourceFile: fork.getSessionFile()!,
		});
		if (!paths.ok) throw new Error(paths.reason);
		Object.assign(f.paths, paths.value);
		expect((await move(f)).status).toBe("moved");
		const moved = SessionManager.open(f.paths.targetFile);
		expect(moved.getEntry("old")).toEqual(f.old);
		expect(existsSync(dirname(sessionArchivePath(f.paths.targetFile, moved.getSessionId(), 0)))).toBe(false);
		expect(existsSync(f.archive)).toBe(true);
	});
	it.each(["file", "folder"])("deletes through a %s symlink", async (kind) => {
		const f = segmentedFixture();
		noTrash();
		const folder = join(home, "logical", "sessions");
		mkdirSync(dirname(folder));
		if (kind === "folder") symlinkSync(f.paths.sourceSessionDir, folder, "dir");
		else mkdirSync(folder);
		const alias = join(folder, kind === "file" ? "alias.jsonl" : basename(f.paths.sourceFile));
		if (kind === "file") symlinkSync(f.paths.sourceFile, alias);
		const artifacts = join(dirname(folder), "session-artifacts", basename(alias).replace(/\.jsonl$/, ""));
		mkdirSync(artifacts, { recursive: true });
		writeFileSync(join(artifacts, "keep"), "artifact");
		const reservation = acquireSessionDeleteLeases(alias, f.paths.agentDir);
		try {
			expect((await deleteSessionFile(alias)).ok).toBe(true);
		} finally {
			reservation.release();
		}
		expect(existsSync(f.paths.sourceFile)).toBe(false);
		expect(existsSync(f.archive)).toBe(false);
		expect(existsSync(artifacts)).toBe(false);
	});
});
describe("lifecycle and segmented header bounds", () => {
	it.each(["own", "inherited"])("import checks %s evidence before writing its destination", async (kind) => {
		const f = segmentedFixture();
		const incoming = SessionManager.open(f.paths.sourceFile);
		if (kind === "inherited") incoming.createBranchedSession(incoming.getLeafId()!);
		const path = incoming.getSessionFile()!;
		const destination = join(home, "uncreated-import");
		const runtime = Object.create(AgentSessionRuntime.prototype) as AgentSessionRuntime;
		Reflect.set(runtime, "_session", { sessionManager: SessionManager.inMemory(home, destination) });
		const before = readFileSync(path);
		expect(() => SessionManager.assertImportEvidence(path, path)).not.toThrow();
		if (kind === "inherited") rmSync(f.paths.sourceFile);
		await expect(runtime.importFromJsonl(path)).rejects.toThrow(/without destination evidence/);
		expect(existsSync(destination)).toBe(false);
		expect(existsSync(join(f.paths.agentDir, "session-leases"))).toBe(false);
		expect(readFileSync(path).equals(before)).toBe(true);
	});
	it("segmented forkFrom never publishes a torn target", () => {
		const f = segmentedFixture();
		const directory = join(home, "forks");
		mkdirSync(directory);
		const write = fs.writeSync;
		vi.spyOn(fs, "writeSync").mockImplementationOnce((descriptor) => {
			write(descriptor, Buffer.from("{"));
			throw new Error("injected fork write failure");
		});
		syncBuiltinESMExports();
		expect(() => SessionManager.forkFrom(f.paths.sourceFile, home, directory)).toThrow(/injected fork write failure/);
		expect(readdirSync(directory)).toEqual([]);
		expect(SessionManager.open(f.paths.sourceFile).getEntry("old")).toEqual(f.old);
	});
	it.each(["move", "forkFrom"])("r2: %s skips dropped git_state ancestry after source move", async (kind) => {
		const f = segmentedFixture();
		const source = SessionManager.open(f.paths.sourceFile);
		const dropped = [source.appendGitState({ branch: "one" }), source.appendGitState({ branch: "two" })];
		const leaf = source.appendMessage(userMsg("after git"));
		dropped.push(source.appendGitState({ branch: "trailing" }));
		const fork =
			kind === "forkFrom" ? SessionManager.forkFrom(f.paths.sourceFile, home, f.paths.sourceSessionDir) : undefined;
		expect((await move(f)).status).toBe("moved");
		const view = SessionManager.open(fork?.getSessionFile() ?? f.paths.targetFile);
		for (const id of dropped) expect(view.isEntryOnBranch(id)).toBe(false);
		expect(view.isEntryOnBranch("old")).toBe(true);
		expect(view.getEntry("old")).toEqual(f.old);
		const cold = SessionManager.open(view.createBranchedSession(leaf)!);
		expect(cold.isEntryOnBranch("old")).toBe(true);
	});
	it.each(["symlink-loop", "archive-zero", "archive-temp", "unknown-temp", "no-archive"])(
		"never-rotated saved deletion preserves base outcome with %s",
		async (kind) => {
			const f = segmentedFixture();
			noTrash();
			writeFileSync(
				f.paths.sourceFile,
				jsonl([{ ...SessionManager.inMemory(home).getHeader()!, id: f.paths.sessionId }, f.old]),
			);
			const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
			const temp = `${f.archive}.${kind === "unknown-temp" ? "unknown" : "999999.11111111-1111-4111-8111-111111111111"}.tmp`;
			if (kind.endsWith("temp")) writeFileSync(temp, "uncommitted");
			if (kind === "no-archive") rmSync(dirname(f.archive), { recursive: true });
			if (kind === "symlink-loop") {
				mkdirSync(f.paths.sourceArtifacts, { recursive: true });
				symlinkSync("y", join(f.paths.sourceArtifacts, "x"));
				symlinkSync("x", join(f.paths.sourceArtifacts, "y"));
				expect([...sessionArtifactFiles(f.paths.sourceArtifacts)]).toEqual([]);
			}
			acquireSessionDeleteLeases(f.paths.sourceFile, f.paths.agentDir).release();
			expect(await deleteSessionFile(f.paths.sourceFile)).toEqual({ ok: true, method: "unlink" });
			expect(existsSync(f.paths.sourceFile) || existsSync(f.paths.sourceArtifacts)).toBe(false);
			expect(existsSync(dirname(f.archive))).toBe(kind === "unknown-temp");
			expect(diagnostic).toHaveBeenCalledTimes(Number(kind === "unknown-temp"));
			if (kind === "unknown-temp") {
				expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(temp));
				expect(readFileSync(temp, "utf8")).toBe("uncommitted");
			}
		},
	);
	it("reserves nested child transcripts, never their archives or uncommitted temps", async () => {
		const f = segmentedFixture();
		const child = SessionManager.create(home, join(f.paths.sourceArtifacts, "sub-01234567"));
		child.appendMessage(userMsg("child"));
		child.appendMessage(assistantMsg("reply"));
		const path = child.getSessionFile()!;
		const archive = sessionArchivePath(path, child.getSessionId(), 0);
		mkdirSync(dirname(archive), { recursive: true });
		const bytes = readFileSync(path);
		writeFileSync(archive, bytes);
		writeFileSync(`${archive}.999999.11111111-1111-4111-8111-111111111111.tmp`, bytes);
		const rows = child.getEntries();
		const header = withRotationRestart(
			{
				...child.getHeader()!,
				rotation: {
					version: 1,
					segment: 1,
					archives: [{ segment: 0, bytes: bytes.length, sha256: hash(bytes) }],
					restart: { version: 1, count: 0, sha256: hash(Buffer.alloc(0)) },
					accounting: { messageCount: 0 },
				},
			},
			{ originalParents: {}, accounting: [], firstMessage: "" },
		);
		writeFileSync(path, serializeSessionEntries([header, ...rows]));
		const competing = acquireSessionLease(path, f.paths.agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
		try {
			expect(() => acquireSessionDeleteLeases(f.paths.sourceFile, f.paths.agentDir)).toThrow(
				SessionAlreadyActiveError,
			);
		} finally {
			competing?.release();
		}
		const reservation = acquireSessionDeleteLeases(f.paths.sourceFile, f.paths.agentDir);
		try {
			expect((await deleteSessionFile(f.paths.sourceFile)).ok).toBe(true);
		} finally {
			reservation.release();
		}
		expect(existsSync(path)).toBe(false);
		expect(existsSync(archive)).toBe(false);
		expect(existsSync(f.archive)).toBe(false);
	});
	it.each(["callback", "artifacts"])("preserves never-rotated %s error rejection", async (kind) => {
		const f = fixture();
		const failure = new Error("ordinary cleanup failure");
		if (kind === "artifacts") vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(failure);
		syncBuiltinESMExports();
		await expect(
			deleteSessionFile(f.paths.sourceFile, {
				afterFileRemoved:
					kind === "callback"
						? () => {
								throw failure;
							}
						: undefined,
			}),
		).rejects.toThrow(failure);
		expect(existsSync(f.paths.sourceFile)).toBe(false);
	});
	it.each(["move", "forkFrom", "createBranchedSession", "rewrite"])(
		"keeps authoritative bytes when %s transforms a near-bound segmented header",
		async (kind) => {
			const f = segmentedFixture();
			const archiveBytes = readFileSync(f.archive);
			const manager = SessionManager.open(f.paths.sourceFile);
			const entries = loadEntriesFromFile(f.paths.sourceFile);
			const header = entries[0];
			if (header.type !== "session") throw new Error("header");
			if (kind === "forkFrom" || kind === "createBranchedSession") {
				const before = readFileSync(f.paths.sourceFile);
				const files = readdirSync(f.paths.sourceSessionDir);
				const huge = "é".repeat(33000);
				if (kind === "forkFrom")
					expect(() => SessionManager.forkFrom(f.paths.sourceFile, huge, f.paths.sourceSessionDir)).toThrow(
						/header.*bound/,
					);
				else
					expect(() =>
						SessionManager.open(f.paths.sourceFile, undefined, huge).createBranchedSession(manager.getLeafId()!),
					).toThrow(/header.*bound/);
				expect(readFileSync(f.paths.sourceFile)).toEqual(before);
				expect(readdirSync(f.paths.sourceSessionDir)).toEqual(files);
				return;
			}
			const transformed = {
				...header,
				...(kind === "rewrite"
					? { parentSession: join(home, "missing-parent.jsonl"), rlmDepth: undefined }
					: { previousSessionPaths: Array.from({ length: 8 }, (_, i) => join(home, `previous-${i}.jsonl`)) }),
				opaque: "",
			};
			const size = Buffer.byteLength(`${JSON.stringify(transformed)}\n`);
			transformed.opaque = "x".repeat(65536 - size - 4);
			writeFileSync(f.paths.sourceFile, serializeSessionEntries([transformed, ...entries.slice(1)]));
			const before = readFileSync(f.paths.sourceFile);
			if (kind === "rewrite") expect(() => SessionManager.open(f.paths.sourceFile)).toThrow(/header.*bound/);
			else {
				const result = await relocateSession({
					paths: f.paths,
					targetCwd: f.targetCwd,
					targetSocket: "new.sock",
					callbacks: f.callbacks,
				});
				expect(result.status).toBe("rolled_back");
				expect(result.messages.join(" ")).toMatch(/header.*bound/);
				expect(existsSync(f.paths.targetFile)).toBe(false);
				expect(existsSync(f.paths.fileTemporary)).toBe(false);
			}
			expect(readFileSync(f.paths.sourceFile)).toEqual(before);
			expect(readFileSync(f.archive)).toEqual(archiveBytes);
		},
	);
});
