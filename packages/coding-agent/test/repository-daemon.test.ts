import * as cp from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { ensureInteractiveDaemonRunning } from "../src/cli/daemon-launch.js";
import { repositoryDaemon, repositoryDaemonRoot, repositorySocketPath } from "../src/cli/repository-daemon.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";
import * as childProcess from "../src/utils/child-process.js";

vi.mock("node:child_process", { spy: true });

it.each([
	"repo",
	"subfolder",
	"worktree",
	"submodule",
	".prime",
	"outside",
	"bare",
	"missing",
	".name with spaces",
	"a".repeat(180),
	"cache",
	"ignored",
	"contents",
	"negated",
	"unwritable",
	"env",
	"spawn",
	"git-dir",
])("TM-01..TM-09 / FR-004 %s", async (kind) => {
	const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pa-repo-")));
	const env = { ...process.env };
	const warning = vi.spyOn(console, "error").mockImplementation(() => {});
	const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	let root = join(temp, kind);
	fs.mkdirSync(root);
	try {
		delete process.env.GIT_DIR;
		delete process.env.GIT_WORK_TREE;
		if (kind !== "outside") git(root, "init", ...(kind === "bare" ? ["--bare"] : []));
		let folder = root;
		if (["worktree", "submodule"].includes(kind)) {
			git(root, "-c", "user.name=Test", "-c", "user.email=t@e.co", "commit", "--allow-empty", "-m", "init");
			folder = join(temp, "checkout");
			if (kind === "worktree") git(root, "worktree", "add", "-b", "linked", folder);
			else {
				git(root, "-c", "protocol.file.allow=always", "submodule", "add", root, "module");
				folder = root = join(root, "module");
			}
		}
		if (["subfolder", "spawn"].includes(kind)) {
			folder = join(root, "nested");
			fs.mkdirSync(folder);
		}
		if (kind === "git-dir") folder = join(root, ".git");
		const session = join(root, kind === ".prime" ? "agent/sessions" : ".prime/agent/sessions");
		const exclude =
			kind === "submodule" ? git(root, "rev-parse", "--git-path", "info/exclude") : join(root, ".git/info/exclude");
		if (kind === "ignored") fs.writeFileSync(join(root, ".gitignore"), ".prime/\n");
		if (kind === "contents") fs.writeFileSync(join(root, ".gitignore"), ".prime/agent/sessions/*\n");
		if (kind === "negated") fs.writeFileSync(join(root, ".gitignore"), "!.prime/agent/sessions/\n");
		if (kind === "unwritable") fs.chmodSync(exclude, 0o444);
		if (kind === "missing") process.env.PATH = join(temp, "no-git");
		if (kind === "env")
			Object.assign(process.env, { GIT_DIR: join(temp, "bad"), GIT_WORK_TREE: temp, PRIME_AGENT_SESSION_DIR: temp });
		const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
		const route = repositoryDaemon(folder);
		if (["outside", "bare", "missing", "git-dir"].includes(kind)) expect(route).toBeUndefined();
		else {
			expect(route).toMatchObject({ root, sessionDir: session });
			expect(process.env.PRIME_AGENT_SESSION_DIR).toBe(session);
			expect(repositoryDaemonRoot(route!.socketPath)).toBe(root);
			expect(fs.existsSync(session) && fs.existsSync(join(dirname(session), "session-artifacts"))).toBe(true);
			const sum = cp.execFileSync("cksum", { input: root, encoding: "utf8" }).split(" ")[0];
			expect(route!.socketPath).toMatch(new RegExp(`-${sum}\\.sock$`));
			expect(Buffer.byteLength(route!.socketPath)).toBeLessThanOrEqual(103);
			if (kind === ".name with spaces") expect(basename(route!.socketPath)).toContain("name_with_spaces-");
			const content = fs.readFileSync(exclude, "utf8");
			const base = kind === ".prime" ? "agent" : ".prime/agent";
			const block = `\n# Prime Agent repository sessions\n/${base}/sessions/\n/${base}/session-artifacts/\n`;
			expect(content).toBe(["ignored", "unwritable"].includes(kind) ? before : before + block);
			expect(warning).toHaveBeenCalledTimes(
				["negated", "unwritable"].includes(kind) ? (kind === "unwritable" ? 2 : 1) : 0,
			);
			const calls = vi.mocked(cp.spawnSync);
			calls.mockClear();
			expect(repositoryDaemon(folder)).toBe(route);
			expect(calls).not.toHaveBeenCalled();
			expect(fs.readFileSync(exclude, "utf8")).toBe(content);
			if (kind === "spawn") {
				vi.spyOn(DaemonClient.prototype, "connect").mockRejectedValue(new Error("no listener"));
				const spawn = vi.spyOn(childProcess, "spawnHidden").mockImplementation(() => {
					throw new Error("captured spawn");
				});
				await expect(ensureInteractiveDaemonRunning(route!.socketPath, folder)).rejects.toThrow("captured spawn");
				expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(root);
			}
		}
	} finally {
		process.env = env;
		vi.restoreAllMocks();
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

it.each([
	["/Users/peterkc/.prime", "prime-460349200.sock"],
	["/Volumes/games", "games-4080299310.sock"],
	["/Volumes/resume", "resume-3425465961.sock"],
	["/Volumes/atlas/beads", "beads-3245780463.sock"],
])("TM-05 literal root %s", (root, socket) => {
	expect(repositorySocketPath(root)).toBe(join(defaultDaemonSocketDir(), socket));
});
