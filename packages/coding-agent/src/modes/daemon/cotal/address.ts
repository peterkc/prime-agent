import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type MeshDirectoryEntry, readDirectory, readDirectoryAsync } from "./enrollment.js";

export interface MeshAddress {
	readonly space: string;
	readonly target: string;
}

export type MeshAddressResult =
	| { readonly ok: true; readonly entry: MeshDirectoryEntry }
	| { readonly ok: false; readonly reason: "unsupported-space" | "unknown" | "ambiguous"; readonly error: string };

export function resolveMeshAddress(
	address: MeshAddress,
	localSpace: string,
	entries: readonly MeshDirectoryEntry[],
): MeshAddressResult {
	if (address.space !== localSpace)
		return {
			ok: false,
			reason: "unsupported-space",
			error: `Mesh space ${JSON.stringify(address.space)} is not yet supported`,
		};
	const byId = entries.find((entry) => entry.sessionId === address.target);
	if (byId) return { ok: true, entry: byId };
	const matches = entries.filter((entry) => entry.name.toLowerCase() === address.target.toLowerCase());
	if (matches.length === 1) return { ok: true, entry: matches[0]! };
	if (matches.length === 0)
		return { ok: false, reason: "unknown", error: `Unknown mesh target ${JSON.stringify(address.target)}` };
	return {
		ok: false,
		reason: "ambiguous",
		error: `Ambiguous mesh target ${JSON.stringify(address.target)}: ${matches.map((entry) => `${entry.sessionId} (${JSON.stringify(entry.name)})`).join(", ")}`,
	};
}

export async function resolveDirectoryAddress(
	meshRoot: string,
	localSpace: string,
	selector: string,
	onInvalidEntry: (file: string) => void,
): Promise<MeshAddressResult> {
	// Read an exact ID first, so an unrelated broken directory entry cannot block it.
	if (/^[A-Za-z0-9_-]+$/.test(selector)) {
		try {
			const entry = readDirectory(meshRoot, selector);
			if (entry) return { ok: true, entry };
		} catch {
			// The scan below checks the actual filename, including on a case-insensitive filesystem.
		}
	}
	const directory = join(meshRoot, "directory");
	const entries: MeshDirectoryEntry[] = [];
	let files: string[];
	try {
		files = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		files = [];
	}
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		try {
			const entry = await readDirectoryAsync(meshRoot, file.slice(0, -5));
			if (entry) entries.push(entry);
		} catch {
			onInvalidEntry(file);
		}
	}
	const local = resolveMeshAddress({ space: localSpace, target: selector }, localSpace, entries);
	if (local.ok || local.reason !== "unknown") return local;
	const separator = selector.indexOf("/");
	if (separator <= 0 || separator === selector.length - 1) return local;
	return resolveMeshAddress(
		{ space: selector.slice(0, separator), target: selector.slice(separator + 1) },
		localSpace,
		entries,
	);
}
