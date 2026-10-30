import * as cp from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import {
	type DaemonInfo,
	discoverDaemons,
	evaluateShutdownQuietPeriod,
	isWorkerSocketPath,
	planReap,
	planShutdownAll,
	planShutdownConfirmation,
	runPs,
	verifyHelloSupervisorPid,
} from "../src/cli/daemon-ps.js";
import { formatDaemonListTable } from "../src/cli/daemon-ps-format.js";
import { APP_NAME, ENV_AGENT_DIR, VERSION } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";

vi.mock("node:child_process", { spy: true });

it("shows repository roots and keeps the default marker with an empty root cell", () => {
	const table = formatDaemonListTable([
		makeDaemon({ socketPath: "repo.sock", status: "current", root: "/srv/beads" }),
		makeDaemon({ socketPath: "default.sock", status: "current", isDefault: true }),
		makeDaemon({ socketPath: "wide.sock", status: "current", root: "/srv/資料/🧪/e\u0301", pid: 456 }),
		makeDaemon({ socketPath: "control.sock", status: "current", root: "/srv/\n\u001b[2J\u009b31m" }),
	]);
	expect(table).toContain("/srv/beads");
	expect(table.split("\n")[2]!.slice(table.indexOf("root"), table.indexOf("pid")).trim()).toBe("");
	expect(table).toMatch(/default\.sock \*[\s\S]+\* default background service/);
	const lines = stripAnsi(table).split("\n");
	expect(lines).toHaveLength(7);
	expect(lines[4]).toContain("/srv/\\u000a\\u001b[2J\\u009b31m");
	expect(visibleWidth(lines[3]!.split("456")[0]!)).toBe(lines[0]!.indexOf("pid"));
});

it.each([
	[37, {}, undefined],
	[38, { root: "/srv/beads" }, "/srv/beads"],
	[38, { root: null }, undefined],
	[38, { root: 42 }, undefined],
	[38, { root: {} }, undefined],
] as const)("status-root schema %s metadata %j survives discovery and JSON", async (schemaRevision, metadata, root) => {
	const temp = mkdtempSync(join(tmpdir(), "prime-status-root-"));
	try {
		vi.stubEnv("TMPDIR", temp);
		vi.stubEnv(ENV_AGENT_DIR, temp);
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const socketPath = join(temp, "server.sock");
		vi.spyOn(cp, "spawnSync").mockReturnValue({
			pid: 123,
			status: 0,
			signal: null,
			output: [],
			stderr: "",
			stdout: `u_str LISTEN 0 4096 ${socketPath} 123 * 0 users:(("${APP_NAME}",pid=123,fd=3))`,
		});
		vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
		vi.spyOn(DaemonClient.prototype, "waitForHello").mockResolvedValue(
			JSON.parse(
				JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					appVersion: VERSION,
					schemaRevision,
					schemaId: schemaRevision === 37 ? "protocol-7-schema-37-mesh-notify" : DAEMON_SCHEMA_ID,
					clientId: "status",
					serverCapabilities: [],
					...metadata,
				}),
			),
		);
		vi.spyOn(DaemonClient.prototype, "request").mockResolvedValue({
			type: "response",
			command: "list",
			success: true,
			data: { sessions: [] },
		});
		vi.spyOn(DaemonClient.prototype, "close").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const daemons = await discoverDaemons();
		expect(daemons).toHaveLength(1);
		expect(daemons[0]).toMatchObject({ socketPath, pid: 123, sessionCount: 0 });
		expect(daemons[0]!.root).toBe(root);
		expect(Object.hasOwn(daemons[0]!, "root")).toBe(typeof root === "string");
		await runPs(true);
		expect(JSON.parse(log.mock.calls[0]![0])).toEqual(JSON.parse(JSON.stringify(daemons)));
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(temp, { recursive: true, force: true });
	}
});

it("recognizes Windows worker named pipes on every platform", () => {
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee")).toBe(true);
	expect(isWorkerSocketPath("\\\\.\\pipe\\prime-agent-daemon")).toBe(false);
});

