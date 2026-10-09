import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it, type TestContext } from "node:test";
import type { OutMessage } from "@stencil-hq/tern";
import pkg from "../package.json";
import { NativeConnection } from "../src/native/connection.js";
import type { TerminalStopOptions } from "../src/terminal.js";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class InputComponent extends TestComponent {
	inputs: string[] = [];
	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	lastStopOptions: TerminalStopOptions | undefined;

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(options?: TerminalStopOptions): void {
		this.lastStopOptions = options;
		super.stop(options);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";
const PAGE_UP = "\x1b[5~";
const VIEWPORT_TOP = "\x1b[1;4A"; // shift+alt+up
const FOLLOW = "\x1b[1;6B"; // ctrl+shift+down

interface Setup {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	chat: TestComponent;
	dock: TestComponent;
}

function setup(transcriptLines: string[], cols = 40, rows = 10): Setup {
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	const chat = new TestComponent();
	chat.lines = transcriptLines;
	const dock = new TestComponent();
	dock.lines = ["> prompt", "footer"];
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	return { terminal, tui, chat, dock };
}

function lines(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

describe("TUI fullscreen mode", () => {
	it("enters the alt screen and lays out transcript window above the dock", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), true);
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");
		assert.strictEqual(terminal.mouseTrackingActive, true, "probe succeeds → wheel tracking enabled");

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 12");
		assert.strictEqual(viewport[7], "Line 19");
		assert.strictEqual(viewport[8], "> prompt");
		assert.strictEqual(viewport[9], "footer");

		tui.stop();
	});

	it("keeps the window pinned to the bottom while following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		chat.lines = lines(25);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[7], "Line 24", "window follows appended content");
		assert.strictEqual(viewport[8], "> prompt", "dock stays pinned");

		tui.stop();
	});

	it("wheel up unfollows and freezes the window while content appends", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "wheel scrolls up 3 lines");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		chat.lines = lines(40);
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "appended content does not move the window");
		assert.strictEqual(viewport[8], "> prompt", "dock still visible");
		assert.strictEqual(tui.getScrollInfo()?.linesBelow, 23);

		tui.stop();
	});

	it("scrolling back to the bottom resumes following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(WHEEL_DOWN);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		chat.lines = lines(22);
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 21");

		tui.stop();
	});

	it("page and home/end keys scroll the window while the editor keeps focus", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const editor = new TestComponent();
		tui.setFocus(editor);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 15");

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 0");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(FOLLOW);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 29");
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		tui.stop();
	});

	it("row-diffs frames: only changed rows are repainted", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.clearWrites();

		chat.lines = [...lines(19), "Line 19 changed"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "no full clear for a single-line change");
		assert.ok(writes.includes("\x1b[8;1H"), "repaints the changed row (window row 8)");
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.strictEqual(repaintedRows.length, 1, "exactly one row repainted");
		assert.strictEqual(terminal.getViewport()[7], "Line 19 changed");

		tui.stop();
	});

	it("resize repaints the whole frame and clamps the scroll position", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 20);
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "resize forces a full frame repaint");
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 0", "scroll position clamped, still at top");
		assert.strictEqual(viewport[18], "> prompt", "dock re-anchored to the new bottom");

		tui.stop();
	});

	it("exit restores the primary screen and flushes fullscreen-era content into scrollback", async () => {
		const { terminal, tui, chat, dock } = setup(lines(5));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");

		chat.lines = lines(30);
		tui.requestRender();
		await terminal.waitForRender();

		tui.exitFullscreen();
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), false);
		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
		const scrollBuffer = terminal.getScrollBuffer().join("\n");
		assert.ok(scrollBuffer.includes("Line 29"), "content appended while fullscreen reached the primary buffer");
		assert.ok(scrollBuffer.includes("Line 0"), "pre-fullscreen content still present");

		tui.stop();
	});

	it("stop() leaves the alt screen and disables mouse tracking", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		tui.stop();
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
	});

	it("can stop without leaving alt screen or flushing fullscreen content", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.clearWrites();
		tui.stop({ preserveAltScreen: true, flushFullscreen: false });
		await terminal.flush();

		assert.strictEqual(tui.isFullscreen(), false);
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");
		assert.strictEqual(terminal.mouseTrackingActive, false);
		assert.ok(!terminal.getWrites().includes("\x1b[?1049l"));
		assert.ok(!terminal.getWrites().includes("Line 29"));

		const next = new TUI(terminal);
		const nextContent = new TestComponent();
		nextContent.lines = ["Agents View"];
		const nextDock = new TestComponent();
		nextDock.lines = ["> prompt"];
		next.start();
		next.enterFullscreen({ scroll: [nextContent], dock: nextDock, mouse: false });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Agents View");
		assert.strictEqual(viewport.at(-1), "> prompt");

		next.stop({ flushFullscreen: false });
		await terminal.flush();
		assert.strictEqual(terminal.getActiveBufferType(), "normal");
	});

	it("ignores preserve requests when no alternate screen is active", async () => {
		const { terminal, tui } = setup(lines(3));
		await terminal.waitForRender();

		terminal.clearWrites();
		tui.stop({ preserveAltScreen: true });
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.lastStopOptions?.preserveAltScreen, false);
	});

	it("can pass viewport keys to the focused component", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const input = new InputComponent();
		tui.setFocus(input);
		tui.enterFullscreen({ scroll: [chat], dock, viewportControls: false });
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();

		assert.deepStrictEqual(input.inputs, [PAGE_UP]);

		tui.stop();
	});
});

