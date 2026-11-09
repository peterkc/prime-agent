import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

interface MeshToolOptions {
	readonly meshHome: string;
}
export interface ToolResult {
	readonly code: number;
	readonly stdout: string;
}

export function absolutePathEntries(): string[] {
	return (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
}

export async function executable(name: string): Promise<string> {
	for (const directory of absolutePathEntries()) {
		const path = resolve(directory, name);
		try {
			await access(path, constants.X_OK);
			if ((await lstat(path)).isDirectory()) continue;
			return path;
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw new Error(`${name} is missing from PATH`);
}

export function runTool(
	path: string,
	args: readonly string[],
	options: MeshToolOptions,
	timeout = 5000,
): Promise<ToolResult> {
	return new Promise((resolveResult, reject) => {
		execFile(
			path,
			[...args],
			{
				cwd: options.meshHome,
				env: { ...process.env, COTAL_HOME: join(options.meshHome, "home"), COTAL_SKIP_CONNECTOR_SEED: "1" },
				timeout,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout) => {
				if (!error) resolveResult({ code: 0, stdout });
				else if (typeof error.code === "number" && !error.killed) resolveResult({ code: error.code, stdout });
				else reject(new Error(`${path.endsWith("/cotal") ? "cotal" : "launchctl"} ${args[0]} could not complete`));
			},
		);
	});
}

export async function meshConfig(
	options: MeshToolOptions,
): Promise<{ readonly space: string; readonly server: string }> {
	const config = await readJson(join(options.meshHome, "mesh.json"));
	if (
		!config ||
		typeof config !== "object" ||
		!("space" in config) ||
		!("server" in config) ||
		typeof config.space !== "string" ||
		!config.space ||
		typeof config.server !== "string" ||
		!config.server
	) {
		throw new Error("Mesh configuration needs space and server strings");
	}
	return { space: config.space, server: config.server };
}

function pendingCount(stdout: string): number {
	let value: unknown;
	try {
		value = JSON.parse(stdout.split(/\r?\n/, 1)[0]!);
	} catch {
		throw new Error("cotal deliver pending returned invalid counts");
	}
	if (
		!value ||
		typeof value !== "object" ||
		!("pending" in value) ||
		!("ackPending" in value) ||
		typeof value.pending !== "number" ||
		typeof value.ackPending !== "number" ||
		!Number.isSafeInteger(value.pending) ||
		!Number.isSafeInteger(value.ackPending) ||
		value.pending < 0 ||
		value.ackPending < 0 ||
		!Number.isSafeInteger(value.pending + value.ackPending)
	)
		throw new Error("cotal deliver pending returned invalid counts");
	return value.pending + value.ackPending;
}

/** True when nothing is at the path; a dangling symlink is still something there. */
export async function absent(path: string): Promise<boolean> {
	return lstat(path).then(
		() => false,
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
}

/** Returns undefined for a missing file only when allowMissing is set; JSON never parses to undefined. */
async function readJson(path: string, allowMissing = false): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(await absent(path)))
			throw new Error(`Mesh file ${path}: unreadable`);
		if (allowMissing) return undefined;
		throw new Error(`Mesh file ${path}: missing`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Mesh file ${path}: unreadable JSON`);
	}
}

export type MeshSessionPending =
	| { readonly status: "left" }
	| { readonly status: "unavailable" }
	| { readonly status: "count"; readonly count: number };

export async function meshSessionPending(
	cotal: string,
	options: MeshToolOptions,
	config: { readonly space: string; readonly server: string },
	sessionId: string,
): Promise<MeshSessionPending> {
	const file = `${sessionId}.json`;
	const path = join(options.meshHome, "enrollments", file);
	const record = await readJson(path, true);
	// A session can unenroll after the listing above; that is not a mesh fault.
	if (record === undefined) {
		return { status: "left" };
	}
	if (
		!/^[A-Za-z0-9_-]+$/.test(sessionId) ||
		!record ||
		typeof record !== "object" ||
		!("sessionId" in record) ||
		record.sessionId !== sessionId ||
		!("identity" in record) ||
		!record.identity ||
		typeof record.identity !== "object" ||
		!("id" in record.identity) ||
		typeof record.identity.id !== "string" ||
		!/^[A-Za-z0-9_]+$/.test(record.identity.id) ||
		!("lifecycleUid" in record) ||
		typeof record.lifecycleUid !== "string" ||
		!/^[a-z0-9]{26,32}$/.test(record.lifecycleUid)
	) {
		throw new Error(`Mesh enrollment ${file}: unreadable record`);
	}
	// Cotal 0.79.0 dmDurable("local", id, uid).
	const durable = `dm_local-${record.identity.id}-${record.lifecycleUid}`;
	const pending = await runTool(
		cotal,
		[
			"deliver",
			"pending",
			sessionId,
			"--space",
			config.space,
			"--server",
			config.server,
			"--root",
			options.meshHome,
			"--durable",
			durable,
			"--json",
		],
		options,
	);
	// Recheck after either result: a count for a session that has left is stale.
	if (await absent(path)) {
		return { status: "left" };
	}
	if (pending.code !== 0) {
		return { status: "unavailable" };
	}
	return { status: "count", count: pendingCount(pending.stdout) };
}
