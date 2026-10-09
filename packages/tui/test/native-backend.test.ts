import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { FrameMessage, Op } from "@stencil-hq/tern";
import { NativeBackend } from "../src/native/backend.js";
import { NativeConnection } from "../src/native/connection.js";
import { type Component, Container } from "../src/tui.js";

function ignoreEvent(): void {}
function rows(lines: string[]): Component {
	return { render: () => lines, invalidate: ignoreEvent };
}
function mount(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const frames: FrameMessage[] = [],
		connection = new NativeConnection(),
		main: Component[] = [];
	function write(text: string): void {
		if (text.startsWith("\x1b_tsp;f;")) frames.push(JSON.parse(text.slice(8, -2)));
	}
	connection.start({ write }, ignoreEvent);
	connection.probe.feed('\x1b_tsp;r;{"r":"hello","v":1,"apc":65536,"credits":2,"cols":80}\x1b\\');
	const backend = new NativeBackend(connection, ignoreEvent, ignoreEvent);
	t.after(() => backend.close(false));
	t.after(() => backend.dispose());
	t.after(() => connection.probe.stop());
	assert.ok(backend.open());
	function render(): readonly Op[] {
		connection.probe.feed('\x1b_tsp;e;{"ev":"ack","sf":"prime","s":100000}\x1b\\');
		frames.length = 0;
		backend.render(main, []);
		return frames.flatMap((frame) => frame.ops);
	}
	return { backend, main, connection, frames, render };
}
it("uses position keys for rebuilt children, one-line updates and adding before tail", (t) => {
	const h = mount(t),
		container = new Container();
	h.main.push(container);
	container.children = [rows(["a"])];
	h.render();
	container.children = [rows(["a"])];
	assert.deepEqual(h.render(), []);
	container.children = [rows(["b"])];
	assert.deepEqual(h.render(), [["set", "main.tx.s0-0_0", { lines: ["b"] }]]);
	container.addChild(rows(["new"]));
	const ops = h.render();
	assert.equal(ops.length, 1);
	assert.deepEqual(ops[0].slice(0, 4), ["add", "main.tx.s0-1_0", "main.tx", "main.tx.tail"]);
});
it("keys a 150-line leaf as three 64-line pieces and changes only its last piece on append", (t) => {
	const h = mount(t),
		values = Array.from({ length: 150 }, (_, i) => `${i}`);
	h.main.push(rows(values));
	const op = h.render()[0];
	assert.ok(op[0] === "add");
	const pieces = op[4].c![0].c!;
	const keys = pieces.map((n) => n.p!.key),
		sizes = pieces.map((n) => (n.p!.lines as string[]).length);
	assert.deepEqual(keys, ["s0_0", "s0_1", "s0_2", "tail"]);
	assert.deepEqual(sizes, [64, 64, 22, 0]);
	values.push("appended");
	assert.deepEqual(h.render(), [
		["set", "main.tx.s0_2", { lines: [...Array.from({ length: 22 }, (_, i) => `${i + 128}`), "appended"] }],
	]);
});
it("uses hello credits and cumulative ack to coalesce blocked views without an ack timer", (t) => {
	const h = mount(t),
		values: string[] = [];
	h.main.push(rows(values));
	for (const line of ["first", "second", "third", "newest"]) {
		values.splice(0, values.length, line);
		h.backend.render(h.main, []);
	}
	assert.equal(h.frames.length, 2);
	h.frames.length = 0;
	t.mock.timers.tick(60000);
	assert.deepEqual(h.frames, []);
	assert.equal(h.backend.live, true);
	h.connection.probe.feed('\x1b_tsp;e;{"ev":"ack","sf":"prime","s":2}\x1b\\');
	assert.deepEqual(h.frames, [{ sf: "prime", s: 3, ops: [["set", "main.tx.s0_0", { lines: ["newest"] }]] }]);
	values.splice(0, values.length, "after ack");
	h.backend.render(h.main, []);
	assert.equal(h.frames.length, 2);
});