class NativeTerminal extends LoggingVirtualTerminal {
	readonly native = new NativeConnection();
	readonly keys: string[] = [];
	override start(input: (data: string) => void, resize: () => void): void {
		super.start(input, resize);
		this.native.start(this, (data) => {
			this.keys.push(data);
			super.sendInput(data);
		});
	}
	override sendInput(data: string): void {
		this.native.probe.feed(data);
	}
	override stop(options?: TerminalStopOptions): void {
		this.native.probe.stop();
		super.stop(options);
	}
	message<Verb extends "o" | "f" | "x">(verb: Verb): Extract<OutMessage, { verb: Verb }>["body"] {
		const packets = Array.from(this.getWrites().matchAll(new RegExp(`\\x1b_tsp;${verb};(.+?)\\x1b\\\\`, "gs")));
		return JSON.parse(packets[packets.length - 1][1]);
	}
	event(body: object): void {
		this.sendInput(`\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`);
	}
	hello(): void {
		this.sendInput('\x1b_tsp;r;{"r":"hello","v":1,"apc":65536,"credits":2,"cols":80}\x1b\\\x1b[?1;2c');
	}
}
async function renderTui(tui: TUI): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
}
function nativeSetup(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const terminal = new NativeTerminal(40, 10),
		tui = new TUI(terminal),
		chat = new InputComponent();
	chat.lines = [`transcript${CURSOR_MARKER}`];
	tui.addChild(chat);
	tui.setFocus(chat);
	t.after(() => tui.stop());
	const layout = { scroll: [chat], dock: new TestComponent(), native: true };
	tui.start();
	terminal.clearWrites();
	tui.enterFullscreen(layout);
	return { terminal, tui, chat, layout };
}
async function nextTui(t: TestContext, h: ReturnType<typeof nativeSetup>): Promise<TUI> {
	const next = new TUI(h.terminal);
	t.after(() => next.stop());
	next.start();
	next.enterFullscreen(h.layout);
	await renderTui(next);
	return next;
}

it("keeps pending entry and exit silent, opens inline without markers, and passes plain PgUp/PgDn", async (t) => {
	const h = nativeSetup(t);
	await renderTui(h.tui);
	assert.equal(h.terminal.getWrites(), "");
	h.tui.exitFullscreen();
	assert.equal(h.terminal.getWrites(), "");
	h.tui.enterFullscreen(h.layout);
	h.terminal.hello();
	await renderTui(h.tui);
	assert.deepEqual(h.terminal.message("o"), { id: "prime", mode: "inline", title: "Prime", role: "prime.session" });
	assert.equal(h.terminal.message("f").ops.length, 2);
	assert.equal(h.terminal.getWrites().includes(JSON.stringify(CURSOR_MARKER).slice(1, -1)), false);
	assert.ok(!h.terminal.altScreenActive && !h.terminal.mouseTrackingActive);
	const before = h.tui.getScrollInfo();
	for (const key of [PAGE_UP, "\x1b[6~"]) h.terminal.sendInput(key);
	assert.deepEqual(h.chat.inputs, [PAGE_UP, "\x1b[6~"]);
	assert.deepEqual(h.tui.getScrollInfo(), before);
});
for (const rejection of ["DA1", "timeout", "malformed"]) {
	it(`rejects pending native entry through ${rejection} with one full ANSI repaint`, async (t) => {
		const h = nativeSetup(t);
		h.terminal.clearWrites();
		if (rejection === "timeout") t.mock.timers.tick(1000);
		else h.terminal.sendInput(rejection === "DA1" ? "\x1b[?1;2c" : '\x1b_tsp;r;{"r":"hello","v":2}\x1b\\');
		await renderTui(h.tui);
		assert.equal(h.terminal.getWrites().includes("\x1b_tsp;"), false);
		assert.equal(h.terminal.getWrites().split("\x1b[?1049h").length - 1, 1);
		assert.equal(h.terminal.getWrites().split("\x1b[2J").length - 1, 1);
	});
}
it("drains release for 50ms, adopts across TUIs, reopens after gone and rejects live but not stale errors", async (t) => {
	const h = nativeSetup(t);
	h.terminal.hello();
	await renderTui(h.tui);
	const seq = h.terminal.message("f").s;
	h.terminal.clearWrites();
	const resolutions: string[] = [],
		released = h.tui.releaseNative();
	void released.then(() => resolutions.push("done"));
	assert.deepEqual(h.terminal.message("x"), { id: "prime", keep: true });
	t.mock.timers.tick(30);
	h.terminal.event({ ev: "ack", sf: "prime", s: seq });
	h.terminal.sendInput("late");
	assert.deepEqual(h.terminal.keys, []);
	await Promise.resolve();
	assert.deepEqual(resolutions, []);
	t.mock.timers.tick(20);
	await released;
	h.tui.stop();
	assert.equal(h.terminal.getWrites().split("\x1b_tsp;x;").length - 1, 1);
	h.terminal.clearWrites();
	const next = await nextTui(t, h);
	assert.equal(h.terminal.message("o").adopt, true);
	assert.equal(h.terminal.message("f").s, seq + 1);
	h.terminal.clearWrites();
	h.terminal.event({ ev: "gone", ids: ["prime"] });
	await renderTui(next);
	assert.equal(h.terminal.message("o").id, "prime-2");
	assert.equal(h.terminal.message("o").adopt, undefined);
	h.terminal.clearWrites();
	h.terminal.event({ ev: "error", sf: "prime", msg: "old" });
	await renderTui(next);
	assert.equal(h.terminal.getWrites(), "");
	h.terminal.event({ ev: "error", sf: "prime-2", msg: "live" });
	await renderTui(next);
	assert.equal(h.terminal.altScreenActive, true);
});
for (const event of [
	{ ev: "gone", ids: ["main.tx.s0_0"] },
	{ ev: "error", sf: "prime", op: 0, msg: "bad op" },
	{ ev: "error", msg: "chunked f message c=0 dropped: over 25165824 bytes" },
]) {
	it(`ends native permanently on an unacked adopt for ${JSON.stringify(event)}`, async (t) => {
		const h = nativeSetup(t);
		h.terminal.hello();
		await renderTui(h.tui);
		h.tui.stop();
		const adopted = await nextTui(t, h);
		assert.equal(h.terminal.message("o").adopt, true);
		h.terminal.clearWrites();
		h.terminal.event(event);
		await renderTui(adopted);
		assert.deepEqual(h.terminal.message("x"), { id: "prime", keep: false });
		assert.equal(h.terminal.getWrites().split("\x1b[?1049h").length - 1, 1);
		assert.equal(h.terminal.getWrites().split("\x1b[2J").length - 1, 1);
		adopted.stop();
		h.terminal.clearWrites();
		await nextTui(t, h);
		assert.equal(h.terminal.getWrites().includes("\x1b_tsp;"), false);
	});
}

