import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import {
	formatProgramStatus,
	PROGRAM_STATUS_CLEAR,
	settledRunStatus,
	withOpenDialog,
} from "../src/modes/interactive/program-status.js";

function parse(report: string): Record<string, string> {
	expect(report.startsWith("\x1b]7501;") && report.endsWith("\x1b\\")).toBe(true);
	return Object.fromEntries(
		report
			.slice(7, -2)
			.split(":")
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	);
}

const decode = (msg: string | undefined) => Buffer.from(msg ?? "", "base64").toString();

function assistant(stopReason: string, errorMessage?: string): AgentMessage {
	return { role: "assistant", stopReason, errorMessage, content: [] } as unknown as AgentMessage;
}

describe("OSC 7501 program status", () => {
	test("formats each state with the app name and a one-line message within the byte limit", () => {
		expect(PROGRAM_STATUS_CLEAR).toBe("\x1b]7501;state=clear\x1b\\");
		expect(parse(formatProgramStatus({ state: "working" }))).toEqual({ state: "working", app: APP_NAME });
		expect(parse(formatProgramStatus({ state: "blocked", msg: "\x1b[1mPick\x1b[0m\n one\t" }))).toEqual({
			state: "blocked",
			kind: "question",
			app: APP_NAME,
			msg: Buffer.from("Pick one").toString("base64"),
		});
		expect(parse(formatProgramStatus({ state: "error", msg: " \n " }))).toEqual({ state: "error", app: APP_NAME });
		const long = decode(parse(formatProgramStatus({ state: "error", msg: "é".repeat(1500) })).msg);
		expect(long).toBe("é".repeat(1024));
	});

	test("settles a run as done, failed with its error, or idle after an abort", () => {
		expect(settledRunStatus([assistant("error", "boom"), assistant("stop")])).toEqual({ state: "done" });
		expect(settledRunStatus([assistant("error", "boom")])).toEqual({ state: "error", msg: "boom" });
		expect(settledRunStatus([assistant("aborted")])).toEqual({ state: "idle" });
		expect(settledRunStatus([])).toEqual({ state: "idle" });
		expect(withOpenDialog({ state: "working" }, "Pick")).toEqual({ state: "blocked", msg: "Pick" });
		expect(withOpenDialog({ state: "done" }, "Pick")).toEqual({ state: "done" });
		expect(withOpenDialog({ state: "working" }, undefined)).toEqual({ state: "working" });
	});

	test("reports a working run as waiting while a dialog is open, writing each change once", async () => {
		const write = vi.fn();
		let enabled = true;
		const mode = {
			runStatus: { state: "idle" },
			openDialogTitles: [],
			programStatusStopped: false,
			settingsManager: { getProgramStatus: () => enabled },
			ui: { terminal: { write } },
		} as any;
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const reports = () => write.mock.calls.map(([report]) => parse(report).state);
		mode.setRunStatus({ state: "working" });
		mode.setRunStatus({ state: "working" });
		let answer!: (value: string) => void;
		const dialog = mode.whileDialogOpen("Pick one", new Promise<string>((resolve) => (answer = resolve)));
		expect(decode(parse(write.mock.calls.at(-1)![0]).msg)).toBe("Pick one");
		answer("a");
		await expect(dialog).resolves.toBe("a");
		mode.reportProgramStatus(true);
		mode.setRunStatus({ state: "done" });
		expect(reports()).toEqual(["working", "blocked", "working", "working", "done"]);
		enabled = false;
		mode.setRunStatus({ state: "working" });
		expect(write).toHaveBeenCalledTimes(5);
	});
});
