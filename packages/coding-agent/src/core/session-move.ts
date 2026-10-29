import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RlmSpawnLedger, readLegacyRlmSubagentRegistry } from "../modes/daemon/rlm-ledger.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { readFirstLineSync } from "../utils/file-lines.js";
import { captureGitContext, type GitContext } from "../utils/git.js";
import { AgentCronJobStore } from "./cron-jobs.js";
import { removeMovedSessionFile, sessionArtifactFiles } from "./session-file-actions.js";
import {
	acquireSessionLease,
	canonicalSessionPath,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
	type SessionLease,
} from "./session-lease.js";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	getSessionArtifactsRoot,
	readSessionInfo,
	type SessionHeader,
	type SessionInfo,
	SessionManager,
} from "./session-manager.js";

export type SessionMoveResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };
export type SessionMovePhase = "suspending" | "copying" | "committing" | "committed";

export interface SessionMoveInput {
	readonly sessionId: string;
	readonly agentDir: string;
	readonly sourceSessionDir: string;
	readonly sourceFile: string;
	readonly targetSessionDir: string;
}

export interface SessionMovePaths extends SessionMoveInput {
	readonly journalPath: string;
	readonly sourceBackup: string;
	readonly sourceArtifactRoot: string;
	readonly sourceArtifacts: string;
	readonly targetArtifactRoot: string;
	readonly targetArtifacts: string;
	readonly artifactTemporary: string;
	readonly targetFile: string;
	readonly fileTemporary: string;
}

export interface SessionMoveJournal extends SessionMovePaths {
	readonly version: 1;
	readonly targetCwd: string;
	readonly targetSocket: string;
	readonly endpointSuspended: boolean;
	readonly phase: SessionMovePhase;
	readonly artifactsPresent: boolean;
	readonly artifactSha256?: string;
	readonly artifactIdentity?: string;
	readonly createdDirectories: readonly string[];
	readonly fileBytes?: number;
	readonly fileSha256?: string;
}

export interface SessionMoveBackup {
	readonly path: string;
	readonly reason: string;
}

export interface SessionMoveReport {
	readonly status: "moved" | "rolled_back" | "pending" | "skipped" | "absent";
	readonly sourceFile: string;
	readonly targetFile?: string;
	readonly journalPath: string;
	readonly committed?: true;
	readonly meshRecordsWritten?: boolean;
	readonly originalMethod?: "trash" | "unlink";
	readonly messages: readonly string[];
	readonly backups: readonly SessionMoveBackup[];
}

export interface SessionMoveMeshWrites {
	readonly enrollment: boolean;
	readonly directory: boolean;
}

export interface SessionMoveCallbacks {
	readonly suspend: (journal: SessionMoveJournal) => Promise<boolean>;
	readonly resume: (journal: SessionMoveJournal) => Promise<void>;
	/** Write and fsync both mesh records. Never release the enrollment claim here. */
	readonly writeMeshRecords: (journal: SessionMoveJournal, writes: SessionMoveMeshWrites) => Promise<void>;
	readonly releaseClaim: () => void | Promise<void>;
	readonly releaseLeases: () => void | Promise<void>;
}

export interface SessionMoveRecoveryCallbacks {
	readonly resume?: SessionMoveCallbacks["resume"];
	readonly acquireLeases: (journal: SessionMoveJournal) => { release(): void };
	readonly readEnrollmentPath: (journal: SessionMoveJournal) => string | undefined | Promise<string | undefined>;
	readonly readDirectorySocket: (journal: SessionMoveJournal) => string | undefined | Promise<string | undefined>;
	readonly acquireClaim: (journal: SessionMoveJournal) => boolean | Promise<boolean>;
	/** Write and fsync only the indicated mesh records. Never release the claim here. */
	readonly writeMeshRecords: SessionMoveCallbacks["writeMeshRecords"];
	readonly releaseClaim: SessionMoveCallbacks["releaseClaim"];
}

function failure(reason: string): { readonly ok: false; readonly reason: string } {
	return { ok: false, reason };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function physicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || present(path)) throw error;
		return join(physicalPath(dirname(resolve(path))), basename(path));
	}
}

function directChild(root: string, path: string): boolean {
	return dirname(resolve(path)) === resolve(root) && dirname(physicalPath(path)) === physicalPath(root);
}

