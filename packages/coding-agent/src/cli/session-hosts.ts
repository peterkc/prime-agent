import { APP_NAME } from "../config.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import { isSessionSummary } from "../modes/daemon/daemon-protocol.js";
import { matchesSessionIdSuffix } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { type DaemonInfo, discoverDaemons } from "./daemon-ps.js";

const HOST_LOOKUP_TIMEOUT_MS = 2000;

/** A live session in a daemon other than the one a command reached. */
export interface SessionHost {
	readonly socketPath: string;
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionName?: string;
}

export interface SessionHostLookup {
	readonly discover?: () => Promise<readonly DaemonInfo[]>;
	readonly list?: (socketPath: string) => Promise<readonly SessionSummary[]>;
}

/** The selector rule of `stop`: exact ids or names first, unambiguous id suffixes second. */
export function matchLiveSessions(sessions: readonly SessionSummary[], selector: string): SessionSummary[] {
	const live = sessions.filter((session) => typeof session.activeSessionId === "string");
	const exact = live.filter(
		(session) =>
			session.activeSessionId === selector || session.sessionId === selector || session.sessionName === selector,
	);
	if (exact.length > 0) return exact;
	return live.filter(
		(session) =>
			matchesSessionIdSuffix(session.activeSessionId!, selector) ||
			matchesSessionIdSuffix(session.sessionId, selector),
	);
}

async function listLiveSessions(socketPath: string): Promise<readonly SessionSummary[]> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(HOST_LOOKUP_TIMEOUT_MS);
		const response = await client.request({ type: "list" }, HOST_LOOKUP_TIMEOUT_MS);
		const sessions = response.success ? (response.data as { sessions?: unknown } | undefined)?.sessions : undefined;
		return Array.isArray(sessions) ? sessions.filter(isSessionSummary) : [];
	} finally {
		client.close();
	}
}

/**
 * Finds the selector in every other reachable daemon. Only for error hints: a daemon that fails to answer is
 * skipped, so the caller keeps its own error.
 */
export async function findSessionHosts(
	selector: string,
	reachedSocket: string,
	lookup: SessionHostLookup = {},
): Promise<SessionHost[]> {
	const list = lookup.list ?? listLiveSessions;
	let daemons: readonly DaemonInfo[];
	try {
		daemons = await (lookup.discover ?? discoverDaemons)();
	} catch {
		return [];
	}
	const reached = normalizeSocketPath(reachedSocket);
	const others = daemons.filter(
		(daemon) =>
			(daemon.status === "current" || daemon.status === "stale") &&
			normalizeSocketPath(daemon.socketPath) !== reached,
	);
	const found = await Promise.all(
		others.map(async (daemon) => {
			const sessions = await list(daemon.socketPath).catch(() => []);
			return matchLiveSessions(sessions, selector).map(
				(session): SessionHost => ({
					socketPath: daemon.socketPath,
					activeSessionId: session.activeSessionId!,
					sessionId: session.sessionId,
					...(session.sessionName ? { sessionName: session.sessionName } : {}),
				}),
			);
		}),
	);
	return found.flat();
}

function quoteArgument(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stopCommand(host: SessionHost): string {
	return `${APP_NAME} stop ${quoteArgument(host.activeSessionId)} --daemon-socket ${quoteArgument(host.socketPath)}`;
}

function hostLabel(host: SessionHost): string {
	return `${host.sessionName ?? host.sessionId} is live in ${host.socketPath}`;
}

export function formatStopHint(hosts: readonly SessionHost[]): string {
	return hosts.map((host) => `${hostLabel(host)}. Stop it there:\n  ${stopCommand(host)}`).join("\n");
}

export function formatMoveHint(hosts: readonly SessionHost[], targetFolder: string): string {
	if (hosts.length === 0)
		return `Another daemon still holds this session, often the daemon that ran it before. Run the move against that daemon with --daemon-socket <socket>; \`${APP_NAME} status\` lists the daemons.`;
	return hosts
		.map(
			(host) =>
				`${hostLabel(host)}. Stop it there, then move it from that daemon:\n  ${stopCommand(host)}\n  ${APP_NAME} move ${quoteArgument(host.sessionId)} ${quoteArgument(targetFolder)} --daemon-socket ${quoteArgument(host.socketPath)}`,
		)
		.join("\n");
}
