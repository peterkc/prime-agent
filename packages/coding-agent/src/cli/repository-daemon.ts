import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { defaultDaemonSocketDir, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";

interface RepositoryDaemon {
	readonly root: string;
	readonly socketPath: string;
	readonly sessionDir: string;
}

interface ResolvedRepositoryDaemon extends RepositoryDaemon {
	readonly excludeFile: string;
}

const repositories = new Map<string, RepositoryDaemon | undefined>();
const roots = new Map<string, string>();

function gitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	return env;
}

/** Resolve repository storage without preparing folders or changing the environment. */
export function resolveRepositoryDaemon(folder: string): ResolvedRepositoryDaemon | undefined {
	const result = spawnSync(
		"git",
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "info/exclude"],
		{ cwd: resolve(folder), env: gitEnvironment(), encoding: "utf8" },
	);
	if (result.status !== 0) return undefined;
	const [toplevel, commonDir, excludeFile] = result.stdout.trimEnd().split("\n");
	if (!toplevel || !commonDir || !excludeFile) return undefined;
	const root = basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;
	const sessionDir = join(root, basename(root) === ".prime" ? "agent" : ".prime/agent", "sessions");
	return { root, sessionDir, socketPath: repositorySocketPath(root), excludeFile };
}

export function prepareRepositoryDaemon(daemon: ResolvedRepositoryDaemon): void {
	prepareSessionFolders(daemon.root, daemon.sessionDir, daemon.excludeFile, gitEnvironment());
}

/** Choose repository storage and socket once per caller folder. */
export function repositoryDaemon(folder: string): RepositoryDaemon | undefined {
	const cwd = resolve(folder);
	if (repositories.has(cwd)) {
		const cached = repositories.get(cwd);
		if (cached) process.env.PRIME_AGENT_SESSION_DIR = cached.sessionDir;
		return cached;
	}
	const daemon = resolveRepositoryDaemon(cwd);
	if (daemon) {
		prepareRepositoryDaemon(daemon);
		process.env.PRIME_AGENT_SESSION_DIR = daemon.sessionDir;
		roots.set(daemon.socketPath, daemon.root);
	}
	repositories.set(cwd, daemon);
	return daemon;
}

export function repositoryDaemonRoot(socketPath: string): string | undefined {
	return roots.get(normalizeSocketPath(socketPath));
}

export function repositoryRootForSocket(cwd: string, socketPath: string): string | undefined {
	return normalizeSocketPath(repositorySocketPath(cwd)) === normalizeSocketPath(socketPath) ? cwd : undefined;
}

export function repositorySocketPath(root: string): string {
	const bytes = Buffer.from(root, "utf8");
	// POSIX cksum includes the byte length, least-significant byte first.
	let crc = 0;
	const update = (byte: number) => {
		crc ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
		}
	};
	for (const byte of bytes) update(byte);
	for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) update(length & 255);
	const sum = String(~crc >>> 0);
	const prefix = defaultDaemonSocketDir();
	const name = basename(root)
		.replace(/^\./, "")
		.replace(/[^A-Za-z0-9._-]/g, "_");
	const limit = 103 - Buffer.byteLength(join(prefix, `-${sum}.sock`));
	return normalizeSocketPath(join(prefix, `${name.slice(0, Math.max(0, limit))}-${sum}.sock`));
}

function prepareSessionFolders(root: string, sessionDir: string, excludeFile: string, env: NodeJS.ProcessEnv): void {
	const folders = [sessionDir, join(dirname(sessionDir), "session-artifacts")];
	const paths = folders.map((folder) => relative(root, folder).split(sep).join("/"));
	const warned = new Set<string>();
	const warn = (folder: string, problem = "is not ignored") => {
		if (warned.has(folder)) return;
		warned.add(folder);
		console.error(`Warning: repository session folder ${problem}: ${folder}`);
	};
	for (const folder of folders) {
		try {
			mkdirSync(folder, { recursive: true });
		} catch {
			warn(folder, "could not be created");
		}
	}
	const ignoredPaths = (): Set<string> | undefined => {
		const check = spawnSync("git", ["check-ignore", "--", ...paths], { cwd: root, env, encoding: "utf8" });
		if (check.status !== 0 && check.status !== 1) return undefined;
		return new Set(check.stdout.trimEnd().split("\n"));
	};
	const ignored = ignoredPaths();
	const missing = paths.filter((path) => !ignored?.has(path));
	if (!ignored) {
		for (const path of missing) warn(join(root, path));
		return;
	}
	if (missing.length === 0) return;
	try {
		mkdirSync(dirname(excludeFile), { recursive: true });
		appendFileSync(
			excludeFile,
			`\n# Prime Agent repository sessions\n${missing.map((path) => `/${path}/`).join("\n")}\n`,
		);
	} catch {
		for (const path of missing) warn(join(root, path));
		return;
	}
	const rechecked = ignoredPaths();
	for (const path of missing) {
		if (!rechecked?.has(path)) warn(join(root, path));
	}
}