/** The single ID/path rule used before a move, recovery, and original deletion. */
export function sessionMovePaths(input: SessionMoveInput): SessionMoveResult<SessionMovePaths> {
	if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(input.sessionId)) {
		return failure(`Unsafe session ID: ${input.sessionId}`);
	}
	try {
		const sourceSessionDir = physicalPath(input.sourceSessionDir);
		const targetSessionDir = physicalPath(input.targetSessionDir);
		const agentDir = physicalPath(input.agentDir);
		const sourceFile = physicalPath(input.sourceFile);
		if (!directChild(sourceSessionDir, sourceFile) || !sourceFile.endsWith(".jsonl")) {
			return failure(`Source session file is not a direct child of its session folder: ${sourceFile}`);
		}
		if (sourceSessionDir === targetSessionDir) return failure("Source and target session folders are the same");
		const sourceArtifactRoot = getSessionArtifactsRoot(sourceSessionDir);
		const targetArtifactRoot = getSessionArtifactsRoot(targetSessionDir);
		const paths: SessionMovePaths = {
			sessionId: input.sessionId,
			agentDir,
			sourceSessionDir,
			sourceFile,
			targetSessionDir,
			sourceBackup: `${sourceFile}.moved`,
			sourceArtifactRoot,
			targetArtifactRoot,
			sourceArtifacts: join(sourceArtifactRoot, input.sessionId),
			targetArtifacts: join(targetArtifactRoot, input.sessionId),
			artifactTemporary: join(targetArtifactRoot, `.${input.sessionId}.moving`),
			targetFile: join(targetSessionDir, `${input.sessionId}.jsonl`),
			fileTemporary: join(targetSessionDir, `.${input.sessionId}.jsonl.moving`),
			journalPath: join(agentDir, "session-moves", `${input.sessionId}.json`),
		};
		for (const [folder, path] of [
			[sourceSessionDir, paths.sourceBackup],
			[sourceArtifactRoot, paths.sourceArtifacts],
			[targetArtifactRoot, paths.targetArtifacts],
			[targetArtifactRoot, paths.artifactTemporary],
			[targetSessionDir, paths.targetFile],
			[targetSessionDir, paths.fileTemporary],
			[join(agentDir, "session-moves"), paths.journalPath],
		]) {
			if (!directChild(folder, path)) return failure(`Move path is not a direct child of its root: ${path}`);
		}
		return { ok: true, value: paths };
	} catch (error) {
		return failure(errorMessage(error));
	}
}

function assertSessionMoveArtifacts(paths: SessionMovePaths): void {
	if (!sessionArtifactFiles(paths.sourceArtifacts).next().done) {
		throw new Error("Cannot move a session with RLM children in its artifact tree");
	}
	const jobs = AgentCronJobStore.forSessionArtifacts();
	jobs.registerSessionArtifact(paths.sessionId, paths.sourceArtifacts);
	const blockingJobs = jobs.list().filter((job) => job.status === "active" || job.status === "paused");
	if (blockingJobs.length > 0) {
		throw new Error(
			`Cannot move a session with an active or paused scheduled job; cancel these jobs first: ${blockingJobs.map((job) => job.id).join(", ")}`,
		);
	}
}

