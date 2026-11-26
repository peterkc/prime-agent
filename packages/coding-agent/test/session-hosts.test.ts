import { describe, expect, it, vi } from "vitest";
import type { DaemonInfo } from "../src/cli/daemon-ps.js";
import { findSessionHosts, formatMoveHint, formatStopHint, matchLiveSessions } from "../src/cli/session-hosts.js";
import { APP_NAME } from "../src/config.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const ARC = "01a200dc-7ad5-77ed-9fbd-d53f2a08b67d";

function session(activeSessionId: string | undefined, sessionId: string, sessionName?: string): SessionSummary {
	return { id: activeSessionId ?? sessionId, activeSessionId, sessionId, sessionName } as SessionSummary;
}

function daemon(socketPath: string, status: DaemonInfo["status"] = "current"): DaemonInfo {
	return { socketPath, status, isDefault: false };
}

const rosters: Record<string, readonly SessionSummary[]> = {
	"/run/prime.sock": [session("e1a528117870", "01a13ede-a1d8-7236-aab2-9f9c683d5791", "pi-prime")],
	"/run/default.sock": [session("0fe15d9b54cc", ARC, "arc-advisor"), session(undefined, "saved-only", "saved")],
	"/run/archiq.sock": [session("c39ad04fac8b", ARC, "arc-advisor")],
};

function lookup(daemons: readonly DaemonInfo[], list = async (socket: string) => rosters[socket] ?? []) {
	return { discover: async () => daemons, list };
}

describe("pi-dkwcu session hosts", () => {
	it("matches live sessions by exact id or name first, then by id suffix", () => {
		const sessions = [
			session("abc123", ARC, "arc-advisor"),
			session("def456", "other", "abc123x"),
			session(undefined, "x", "saved"),
		];
		expect(matchLiveSessions(sessions, "arc-advisor").map((s) => s.activeSessionId)).toEqual(["abc123"]);
		expect(matchLiveSessions(sessions, ARC).map((s) => s.activeSessionId)).toEqual(["abc123"]);
		expect(matchLiveSessions(sessions, "d53f2a08b67d").map((s) => s.activeSessionId)).toEqual(["abc123"]);
		expect(matchLiveSessions(sessions, "saved")).toEqual([]);
	});

	it("finds the session in other reachable daemons and names the stop command", async () => {
		const hosts = await findSessionHosts(
			"arc-advisor",
			"/run/prime.sock",
			lookup([daemon("/run/prime.sock"), daemon("/run/default.sock", "stale")]),
		);
		expect(hosts).toEqual([
			{
				socketPath: "/run/default.sock",
				activeSessionId: "0fe15d9b54cc",
				sessionId: ARC,
				sessionName: "arc-advisor",
			},
		]);
		expect(formatStopHint(hosts)).toBe(
			`arc-advisor is live in /run/default.sock. Stop it there:\n  ${APP_NAME} stop 0fe15d9b54cc --daemon-socket /run/default.sock`,
		);
	});

	it("lists every daemon that runs the session and never the one already asked", async () => {
		const hosts = await findSessionHosts(
			ARC,
			"/run/prime.sock",
			lookup([daemon("/run/prime.sock"), daemon("/run/default.sock"), daemon("/run/archiq.sock")]),
		);
		expect(hosts.map((host) => host.socketPath)).toEqual(["/run/default.sock", "/run/archiq.sock"]);
		const self = await findSessionHosts(ARC, "/run/default.sock", lookup([daemon("/run/default.sock")]));
		expect(self).toEqual([]);
	});

	it("skips unreachable daemons and daemons that fail to answer, and returns nothing when discovery fails", async () => {
		const list = vi.fn(async (socket: string) => {
			if (socket === "/run/archiq.sock") throw new Error("connect timeout");
			return rosters[socket] ?? [];
		});
		const hosts = await findSessionHosts(
			ARC,
			"/run/prime.sock",
			lookup(
				[
					daemon("/run/default.sock", "unreachable"),
					daemon("/run/archiq.sock"),
					daemon("/run/gone.sock", "orphan-file"),
				],
				list,
			),
		);
		expect(hosts).toEqual([]);
		expect(list).toHaveBeenCalledExactlyOnceWith("/run/archiq.sock");
		const failing = { discover: async () => Promise.reject(new Error("ps failed")) };
		expect(await findSessionHosts(ARC, "/run/prime.sock", failing)).toEqual([]);
	});

	it("gives the stop and move commands for the host, or a general move hint without one", () => {
		const host = { socketPath: "/run/default.sock", activeSessionId: "0fe15d9b54cc", sessionId: ARC };
		expect(formatMoveHint([host], "/Volumes/arc hiq")).toBe(
			`${ARC} is live in /run/default.sock. Stop it there, then move it from that daemon:\n  ${APP_NAME} stop 0fe15d9b54cc --daemon-socket /run/default.sock\n  ${APP_NAME} move ${ARC} '/Volumes/arc hiq' --daemon-socket /run/default.sock`,
		);
		expect(formatMoveHint([], "/Volumes/archiq")).toContain("--daemon-socket <socket>");
	});
});
