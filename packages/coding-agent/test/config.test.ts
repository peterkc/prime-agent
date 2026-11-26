import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/config.ts";
import {
	detectInstallChange,
	detectInstallMethod,
	findNodePackageDir,
	getConfiguredSelfUpdateArgv,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	makeConfiguredSelfUpdateCommand,
} from "../src/config.ts";
import * as publicApi from "../src/index.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "pi-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("findNodePackageDir", () => {
	test("skips binary metadata copied into dist", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-package-dir-"));
		const distDir = join(tempDir, "dist");
		const bundleDir = join(distDir, "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), "{}");
		writeFileSync(join(distDir, "package.json"), "{}");

		expect(findNodePackageDir(bundleDir)).toBe(tempDir);
	});
});

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @earendil-works/pi-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	// Issue #7756
	test("does not name pnpm for unmanaged installs under PNPM_HOME", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-pnpm-home-"));
		const packageDir = join(
			tempDir,
			".local",
			"share",
			"pnpm",
			"global-nub",
			"5",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		mkdirSync(packageDir, { recursive: true });
		process.env.PI_PACKAGE_DIR = packageDir;
		process.env.PATH = "";
		process.argv[1] = join(packageDir, "dist", "cli.js");
		setExecPath(join(packageDir, "dist", "cli.js"));

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		});
	});

	test("self-updates exact npm versions without uninstalling the current package", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, {
			packageName: "@earendil-works/pi-coding-agent",
			installSpec: "@earendil-works/pi-coding-agent@1.2.3",
		});

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent@1.2.3",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent@1.2.3`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
			display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@earendil-works/pi-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@earendil-works/pi-coding-agent",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@earendil-works/pi-coding-agent"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
			display:
				"pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
					display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
				},
			],
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@earendil-works/pi-coding-agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@earendil-works", "pi-coding-agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@earendil-works",
			"pi-coding-agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.PI_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
					display: "yarn global add --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
			display:
				"bun uninstall -g @mariozechner/pi-coding-agent && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
					display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
			"the install path is not writable",
		);
	});
});

describe("detectInstallChange", () => {
	// Regression test for #10439: a deleted pnpm install must not fall back to a package.json further up.
	test("reports a removed install instead of reading a package.json further up", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-install-change-"));
		const installDir = join(tempDir, "global", "hash");
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "0.0.1" }));
		rmSync(installDir, { recursive: true, force: true });
		expect(detectInstallChange(join(installDir, "package.json"))).toEqual({ kind: "removed" });
	});
});

describe("configured self-update command", () => {
	const originalSelfUpdateCommand = process.env.PI_SELF_UPDATE_COMMAND;

	afterEach(() => {
		if (originalSelfUpdateCommand === undefined) {
			delete process.env.PI_SELF_UPDATE_COMMAND;
		} else {
			process.env.PI_SELF_UPDATE_COMMAND = originalSelfUpdateCommand;
		}
	});

	test("prefers PI_SELF_UPDATE_COMMAND over the setting and splits it on whitespace", () => {
		process.env.PI_SELF_UPDATE_COMMAND = "  nub   upgrade {installSpec} ";

		expect(getConfiguredSelfUpdateArgv(["mise", "upgrade"])).toEqual(["nub", "upgrade", "{installSpec}"]);
	});

	test("uses the setting when PI_SELF_UPDATE_COMMAND is unset or blank", () => {
		process.env.PI_SELF_UPDATE_COMMAND = " ";

		expect(getConfiguredSelfUpdateArgv(["mise", "upgrade", "npm:{packageName}"])).toEqual([
			"mise",
			"upgrade",
			"npm:{packageName}",
		]);
		expect(getConfiguredSelfUpdateArgv([])).toBeUndefined();
		expect(getConfiguredSelfUpdateArgv(undefined)).toBeUndefined();
	});

	test("fills placeholders in every argument", () => {
		const command = makeConfiguredSelfUpdateCommand(
			["wrapper", "install", "{installSpec}", "--name={packageName}", "--version", "{version}", "{unknown}"],
			{ packageName: "@earendil-works/pi-coding-agent", version: "1.2.3" },
		);

		expect(command).toEqual({
			command: "wrapper",
			args: [
				"install",
				"@earendil-works/pi-coding-agent@1.2.3",
				"--name=@earendil-works/pi-coding-agent",
				"--version",
				"1.2.3",
				"{unknown}",
			],
			display:
				"wrapper install @earendil-works/pi-coding-agent@1.2.3 --name=@earendil-works/pi-coding-agent --version 1.2.3 {unknown}",
		});
	});
});

