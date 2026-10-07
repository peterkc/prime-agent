import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonInfo, discoverDaemons } from "../src/cli/daemon-ps.js";
import { runRestart } from "../src/cli/daemon-restart.js";
import type * as StopConfirm from "../src/cli/daemon-stop-confirm.js";
import { promptYesNo } from "../src/cli/daemon-stop-confirm.js";
import {
	type DaemonUpdateRestartStatus,
	launchDaemonUpdateRestartCoordinator,
} from "../src/cli/daemon-update-restart.js";
import { ENV_SESSION_DIR, getSessionDirEnvOverride } from "../src/config.js";
import type * as Supervisor from "../src/modes/daemon/daemon-supervisor.js";
import { readPersistedDaemonFolders } from "../src/modes/daemon/daemon-supervisor.js";
import { DAEMON_WORKER_SUPERVISOR_SOCKET_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";
import { createDeferred } from "./suite/scheduling.js";

vi.mock("../src/cli/daemon-ps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/cli/daemon-ps.js")>()),
	discoverDaemons: vi.fn(),
}));
vi.mock("../src/cli/daemon-stop-confirm.js", async (importOriginal) => ({
	...(await importOriginal<typeof StopConfirm>()),
	promptYesNo: vi.fn(),
}));
vi.mock("../src/cli/daemon-update-restart.js", () => ({ launchDaemonUpdateRestartCoordinator: vi.fn() }));
vi.mock("../src/modes/daemon/daemon-supervisor.js", () => ({ readPersistedDaemonFolders: vi.fn() }));

