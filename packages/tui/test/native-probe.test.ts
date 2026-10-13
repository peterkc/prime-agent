import assert from "node:assert/strict";
import { homedir } from "node:os";
import { relative } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { NativeConnection } from "../src/native/connection.js";

const hello = { r: "hello", v: 1, apc: 65536, credits: 2, cols: 120 };
const da1 = "\x1b[?1;2c";

function connection(t: TestContext): { native: NativeConnection; writes: string[]; keys: string[] } {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const native = new NativeConnection();
	const writes: string[] = [];
	const keys: string[] = [];
	native.start({ write: (text) => writes.push(text) }, (text) => keys.push(text));
	t.after(() => native.probe.stop());
	writes.length = 0;
	return { native, writes, keys };
}
for (const [name, body] of [
	["non-JSON", "not-json"],
	["version 2", { ...hello, v: 2 }],
	["missing version", { r: "hello", apc: 65536, credits: 2, cols: 120 }],
	["missing apc", { r: "hello", v: 1, credits: 2, cols: 120 }],
	["fractional apc", { ...hello, apc: 64.5 }],
	["apc below minimum", { ...hello, apc: 63 }],
	["apc above maximum", { ...hello, apc: 262145 }],
	["zero credits", { ...hello, credits: 0 }],
	["fractional credits", { ...hello, credits: 1.5 }],
	["missing cols", { r: "hello", v: 1, apc: 65536, credits: 2 }],
	["fractional cols", { ...hello, cols: 1.5 }],
] as const) {
	it(`rejects malformed hello: ${name}`, (t) => {
		const { native, writes } = connection(t);
		native.probe.feed(`\x1b_tsp;r;${typeof body === "string" ? body : JSON.stringify(body)}\x1b\\`);
		t.mock.timers.tick(1000);
		assert.equal(native.probe.state.kind, "off");
		assert.equal(native.open(), undefined);
		assert.deepEqual(writes, []);
	});
}
for (const [name, input] of [
	["DA1 first", `${da1}\x1b_tsp;r;${JSON.stringify(hello)}\x1b\\`],
	["silence", ""],
]) {
	it(`keeps native off after ${name} across later starts`, (t) => {
		const { native, writes, keys } = connection(t);
		native.probe.feed(input);
		if (name === "DA1 first") assert.equal(native.probe.state.kind, "off");
		t.mock.timers.tick(1000);
		assert.equal(native.probe.state.kind, "off");
		native.start({ write: (text) => writes.push(text) }, (text) => keys.push(text));
		assert.equal(native.open(), undefined);
		assert.deepEqual(writes, []);
	});
}