describe("Prime identity", () => {
	let identityDir: string;

	beforeEach(() => {
		identityDir = mkdtempSync(join(tmpdir(), "prime-identity-"));
		tempDir = identityDir;
	});

	test("exports the Prime identity and exact environment names", () => {
		expect({
			APP_NAME: publicApi.APP_NAME,
			ENV_PREFIX: publicApi.ENV_PREFIX,
			ENV_AGENT_DIR: publicApi.ENV_AGENT_DIR,
		}).toEqual({
			APP_NAME: "prime-agent",
			ENV_PREFIX: "PRIME_AGENT",
			ENV_AGENT_DIR: "PRIME_AGENT_CODING_AGENT_DIR",
		});
		expect(config.CONFIG_DIR_NAME).toBe(".prime/agent");
		expect(config.ENV_SESSION_DIR).toBe("PRIME_AGENT_CODING_AGENT_SESSION_DIR");
	});

	test.each([
		["unset overrides", undefined, undefined, ".prime/agent"],
		["Prime override", "~/custom-agent", undefined, "custom-agent"],
		["legacy override ignored", undefined, "~/legacy-agent", ".prime/agent"],
		["Prime override wins", "~/custom-agent", "~/legacy-agent", "custom-agent"],
		["empty Prime override", "", "~/legacy-agent", ".prime/agent"],
	] as const)("resolves the agent folder with %s", (_name, prime, legacy, expected) => {
		vi.stubEnv("HOME", identityDir);
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", prime);
		vi.stubEnv("PI_CODING_AGENT_DIR", legacy);
		expect(config.getAgentDir()).toBe(join(homedir(), expected));
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", undefined);
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		expect(config.getAgentDir()).toBe(join(homedir(), ".prime", "agent"));
	});

	test.each([
		["prime---agent", "PRIME_AGENT"],
		["__prime..agent__", "PRIME_AGENT"],
		["--", "PI"],
	])("normalizes the environment prefix for %s", (name, expected) => {
		const packageDir = identityDir;
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ piConfig: { name } }));
		const script = join(packageDir, "prefix.mts");
		const configUrl = pathToFileURL(resolve(__dirname, "../src/config.ts")).href;
		writeFileSync(
			script,
			`import * as config from ${JSON.stringify(configUrl)};
console.log(JSON.stringify([config.ENV_PREFIX, config.ENV_AGENT_DIR, config.ENV_SESSION_DIR]));
`,
		);
		const result = spawnSync(process.execPath, [script], {
			env: { ...process.env, PI_PACKAGE_DIR: packageDir },
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([
			expected,
			`${expected}_CODING_AGENT_DIR`,
			`${expected}_CODING_AGENT_SESSION_DIR`,
		]);
	});

	test("reads project settings from .prime/agent", () => {
		const projectDir = identityDir;
		const settingsDir = join(projectDir, ".prime", "agent");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ theme: "light" }));
		const settings = publicApi.SettingsManager.create(projectDir, join(projectDir, "user-agent"));
		expect(settings.getTheme()).toBe("light");
		expect(settings.getProjectSettings()).toMatchObject({ theme: "light" });
	});

	test("creates a session file under PRIME_AGENT_CODING_AGENT_SESSION_DIR", () => {
		const projectDir = identityDir;
		const sourceDir = join(projectDir, "source-sessions");
		const sessionDir = join(projectDir, "override-sessions");
		const agentDir = join(projectDir, "agent");
		const source = publicApi.SessionManager.create(projectDir, sourceDir);
		source.appendMessage({ role: "user", content: "saved input", timestamp: 0 });
		const cliPath = resolve(__dirname, "../src/cli.ts");
		const resolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
		const result = spawnSync(
			process.execPath,
			["--import", resolverUrl, cliPath, "--fork", source.getSessionFile()!, "--model", "missing-model", "-p", "hi"],
			{
				cwd: projectDir,
				env: {
					...process.env,
					PRIME_AGENT_CODING_AGENT_DIR: agentDir,
					PI_CODING_AGENT_DIR: agentDir,
					PRIME_AGENT_CODING_AGENT_SESSION_DIR: sessionDir,
					PI_OFFLINE: "1",
				},
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("missing-model");
		const files = readdirSync(sessionDir);
		expect(files).toHaveLength(1);
		const [sessionFile] = files;
		expect(sessionFile).toMatch(/\.jsonl$/);
		expect(readFileSync(join(sessionDir, sessionFile), "utf8")).toContain("saved input");
		expect(readdirSync(sourceDir)).toHaveLength(1);
	});
});