/** Side-effect-free saved-session checks shared by the CLI and supervisor. */
export async function preflightSessionMove(
	input: Omit<SessionMoveInput, "sessionId">,
): Promise<{ paths: SessionMovePaths; info: SessionInfo }> {
	const header: unknown = JSON.parse(readFirstLineSync(input.sourceFile) ?? "null");
	if (
		!header ||
		typeof header !== "object" ||
		!("type" in header) ||
		header.type !== "session" ||
		!("id" in header) ||
		typeof header.id !== "string"
	)
		throw new Error("Invalid session header");
	const checked = sessionMovePaths({ ...input, sessionId: header.id });
	if (!checked.ok) throw new Error(checked.reason);
	const paths = checked.value;
	if (
		!("version" in header) ||
		header.version !== CURRENT_SESSION_VERSION ||
		("parentSession" in header &&
			header.parentSession &&
			(!("rlmDepth" in header) || !Number.isSafeInteger(header.rlmDepth) || Number(header.rlmDepth) < 0))
	)
		throw new Error("Open the session once in its own repository first to upgrade it");
	const info = await readSessionInfo(paths.sourceFile);
	if (!info) throw new Error(`Session not found: ${paths.sourceFile}`);
	if ((info.rlmDepth ?? 0) > 0) throw new Error("Cannot move an RLM child session");
	const ledger = new RlmSpawnLedger(paths.agentDir, paths.sourceSessionDir);
	const edges = await ledger.liveEdges();
	if (edges.some((edge) => canonicalSessionPath(edge.parent) === paths.sourceFile)) {
		throw new Error("Cannot move a session with RLM children");
	}
	if (!existsSync(ledger.ledgerPath)) {
		const legacy = await readLegacyRlmSubagentRegistry(join(paths.sourceArtifacts, "rlm-subagents.jsonl"), {
			throwOnReadError: true,
		});
		if (legacy.some((child) => child.status !== "deleted" && existsSync(child.sessionFile))) {
			throw new Error("Cannot move a session with RLM children");
		}
	}
	assertSessionMoveArtifacts(paths);
	if (present(paths.journalPath))
		throw new Error(
			`An earlier move of this session is waiting for recovery (${paths.journalPath}). Fix the error it reported, or restart the source daemon to finish the recovery, then try again`,
		);
	for (const path of [
		paths.sourceBackup,
		paths.targetFile,
		paths.fileTemporary,
		paths.targetArtifacts,
		paths.artifactTemporary,
	]) {
		if (present(path)) throw new Error(`Move destination already exists: ${path}`);
	}
	for (const target of await SessionManager.listAll(undefined, paths.targetSessionDir)) {
		if (target.id === info.id) throw new Error(`Target already holds session ${info.id}`);
		if ((target.rlmDepth ?? 0) === 0 && info.name && target.name === info.name)
			throw new Error(`Target already has a top-level session named ${info.name}`);
	}
	return { paths, info };
}

export function validateSessionMoveJournal(
	journal: SessionMoveJournal,
	agentDir: string,
	sourceSessionDir: string,
	journalPath: string,
): SessionMoveResult<SessionMoveJournal> {
	const expected = sessionMovePaths({ ...journal, agentDir, sourceSessionDir });
	if (!expected.ok) return expected;
	for (const key of Object.keys(expected.value) as (keyof SessionMovePaths)[]) {
		if (journal[key] !== expected.value[key]) return failure(`Invalid journal path or ID: ${key}`);
	}
	if (journal.journalPath !== resolve(journalPath)) return failure(`Invalid journal path: ${journalPath}`);
	const allowedDirectories = [dirname(journal.journalPath), journal.targetArtifactRoot];
	if (journal.createdDirectories.some((path) => !allowedDirectories.includes(path))) {
		return failure("Invalid created directory in move journal");
	}
	return { ok: true, value: journal };
}

/** Keep all non-git entries, relinking through every removed git_state parent. */
export function transformSessionMoveEntries(
	entries: readonly FileEntry[],
	targetCwd: string,
	git: GitContext | undefined,
): FileEntry[] {
	const droppedParents = new Map<string, string | null>();
	for (const entry of entries) {
		if (entry.type === "git_state") droppedParents.set(entry.id, entry.parentId);
	}
	const transformed: FileEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "session") {
			transformed.push({ ...entry, cwd: targetCwd, git });
			continue;
		}
		if (entry.type === "git_state") continue;
		let parentId = entry.parentId;
		const visited = new Set<string>();
		while (parentId !== null && droppedParents.has(parentId)) {
			if (visited.has(parentId)) throw new Error(`Cyclic git_state parent: ${parentId}`);
			visited.add(parentId);
			parentId = droppedParents.get(parentId) ?? null;
		}
		transformed.push(parentId === entry.parentId ? entry : { ...entry, parentId });
	}
	return transformed;
}

function readMoveEntries(path: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry: unknown = JSON.parse(line);
		if (
			!entry ||
			typeof entry !== "object" ||
			!("type" in entry) ||
			!("id" in entry) ||
			typeof entry.type !== "string" ||
			typeof entry.id !== "string"
		) {
			throw new Error(`Invalid session entry: ${path}`);
		}
		if (
			entry.type !== "session" &&
			(!("parentId" in entry) || (entry.parentId !== null && typeof entry.parentId !== "string"))
		) {
			throw new Error(`Invalid session entry parent: ${path}`);
		}
		entries.push(entry as FileEntry);
	}
	if (entries[0]?.type !== "session" || entries.slice(1).some((entry) => entry.type === "session")) {
		throw new Error(`Session file has no single leading session header: ${path}`);
	}
	return entries;
}

