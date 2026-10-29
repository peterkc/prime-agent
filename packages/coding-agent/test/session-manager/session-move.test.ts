import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	cpSync,
	existsSync,
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionAlreadyActiveError } from "../../src/core/session-lease.js";
import {
	appendCustomMessageToExistingFile,
	appendSessionInfoToExistingFile,
	appendSessionStateToExistingFile,
	type FileEntry,
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
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { AgentsViewMode } from "../../src/modes/agents-view/agents-view-mode.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import { writeFileAtomicSync } from "../../src/utils/atomic-file.js";
import { spawnHidden } from "../../src/utils/child-process.js";

let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "session-move-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function jsonl(entries: readonly FileEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
function readEntries(path: string): FileEntry[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
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
	writeFileSync(journal.journalPath, JSON.stringify(journal));
	if (state !== "empty") writeFileSync(journal.fileTemporary, bytes);
	if (["artifacts", "renamed", "promoted", "published"].includes(state))
		cpSync(journal.sourceArtifacts, journal.artifactTemporary, { recursive: true });
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
function fakeTrash(f: Fixture, mode: "success" | "failure" | "broken-interpreter") {
	const bin = join(home, "bin");
	mkdirSync(bin);
	const script =
		mode === "broken-interpreter"
			? "#!/missing-interpreter\n"
			: `#!${process.execPath}\nconst fs = require('node:fs');\n${mode === "success" ? `if (!fs.existsSync(${JSON.stringify(f.paths.sourceArtifacts)})) process.exit(7); fs.renameSync(process.argv[2], ${JSON.stringify(join(home, "trashed"))});` : "process.stderr.write('refused'); process.exitCode = 9;"}\n`;
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
		expect(checked).toHaveProperty(
			"reason",
			kind === "entry" ? "Session entry 0 differs" : "Artifact differs: nested/file.bin",
		);
		expect(readEntries(j.sourceFile)).toEqual(f.entries);
		expect(existsSync(j.targetFile)).toBe(false);
	});
	it.each(["success", "missing", "failure", "broken-interpreter"] as const)(
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
	] as const)("AC-4/AC-6 recovers real pre-commit state $step twice", async ({ phase, state }) => {
		const f = fixture();
		journalState(f, phase, state);
		f.recovery.resume = f.callbacks.resume;
		expect((await recover(f)).status).toBe("rolled_back");
		expect(f.events).toEqual(["resume"]);
		untouchedSource(f);
		expect((await recover(f)).status).toBe("absent");
	});
	it.each(["suspend", "copy"] as const)(
		"AC-4 relocation failure during %s restores the source and resumes even a partly closed endpoint",
		async (step) => {
			const f = fixture();
			f.callbacks.suspend = async () => {
				if (step === "suspend") throw new Error("suspend failed");
				symlinkSync(f.paths.sourceFile, join(f.paths.sourceArtifacts, "link"));
				return true;
			};
			const result = await move(f);
			expect(result.status).toBe("rolled_back");
			expect(f.events).toContain("resume");
			untouchedSource(f);
		},
	);
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

	it.each(["suspending", "copying", "committing", "committed"] as const)(
		"AC-7 published target wins over phase %s and recovery preserves both original backups",
		async (phase) => {
			const f = fixture();
			const j = journalState(f, phase, "published");
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
	it.each(["", "not-json\n", '{"type":"session","id":"foreign"}\n', '{"type":"session"}\n', "{}\n"])(
		"AC-8 keeps an invalid published target %j and changes no files",
		async (content) => {
			const f = fixture();
			const j = journalState(f, "committing", "promoted");
			writeFileSync(j.targetFile, content);
			const before = [j.journalPath, j.sourceBackup, f.enrollment, f.directory].map((path) => readFileSync(path));
			const result = await recover(f);
			expect(result.status).toBe("pending");
			expect(f.events).toEqual([]);
			expect([j.journalPath, j.sourceBackup, f.enrollment, f.directory].map((path) => readFileSync(path))).toEqual(
				before,
			);
			expect(readFileSync(j.targetFile, "utf8")).toBe(content);
			expect(existsSync(j.sourceArtifacts)).toBe(true);
		},
	);
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
	it.each(["enrollment", "directory", "both", "neither"] as const)(
		"AC-10 separately fixes %s records and repeats without taking an unnecessary claim",
		async (wrong) => {
			const f = fixture();
			const j = journalState(f, "committing", "published");
			if (wrong === "directory" || wrong === "neither")
				writeFileSync(f.enrollment, JSON.stringify({ path: j.targetFile }));
			if (wrong === "enrollment" || wrong === "neither")
				writeFileSync(f.directory, JSON.stringify({ socket: j.targetSocket }));
			const beforeEnrollment = readFileSync(f.enrollment);
			const beforeDirectory = readFileSync(f.directory);
			expect((await recover(f)).status).toBe("moved");
			expect(JSON.parse(readFileSync(f.enrollment, "utf8")).path).toBe(j.targetFile);
			expect(JSON.parse(readFileSync(f.directory, "utf8")).socket).toBe(j.targetSocket);
			if (wrong === "directory" || wrong === "neither") expect(readFileSync(f.enrollment)).toEqual(beforeEnrollment);
			if (wrong === "enrollment" || wrong === "neither") expect(readFileSync(f.directory)).toEqual(beforeDirectory);
			expect(f.events).toEqual(wrong === "neither" ? [] : ["claim", "mesh", "release claim"]);
			expect((await recover(f)).status).toBe("absent");
		},
	);
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
		appendSessionInfoToExistingFile(f.paths.sourceFile, "new", f.paths.agentDir);
		expect(readEntries(f.paths.sourceFile).at(-1)).toMatchObject({ name: "new", parentId: "trailing" });
	});
	it("AC-12 the offline full-open fallback holds its lease while the competing move refuses", () => {
		const f = fixture();
		writeFileSync(f.paths.sourceFile, jsonl([{ ...f.entries[0], version: 2 }, ...f.entries.slice(1)]));
		const open = SessionManager.open;
		let contention = false;
		vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
			expect(() => acquireSessionMoveLeases(f.paths, f.paths.agentDir)).toThrow(SessionAlreadyActiveError);
			contention = true;
			return open(...args);
		});
		appendSessionInfoToExistingFile(f.paths.sourceFile, "renamed", f.paths.agentDir);
		expect(contention).toBe(true);
		expect(readEntries(f.paths.sourceFile).at(-1)).toMatchObject({ name: "renamed", parentId: "trailing" });
	});
	it.each(["prefix", "path"] as const)(
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
					writeFileSync(
						journal.targetFile,
						jsonl([{ ...f.expected[0], cwd: "/changed" }, ...f.expected.slice(1)]),
					);
				else Object.assign(journal, { sourceArtifacts: outside });
			};
			const result = await move(f);
			expect(result.status).toBe("moved");
			expect(result.backups.length).toBeGreaterThan(0);
			expect(result.messages.join(" ")).toMatch(kind === "prefix" ? /prefix changed/ : /Invalid journal path/);
			expect(existsSync(f.paths.sourceBackup)).toBe(true);
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
		"sourceArtifacts",
		"targetFile",
		"fileTemporary",
		"artifactTemporary",
		"sourceBackup",
		"journalPath",
	] as const;
	it.each(escapedFields.flatMap((field) => (["promoted", "published"] as const).map((state) => ({ field, state }))))(
		"AC-30 recovery keeps a journal with escaped $field in $state state and removes nothing",
		async ({ field, state }) => {
			const f = fixture();
			const j = journalState(f, "committing", state);
			const outside = join(home, "outside");
			writeFileSync(outside, "do not remove");
			writeFileSync(j.journalPath, JSON.stringify({ ...j, [field]: outside }));
			const before = readFileSync(j.journalPath);
			expect((await recover(f)).status).toBe("pending");
			expect(readFileSync(j.journalPath)).toEqual(before);
			expect(readFileSync(outside, "utf8")).toBe("do not remove");
			expect(existsSync(j.sourceBackup)).toBe(true);
			expect(existsSync(j.targetFile)).toBe(state === "published");
			expect(f.events).toEqual([]);
		},
	);
});
