import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { isProcessAlive } from "../utils/child-process.js";

/** Resolve missing descendants too, without replacing or creating a symlink. */
export function canonicalStoragePath(path: string, seen = new Set<string>()): string {
	const absolute = resolve(path);
	if (seen.has(absolute)) throw new Error(`Cyclic session storage symlink: ${path}`);
	seen.add(absolute);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		if (lstatSync(absolute).isSymbolicLink()) {
			return canonicalStoragePath(resolve(dirname(absolute), readlinkSync(absolute)), seen);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(canonicalStoragePath(parent, seen), basename(absolute));
}

/** Archive identity follows the generated v7 and legacy v4 session UUIDs. Custom SDK IDs do not rotate. */
export function isRotatableSessionId(id: string): boolean {
	return /^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}

export function isSessionArchivePath(path: string): boolean {
	for (const candidate of [resolve(path), canonicalStoragePath(path)]) {
		const components = candidate.slice(parse(candidate).root.length).split(sep);
		if (
			components.some(
				(part, index) =>
					part.toLowerCase() === "archive" && isRotatableSessionId((components[index + 1] ?? "").toLowerCase()),
			)
		)
			return true;
	}
	return false;
}

/** Benign archive files are removable on delete and excluded from move copies. */
export function isDisposableSessionArchiveFile(name: string): boolean {
	if (name === ".DS_Store") return true;
	const temporary =
		/^(0|[1-9][0-9]*)\.jsonl\.([1-9][0-9]*)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(
			name,
		);
	return !!temporary && Number.isSafeInteger(Number(temporary[2])) && !isProcessAlive(Number(temporary[2]));
}

export function requireActiveSessionPath(path: string): void {
	if (isSessionArchivePath(path)) throw new Error(`Cannot write or resume a session archive: ${path}`);
	for (const candidate of [resolve(path), canonicalStoragePath(path)]) {
		const name = basename(candidate);
		if (name.endsWith(".moved") || name.endsWith(".moving")) {
			throw new Error(`Cannot open move backup or temporary: ${path}`);
		}
		if (name.endsWith(".relocated")) throw new Error(`Cannot open move redirect: ${path}`);
	}
}

export function sessionArchivePath(activeFile: string, sessionId: string, segment: number): string {
	if (!isRotatableSessionId(sessionId) || !Number.isSafeInteger(segment) || segment < 0) {
		throw new Error("Unsafe session archive identity");
	}
	const path = join(dirname(canonicalStoragePath(activeFile)), "archive", sessionId, `${segment}.jsonl`);
	if (canonicalStoragePath(path) !== path) throw new Error(`Session archive symlink is not allowed: ${path}`);
	return path;
}
