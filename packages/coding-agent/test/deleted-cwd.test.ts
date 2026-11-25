import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getPackageDir } from "../src/config.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { main } from "../src/main.ts";
import * as migrations from "../src/migrations.ts";

// Regression test for https://github.com/earendil-works/pi/issues/11509
describe("startup in a deleted working directory", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("prints an actionable error and exits 1 instead of throwing", async () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
				code: "ENOENT",
				syscall: "uv_cwd",
			});
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await expect(main(["--no-extensions", "--version"])).rejects.toThrow("process.exit(1)");
		expect(exitSpy).toHaveBeenCalledWith(1);
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("The current working directory no longer exists");
	});

	test("rethrows unrelated cwd errors", async () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});

		await expect(main(["--no-extensions", "--version"])).rejects.toThrow("EACCES");
	});
});

describe("startup with the project and user configuration in the same folder", () => {
	const cases = [
		"home start",
		"home auth help",
		"home alias",
		"missing agent under project alias",
		"case-only agent alias",
		"realpath failure",
	] as const;
	for (const override of ["cleared", "explicit"] as const) {
		test.for(cases)(`refuses %s with ${override} agent override before settings or migrations`, async (name, ctx) => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-collision-"));
			try {
				const home = join(root, "home");
				const agentDir = join(home, CONFIG_DIR_NAME);
				mkdirSync(join(home, ".prime"), { recursive: true });
				if (name !== "missing agent under project alias") mkdirSync(agentDir, { recursive: true });
				writeFileSync(join(home, "sentinel"), "unchanged");
				// test-policy: allow conditional-or-disabled-test -- Case-only aliases do not exist on case-sensitive filesystems.
				if (name === "case-only agent alias" && !existsSync(home.toUpperCase())) ctx.skip();
				let cwd = name === "case-only agent alias" && override === "cleared" ? home.toUpperCase() : home;
				if (name === "home alias") {
					cwd = join(root, "home-alias");
					symlinkSync(home, cwd, "dir");
				} else if (name === "missing agent under project alias") {
					cwd = join(root, "project");
					mkdirSync(cwd);
					symlinkSync(join(home, ".prime"), join(cwd, ".prime"), "dir");
				}
				const selectedAgentDir =
					name === "case-only agent alias" && override === "explicit" ? agentDir.toUpperCase() : agentDir;
				vi.stubEnv("HOME", home);
				vi.stubEnv(ENV_AGENT_DIR, override === "explicit" ? selectedAgentDir : undefined);
				vi.spyOn(process, "cwd").mockReturnValue(cwd);
				if (name === "realpath failure") {
					vi.spyOn(realpathSync, "native").mockImplementation(() => {
						throw new Error("EACCES");
					});
				}
				const settings = vi.spyOn(SettingsManager, "create").mockImplementation(() => {
					throw new Error("settings created before refusal");
				});
				const migrate = vi.spyOn(migrations, "runMigrations");
				const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
				vi.spyOn(console, "log").mockImplementation(() => {});
				const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					throw new Error(`process.exit(${code})`);
				}) as typeof process.exit);
				const before = readdirSync(root, { recursive: true }).sort();
				await expect(main(name === "home auth help" ? ["auth", "--help"] : [])).rejects.toThrow("process.exit(1)");
				expect(exit).toHaveBeenCalledWith(1);
				expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(selectedAgentDir);
				expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
					"Start in a project folder",
				);
				expect(settings).not.toHaveBeenCalled();
				expect(migrate).not.toHaveBeenCalled();
				expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
				expect(readFileSync(join(home, "sentinel"), "utf8")).toBe("unchanged");
			} finally {
				vi.restoreAllMocks();
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test.each(["cleared", "explicit"] as const)(
		"refuses a HOME session resumed from a project with %s agent override before HOME settings or migrations",
		async (override) => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-resume-"));
			try {
				const home = join(root, "home");
				const project = join(home, "project");
				const agentDir = join(home, CONFIG_DIR_NAME);
				mkdirSync(project, { recursive: true });
				mkdirSync(agentDir, { recursive: true });
				writeFileSync(join(home, "sentinel"), "unchanged");
				const session = SessionManager.create(home, join(root, "sessions"));
				session.appendMessage({ role: "user", content: "existing message", timestamp: Date.now() });
				const sessionFile = session.getSessionFile()!;
				const sourceSession = readFileSync(sessionFile, "utf8");
				vi.stubEnv("HOME", home);
				vi.stubEnv(ENV_AGENT_DIR, override === "explicit" ? agentDir : undefined);
				vi.stubEnv("PI_OFFLINE", "1");
				vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
				vi.spyOn(process, "cwd").mockReturnValue(project);
				const settings = vi.spyOn(SettingsManager, "create").mockImplementation((cwd) => {
					if (cwd === home) throw new Error("HOME settings created before refusal");
					return SettingsManager.inMemory();
				});
				const migrate = vi.spyOn(migrations, "runMigrations");
				const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
				const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					throw new Error(`process.exit(${code})`);
				}) as typeof process.exit);
				const before = readdirSync(home, { recursive: true }).sort();
				await expect(main(["--no-extensions", "--session", sessionFile, "--print", "not sent"])).rejects.toThrow(
					"process.exit(1)",
				);
				expect(exit).toHaveBeenCalledWith(1);
				expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(agentDir);
				expect(settings).toHaveBeenCalledWith(project, agentDir, { projectTrusted: false });
				expect(settings.mock.calls.filter(([cwd]) => cwd === home)).toEqual([]);
				expect(migrate.mock.calls.filter(([cwd]) => cwd === home)).toEqual([]);
				expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
				expect(readFileSync(join(home, "sentinel"), "utf8")).toBe("unchanged");
				expect(readFileSync(sessionFile, "utf8")).toBe(sourceSession);
			} finally {
				restoreStdout();
				vi.restoreAllMocks();
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test("refuses --session HOME --name before changing the session file and without a stack trace", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-config-named-resume-"));
		try {
			const home = join(root, "home");
			const project = join(home, "project");
			const agentDir = join(home, CONFIG_DIR_NAME);
			mkdirSync(project, { recursive: true });
			const session = SessionManager.create(home, join(root, "sessions"));
			session.appendMessage({ role: "user", content: "existing message", timestamp: Date.now() });
			const sessionFile = session.getSessionFile()!;
			const before = readFileSync(sessionFile, "utf8");
			const result = spawnSync(
				process.execPath,
				[
					join(getPackageDir(), "src", "cli.ts"),
					"--offline",
					"--no-extensions",
					"--session",
					sessionFile,
					"--name",
					"x",
					"--print",
					"not sent",
				],
				{
					cwd: project,
					env: {
						PATH: process.env.PATH,
						USER: process.env.USER,
						HOME: home,
						TMPDIR: root,
						[ENV_AGENT_DIR]: agentDir,
					},
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			if (result.error) throw result.error;
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(agentDir);
			expect(result.stderr).toContain("Start in a project folder");
			expect.soft(readFileSync(sessionFile, "utf8")).toBe(before);
			expect(result.stderr).not.toMatch(/^\s+at /m);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.each(["cleared", "explicit"] as const)(
		"keeps a project below HOME working with %s agent override",
		async (override) => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-project-"));
			try {
				const project = join(root, "project");
				mkdirSync(project);
				vi.stubEnv("HOME", root);
				vi.stubEnv(ENV_AGENT_DIR, override === "explicit" ? join(root, CONFIG_DIR_NAME) : undefined);
				vi.spyOn(process, "cwd").mockReturnValue(project);
				const settings = vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
				const migrate = vi.spyOn(migrations, "runMigrations");
				const log = vi.spyOn(console, "log").mockImplementation(() => {});
				vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					throw new Error(`process.exit(${code})`);
				}) as typeof process.exit);
				await expect(main(["--version"])).rejects.toThrow("process.exit(0)");
				expect(settings).toHaveBeenCalledWith(project, join(root, CONFIG_DIR_NAME), { projectTrusted: false });
				expect(migrate).not.toHaveBeenCalled();
				expect(log).toHaveBeenCalled();
			} finally {
				vi.restoreAllMocks();
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
