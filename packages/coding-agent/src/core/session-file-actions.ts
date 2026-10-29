import { type Dirent, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { spawnSyncHidden } from "../utils/child-process.js";
import { readFirstLineSync } from "../utils/file-lines.js";
import {
	acquireSessionLease,
	canonicalSessionPath,
	hasSessionLease,
	SESSION_LEASES_ENABLED_ENV,
	type SessionLease,
} from "./session-lease.js";
import { getSessionArtifactPathForFile } from "./session-manager.js";

/** Reserve the target and artifact files before a recursive saved-session delete. */
export function acquireSessionDeleteLeases(sessionPath: string, agentDir: string): { release(): void } {
	const leases: SessionLease[] = [];
	const paths = new Set<string>();
	const release = () => {
		for (const lease of leases.reverse()) lease.release();
	};
	const acquire = (path: string) => {
		if (paths.has(canonicalSessionPath(path))) return;
		const lease = acquireSessionLease(path, agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
		if (lease) {
			leases.push(lease);
			paths.add(lease.sessionPath);
		}
	};
	try {
		acquire(sessionPath);
		const directories = basename(sessionPath).replace(/\.jsonl$/, "")
			? [getSessionArtifactPathForFile(sessionPath)]
			: [];
		while (directories.length > 0) {
			const directory = directories.pop()!;
			let entries: Dirent[];
			try {
				// rm removes directory symlinks themselves, not the trees they point at.
				if (!lstatSync(directory).isDirectory()) continue;
				entries = readdirSync(directory, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					directories.push(path);
					continue;
				}
				if (!hasSessionLease(path, agentDir)) {
					if (!entry.isFile() && !entry.isSymbolicLink()) continue;
					try {
						if (entry.isSymbolicLink() && !statSync(path).isFile()) continue;
						const header = JSON.parse(readFirstLineSync(path) ?? "null") as { type?: unknown } | null;
						if (header?.type !== "session") continue;
					} catch {
						// No existing lease: a failed probe identifies no owner to protect.
						continue;
					}
				}
				acquire(path);
			}
		}
		return { release };
	} catch (error) {
		release();
		throw error;
	}
}

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void | Promise<void>;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	// A degenerate name (".jsonl") would resolve to the artifacts root itself.
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSyncHidden("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/** Unlike ordinary delete, a move backup is kept when an installed trash command fails. */
export async function removeMovedSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const result = spawnSyncHidden("trash", args, { encoding: "utf-8" });
	if (!existsSync(sessionPath)) return { ok: true, method: "trash" };
	const extensions = process.platform === "win32" ? ["", ".exe", ".com", ".cmd", ".bat"] : [""];
	const installed = (process.env.PATH ?? "")
		.split(delimiter)
		.some((directory) => extensions.some((extension) => existsSync(join(directory, `trash${extension}`))));
	if ((result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" || installed) {
		return { ok: false, error: `trash failed: ${result.error?.message ?? (result.stderr?.trim() || result.status)}` };
	}
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		await options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
