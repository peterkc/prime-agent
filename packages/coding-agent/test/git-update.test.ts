import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

interface PackageManagerCommands {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

describe("DefaultPackageManager git update", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function setupRemoteAndInstall(sourceOverride?: string): void {
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		settingsManager.setPackages([sourceOverride ?? gitSource]);
	}

	describe("temporary git sources", () => {
		it.each([
			{ name: "refreshes an unpinned cache", pinned: false, offline: false, expected: "// v2" },
			{ name: "keeps a pinned cache", pinned: true, offline: false, expected: "// v1" },
			{ name: "keeps an offline cache", pinned: false, offline: true, expected: "// v1" },
		])("uses the private git root and $name (pi #5345)", async ({ pinned, offline, expected }) => {
			const previousOfflineEnv = process.env.PI_OFFLINE;
			delete process.env.PI_OFFLINE;
			try {
				mkdirSync(join(remoteDir, "extensions"), { recursive: true });
				initGitRepo(remoteDir);
				const initialCommit = createCommit(remoteDir, "extensions/index.ts", "// v1", "Initial commit");
				const source = pinned ? `${gitSource}@${initialCommit}` : gitSource;
				const tempRoot = join(agentDir, "tmp", "extensions");
				const cachedDir = join(tempRoot, "git-github.com", "7db90b30", "test", "extension");
				const extensionPath = join(cachedDir, "extensions", "index.ts");
				const commandSpy = vi
					.spyOn(packageManager as unknown as PackageManagerCommands, "runCommand")
					.mockImplementation(async (command, args, options) => {
						expect(command).toBe("git");
						if (args[0] === "clone") {
							expect(args).toEqual(["clone", "https://github.com/test/extension", cachedDir]);
							git(["clone", remoteDir, cachedDir], tempDir);
						} else {
							git(args, options?.cwd ?? tempDir);
						}
					});

				const installed = await packageManager.resolveExtensionSources([source], { temporary: true });
				expect(installed.extensions.map((resource) => resource.path)).toEqual([extensionPath]);
				expect(installed.extensions[0].metadata.baseDir).toBe(cachedDir);
				expect(cachedDir.startsWith(join(tmpdir(), "pi-extensions"))).toBe(false);
				// test-policy: allow environment-gated-path -- POSIX permission bits do not apply on Windows.
				if (process.platform !== "win32") {
					expect(statSync(tempRoot).mode & 0o777).toBe(0o700);
				}

				createCommit(remoteDir, "extensions/index.ts", "// v2", "Second commit");
				commandSpy.mockClear();
				if (offline) process.env.PI_OFFLINE = "1";
				const resolved = await packageManager.resolveExtensionSources([source], { temporary: true });

				expect(resolved.extensions.map((resource) => resource.path)).toEqual([extensionPath]);
				expect(getFileContent(cachedDir, "extensions/index.ts")).toBe(expected);
				if (pinned || offline) {
					expect(getCurrentCommit(cachedDir)).toBe(initialCommit);
					expect(commandSpy).not.toHaveBeenCalled();
				}
			} finally {
				if (previousOfflineEnv === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = previousOfflineEnv;
			}
		});
	});

	// Each case first fast-forwards onto `before`, then the remote drops those commits
	// (git reset --hard HEAD~n) and publishes `after` in their place.
	it.each<[string, string[], string[]]>([
		["remote history is rewritten", ["// v2"], ["// v2-rewritten"]],
		["the local commit no longer exists in the remote", ["// v2", "// v3"], ["// v2-new"]],
		["the whole history is rewritten", ["// v2", "// v3"], ["// rewrite-a", "// rewrite-b"]],
	])("recovers when %s", async (_name, before, after) => {
		setupRemoteAndInstall();

		for (const content of before) {
			createCommit(remoteDir, "extension.ts", content, `before ${content}`);
		}
		await packageManager.update();
		expect(getFileContent(installedDir, "extension.ts")).toBe(before[before.length - 1]);

		git(["reset", "--hard", `HEAD~${before.length}`], remoteDir);
		let rewrittenCommit = "";
		for (const content of after) {
			rewrittenCommit = createCommit(remoteDir, "extension.ts", content, `after ${content}`);
		}

		await packageManager.update();

		expect(getCurrentCommit(installedDir)).toBe(rewrittenCommit);
		expect(getFileContent(installedDir, "extension.ts")).toBe(after[after.length - 1]);
	});

	it("should not update pinned git sources (with @ref)", async () => {
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		const initialCommit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["checkout", initialCommit], installedDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		settingsManager.setPackages([`${gitSource}@${initialCommit}`]);

		createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

		await packageManager.update();

		expect(getCurrentCommit(installedDir)).toBe(initialCommit);
		expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
	});

	it("should not install locally when source is only registered globally", async () => {
		setupRemoteAndInstall();

		createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

		const projectGitDir = join(tempDir, ".prime", "agent", "git", "github.com", "test", "extension");
		expect(existsSync(projectGitDir)).toBe(false);

		await packageManager.update(gitSource);

		expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		expect(existsSync(projectGitDir)).toBe(false);
	});
});
