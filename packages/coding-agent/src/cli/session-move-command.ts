import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_NAME, expandTildePath, getAgentDir, getSessionsDir } from "../config.js";
import { canonicalSessionPath } from "../core/session-lease.js";
import { SessionManager } from "../core/session-manager.js";
import { preflightSessionMove } from "../core/session-move.js";
import { looksLikeSessionPath } from "../core/session-resolver.js";
import { enrollmentPath } from "../modes/daemon/cotal/mesh-shared.js";
import { resolveCatalogSessionMatch } from "../modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	type DaemonResponse,
	meetsDaemonCommandCompatibility,
} from "../modes/daemon/daemon-protocol.js";
import { matchesSessionIdSuffix } from "../modes/daemon/daemon-session-id.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { readPersistedDaemonFolders } from "../modes/daemon/daemon-supervisor.js";
import { getCommandSpec } from "./command-registry.js";
import { runStart } from "./daemon-command.js";
import { promptYesNo } from "./daemon-stop-confirm.js";
import { prepareRepositoryDaemon, resolveRepositoryDaemon } from "./repository-daemon.js";

const SESSION_MOVE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface MoveOptions {
	readonly selector: string;
	readonly folder: string;
	readonly socketPath?: string;
	readonly dryRun: boolean;
	readonly yes: boolean;
	readonly json: boolean;
}

