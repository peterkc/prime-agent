import { basename } from "node:path";
import { ENV_SESSION_DIR, getAgentDir } from "../config.js";
import { readPersistedDaemonFolders } from "../modes/daemon/daemon-supervisor.js";
import { DAEMON_WORKER_SUPERVISOR_SOCKET_ENV } from "../modes/daemon/daemon-worker-protocol.js";
import { normalizeSocketPath } from "../utils/daemon-socket-path.js";
import { type DaemonInfo, discoverDaemons, planShutdownConfirmation } from "./daemon-ps.js";
import { pluralizeSessions, promptYesNo } from "./daemon-stop-confirm.js";
import { type DaemonUpdateRestartStatus, launchDaemonUpdateRestartCoordinator } from "./daemon-update-restart.js";

interface RestartOptions {
	readonly names: readonly string[];
	readonly socketPath?: string;
	readonly force: boolean;
	readonly json: boolean;
}

interface RestartTarget {
	readonly name: string;
	readonly socketPath: string;
	readonly sessionCount?: number;
}

type RestartResult = Pick<RestartTarget, "name" | "socketPath"> &
	Pick<DaemonUpdateRestartStatus, "phase" | "counts" | "failures" | "message">;

function parseRestartOptions(args: readonly string[]): RestartOptions | { readonly error: string } {
	const names: string[] = [];
	let socketPath: string | undefined;
	let force = false;
	let json = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		switch (arg) {
			case "--force":
				force = true;
				break;
			case "--json":
				json = true;
				break;
			case "--daemon-socket": {
				const path = args[++index];
				if (!path || path.startsWith("-") || socketPath !== undefined) {
					return { error: "--daemon-socket requires one path." };
				}
				socketPath = normalizeSocketPath(path);
				break;
			}
			default:
				if (arg.startsWith("-")) return { error: `Unknown restart option: ${arg}` };
				names.push(arg);
		}
	}
	if (names.length > 0 && socketPath !== undefined) {
		return { error: "Daemon names cannot be combined with --daemon-socket." };
	}
	return { names, socketPath, force, json };
}

function restartTarget(daemon: DaemonInfo): RestartTarget {
	const socketPath = normalizeSocketPath(daemon.socketPath);
	const stem = basename(socketPath).replace(/\.sock$/, "");
	return {
		name: daemon.isDefault ? "default" : stem.replace(/-\d+$/, ""),
		socketPath,
		sessionCount: daemon.sessionCount,
	};
}

function matchesTarget(name: string, target: RestartTarget): boolean {
	const fileName = basename(target.socketPath);
	return (
		name === target.name ||
		name === fileName ||
		name === fileName.replace(/\.sock$/, "") ||
		normalizeSocketPath(name) === target.socketPath
	);
}

function resolveTargets(
	daemons: readonly DaemonInfo[],
	options: RestartOptions,
): { readonly targets: readonly RestartTarget[] } | { readonly error: string } {
	const reachable = daemons
		.filter((daemon) => daemon.status === "current" || daemon.status === "stale")
		.map(restartTarget);
	const selectors = options.socketPath === undefined ? options.names : [options.socketPath];
	if (selectors.length === 0) return { targets: reachable };
	const targets: RestartTarget[] = [];
	for (const name of selectors) {
		const matches = reachable.filter((target) => matchesTarget(name, target));
		if (matches.length !== 1) {
			const candidates = reachable.map((target) => `${target.name}: ${target.socketPath}`).join("\n");
			return {
				error: `${matches.length === 0 ? "No reachable daemon matches" : "Ambiguous daemon"}: ${name}\nCandidates:\n${candidates || "(none)"}`,
			};
		}
		const target = matches[0]!;
		if (!targets.some((selected) => selected.socketPath === target.socketPath)) targets.push(target);
	}
	return { targets };
}

function failRestart(message: string): void {
	console.error(message);
	process.exitCode = 1;
}

async function confirmRestart(targets: readonly RestartTarget[], options: RestartOptions): Promise<boolean> {
	const printTarget = options.json ? console.error : console.log;
	for (const target of targets) {
		printTarget(
			`${target.name}: ${target.socketPath} (${target.sessionCount ?? "unknown"} ${pluralizeSessions(target.sessionCount ?? 0).noun})`,
		);
	}
	switch (planShutdownConfirmation(targets.length, options.json, options.force, process.stdin.isTTY)) {
		case "none":
			return true;
		case "prompt":
			return promptYesNo(`Restart ${targets.length} daemon${targets.length === 1 ? "" : "s"}?`);
		case "json-error":
			failRestart("restart --json requires --force.");
			return false;
		case "tty-error":
			failRestart("restart requires an interactive confirmation. Use --force in non-interactive shells.");
			return false;
	}
}

async function restartDaemon(target: RestartTarget): Promise<RestartResult> {
	const sessionDir = process.env[ENV_SESSION_DIR];
	try {
		const agentDir = getAgentDir();
		const folders = readPersistedDaemonFolders(agentDir, target.socketPath);
		if (folders?.cwd === undefined) {
			console.error(`${target.name}: saved default folder is unavailable; using ${process.cwd()}.`);
		}
		if (folders !== undefined) process.env[ENV_SESSION_DIR] = folders.sessionDir ?? "";
		const { phase, counts, failures, message } = await launchDaemonUpdateRestartCoordinator({
			socketPath: target.socketPath,
			agentDir,
			cwd: folders?.cwd ?? process.cwd(),
		});
		return { name: target.name, socketPath: target.socketPath, phase, counts, failures, message };
	} catch (error) {
		return {
			name: target.name,
			socketPath: target.socketPath,
			phase: "failed",
			counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (sessionDir === undefined) delete process.env[ENV_SESSION_DIR];
		else process.env[ENV_SESSION_DIR] = sessionDir;
	}
}

function restartFailed(result: RestartResult): boolean {
	return result.phase === "failed" || result.counts.failed > 0;
}

function printRestartResult(result: RestartResult): void {
	const { restored, resumed, failed } = result.counts;
	const outcome =
		result.phase === "failed"
			? `failed: ${result.message ?? "unknown error"}`
			: result.phase === "skipped"
				? "not running"
				: "restarted";
	console.log(`${result.name}: ${outcome} (restored ${restored}, resumed ${resumed}, failed ${failed})`);
	for (const failure of result.failures ?? []) {
		console.error(`${result.name}: ${failure.sessionFile}: ${failure.message}`);
	}
}

export async function runRestart(args: readonly string[]): Promise<void> {
	const results: RestartResult[] = [];
	try {
		const options = parseRestartOptions(args);
		if ("error" in options) return failRestart(options.error);
		const selection = resolveTargets(await discoverDaemons(), options);
		if ("error" in selection) return failRestart(selection.error);
		const { targets } = selection;
		if (!(await confirmRestart(targets, options))) return;
		const ownSocket = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		const ownPath = ownSocket ? normalizeSocketPath(ownSocket) : undefined;
		const ordered = [...targets].sort((a, b) => Number(a.socketPath === ownPath) - Number(b.socketPath === ownPath));
		for (const target of ordered) {
			const result = await restartDaemon(target);
			results.push(result);
			if (restartFailed(result)) process.exitCode = 1;
			if (!options.json) printRestartResult(result);
		}
	} catch (error) {
		failRestart(error instanceof Error ? error.message : String(error));
	} finally {
		if (args.includes("--json")) console.log(JSON.stringify(results, null, 2));
	}
}
