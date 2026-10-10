import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import {
	formatProgramStatus,
	PROGRAM_STATUS_CLEAR,
	settledRunStatus,
	withOpenDialog,
} from "../src/modes/interactive/program-status.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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
		expect(withOpenDialog({ state: "done" }, "Pick")).toEqual({ state: "blocked", msg: "Pick" });
		expect(withOpenDialog({ state: "working" }, undefined)).toEqual({ state: "working" });
	});

	test("reports a working run as waiting while a dialog is open, writing each change once", async () => {
		const { mode, reports, write } = fakeMode();
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
		mode.enabled = false;
		mode.setRunStatus({ state: "working" });
		expect(write).toHaveBeenCalledTimes(5);
	});

	test("settles runs, retries and compactions from their events", async () => {
		const { mode, reports, event } = fakeMode();
		const toolTurn = [assistant("toolUse"), { role: "toolResult", isError: true } as unknown as AgentMessage];
		await event({ type: "agent_start" });
		await event({ type: "agent_end", messages: toolTurn });
		await event({ type: "agent_start" });
		mode.streaming = true;
		mode.interruptOrClearInput();
		await event({ type: "agent_end", messages: toolTurn });
		mode.streaming = false;
		await event({ type: "agent_start" });
		await event({ type: "auto_retry_start", delayMs: 1000 });
		await event({ type: "auto_retry_end", success: false, finalError: "overloaded" });
		await event({ type: "auto_retry_start", delayMs: 1000 });
		mode.retryAttempt = 1;
		mode.interruptOrClearInput();
		await event({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
		mode.setRunStatus({ state: "done" });
		await event({ type: "compaction_start", reason: "threshold" });
		mode.syncRunStatus({ isCompacting: true }, []);
		await event({ type: "compaction_end", aborted: false, result: {} });
		await event({ type: "compaction_start", reason: "manual" });
		await event({ type: "compaction_end", errorMessage: "Compaction failed", errorSeverity: "error" });
		mode.syncRunStatus({ isCompacting: true });
		await event({ type: "compaction_end", aborted: false, result: {} });
		mode.runAbortRequested = true;
		proto.resetCurrentSessionRenderState.call(mode);
		mode.syncRunStatus({ isStreaming: true });
		await event({ type: "agent_end", messages: [assistant("stop")] });
		mode.syncRunStatus({}, []);
		mode.syncRunStatus({ isStreaming: true });
		mode.syncRunStatus({}, [assistant("error", "lost")]);
		await event({ type: "compaction_start", reason: "manual" });
		await event({ type: "compaction_end", aborted: true });
		// Missed ends: this client's stop, then a run it did not stop, then a compaction outside a run.
		mode.syncRunStatus({ isStreaming: true });
		mode.streaming = true;
		mode.interruptOrClearInput();
		mode.streaming = false;
		for (const step of [{}, { isStreaming: true }, {}]) mode.syncRunStatus(step, [assistant("stop")]);
		await event({ type: "compaction_start", reason: "threshold" });
		mode.syncRunStatus({}, [assistant("stop")]);
		for (const step of [{ isCompacting: true }, {}]) mode.syncRunStatus(step, [assistant("stop")]);
		for (const type of ["compaction_start", "compaction_end", "agent_start"]) await event({ type, aborted: false });
		mode.syncRunStatus({}, [assistant("stop")]);
		const states = "working done working idle working error working idle done working done working error";
		const resyncs = "working idle working done working idle working idle working idle working done";
		expect(reports().join(" ")).toBe(`${states} working idle working done working error working idle ${resyncs}`);
	});

	test("takes the status from snapshots, drops reset dialogs, and writes nothing without a terminal", async () => {
		const { mode, reports, write } = fakeMode();
		mode.syncRunStatus({ isStreaming: true });
		void mode.whileDialogOpen("Lost", new Promise(() => {}));
		mode.resetExtensionUI();
		mode.syncRunStatus({ isStreaming: false, isCompacting: false });
		expect(reports()).toEqual(["working", "blocked", "working", "idle"]);
		setStdoutTTY(false);
		mode.setRunStatus({ state: "working" });
		setStdoutTTY(true);
		proto.stop.call(mode);
		mode.setRunStatus({ state: "done" });
		expect(write.mock.calls.slice(4)).toEqual([[PROGRAM_STATUS_CLEAR]]);
	});
});

/** Runs InteractiveMode's own status code on a stand-in; members a test does not set do nothing. */
function fakeMode() {
	initTheme("dark");
	setStdoutTTY(true);
	const write = vi.fn();
	const ignore: any = new Proxy(() => {}, {
		get: (_target, key) =>
			key === "then" ? undefined : key === Symbol.iterator ? () => [][Symbol.iterator]() : ignore,
		apply: () => ignore,
	});
	const own = new Set(
		"handleEvent setRunStatus reportProgramStatus syncRunStatus whileDialogOpen sendRunNotification updateConnectionStateFromEvent patchConnectionState".split(
			" ",
		),
	);
	const fields: Record<string | symbol, unknown> = {
		...{
			runStatus: { state: "idle" },
			openDialogs: [],
			programStatusStopped: false,
			runAbortRequested: false,
			notificationsCancelled: false,
			pendingErrorNotification: false,
		},
		...{ isInitialized: true, streaming: false, retryAttempt: 0, statusBeforeCompaction: undefined },
		connectionState: undefined,
		settingsManager: {
			getProgramStatus: () => fields.enabled !== false,
			getShowTerminalProgress: () => false,
			getNotifyOnCompletion: () => fields.completion !== false,
			getNotifyOnError: () => fields.error !== false,
			getNotifyOnInput: () => fields.input !== false,
		},
		getCurrentSessionName: () => "Test session",
		ui: Object.setPrototypeOf({ terminal: { write, notify: vi.fn() } }, ignore),
		isAgentStreaming: () => fields.streaming,
		getRetryAttempt: () => mode.connectionState?.retryAttempt ?? fields.retryAttempt,
		...{ startCompactionLoader: proto.startCompactionLoader, interruptOrClearInput: proto.interruptOrClearInput },
		...{ resetExtensionUI: proto.resetExtensionUI, extensionSelector: undefined, extensionInput: undefined },
	};
	const mode: any = new Proxy(fields, {
		get: (target, key) => (key in target ? target[key] : own.has(key as string) ? proto[key as string] : ignore),
	});
	const reports = () => write.mock.calls.map(([report]) => parse(report).state);
	return { mode, reports, write, event: (e: object) => mode.handleEvent(e) };
}