function parseOptions(args: readonly string[]): MoveOptions {
	const operands: string[] = [];
	let socketPath: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (["--dry-run", "--yes", "--json"].includes(arg)) continue;
		if (arg === "--daemon-socket" || arg === "--socket") {
			const path = args[++index];
			if (!path || path.startsWith("-") || socketPath) throw new Error(`${arg} requires one path`);
			socketPath = normalizeSocketPath(path);
		} else if (arg.startsWith("-")) throw new Error(`Unknown move option: ${arg}`);
		else operands.push(arg);
	}
	if (operands.length !== 2) throw new Error(`Usage: ${APP_NAME} ${getCommandSpec(["move"])!.usage}`);
	return {
		selector: operands[0]!,
		folder: operands[1]!,
		socketPath,
		dryRun: args.includes("--dry-run"),
		yes: args.includes("--yes"),
		json: args.includes("--json"),
	};
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** No version probe: that probe logs, and its ensure path can replace a daemon. */
async function readSourceDaemon(socketPath: string): Promise<DaemonClient | undefined> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
	} catch (error) {
		client.close();
		const message = error instanceof Error ? error.message : String(error);
		// DaemonClient wraps connect errors without retaining their errno.
		if (/^Failed to connect to the Prime Agent daemon: connect (ENOENT|ECONNREFUSED) /.test(message))
			return undefined;
		throw new Error(`Cannot read source daemon: ${message}`, { cause: error });
	}
	try {
		const hello = await client.waitForHello();
		if (
			!client.supportsServerCapability("session_move") ||
			!meetsDaemonCommandCompatibility(hello, DAEMON_COMMAND_COMPATIBILITY.move_saved_session)
		) {
			throw new Error("Source daemon does not support session_move at schema revision 36; it was not restarted");
		}
		return client;
	} catch (error) {
		client.close();
		throw new Error(`Cannot read source daemon: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

interface RosterSession {
	readonly id: string;
	readonly sessionId: string;
	readonly activeSessionId?: string;
	readonly sessionName?: string;
	readonly sessionFile?: string;
}

function isRosterSession(value: unknown): value is RosterSession {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string") return false;
	return ["activeSessionId", "sessionName", "sessionFile"].every(
		(key) => value[key] === undefined || typeof value[key] === "string",
	);
}

async function readRoster(client: DaemonClient | undefined): Promise<RosterSession[]> {
	if (!client) return [];
	const response = await client.request({ type: "list" });
	if (!response.success) throw new Error(`Cannot read source daemon state: ${response.error}`);
	if (
		!isRecord(response.data) ||
		!Array.isArray(response.data.sessions) ||
		!response.data.sessions.every(isRosterSession)
	) {
		throw new Error("Cannot read source daemon state: invalid session list");
	}
	return response.data.sessions;
}

async function resolveSource(selector: string, sessionDir: string, roster: readonly RosterSession[]): Promise<string> {
	if (looksLikeSessionPath(selector)) return resolve(expandTildePath(selector));
	const exact = roster.filter(
		(row) =>
			row.id === selector ||
			row.activeSessionId === selector ||
			row.sessionId === selector ||
			row.sessionName === selector,
	);
	const matches = exact.length
		? exact
		: roster.filter(
				(row) =>
					matchesSessionIdSuffix(row.activeSessionId ?? row.id, selector) ||
					matchesSessionIdSuffix(row.sessionId, selector),
			);
	if (matches.length > 1) throw new Error(`Ambiguous session selector "${selector}"`);
	if (matches[0]?.sessionFile) return matches[0].sessionFile;
	const local = resolveCatalogSessionMatch(await SessionManager.list(process.cwd(), sessionDir), selector);
	const saved = local ?? resolveCatalogSessionMatch(await SessionManager.listAll(undefined, sessionDir), selector);
	if (!saved) throw new Error(`No session found matching '${selector}'`);
	return saved.path;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface RecoveredMove {
	readonly status: string;
	readonly messages: readonly string[];
	readonly backups: readonly { readonly path: string; readonly reason: string }[];
}

function parseRecovered(value: unknown): readonly RecoveredMove[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		!value.every(
			(row) =>
				isRecord(row) &&
				typeof row.status === "string" &&
				Array.isArray(row.messages) &&
				row.messages.every((message) => typeof message === "string") &&
				Array.isArray(row.backups) &&
				row.backups.every(
					(backup) => isRecord(backup) && typeof backup.path === "string" && typeof backup.reason === "string",
				),
		)
	) {
		throw new Error("Source daemon returned invalid recovered move reports; inspect the move journals");
	}
	return value;
}

function printRecovered(recovered: readonly RecoveredMove[]): void {
	for (const row of recovered) {
		console.log(`Recovered move: ${row.status}`);
		for (const message of row.messages) console.log(message);
		for (const backup of row.backups) console.log(`Kept ${backup.path}: ${backup.reason}`);
	}
}

interface MoveReply {
	readonly moved: true;
	readonly targetFile: string;
	readonly original: {
		readonly deleted: boolean;
		readonly method?: "trash" | "unlink";
		readonly backups: readonly { readonly path: string; readonly reason: string }[];
	};
	readonly mesh:
		| { readonly status: "updated" | "not_enrolled" }
		| { readonly status: "failed"; readonly step: "enrollment" | "directory"; readonly reason: string };
	readonly messages: readonly string[];
	readonly recovered: readonly RecoveredMove[];
	readonly recoveryPending: boolean;
}

function parseReply(value: unknown): MoveReply {
	if (
		!isRecord(value) ||
		value.moved !== true ||
		typeof value.targetFile !== "string" ||
		!isRecord(value.original) ||
		typeof value.original.deleted !== "boolean" ||
		(value.original.method !== undefined &&
			value.original.method !== "trash" &&
			value.original.method !== "unlink") ||
		!Array.isArray(value.original.backups) ||
		!value.original.backups.every(
			(backup) => isRecord(backup) && typeof backup.path === "string" && typeof backup.reason === "string",
		) ||
		!isRecord(value.mesh) ||
		!["updated", "not_enrolled", "failed"].includes(String(value.mesh.status)) ||
		(value.mesh.status === "failed" &&
			(typeof value.mesh.reason !== "string" ||
				(value.mesh.step !== "enrollment" && value.mesh.step !== "directory"))) ||
		!Array.isArray(value.messages) ||
		!value.messages.every((message) => typeof message === "string") ||
		!Array.isArray(value.recovered) ||
		typeof value.recoveryPending !== "boolean"
	) {
		throw new Error("Source daemon returned an invalid move result; inspect the session before retrying");
	}
	return { ...value, recovered: parseRecovered(value.recovered) } as unknown as MoveReply;
}

export async function runSessionMove(args: readonly string[]): Promise<void> {
	let client: DaemonClient | undefined;
	let recovered: readonly RecoveredMove[] = [];
	try {
		const options = parseOptions(args);
		const agentDir = getAgentDir();
		const sourceRepository = options.socketPath ? undefined : resolveRepositoryDaemon(process.cwd());
		const sourceSocket = options.socketPath ?? sourceRepository?.socketPath ?? defaultDaemonSocketPath();
		const sourceFolders = readPersistedDaemonFolders(agentDir, sourceSocket);
		const sourceSessionDir = sourceFolders?.sessionDir ?? sourceRepository?.sessionDir ?? getSessionsDir(agentDir);
		const targetCwd = realpathSync(expandTildePath(options.folder));
		if (!statSync(targetCwd).isDirectory()) throw new Error(`Target folder is not a directory: ${targetCwd}`);
		const targetRepository = resolveRepositoryDaemon(targetCwd);
		const targetSocket = targetRepository?.socketPath ?? defaultDaemonSocketPath();
		const targetSessionDir =
			readPersistedDaemonFolders(agentDir, targetSocket)?.sessionDir ??
			targetRepository?.sessionDir ??
			getSessionsDir(agentDir);
		client = await readSourceDaemon(sourceSocket);
		const roster = await readRoster(client);
		const sessionPath = await resolveSource(options.selector, sourceSessionDir, roster);
		const { paths, info } = await preflightSessionMove({
			agentDir,
			sourceSessionDir,
			sourceFile: sessionPath,
			targetSessionDir,
		});
		if (
			roster.some(
				(row) =>
					row.sessionFile &&
					canonicalSessionPath(row.sessionFile) === paths.sourceFile &&
					row.activeSessionId !== undefined,
			)
		) {
			throw new Error("Cannot move the currently active session");
		}
		const resume = info.id.startsWith("-") ? `--resume=${info.id}` : `--resume ${info.id}`;
		const openCommand = `cd ${shellQuote(targetCwd)} && ${APP_NAME} ${resume}`;
		const identity = { sessionId: info.id, name: info.name ?? null, targetFile: paths.targetFile, openCommand };
		const recheck =
			"The source daemon checks again during the real move, including that no process has the session open.";
		const meshHosting =
			"The target daemon hosts the session's mesh inbox once the session is opened there or that daemon starts.";
		if (options.dryRun) {
			const preview = {
				...identity,
				dryRun: true,
				original: { file: paths.sourceFile, artifacts: paths.sourceArtifacts },
				mesh: { enrolled: present(enrollmentPath(join(agentDir, "mesh"), info.id)) },
				recheck,
				meshHosting,
			};
			if (options.json) console.log(JSON.stringify(preview));
			else {
				console.log(`Would move ${info.name ?? "(unnamed)"} (${info.id}) to ${paths.targetFile}`);
				console.log(
					`Would delete original file: ${paths.sourceFile} and artifact folder: ${paths.sourceArtifacts}`,
				);
				console.log(`Mesh: ${preview.mesh.enrolled ? "enrolled" : "not enrolled"}`);
				console.log(`${openCommand}\n${meshHosting}\n${recheck}`);
			}
			return;
		}
		if (!options.yes) {
			if (!process.stdin.isTTY)
				throw new Error("move requires terminal confirmation. Use --yes in non-interactive shells");
			const print = options.json ? console.error : console.log;
			print(`Source session file: ${paths.sourceFile}\nTarget session file: ${paths.targetFile}`);
			print(`The original session file goes to the Trash, or is unlinked if trash is missing: ${paths.sourceFile}`);
			print(`The original artifact folder is removed: ${paths.sourceArtifacts}`);
			if (!(await promptYesNo(`Move ${info.name ?? info.id} (${info.id}) to ${targetCwd}?`)))
				throw new Error("Session move declined");
		}
		if (!client) {
			await runStart(
				{
					command: "start",
					socketPath: sourceSocket,
					json: true,
					repositoryRouted: false,
					positionals: [
						"--cwd",
						sourceFolders?.cwd ?? sourceRepository?.root ?? process.cwd(),
						"--session-dir",
						sourceSessionDir,
					],
				},
				{ quiet: true },
			);
			client = await readSourceDaemon(sourceSocket);
			if (!client) throw new Error("Source daemon did not start");
		}
		// No await before request: readSourceDaemon already cached the hello.
		if (!client.isConnected) {
			throw new Error("Move failed: source daemon disconnected before the move request was sent. Nothing moved.");
		}
		if (targetRepository && targetSessionDir === targetRepository.sessionDir)
			prepareRepositoryDaemon(targetRepository);
		else mkdirSync(targetSessionDir, { recursive: true });
		let response: DaemonResponse;
		try {
			response = await client.request(
				{
					type: "move_saved_session",
					sessionPath: paths.sourceFile,
					targetSessionDir: paths.targetSessionDir,
					targetCwd,
					targetSocket,
				},
				SESSION_MOVE_TIMEOUT_MS,
			);
		} catch (error) {
			throw new Error(
				`Move result is unknown: ${error instanceof Error ? error.message : String(error)}. Check the target folder ${targetCwd} and run ${APP_NAME} move ${shellQuote(options.selector)} ${shellQuote(targetCwd)} --dry-run again.`,
				{ cause: error },
			);
		}
		recovered = parseRecovered(isRecord(response.data) ? response.data.recovered : undefined);
		if (!response.success) throw new Error(response.error);
		const reply = parseReply(response.data);
		const note =
			reply.mesh.status === "failed"
				? "The source daemon finishes the mesh update at its next start or move and keeps the original as a backup to delete by hand. The target daemon hosts the mesh inbox only after the source finishes the update or the session is opened there."
				: meshHosting;
		const output = { ...reply, ...identity, targetFile: reply.targetFile, meshHosting: note };
		if (options.json) console.log(JSON.stringify(output));
		else {
			printRecovered(reply.recovered);
			console.log(`Moved ${info.name ?? "(unnamed)"} (${info.id}) to ${reply.targetFile}`);
			if (reply.original.method)
				console.log(
					`Original file ${reply.original.method === "trash" ? "trashed" : "unlinked"}: ${paths.sourceBackup}`,
				);
			if (reply.original.deleted) console.log(`Original artifact folder removed: ${paths.sourceArtifacts}`);
			for (const backup of reply.original.backups) console.log(`Kept ${backup.path}: ${backup.reason}`);
			if (!reply.original.deleted && reply.original.backups.length === 0)
				console.log(
					`Original backup kept: ${paths.sourceBackup}; artifact folder kept: ${paths.sourceArtifacts}. ${reply.messages.join("; ")}`,
				);
			console.log(
				`Mesh: ${reply.mesh.status === "failed" ? `failed at ${reply.mesh.step}: ${reply.mesh.reason}` : reply.mesh.status === "updated" ? "records updated" : "not enrolled"}`,
			);
			for (const message of reply.messages) console.log(message);
			console.log(`${openCommand}\n${note}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (args.includes("--json"))
			console.log(
				JSON.stringify({
					error: message,
					...(recovered.length ? { recovered } : {}),
					...(args.includes("--dry-run") ? { dryRun: true } : {}),
				}),
			);
		else {
			printRecovered(recovered);
			console.error(message);
		}
		process.exitCode = 1;
	} finally {
		client?.close();
	}
}
