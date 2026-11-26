import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { execFileSyncHidden, spawnSyncHidden } from "./utils/child-process.ts";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	/** Set on records written by a kernel (e.g. bash() children) so the host can reap per kernel. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	/** Missing on identity-free records: old journals or host writes whose start-id query failed (kernels no longer write pid-only records). */
	processStartId?: string;
}

export function recordOrphanProcessState(pid: number, active: boolean, path: string): void {
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		const descriptor = openSync(path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<number, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as OrphanProcessRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	// Pid-only actives (no processStartId) still surface from old journals or
	// host writes whose start-id query failed; reapers decide per-platform.
	return [...latest.values()]
		.filter(
			(record) =>
				record.active && (record.processStartId === undefined || typeof record.processStartId === "string"),
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	// Pid-only records can never claim identity (undefined === undefined must not match).
	return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}

/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there).
 */
export function shouldReapOrphanProcess(orphan: ActiveOrphanProcess): boolean {
	if (orphan.processStartId === undefined) {
		return process.platform !== "win32";
	}
	return isOrphanProcessIdentityCurrent(orphan);
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(kernelPid: number, path: string): void {
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return;
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return;
	}
	for (const orphan of orphans) {
		if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
			continue;
		}
		if (!shouldReapOrphanProcess(orphan)) {
			continue;
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (killOrphanProcess(orphan.pid)) {
			recordOrphanProcessState(orphan.pid, false, path);
		}
	}
}

// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
		const result = spawnSyncHidden(
			win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// The orphan may already have exited.
		}
	}
	return false;
}

interface ProcessQueryOptions {
	env?: NodeJS.ProcessEnv;
}

type ProcessQuery = (command: string, args: string[], options?: ProcessQueryOptions) => string;

function runProcessQuery(command: string, args: string[], options?: ProcessQueryOptions): string {
	return execFileSyncHidden(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: options?.env,
	});
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

export function getPsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		// `lstart` is rendered in the subprocess timezone and locale, so pin both for a durable identity.
		const startTime = query("ps", ["-p", String(pid), "-o", "lstart="], {
			env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
		}).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		return getWindowsProcessStartId(pid);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) {
			return `proc:${startTime}`;
		}
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	return getPsProcessStartId(pid);
}
