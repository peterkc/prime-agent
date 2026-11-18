import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
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
	const cases = ["home start", "home auth help", "home alias", "missing agent under project alias"] as const;
	for (const override of ["cleared", "explicit"] as const) {
		test.each(cases)(`refuses %s with ${override} agent override before settings or migrations`, async (scenario) => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-collision-"));
			try {
				const home = join(root, "home");
				const agentDir = join(home, CONFIG_DIR_NAME);
				mkdirSync(join(home, ".prime"), { recursive: true });
				if (scenario !== "missing agent under project alias") mkdirSync(agentDir, { recursive: true });
				writeFileSync(join(home, "sentinel"), "unchanged");
				let cwd = home;
				if (scenario === "home alias") {
					cwd = join(root, "home-alias");
					symlinkSync(home, cwd, "dir");
				} else if (scenario === "missing agent under project alias") {
					cwd = join(root, "project");
					mkdirSync(cwd);
					symlinkSync(join(home, ".prime"), join(cwd, ".prime"), "dir");
				}
				vi.stubEnv("HOME", home);
				vi.stubEnv(ENV_AGENT_DIR, override === "explicit" ? agentDir : undefined);
				vi.spyOn(process, "cwd").mockReturnValue(cwd);
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
				await expect(main(scenario === "home auth help" ? ["auth", "--help"] : [])).rejects.toThrow(
					"process.exit(1)",
				);
				expect(exit).toHaveBeenCalledWith(1);
				expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(agentDir);
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