const ansiScript = String.raw`import { mock } from "node:test";
import { ProcessTerminal } from "./src/terminal.ts";
import { TUI } from "./src/tui.ts";
mock.timers.enable({ apis: ["setTimeout"] });
mock.method(process, "kill", () => true);
const terminal = new ProcessTerminal(), tui = new TUI(terminal);
const chat = { lines: [], render() { return this.lines; }, invalidate() {} };
const dock = { render() { return ["dock"]; }, invalidate() {} };
tui.addChild(chat); tui.addChild(dock); tui.start();
terminal.native?.probe.feed('\x1b_tsp;r;{"r":"hello","v":1,"apc":65536,"credits":2,"cols":80}\x1b\\\x1b[?1;2c');
if (process.env.PI_TUI_NATIVE === "1" && terminal.native?.probe.state.kind !== "available") throw new Error("probe failed");
tui.enterFullscreen({ scroll: [chat], dock, ...(process.env.PI_TUI_NATIVE === "1" ? {} : { native: true }) });
for (const line of ["first", "second"]) {
  chat.lines = [line]; tui.requestRender(true);
  await new Promise((resolve) => process.nextTick(resolve));
}
await tui.releaseNative?.();
tui.stop(); mock.timers.reset(); mock.reset();`;
const baseAnsiBytes =
	"\x1b[?2004h\x1b[?u\x1b[?25l\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2026h\x1b[2J\x1b[H\x1b[1;1H\x1b[2Kfirst\x1b[0m\x1b]8;;\x07\x1b[2;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[3;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[4;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[5;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[6;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[7;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[8;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[9;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[10;1H\x1b[2Kdock\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?25l\x1b[?2026h\x1b[2J\x1b[H\x1b[1;1H\x1b[2Ksecond\x1b[0m\x1b]8;;\x07\x1b[2;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[3;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[4;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[5;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[6;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[7;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[8;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[9;1H\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[10;1H\x1b[2Kdock\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?25l\x1b[?1006l\x1b[?1002l\x1b[?1049l\x1b[?2026hsecond\x1b[0m\x1b]8;;\x07\r\ndock\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?25l\x1b[1B\r\n\x1b[?25h\x1b[?2004l";
for (const gate of [undefined, "1"]) {
	it(`preserves complete ProcessTerminal stdout from the base with gate ${gate}`, () => {
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", ansiScript], {
			env: { COLUMNS: "40", LINES: "10", PI_TUI_NATIVE: gate },
			encoding: "utf8",
			timeout: 10000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		const probe =
			gate === "1" ? `\x1b_tsp;q;{"q":"hello","v":[1],"app":"prime-agent","ver":"${pkg.version}"}\x1b\\\x1b[c` : "";
		assert.equal(result.stdout, baseAnsiBytes.replace("\x1b[?u", `\x1b[?u${probe}`));
	});
}