for (const dir of ["", "missing"]) {
	it(`probes with PI_PACKAGE_DIR=~/<tui root>/${dir}, or stays off when it has no package.json`, (t) => {
		const was = process.env.PI_PACKAGE_DIR;
		t.after(() => {
			if (was === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = was;
		});
		process.env.PI_PACKAGE_DIR = `~/${relative(homedir(), fileURLToPath(new URL("..", import.meta.url)))}/${dir}`;
		assert.equal(connection(t).native.probe.state.kind, dir ? "off" : "pending");
	});
}

it("accepts hello before DA1 and ignores invalid resize and unknown events", (t) => {
	const { native, writes, keys } = connection(t);
	const events: string[] = [];
	native.subscribe((event) => events.push(event.ev));
	native.probe.feed(`\x1b_tsp;r;${JSON.stringify(hello)}\x1b\\${da1}`);
	assert.deepEqual(native.probe.state, { kind: "available", caps: { apc: 65536, credits: 2, cols: 120 } });
	for (const body of [{ ev: "resize" }, { ev: "resize", cols: 1.5 }, { ev: "resize", cols: 0 }, { ev: "new-event" }]) {
		native.probe.feed(`\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`);
	}
	assert.deepEqual(events, []);
	assert.deepEqual(native.probe.state, { kind: "available", caps: { apc: 65536, credits: 2, cols: 120 } });
	native.start({ write: (text) => writes.push(text) }, (text) => keys.push(text));
	assert.deepEqual(writes, []);
	assert.deepEqual(keys, []);
});
for (const [name, ops, expected] of [
	["within apc", [["focus", null]], '\x1b_tsp;f;{"sf":"prime","s":1,"ops":[["focus",null]]}\x1b\\'],
	[
		"over apc",
		[["text", "log", "append", "abcdefghijklmnopqrstuvwxyz0123456789"]],
		'\x1b_tsp;f;c=0;m=1;{"sf":"prime","s":1,"ops":[["text","log","append","abcdefghijklm\x1b\\\x1b_tsp;f;c=0;nopqrstuvwxyz0123456789"]]}\x1b\\',
	],
] as const) {
	it(`encodes frame ${name} with the negotiated limit`, (t) => {
		const { native, writes } = connection(t);
		native.probe.feed('\x1b_tsp;r;{"r":"hello","v":1,"apc":64,"credits":2,"cols":120}\x1b\\');
		native.send({ verb: "f", body: { sf: "prime", s: 1, ops } });
		assert.deepEqual(writes, [expected]);
	});
}

it("adopts the retained Surface, routes ack and gone, and never reopens after native ends", async (t) => {
	const { native, writes } = connection(t);
	native.probe.feed(`\x1b_tsp;r;${JSON.stringify(hello)}\x1b\\`);
	const first = native.open();
	assert.ok(first);
	assert.equal(native.liveSurfaceId, "prime");
	first.send([["focus", null]]);
	await first.close({ keep: true });
	const adopted = native.open();
	assert.ok(adopted);
	assert.equal(adopted.seq, 1);
	assert.match(writes.at(-1)!, /"adopt":true/);
	adopted.send([["focus", null]]);
	adopted.send([["focus", null]]);
	adopted.send([["focus", null]]);
	assert.equal(adopted.seq, 3);
	native.probe.feed('\x1b_tsp;e;{"ev":"ack","sf":"prime","s":3}\x1b\\');
	assert.equal(adopted.seq, 4);
	native.probe.feed('\x1b_tsp;e;{"ev":"gone","ids":["prime"]}\x1b\\');
	assert.equal(adopted.closed, true);
	const fresh = native.open();
	assert.ok(fresh);
	assert.equal(fresh.id, "prime-2");
	assert.equal(fresh.seq, 0);
	assert.equal(
		writes.at(-2),
		'\x1b_tsp;o;{"id":"prime-2","mode":"inline","title":"Prime","role":"prime.session"}\x1b\\',
	);
	assert.match(writes.at(-1)!, /tsp;s;\{"sf":"prime-2","name":"prime","css":"\.sf-rows-mark \{ display: none; \}"\}/);
	await fresh.close({ keep: true });
	native.probe.feed('\x1b_tsp;e;{"ev":"gone","ids":["prime-2"]}\x1b\\');
	assert.equal(native.open()?.id, "prime-3");
	native.probe.end();
	writes.length = 0;
	native.start({ write: (text) => writes.push(text) }, () => {});
	assert.equal(native.open(), undefined);
	assert.deepEqual(writes, []);
});

for (const outcome of ["available", "invalid", "timeout"] as const) {
	it(`keeps the native sentinel separate from a later OSC probe when native is ${outcome}`, (t) => {
		const { native, keys } = connection(t);
		if (outcome === "timeout") t.mock.timers.tick(1000);
		else native.probe.feed(`\x1b_tsp;r;${JSON.stringify({ ...hello, v: outcome === "invalid" ? 2 : 1 })}\x1b\\`);
		native.probe.feed("a\x1b[Ab");
		assert.equal(keys.join(""), "a\x1b[Ab");
		native.probe.feed(da1);
		native.probe.feed("\x1b]99;i=p:p=?;p=title\x1b\\");
		native.probe.feed(da1);
		const sentinel = outcome === "available" ? "\x1b[?c" : da1;
		assert.equal(keys.join(""), `a\x1b[Ab\x1b]99;i=p:p=?;p=title\x1b\\${sentinel}`);
	});
}

const kitty = "\x1bP>|kitty(0.48.2)\x1b\\";
for (const [name, reply] of [
	["tmux", "\x1bP>|tmux 3.5a\x1b\\"],
	["kitty-foo", "\x1bP>|kitty-foo(1)\x1b\\"],
	["a terminal without XTVERSION", ""],
] as const) {
	it(`never sends hello to ${name}`, (t) => {
		const { native, writes, keys } = connection(t);
		native.probe.feed(`${reply}${da1}`);
		assert.equal(native.probe.state.kind, "off");
		assert.deepEqual([writes, keys], [[], []]);
	});
}

it("sends hello after a kitty reply and ends on its XTVERSION reply, not another DA1", (t) => {
	const { native, writes, keys } = connection(t);
	native.probe.feed(kitty.slice(0, 5));
	native.probe.feed(`${kitty.slice(5)}${da1}`);
	assert.equal(writes.length, 1);
	assert.ok(writes[0].startsWith("\x1b_tsp;q;") && writes[0].endsWith("\x1b\\\x1b[>0q"));
	native.probe.feed(da1);
	assert.equal(native.probe.state.kind, "pending");
	native.probe.feed(`\x1b_tsp;r;${JSON.stringify(hello)}\x1b\\${kitty}`);
	assert.equal(native.probe.state.kind, "available");
	assert.deepEqual(keys, ["\x1b[?c"]);
});

it("ends at once when a kitty terminal does not answer hello", (t) => {
	const { native, keys } = connection(t);
	native.probe.feed(`${kitty}${da1}`);
	native.probe.feed(kitty);
	assert.equal(native.probe.state.kind, "off");
	assert.deepEqual(keys, []);
});

it("passes an Escape typed during the probe after 10 ms", (t) => {
	const { native, keys } = connection(t);
	native.probe.feed("\x1b");
	t.mock.timers.tick(10);
	assert.deepEqual(keys, ["\x1b"]);
});

it("releases an unfinished XTVERSION reply once the probe gives up", (t) => {
	const { native, keys } = connection(t);
	native.probe.feed("\x1bP>|kit");
	t.mock.timers.tick(1000);
	native.probe.feed("abc");
	assert.equal(keys.join(""), "\x1bP>|kitabc");
});

it("leaves a pasted XTVERSION reply in the paste and sends no hello for it", (t) => {
	const { native, writes, keys } = connection(t);
	const paste = `\x1b[200~${kitty}\x1b[201~`;
	native.probe.feed(paste.slice(0, 9));
	native.probe.feed(`${paste.slice(9)}${da1}`);
	assert.deepEqual([native.probe.state.kind, writes, keys.join("")], ["off", [], paste]);
});

it("forgets an unfinished paste when the probe stops", (t) => {
	const { native, keys } = connection(t);
	native.probe.feed("\x1b[200~x");
	native.probe.stop();
	native.start({ write: () => {} }, (text) => keys.push(text));
	keys.length = 0;
	native.probe.feed("\x1b");
	t.mock.timers.tick(10);
	assert.deepEqual(keys, ["\x1b"]);
});

it("releases a partial paste end once the probe gives up", (t) => {
	const { native, keys } = connection(t);
	native.probe.feed(`${kitty}${da1}`);
	native.probe.feed("\x1b[200~x\x1b[20");
	t.mock.timers.tick(1000);
	assert.equal(keys.join(""), "\x1b[200~x\x1b[20");
});

it("keeps tracking a paste that starts in the same read as the kitty reply", (t) => {
	const { native, writes, keys } = connection(t);
	native.probe.feed(`${kitty}\x1b[200~`);
	native.probe.feed(`${da1}${kitty}\x1b[201~`);
	assert.deepEqual([writes, keys.join("")], [[], `\x1b[200~${da1}${kitty}\x1b[201~`]);
});

it("keeps a split XTVERSION reply start across a pause", (t) => {
	const { native, writes, keys } = connection(t);
	native.probe.feed("\x1bP>");
	t.mock.timers.tick(10);
	native.probe.feed(`${kitty.slice(3)}${da1}`);
	assert.deepEqual([writes.length, keys], [1, []]);
});