function fsyncPath(path: string): void {
	const directory = statSync(path).isDirectory();
	try {
		const descriptor = openSync(path, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		// Windows does not support opening/fsyncing directory handles.
		if (process.platform !== "win32" || !directory) throw error;
	}
}

function writeSyncedFile(path: string, bytes: Buffer): void {
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function artifactFiles(root: string, relative = ""): Map<string, string> {
	const files = new Map<string, string>();
	const path = join(root, relative);
	const metadata = lstatSync(path);
	if (metadata.isDirectory()) {
		for (const name of readdirSync(path).sort()) {
			for (const [child, hash] of artifactFiles(root, join(relative, name))) files.set(child, hash);
		}
	} else if (metadata.isFile()) {
		files.set(relative, digest(readFileSync(path)));
	} else {
		throw new Error(`Artifact is not a regular file or folder: ${path}`);
	}
	return files;
}

/** The session-file lease does not fence artifact writers. */
function artifactDigest(path: string): string | undefined {
	return present(path) ? digest(Buffer.from(JSON.stringify([...artifactFiles(path)]))) : undefined;
}

function artifactIdentity(path: string): string {
	const { dev, ino } = lstatSync(path, { bigint: true });
	return `${dev}:${ino}`;
}

function copyArtifacts(source: string, target: string): void {
	const metadata = lstatSync(source);
	if (metadata.isDirectory()) {
		mkdirSync(target, { mode: metadata.mode & 0o777 });
		for (const name of readdirSync(source)) copyArtifacts(join(source, name), join(target, name));
		fsyncPath(target);
	} else if (metadata.isFile()) {
		copyFileSync(source, target, constants.COPYFILE_EXCL);
		fsyncPath(target);
	} else {
		throw new Error(`Artifact is not a regular file or folder: ${source}`);
	}
}

/** Verify the actual disk copy, including the transformed leaf and equal-size artifact corruption. */
export function verifySessionMoveCopy(
	journal: SessionMoveJournal,
	sourceEntries: readonly FileEntry[],
	git: GitContext | undefined,
): SessionMoveResult<null> {
	try {
		const expected = transformSessionMoveEntries(sourceEntries, journal.targetCwd, git);
		const actual = readMoveEntries(journal.fileTemporary);
		if (actual.length !== expected.length) return failure("Session entry count differs");
		for (let index = 0; index < expected.length; index++) {
			// JSON serialization drops optional undefined fields in headers.
			if (!isDeepStrictEqual(actual[index], JSON.parse(JSON.stringify(expected[index])))) {
				return failure(`Session entry ${index} differs`);
			}
		}
		const expectedLeaf = expected.length > 1 ? expected.at(-1)?.id : null;
		const actualLeaf = actual.length > 1 ? actual.at(-1)?.id : null;
		if (actualLeaf !== expectedLeaf) return failure("Session leaf differs");
		if (journal.artifactsPresent) {
			const source = artifactFiles(journal.sourceArtifacts);
			const target = artifactFiles(journal.artifactTemporary);
			for (const path of new Set([...source.keys(), ...target.keys()])) {
				if (source.get(path) !== target.get(path)) return failure(`Artifact differs: ${path}`);
			}
		}
		return { ok: true, value: null };
	} catch (error) {
		return failure(errorMessage(error));
	}
}

function writeJournal(journal: SessionMoveJournal): void {
	writeFileAtomicSync(journal.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { fsync: true, fsyncDir: true });
}

function renameAbsent(source: string, target: string): void {
	if (present(target)) throw new Error(`Rename destination already exists: ${target}`);
	renameSync(source, target);
	fsyncPath(dirname(source));
	if (dirname(target) !== dirname(source)) fsyncPath(dirname(target));
}

function deleteJournal(journal: SessionMoveJournal): void {
	const journalDirectory = dirname(journal.journalPath);
	try {
		for (const path of [...journal.createdDirectories].reverse()) {
			if (path !== journalDirectory && present(path) && readdirSync(path).length === 0) {
				rmdirSync(path);
				fsyncPath(dirname(path));
			}
		}
		unlinkSync(journal.journalPath);
		fsyncPath(journalDirectory);
		if (journal.createdDirectories.includes(journalDirectory) && readdirSync(journalDirectory).length === 0) {
			rmdirSync(journalDirectory);
			fsyncPath(dirname(journalDirectory));
		}
	} catch (error) {
		if (!present(journal.journalPath)) {
			mkdirSync(journalDirectory, { recursive: true });
			writeJournal(journal);
		}
		throw error;
	}
}

function report(
	journal: SessionMoveJournal,
	status: SessionMoveReport["status"],
	messages: string[],
	backups: SessionMoveBackup[] = [],
): SessionMoveReport {
	return {
		status,
		sourceFile: journal.sourceFile,
		targetFile: journal.targetFile,
		journalPath: journal.journalPath,
		messages,
		backups,
	};
}

/** Roll back only the paths reserved by this journal; a failed undo keeps it for recovery. */
export async function rollbackSessionMove(
	journal: SessionMoveJournal,
	resume?: SessionMoveCallbacks["resume"],
): Promise<SessionMoveReport> {
	const valid = validateSessionMoveJournal(journal, journal.agentDir, journal.sourceSessionDir, journal.journalPath);
	if (!valid.ok) return report(journal, "pending", [valid.reason]);
	if (present(journal.targetFile))
		return report(journal, "pending", ["Target exists; recovery must inspect it before any rollback"]);
	const errors: string[] = [];
	for (const path of [journal.targetArtifacts, journal.fileTemporary, journal.artifactTemporary]) {
		try {
			if (path !== journal.fileTemporary && !journal.artifactsPresent) continue;
			// Promotion is only attempted after the committing journal is durable.
			if (path === journal.targetArtifacts && journal.phase !== "committing" && journal.phase !== "committed")
				continue;
			if (present(path)) {
				if (path === journal.targetArtifacts && artifactIdentity(path) !== journal.artifactIdentity) {
					if (!journal.artifactIdentity)
						throw new Error("Artifact ownership is unknown; keep the journal for recovery");
					continue;
				}
				rmSync(path, { recursive: true });
				fsyncPath(dirname(path));
			}
		} catch (error) {
			errors.push(`${path}: ${errorMessage(error)}`);
		}
	}
	try {
		if (present(journal.sourceBackup)) renameAbsent(journal.sourceBackup, journal.sourceFile);
	} catch (error) {
		errors.push(`${journal.sourceBackup}: ${errorMessage(error)}`);
	}
	try {
		await resume?.(journal);
	} catch (error) {
		errors.push(`Endpoint resume: ${errorMessage(error)}`);
	}
	if (errors.length === 0) {
		try {
			deleteJournal(journal);
		} catch (error) {
			errors.push(`Journal cleanup: ${errorMessage(error)}`);
		}
	}
	return errors.length > 0
		? report(journal, "pending", ["Move failed; recovery is pending", ...errors])
		: report(journal, "rolled_back", ["Nothing moved"]);
}

/** Normal flow only. The caller still holds its pre-publication target-file lease. */
export async function deleteSessionMoveOriginal(
	journal: SessionMoveJournal,
	paths: SessionMovePaths,
): Promise<{ readonly backups: SessionMoveBackup[]; readonly method?: "trash" | "unlink" }> {
	const backups: SessionMoveBackup[] = [];
	let method: "trash" | "unlink" | undefined;
	let reason: string | undefined;
	const valid = validateSessionMoveJournal(journal, paths.agentDir, paths.sourceSessionDir, paths.journalPath);
	if (!valid.ok) reason = valid.reason;
	for (const key of Object.keys(paths) as (keyof SessionMovePaths)[]) {
		if (journal[key] !== paths[key]) reason = `Invalid journal path or ID: ${key}`;
	}
	try {
		if (!reason) {
			if (journal.fileBytes === undefined || journal.fileSha256 === undefined) {
				reason = "Verified file length or SHA-256 is missing";
			} else {
				const descriptor = openSync(journal.targetFile, "r");
				try {
					const hash = createHash("sha256");
					const buffer = Buffer.alloc(Math.min(journal.fileBytes, 64 * 1024));
					let offset = 0;
					while (offset < journal.fileBytes) {
						const count = readSync(
							descriptor,
							buffer,
							0,
							Math.min(buffer.length, journal.fileBytes - offset),
							offset,
						);
						if (count === 0) break;
						hash.update(buffer.subarray(0, count));
						offset += count;
					}
					if (offset !== journal.fileBytes || hash.digest("hex") !== journal.fileSha256) {
						reason = "Published session's verified prefix changed";
					}
				} finally {
					closeSync(descriptor);
				}
			}
		}
		if (!reason && artifactDigest(journal.sourceArtifacts) !== journal.artifactSha256) {
			reason = "Source artifacts changed during the move; original kept";
		}
		if (!reason && present(journal.sourceBackup)) {
			const removed = await removeMovedSessionFile(journal.sourceBackup);
			if (!removed.ok) reason = removed.error;
			else method = removed.method;
		}
		if (!reason && artifactDigest(journal.sourceArtifacts) !== journal.artifactSha256) {
			reason = "Source artifacts changed during original-file removal; artifacts kept";
		}
		if (!reason && present(journal.sourceArtifacts)) rmSync(journal.sourceArtifacts, { recursive: true });
	} catch (error) {
		reason = errorMessage(error);
	}
	if (reason) {
		for (const path of [paths.sourceBackup, paths.sourceArtifacts]) {
			if (present(path)) backups.push({ path, reason });
		}
	}
	return { backups, method };
}

/** Canonical ordering matches other session file actions; all four leases are enabled. */
export function acquireSessionMoveLeases(paths: SessionMovePaths, agentDir: string): { release(): void } {
	const checked = sessionMovePaths(paths);
	if (!checked.ok) throw new Error(checked.reason);
	for (const key of Object.keys(checked.value) as (keyof SessionMovePaths)[]) {
		if (paths[key] !== checked.value[key]) throw new Error(`Invalid move path: ${key}`);
	}
	const leases: SessionLease[] = [];
	const targets = [
		...new Set(
			[paths.sourceFile, paths.targetFile, paths.fileTemporary, paths.artifactTemporary].map(canonicalSessionPath),
		),
	].sort();
	function release(): void {
		for (const lease of leases.reverse()) lease.release();
	}
	try {
		for (const path of targets) {
			const lease = acquireSessionLease(path, agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
			if (lease) leases.push(lease);
		}
		return { release };
	} catch (error) {
		release();
		throw error;
	}
}

/** The supervisor reserves leases and checks roster/jobs/names before entering this file-only transaction. */
export async function relocateSession(options: {
	readonly paths: SessionMovePaths;
	readonly targetCwd: string;
	readonly targetSocket: string;
	readonly callbacks: SessionMoveCallbacks;
}): Promise<SessionMoveReport> {
	const { paths, callbacks } = options;
	let journal: SessionMoveJournal | undefined;
	let committed = false;
	let meshRecordsWritten = false;
	let originalMethod: "trash" | "unlink" | undefined;
	try {
		const checked = sessionMovePaths(paths);
		if (!checked.ok) throw new Error(checked.reason);
		if (!isDeepStrictEqual(paths, checked.value)) throw new Error("Invalid derived move paths");
		if (!statSync(paths.agentDir).isDirectory()) throw new Error("Agent folder is not a directory");
		if (!statSync(paths.targetSessionDir).isDirectory()) throw new Error("Target session folder is not a directory");
		const targetCwd = realpathSync(options.targetCwd);
		if (!statSync(targetCwd).isDirectory()) throw new Error("Target cwd is not a directory");
		for (const path of [
			paths.journalPath,
			paths.sourceBackup,
			paths.targetFile,
			paths.fileTemporary,
			paths.targetArtifacts,
			paths.artifactTemporary,
		]) {
			if (present(path)) throw new Error(`Move destination already exists: ${path}`);
		}
		const sourceEntries = readMoveEntries(paths.sourceFile);
		const header = sourceEntries[0] as SessionHeader;
		if (header.id !== paths.sessionId) throw new Error("Source session ID differs");
		if (
			header.version !== CURRENT_SESSION_VERSION ||
			(header.parentSession &&
				(!Number.isSafeInteger(header.rlmDepth) || header.rlmDepth === undefined || header.rlmDepth < 0))
		) {
			throw new Error("Open the session once in its own repository first to upgrade it");
		}
		if ((header.rlmDepth ?? 0) > 0) throw new Error("Cannot move an RLM child session");
		assertSessionMoveArtifacts(paths);
		const artifactsPresent = present(paths.sourceArtifacts);
		if (artifactsPresent && !lstatSync(paths.sourceArtifacts).isDirectory()) {
			throw new Error(`Source artifact folder is not a directory: ${paths.sourceArtifacts}`);
		}
		const createdDirectories = [dirname(paths.journalPath), paths.targetArtifactRoot].filter(
			(path) => !present(path),
		);
		journal = {
			...paths,
			version: 1,
			phase: "suspending",
			targetCwd,
			targetSocket: options.targetSocket,
			endpointSuspended: false,
			artifactsPresent,
			artifactSha256: artifactDigest(paths.sourceArtifacts),
			createdDirectories,
		};
		mkdirSync(dirname(paths.journalPath), { recursive: true });
		if (createdDirectories.includes(dirname(paths.journalPath))) fsyncPath(paths.agentDir);
		writeJournal(journal);
		const endpointSuspended = await callbacks.suspend(journal);
		if (artifactDigest(paths.sourceArtifacts) !== journal.artifactSha256) {
			throw new Error("Source artifacts changed while suspending the endpoint; try the move again");
		}
		journal = { ...journal, endpointSuspended, phase: "copying" };
		writeJournal(journal);
		const git = captureGitContext(targetCwd) ?? undefined;
		const transformed = transformSessionMoveEntries(sourceEntries, targetCwd, git);
		const bytes = Buffer.from(`${transformed.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		writeSyncedFile(paths.fileTemporary, bytes);
		journal = { ...journal, fileBytes: bytes.length, fileSha256: digest(bytes) };
		writeJournal(journal);
		if (artifactsPresent) {
			mkdirSync(paths.targetArtifactRoot, { recursive: true });
			if (createdDirectories.includes(paths.targetArtifactRoot)) fsyncPath(dirname(paths.targetArtifactRoot));
			copyArtifacts(paths.sourceArtifacts, paths.artifactTemporary);
			journal = { ...journal, artifactIdentity: artifactIdentity(paths.artifactTemporary) };
			writeJournal(journal);
		}
		const verified = verifySessionMoveCopy(journal, sourceEntries, git);
		if (!verified.ok) throw new Error(verified.reason);
		if (artifactDigest(paths.sourceArtifacts) !== journal.artifactSha256) {
			throw new Error("Source artifacts changed while copying; try the move again");
		}
		journal = { ...journal, phase: "committing" };
		writeJournal(journal);
		renameAbsent(paths.sourceFile, paths.sourceBackup);
		if (artifactsPresent) renameAbsent(paths.artifactTemporary, paths.targetArtifacts);
		if (present(paths.targetFile)) throw new Error(`Rename destination already exists: ${paths.targetFile}`);
		renameSync(paths.fileTemporary, paths.targetFile);
		committed = true;
		fsyncPath(dirname(paths.targetFile));
		journal = { ...journal, phase: "committed" };
		writeJournal(journal);
		const cleanupJournal = { ...journal };
		await callbacks.writeMeshRecords(journal, { enrollment: true, directory: true });
		meshRecordsWritten = true;
		const deletion = await deleteSessionMoveOriginal(journal, paths);
		originalMethod = deletion.method;
		deleteJournal(cleanupJournal);
		return {
			...report(
				cleanupJournal,
				"moved",
				["Session moved", ...deletion.backups.map((backup) => `Kept ${backup.path}: ${backup.reason}`)],
				deletion.backups,
			),
			originalMethod,
			meshRecordsWritten,
		};
	} catch (error) {
		if (journal && present(journal.journalPath)) {
			if (committed)
				return {
					...report(journal, "pending", ["Session published; recovery is pending", errorMessage(error)]),
					committed: true,
					meshRecordsWritten,
					originalMethod,
				};
			const rolledBack = await rollbackSessionMove(journal, callbacks.resume);
			return { ...rolledBack, messages: [errorMessage(error), ...rolledBack.messages] };
		}
		if (journal) {
			for (const path of [...journal.createdDirectories].reverse()) {
				if (present(path) && readdirSync(path).length === 0) rmdirSync(path);
			}
		}
		return {
			status: "rolled_back",
			sourceFile: paths.sourceFile,
			targetFile: paths.targetFile,
			journalPath: paths.journalPath,
			messages: [errorMessage(error), "Nothing moved"],
			backups: [],
		};
	} finally {
		try {
			await callbacks.releaseClaim();
		} finally {
			await callbacks.releaseLeases();
		}
	}
}

function parseJournal(path: string): SessionMoveJournal {
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!raw || typeof raw !== "object") throw new Error("Move journal must be an object");
	const fields = [
		"sessionId",
		"agentDir",
		"sourceSessionDir",
		"sourceFile",
		"targetSessionDir",
		"journalPath",
		"sourceBackup",
		"sourceArtifactRoot",
		"sourceArtifacts",
		"targetArtifactRoot",
		"targetArtifacts",
		"artifactTemporary",
		"targetFile",
		"fileTemporary",
		"targetCwd",
		"targetSocket",
	] as const;
	const record = raw as Record<string, unknown>;
	for (const field of fields) {
		if (typeof record[field] !== "string") throw new Error(`Invalid journal field: ${field}`);
	}
	if (
		!("version" in raw) ||
		raw.version !== 1 ||
		!("phase" in raw) ||
		!(["suspending", "copying", "committing", "committed"] as unknown[]).includes(raw.phase) ||
		!("endpointSuspended" in raw) ||
		typeof raw.endpointSuspended !== "boolean" ||
		!("artifactsPresent" in raw) ||
		typeof raw.artifactsPresent !== "boolean" ||
		!("createdDirectories" in raw) ||
		!Array.isArray(raw.createdDirectories) ||
		!raw.createdDirectories.every((path) => typeof path === "string")
	)
		throw new Error("Invalid move journal state");
	if (
		("fileBytes" in raw &&
			(typeof raw.fileBytes !== "number" || !Number.isSafeInteger(raw.fileBytes) || raw.fileBytes < 0)) ||
		("fileSha256" in raw && (typeof raw.fileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.fileSha256))) ||
		("artifactSha256" in raw &&
			(typeof raw.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.artifactSha256)))
	) {
		throw new Error("Invalid verified file length or SHA-256");
	}
	if (
		"artifactIdentity" in raw &&
		(typeof raw.artifactIdentity !== "string" || !/^\d+:\d+$/.test(raw.artifactIdentity))
	) {
		throw new Error("Invalid artifact directory identity");
	}
	return raw as SessionMoveJournal;
}

/** Recover one source-owned journal. Published moves never restore or delete the original. */
export async function recoverSessionMove(options: {
	readonly journalPath: string;
	readonly agentDir: string;
	readonly sourceSessionDir: string;
	readonly callbacks: SessionMoveRecoveryCallbacks;
}): Promise<SessionMoveReport> {
	const { journalPath, callbacks } = options;
	const unhandled = { sourceFile: "", journalPath, messages: [] as string[], backups: [] as SessionMoveBackup[] };
	if (!present(journalPath)) return { ...unhandled, status: "absent" };
	let journal: SessionMoveJournal;
	try {
		journal = parseJournal(journalPath);
		const checked = validateSessionMoveJournal(journal, options.agentDir, options.sourceSessionDir, journalPath);
		if (!checked.ok) return report(journal, "pending", [checked.reason]);
	} catch (error) {
		return { ...unhandled, status: "pending", messages: [errorMessage(error)] };
	}
	try {
		if (present(journal.targetFile)) {
			let header: unknown;
			try {
				header = JSON.parse(readFirstLineSync(journal.targetFile) ?? "null");
			} catch {
				header = null;
			}
			if (
				!header ||
				typeof header !== "object" ||
				!("type" in header) ||
				header.type !== "session" ||
				!("id" in header) ||
				header.id !== journal.sessionId
			) {
				return report(journal, "pending", [
					`Published target has a missing, malformed, or different session header: ${journal.targetFile}`,
				]);
			}
			const enrollment = (await callbacks.readEnrollmentPath(journal)) !== journal.targetFile;
			const directory = (await callbacks.readDirectorySocket(journal)) !== journal.targetSocket;
			if (enrollment || directory) {
				if (!(await callbacks.acquireClaim(journal)))
					return report(journal, "skipped", ["Enrollment claim is held elsewhere"]);
				try {
					await callbacks.writeMeshRecords(journal, { enrollment, directory });
				} finally {
					await callbacks.releaseClaim();
				}
			}
			const backups = [journal.sourceBackup, journal.sourceArtifacts]
				.filter(present)
				.map((path) => ({ path, reason: "Recovery keeps the original; delete this backup by hand" }));
			// Recovery removes only its journal, not originals or remaining move files.
			unlinkSync(journal.journalPath);
			fsyncPath(dirname(journal.journalPath));
			return report(
				journal,
				"moved",
				["Finished published move", ...backups.map((backup) => `Backup to delete by hand: ${backup.path}`)],
				backups,
			);
		}
		let leases: { release(): void };
		try {
			leases = callbacks.acquireLeases(journal);
		} catch (error) {
			if (error instanceof SessionAlreadyActiveError) {
				return report(journal, "skipped", [`Could not take move leases: ${errorMessage(error)}`]);
			}
			throw error;
		}
		try {
			return await rollbackSessionMove(journal, callbacks.resume);
		} finally {
			leases.release();
		}
	} catch (error) {
		return report(journal, "pending", ["Recovery is pending", errorMessage(error)]);
	}
}
