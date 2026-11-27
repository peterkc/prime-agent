import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enrollmentPath, parseDirectoryEntry } from "../modes/daemon/cotal/mesh-shared.js";
import { resolveSessionRlmDepth, type SessionHeader } from "./session-manager.js";
import { readSessionHeaderLineSync } from "./session-rotation-state.js";

/**
 * The holder's RLM depth, by the same rule as the requester's, or undefined for a stale entry whose enrollment or
 * transcript is gone. A transcript whose header cannot be read counts as top-level, so it keeps its name.
 */
function holderRlmDepth(meshRoot: string, sessionId: string): number | undefined {
	let sessionFile: unknown;
	try {
		sessionFile = (JSON.parse(readFileSync(enrollmentPath(meshRoot, sessionId), "utf8")) as { sessionFile?: unknown })
			.sessionFile;
	} catch {
		return undefined;
	}
	if (typeof sessionFile !== "string" || !existsSync(sessionFile)) return undefined;
	try {
		const header = JSON.parse(readSessionHeaderLineSync(sessionFile) ?? "null") as Partial<SessionHeader> | null;
		return header ? resolveSessionRlmDepth(header, sessionFile) : 0;
	} catch {
		return 0;
	}
}

/**
 * The mesh directory entry that already holds a name, ignoring case. Agent messages resolve a name over every entry
 * in this directory, which all daemons on the machine share, so a second holder makes sends to the name ambiguous.
 * A top-level session conflicts with any other entry; an RLM child conflicts only with top-level sessions, so
 * children of different parents may share a name.
 */
export function findSessionNameHolder(
	agentDir: string,
	sessionId: string,
	name: string,
	rlmDepth: number,
): string | undefined {
	const meshRoot = join(agentDir, "mesh");
	const wanted = name.trim().toLowerCase();
	let files: string[];
	try {
		files = readdirSync(join(meshRoot, "directory"));
	} catch {
		return undefined;
	}
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		const holder = file.slice(0, -5);
		if (holder === sessionId) continue;
		let holderName: string;
		try {
			holderName = parseDirectoryEntry(
				file,
				holder,
				JSON.parse(readFileSync(join(meshRoot, "directory", file), "utf8")),
			).name;
		} catch {
			continue;
		}
		if (holderName.toLowerCase() !== wanted) continue;
		const holderDepth = holderRlmDepth(meshRoot, holder);
		// A stale entry, left by a delete or rename outside a mesh-enabled daemon, does not hold the name.
		if (holderDepth === undefined) continue;
		if (rlmDepth > 0 && holderDepth > 0) continue;
		return holder;
	}
	return undefined;
}

/** Refuses a name that another session in the mesh directory already holds. */
export function assertSessionNameAvailable(agentDir: string, sessionId: string, name: string, rlmDepth: number): void {
	const holder = findSessionNameHolder(agentDir, sessionId, name, rlmDepth);
	if (!holder) return;
	throw new Error(
		rlmDepth > 0
			? `Session name "${name}" is already used by top-level session ${holder}. Choose another name.`
			: `Session name "${name}" is already used by session ${holder}. Choose another name, or rename or delete that session first.`,
	);
}