const proto = InteractiveMode.prototype as unknown as Record<string, any>;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const setStdoutTTY = (value: boolean) => Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdout, "isTTY");
});

describe("client terminal notifications", () => {
	beforeEach(() => {
		vi.stubEnv("TERM_PROGRAM", "ghostty");
		vi.stubEnv("PI_NOTIFICATIONS", "on");
	});
	test("notifies on completion, failure, and working input dialogs, not idle dialogs or cancellation", async () => {
		const { mode, event } = fakeMode();
		const notify = mode.ui.terminal.notify;
		await mode.whileDialogOpen("Idle", Promise.resolve("a"));
		await event({ type: "agent_start" });
		await mode.whileDialogOpen("Question", Promise.resolve("a"));
		await event({ type: "agent_end", messages: [assistant("stop")] });
		await event({ type: "agent_start" });
		await event({ type: "agent_end", messages: [assistant("error")] });
		await event({ type: "agent_start" });
		mode.streaming = true;
		mode.interruptOrClearInput();
		await event({ type: "agent_end", messages: [assistant("stop")] });
		await event({ type: "auto_retry_end", success: false });
		await event({ type: "agent_start" });
		await event({ type: "agent_end", messages: [assistant("error")] });
		const types = notify.mock.calls.map(([n]: [{ type: string }]) => n.type);
		expect(types).toEqual(["ask", "completion", "error", "error"]);
	});

	test.each([true, false])("settles retry notifications with waiting action=%s", async (waiting) => {
		vi.useFakeTimers();
		const { mode, event } = fakeMode();
		const notify = mode.ui.terminal.notify;
		for (const success of [false, true]) {
			notify.mockClear();
			mode.connectionState = { sessionActions: { active: { kind: "turn" } }, retryAttempt: 0 };
			await event({ type: "agent_start" });
			await event({ type: "agent_end", messages: [assistant("error")] });
			for (const attempt of [1, 2]) {
				await event({ type: "auto_retry_start", delayMs: 1000, attempt });
				if (!waiting) await event({ type: "session_action_update", actions: {} });
				await event({ type: "agent_start" });
				if (!success || attempt === 1) await event({ type: "agent_end", messages: [assistant("error")] });
				expect(notify).not.toHaveBeenCalled();
			}
			await event({ type: "auto_retry_end", success, finalError: success ? undefined : "failed" });
			if (success) await event({ type: "agent_end", messages: [assistant("stop")] });
			await event({ type: "session_action_update", actions: {} });
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0].type).toBe(success ? "completion" : "error");
		}
	});

	test.each([true, false])("overflow compaction drops the held error only when willRetry=%s", async (willRetry) => {
		const { mode, event } = fakeMode();
		mode.connectionState = { sessionActions: { active: { kind: "turn" } } };
		const notify = mode.ui.terminal.notify;
		await event({ type: "agent_start" });
		await event({ type: "agent_end", messages: [assistant("error")] });
		await event({ type: "compaction_start", reason: "overflow" });
		await event({ type: "compaction_end", reason: "overflow", willRetry, result: {}, aborted: false });
		await event({ type: "session_action_update", actions: {} });
		expect(notify).toHaveBeenCalledTimes(willRetry ? 0 : 1);
		if (willRetry) {
			await event({ type: "agent_start" });
			await event({ type: "agent_end", messages: [assistant("stop")] });
		}
		expect(notify.mock.calls[0][0].type).toBe(willRetry ? "completion" : "error");
	});

	test.each([
		["tern", true, "", [false, false, false]],
		["tern", false, "", [false, false, true]],
		["WarpTerminal", true, "1", [false, false, true]],
		["WarpTerminal", true, "", [true, true, true]],
	])("terminal suppression for %s programStatus=%s Warp protocol=%s", (terminal, status, warp, allowed) => {
		vi.stubEnv("TERM_PROGRAM", terminal);
		vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", warp);
		vi.stubEnv("PI_NOTIFICATIONS", "on");
		const { mode } = fakeMode();
		mode.enabled = status;
		for (const [index, type] of ["completion", "error", "ask"].entries()) {
			mode.sendRunNotification(type);
			expect(mode.ui.terminal.notify.mock.calls.length).toBe(allowed.slice(0, index + 1).filter(Boolean).length);
		}
	});

	test.each(["settings", "env", "tty", "stopped"])("no notifications when %s disables them", (reason) => {
		vi.stubEnv("TERM_PROGRAM", "ghostty");
		vi.stubEnv("PI_NOTIFICATIONS", reason === "env" ? "off" : "on");
		const { mode } = fakeMode();
		if (reason === "settings") mode.completion = mode.error = mode.input = false;
		if (reason === "tty") setStdoutTTY(false);
		if (reason === "stopped") proto.stop.call(mode);
		for (const type of ["completion", "error", "ask"]) mode.sendRunNotification(type);
		expect(mode.ui.terminal.notify).not.toHaveBeenCalled();
	});
});
