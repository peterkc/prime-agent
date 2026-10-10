import assert from "node:assert/strict";
import type * as importChildProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.js";
import {
	canProbeNotifications,
	detectNotificationTerminal,
	formatTerminalNotification,
	NOTIFICATION_PROTOCOLS,
	notificationsSuppressed,
	TerminalNotifications,
	wrapNotification,
} from "../src/terminal-notify.js";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof importChildProcess;
const originalEnv = process.env;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const osc9 = "\x1b]9;Prime: Complete\x1b\\";
const osc99 = "\x1b]99;;Prime: Complete\x1b\\";
const tmuxOsc9 = "\x1bPtmux;\x1b\x1b]9;Prime: Complete\x1b\x1b\\\x1b\\\x07";
const notification = {
	title: "Prime",
	body: "Complete",
	type: "completion",
	urgency: "normal",
	actions: "focus",
} as const;
beforeEach(() => {
	process.env = { TERM_PROGRAM: "kitty", PI_NO_DESKTOP_NOTIFY: "1" };
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	process.env = originalEnv;
	for (const [stream, descriptor] of [
		[process.stdin, stdinTTY],
		[process.stdout, stdoutTTY],
	] as const) {
		if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
		else Reflect.deleteProperty(stream, "isTTY");
	}
});
test("notification protocol table and detection precedence", () => {
	for (const [program, id, protocol] of [
		["kitty", "kitty", "osc99"],
		["otty", "otty", "osc99"],
		["tern", "tern", "osc99"],
		["ghostty", "ghostty", "osc9"],
		["wezterm", "wezterm", "osc9"],
		["iterm.app", "iterm2", "osc9"],
		["WarpTerminal", "warp", "osc9"],
		["monstar", "monstar", "osc9"],
		["vscode", "vscode", "bell"],
		["alacritty", "alacritty", "bell"],
		["orca", "orca", "bell"],
		["rio", "rio", "bell"],
		["unknown", "base", "bell"],
		["", "trueColor", "bell"],
	] as const) {
		const env = { TERM_PROGRAM: program.toUpperCase(), COLORTERM: program ? "" : "24BIT" };
		assert.equal(detectNotificationTerminal(env), id);
		assert.equal(NOTIFICATION_PROTOCOLS[id], protocol);
	}
	const markers = {
		KITTY_WINDOW_ID: "kitty",
		GHOSTTY_RESOURCES_DIR: "ghostty",
		WEZTERM_PANE: "wezterm",
		ITERM_SESSION_ID: "iterm2",
		VSCODE_PID: "vscode",
		ALACRITTY_WINDOW_ID: "alacritty",
	};
	for (const [key, id] of Object.entries(markers))
		assert.equal(detectNotificationTerminal({ [key]: "1", TERM_PROGRAM: "tern" }), id);
	assert.equal(detectNotificationTerminal({ TERM_PROGRAM: "tmux", TERM: "screen" }, "kitty"), "kitty");
	assert.equal(detectNotificationTerminal({ TERM: "xterm-ghostty" }), "ghostty");
	assert.equal(detectNotificationTerminal({ TERM: "MONSTAR" }), "monstar");
	assert.equal(detectNotificationTerminal({}), "base");
});
test("plain notifications are one control-free line and rich notifications carry metadata", () => {
	assert.equal(formatTerminalNotification("bell", notification), "\x07");
	assert.equal(formatTerminalNotification("osc9", notification), osc9);
	assert.equal(
		formatTerminalNotification("osc99", { title: "\x1b[31mPrime\x1b[0m", body: "a\nb\x07" }),
		"\x1b]99;;Prime: a b\x1b\\",
	);
	const rich =
		"\x1b]99;i=n1:f=UHJpbWU=:t=Y29tcGxldGlvbg==:u=1:a=focus:d=0;Prime\x1b\\\x1b]99;i=n1:p=body;Complete\x1b\\";
	assert.equal(formatTerminalNotification("osc99", notification, "n1"), rich);
	const encoded = formatTerminalNotification("osc99", { title: "hello\x1b\\\n", body: "", id: "0" }, "n2");
	assert.equal(encoded, `\x1b]99;i=n2:f=UHJpbWU=:e=1;${Buffer.from("hello\x1b\\\n").toString("base64")}\x1b\\`);
	const chunks = formatTerminalNotification("osc99", { title: "😀".repeat(600), body: "" }, "n3")
		.split("\x1b\\")
		.slice(0, -1);
	assert.equal(chunks.length, 2);
	assert.equal(Buffer.byteLength(chunks[0]!.split(";")[2]!), 2048);
	assert.equal(Buffer.byteLength(chunks[1]!.split(";")[2]!), 352);
	assert.match(chunks[0]!, /:d=0;/u);
	assert.doesNotMatch(chunks[1]!, /:d=0;/u);
});

test("tmux and Zellij retain BEL monitoring without wrapping BEL itself", () => {
	const sequence = osc9;
	assert.equal(wrapNotification(sequence, "osc9", { TMUX: "1" }), tmuxOsc9);
	assert.equal(wrapNotification(sequence, "osc9", { ZELLIJ: "1" }), `${sequence}\x07`);
	assert.equal(wrapNotification("\x07", "bell", { TMUX: "1" }), "\x07");
	assert.equal(wrapNotification(sequence, "osc9", {}), sequence);
});