const defaultPath = "/tmp/default.sock";
const workPath = "/tmp/work-123.sock";
const workNames = [workPath, "/tmp/./work-123.sock", "work-123.sock", "work-123", "work"];
const invalidArguments = [["work", "--daemon-socket", defaultPath], ["--unknown"]];
const confirmations = ["prompt", "declined", "failed", "json-error", "tty-error", "force", "empty"];
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const daemon = (socketPath: string, status: DaemonInfo["status"] = "current"): DaemonInfo => ({
	socketPath,
	status,
	isDefault: socketPath === defaultPath,
	sessionCount: 2,
});
const complete: DaemonUpdateRestartStatus = {
	version: 1,
	requestId: "request",
	socketPath: defaultPath,
	phase: "complete",
	coordinator: { pid: 42 },
	counts: { total: 2, restored: 2, resumed: 1, failed: 0 },
	startedAt: "now",
	updatedAt: "now",
};
const discover = vi.mocked(discoverDaemons);
const launch = vi.mocked(launchDaemonUpdateRestartCoordinator);
const prompt = vi.mocked(promptYesNo);
const calledPaths = () => launch.mock.calls.map(([options]) => options.socketPath);
describe("daemon restart", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubEnv(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV, "");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		process.exitCode = undefined;
		discover.mockResolvedValue([daemon(defaultPath), daemon(workPath)]);
		launch.mockResolvedValue(complete);
		vi.mocked(readPersistedDaemonFolders).mockReturnValue({ cwd: process.cwd() });
		prompt.mockResolvedValue(true);
	});
	afterEach(() => {
		process.exitCode = undefined;
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
	});
	it.each([
		["valid", true, "/saved/sessions"],
		["no-session-dir", true, ""],
		["missing-file", false, "/caller/sessions"],
		["invalid-file", false, "/caller/sessions"],
		["wrong-socket", false, "/caller/sessions"],
		["missing-cwd", false, "/saved/sessions"],
		["missing-folder", false, "/saved/sessions"],
		["not-folder", false, "/saved/sessions"],
		["throws-absent", true, "/saved/sessions"],
		["throws-empty", true, "/saved/sessions"],
		["throws-set", true, "/saved/sessions"],
	])("preserves folders and caller state: %s", async (kind, useSavedCwd, expected) => {
		const actual = await vi.importActual<typeof Supervisor>("../src/modes/daemon/daemon-supervisor.js");
		const agentDir = mkdtempSync(join(tmpdir(), "pp-restart-folder-"));
		const original = kind === "throws-absent" ? undefined : kind === "throws-empty" ? "" : "/caller/sessions";
		const inheritedOverride = original === undefined ? "/legacy/sessions" : original || undefined;
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		vi.stubEnv(ENV_SESSION_DIR, original);
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_SESSION_DIR", "/legacy/sessions");
		try {
			const key = createHash("sha256").update(workPath).digest("hex").slice(0, 12);
			const descriptorDir = join(agentDir, "daemon-workers", key);
			mkdirSync(descriptorDir, { recursive: true });
			const configPath = join(descriptorDir, "supervisor-config");
			const alternateCwds: Record<string, string | undefined> = {
				"missing-cwd": undefined,
				"missing-folder": join(agentDir, "missing"),
				"not-folder": configPath,
			};
			const cwd = kind in alternateCwds ? alternateCwds[kind] : agentDir;
			const savedSessionDir = kind === "no-session-dir" ? undefined : "/saved/sessions";
			const config = {
				version: 1,
				socketPath: kind === "wrong-socket" ? "/other.sock" : workPath,
				defaultSessionConfig: { cwd, agentDir, sessionDir: savedSessionDir },
			};
			if (kind !== "missing-file") writeFileSync(configPath, kind === "invalid-file" ? "{" : JSON.stringify(config));
			vi.mocked(readPersistedDaemonFolders).mockImplementation(actual.readPersistedDaemonFolders);
			const seen: unknown[] = [];
			launch.mockImplementation(async ({ cwd: launchedCwd, socketPath }) => {
				const current = process.env[ENV_SESSION_DIR];
				seen.push([launchedCwd, current, getSessionDirEnvOverride()]);
				if (kind.startsWith("throws-") && socketPath === workPath) throw new Error("launch failed");
				return complete;
			});
			await runRestart(["work", "default", "--force"]);
			expect(seen).toEqual([
				[useSavedCwd ? agentDir : process.cwd(), expected, expected || undefined],
				[process.cwd(), original, inheritedOverride],
			]);
			expect(process.env[ENV_SESSION_DIR]).toBe(original);
			expect(process.exitCode).toBe(kind.startsWith("throws-") ? 1 : undefined);
			const warning = `work: saved default folder is unavailable; using ${process.cwd()}.`;
			expect(vi.mocked(console.error).mock.calls.some(([message]) => message === warning)).toBe(!useSavedCwd);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
	it.each<[string[], string[]]>([
		...workNames.map((name): [string[], string[]] => [[name], [workPath]]),
		[["default"], [defaultPath]],
		[["--daemon-socket", workPath], [workPath]],
		[[], [defaultPath, workPath]],
		[["work", "work-123.sock"], [workPath]],
	])("resolves targets %j to %j", async (args, paths) => {
		discover.mockResolvedValue([
			daemon(defaultPath),
			{ ...daemon(workPath, "stale"), sessionCount: 1 },
			daemon("/tmp/down.sock", "unreachable"),
			daemon("/tmp/orphan.sock", "orphan-file"),
		]);
		await runRestart([...args, "--force"]);
		expect(calledPaths()).toEqual(paths);
		if (paths.includes(workPath)) expect(console.log).toHaveBeenCalledWith(`work: ${workPath} (1 session)`);
	});
	it.each(["unknown", "work"])("rejects unknown or ambiguous %s before any restart", async (name) => {
		discover.mockResolvedValue([daemon(workPath), daemon("/tmp/work-456.sock")]);
		await runRestart(["work-123", name, "--force"]);
		expect(process.exitCode).toBe(1);
		expect(launch).not.toHaveBeenCalled();
		const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
		for (const text of [name, "work", workPath, "/tmp/work-456.sock"]) expect(errors).toContain(text);
		if (name === "unknown") expect(errors).toContain("No reachable daemon matches: unknown");
	});
	it.each(invalidArguments)("rejects invalid arguments %j", async (...args) => {
		await runRestart([...args, "--force"]);
		expect(process.exitCode).toBe(1);
		expect(launch).not.toHaveBeenCalled();
	});
	it("restarts the caller daemon last and waits for each coordinator", async () => {
		vi.stubEnv(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV, defaultPath.replace(/\/([^/]*)$/, "/./$1"));
		const first = createDeferred<DaemonUpdateRestartStatus>();
		const started = createDeferred();
		launch.mockImplementationOnce(() => {
			started.resolve();
			return first.promise;
		});
		const running = runRestart(["default", "work", "--force"]);
		await started.promise;
		expect(calledPaths()).toEqual([workPath]);
		first.resolve(complete);
		await running;
		expect(calledPaths()).toEqual([workPath, defaultPath]);
	});
	it.each(confirmations)("confirms restart: %s", async (kind) => {
		Object.defineProperty(process.stdin, "isTTY", { value: kind !== "tty-error", configurable: true });
		if (kind === "empty") discover.mockResolvedValue([]);
		prompt.mockImplementation(async () => {
			expect(console.log).toHaveBeenCalledWith(`default: ${defaultPath} (2 sessions)`);
			expect(launch).not.toHaveBeenCalled();
			if (kind === "failed") throw new Error("confirmation failed");
			return kind !== "declined";
		});
		await runRestart(kind === "json-error" ? ["--json"] : kind === "force" ? ["--force"] : []);
		expect(prompt).toHaveBeenCalledTimes(["prompt", "declined", "failed"].includes(kind) ? 1 : 0);
		expect(calledPaths()).toEqual(["prompt", "force"].includes(kind) ? [defaultPath, workPath] : []);
		expect(process.exitCode).toBe(["failed", "json-error", "tty-error"].includes(kind) ? 1 : undefined);
	});
	it.each([
		["failed", "failed", 0, "failed: restart failed", 1],
		["throws", "failed", 0, "failed: restart failed", 1],
		["skipped", "skipped", 0, "not running", undefined],
		["complete-with-failures", "complete", 1, "restarted", 1],
	] as const)("reports %s and continues", async (kind, phase, failed, outcome, exitCode) => {
		const failures = [{ sessionFile: "/session.jsonl", message: "restore failed" }];
		const counts =
			kind === "throws" ? { total: 0, restored: 0, resumed: 0, failed: 0 } : { ...complete.counts, failed };
		if (kind === "throws") launch.mockRejectedValueOnce(new Error("restart failed"));
		else launch.mockResolvedValueOnce({ ...complete, phase, counts, failures, message: "restart failed" });
		await runRestart(kind === "failed" ? ["--force", "--json"] : ["--force"]);
		expect(calledPaths()).toEqual([defaultPath, workPath]);
		expect(process.exitCode).toBe(exitCode);
		if (kind !== "failed") {
			const text = failed ? "restarted (restored 2, resumed 1, failed 1)" : outcome;
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`default: ${text}`));
		} else {
			expect(console.log).toHaveBeenCalledTimes(1);
			expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual([
				{ name: "default", socketPath: defaultPath, phase, counts, failures, message: "restart failed" },
				{ name: "work", socketPath: workPath, phase: "complete", counts: complete.counts },
			]);
			expect(console.error).toHaveBeenCalledWith(`work: ${workPath} (2 sessions)`);
		}
	});
});
