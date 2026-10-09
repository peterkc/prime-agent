import { afterEach, describe, expect, it, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeUi = {
	releaseNative: () => Promise<void>;
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
	fullscreenEnabled: boolean;
	applyFullscreen: (enabled: boolean) => void;
	showStatus: (message: string) => void;
};

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): Promise<void>;
};

function callHandleCtrlZ(context: HandleCtrlZThis): Promise<void> {
	return (interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

describe("InteractiveMode.handleCtrlZ", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("shows a status message and skips suspend on Windows", async () => {
		const ui: FakeUi = {
			releaseNative: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis = { ui, showStatus, fullscreenEnabled: false, applyFullscreen: vi.fn() };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			await callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	it.each(["SIGCONT first", "no SIGCONT", "late SIGCONT"])("restores TUI: %s (FR-015)", async (order) => {
		vi.useFakeTimers();
		const ui: FakeUi = {
			releaseNative: vi.fn(async () => {
				await Promise.resolve();
				expect(ui.stop).not.toHaveBeenCalled();
			}),
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui, fullscreenEnabled: true, applyFullscreen: vi.fn(), showStatus: vi.fn() };

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await callHandleCtrlZ(context);
		const keepAliveHandle = setIntervalSpy.mock.results[0].value;

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(ui.releaseNative).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		if (order === "SIGCONT first") sigcontHandler!();
		vi.advanceTimersByTime(250);
		if (order !== "SIGCONT first") {
			expect(removeListenerSpy).toHaveBeenCalledWith("SIGCONT", sigcontHandler);
			expect(context.showStatus).toHaveBeenCalledExactlyOnceWith(
				"Suspend needs a shell with job control; Prime kept running",
			);
		}
		if (order === "late SIGCONT") sigcontHandler!();
		if (order === "SIGCONT first") expect(context.showStatus).not.toHaveBeenCalled();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledExactlyOnceWith(true);
		expect(context.applyFullscreen).toHaveBeenCalledExactlyOnceWith(true);
	});

	test("cleans up the temporary handlers if suspension fails", async () => {
		const ui: FakeUi = {
			releaseNative: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui, fullscreenEnabled: false, applyFullscreen: vi.fn(), showStatus: vi.fn() };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		await expect(callHandleCtrlZ(context)).rejects.toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});