describe("evaluateShutdownQuietPeriod", () => {
	it("requires a full quiet period independently of the convergence window", () => {
		expect(evaluateShutdownQuietPeriod(10_500, 10_000)).toBe("waiting");
		expect(evaluateShutdownQuietPeriod(11_000, 10_000)).toBe("complete");
	});
});

describe("verifyHelloSupervisorPid", () => {
	it("accepts the hello pid only while its process identity still matches", () => {
		const processStartId = getProcessStartId(process.pid);
		expect(verifyHelloSupervisorPid(process.pid, processStartId)).toBe(process.pid);
		if (processStartId) {
			expect(verifyHelloSupervisorPid(process.pid, `${processStartId}-stale`)).toBeUndefined();
		}
	});
});

describe("planReap", () => {
	it("never touches the default daemon or daemons with live sessions", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "stale", isDefault: true, sessionCount: 0, pid: 1 }),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["skip", "skip"]);
	});

	it("removes orphan files and stops reachable idle non-default daemons", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/idle.sock", status: "current", sessionCount: 0, pid: 5 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			false,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "remove-file"]);
	});

	it("removes a stale default socket file", () => {
		const plan = planReap(
			[makeDaemon({ socketPath: "/tmp/default.sock", status: "orphan-file", isDefault: true })],
			true,
		);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("only kills unreachable daemons with --force", () => {
		const daemon = makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 });
		const skipped = planReap([daemon], false)[0]!;
		expect(skipped.kind).toBe("skip");
		expect(skipped.kind === "skip" ? skipped.reason : "").toContain("prime-agent shutdown --force");
		expect(planReap([daemon], true)[0]!.kind).toBe("kill");
	});

	it("refuses to kill a pid that backs more than one discovered daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/listening.sock", status: "current", sessionCount: 4, pid: 99 }),
				makeDaemon({ socketPath: "/tmp/phantom.sock", status: "unreachable", pid: 99 }),
			],
			true,
		);
		const phantom = plan.find((action) => action.daemon.socketPath === "/tmp/phantom.sock");
		expect(phantom?.kind).toBe("skip");
		expect(phantom && phantom.kind === "skip" ? phantom.reason : "").toContain("also backs another daemon");
	});
});

describe("planShutdownAll", () => {
	it("targets every service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({
					socketPath: "/tmp/default.sock",
					status: "current",
					isDefault: true,
					sessionCount: 0,
					pid: 1,
				}),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
				makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "shutdown", "kill", "remove-file"]);
	});

	it("never skips a service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({ socketPath: "/tmp/a.sock", status: "stale", pid: 9 }),
				makeDaemon({ socketPath: "/tmp/b.sock", status: "unreachable", pid: 10 }),
			],
			true,
		);
		expect(plan.some((action) => action.kind === "skip")).toBe(false);
	});

	it("removes the socket file for an unreachable daemon with no pid", () => {
		const plan = planShutdownAll([makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" })], false);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("requires force for unreachable tracked workers", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/worker-only.sock",
			status: "unreachable",
			hasTrackedWorkers: true,
		});
		expect(planShutdownAll([daemon], false)[0]!.kind).toBe("skip");
		expect(planShutdownAll([daemon], true)[0]!.kind).toBe("remove-file");
	});
});

describe("planShutdownConfirmation", () => {
	it("never prompts when JSON output was requested", () => {
		expect(planShutdownConfirmation(1, true, false, true)).toBe("json-error");
	});

	it("prompts only for non-JSON shutdown at a TTY", () => {
		expect(planShutdownConfirmation(1, false, false, true)).toBe("prompt");
		expect(planShutdownConfirmation(1, false, false, false)).toBe("tty-error");
		expect(planShutdownConfirmation(1, true, true, true)).toBe("none");
		expect(planShutdownConfirmation(0, false, false, true)).toBe("none");
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