test("OSC 99 probe reuses buffered stdin, confirms rich support, and consumes its DA1 sentinel", async () => {
	const output: string[] = [];
	const client = new TerminalNotifications((sequence) => output.push(sequence));
	const buffer = new StdinBuffer();
	const keys: string[] = [];
	buffer.on("data", (sequence) => {
		if (!client.handleResponse(sequence)) keys.push(sequence);
	});
	try {
		client.start();
		const probeId = /i=([^:]+)/u.exec(output[0]!)![1];
		assert.match(output[0]!, /:p=\?;\x1b\\\x1b\[c$/u);
		await client.send(notification);
		assert.equal(output[1], osc99);
		buffer.process(`\x1b]99;i=${probeId}:p=?;p=ti`);
		buffer.process("tle,body\x1b");
		buffer.process("\\\x1b[?1;2cX");
		await client.send(notification);
		assert.match(output[2]!, /^\x1b\]99;i=prime-.*:f=UHJpbWU=/u);
		assert.deepEqual(keys, ["X"]);
		client.stop();
		await client.send(notification);
		assert.equal(output.length, 3);
	} finally {
		client.stop();
		buffer.destroy();
	}
});

test("DA1 first, unsupported replies, and mismatched probe ids never enable rich OSC 99", async () => {
	for (const reply of ["sentinel", "unsupported", "mismatch", "malformed"]) {
		const output: string[] = [];
		const client = new TerminalNotifications((sequence) => output.push(sequence));
		client.start();
		const id = /i=([^:]+)/u.exec(output[0]!)![1];
		if (reply === "sentinel") client.handleResponse("\x1b[?1c");
		client.handleResponse(
			`\x1b]99;${reply === "malformed" ? "ix" : "i="}${reply === "mismatch" ? "other" : id}:p=?;p=${reply === "unsupported" ? "body" : "title"}\x07`,
		);
		await client.send(notification);
		assert.equal(output[1], osc99);
		client.stop();
	}
});

test("multiplexers forbid probes; environment, non-TTY, and stop suppress delivery", async () => {
	for (const env of [
		{ TMUX: "1" },
		{ STY: "1" },
		{ ZELLIJ: "1" },
		{ HERDR_ENV: "1" },
		{ HERDR_PANE_ID: "a" },
		{ CMUX_WORKSPACE_ID: "a" },
		{ WMUX: "1" },
		{ TERM: "screen-256color" },
	])
		assert.equal(canProbeNotifications(env), false);
	assert.equal(canProbeNotifications({ CMUX_SOCKET_PATH: "/socket" }), true);
	for (const value of ["off", "0", "false"]) assert.equal(notificationsSuppressed({ PI_NOTIFICATIONS: value }), true);
	for (const reason of ["env", "tty", "stop"]) {
		const output: string[] = [];
		process.env.TERM_PROGRAM = "ghostty";
		const client = new TerminalNotifications((sequence) => output.push(sequence));
		client.start();
		if (reason === "env") process.env.PI_NOTIFICATIONS = "off";
		if (reason === "tty") Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		if (reason === "stop") client.stop();
		await client.send(notification);
		assert.deepEqual(output, []);
		client.stop();
		delete process.env.PI_NOTIFICATIONS;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	}
});

test("delivery prefers Herdr then cmux and falls back on Node spawn errors", async () => {
	const calls: [string, readonly string[]][] = [];
	let failHerdr = false;
	let failCmux = false;
	mock.method(childProcess, "spawn", (command: string, args: readonly string[]) => {
		calls.push([command, args]);
		const child: ChildProcess = new childProcess.ChildProcess();
		queueMicrotask(() =>
			child.emit((command === "herdr" ? failHerdr : failCmux) ? "error" : "spawn", new Error("missing")),
		);
		return child;
	});
	syncBuiltinESMExports();
	process.env = {
		TERM_PROGRAM: "ghostty",
		HERDR_PANE_ID: "pane-1",
		CMUX_SURFACE_ID: "12345678-1234-1234-1234-123456789abc",
	};
	const output: string[] = [];
	const client = new TerminalNotifications((sequence) => output.push(sequence));
	client.start();
	await client.send({ ...notification, title: "--help", type: "ask" });
	assert.deepEqual(calls, [["herdr", ["notification", "show", "Prime", "--body", "Complete", "--sound", "request"]]]);
	failHerdr = true;
	await client.send(notification);
	assert.equal(calls[2]![0], "cmux");
	const surface = process.env.CMUX_SURFACE_ID!;
	assert.deepEqual(calls[2]![1], ["notify", "--surface", surface, "--title", "Prime", "--body", "Complete"]);
	assert.deepEqual(output, []);
	failCmux = true;
	await client.send(notification);
	assert.deepEqual(output, [osc9]);
	const suppressed = client.send(notification);
	process.env.PI_NOTIFICATIONS = "off";
	const callsBeforeFallback = calls.length;
	await suppressed;
	assert.equal(calls.length, callsBeforeFallback);
	delete process.env.PI_NOTIFICATIONS;
	const pending = client.send(notification);
	client.stop();
	await pending;
	assert.equal(output.length, 1);
});

test("tmux termtype lookup is bounded and cached per terminal client", async () => {
	let queries = 0;
	mock.method(childProcess, "execFileSync", (command: string, args: string[], options: { timeout: number }) => {
		queries++;
		assert.equal(command, "tmux");
		assert.deepEqual(args, ["display-message", "-p", "#{client_termtype}"]);
		assert.equal(options.timeout, 500);
		return "WezTerm (2026)";
	});
	syncBuiltinESMExports();
	process.env = { TMUX: "1", TERM_PROGRAM: "tmux" };
	const output: string[] = [];
	const client = new TerminalNotifications((sequence) => output.push(sequence));
	process.env.PI_NOTIFICATIONS = "off";
	client.start();
	delete process.env.PI_NOTIFICATIONS;
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
	client.start();
	assert.equal(queries, 0);
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	client.start();
	client.start();
	await client.send(notification);
	assert.equal(queries, 1);
	assert.deepEqual(output, [tmuxOsc9]);
	client.stop();
});
