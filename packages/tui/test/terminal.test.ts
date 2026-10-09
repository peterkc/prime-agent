import assert from "node:assert";
import { describe, it, type TestContext } from "node:test";
import { InputParser } from "@stencil-hq/tern";
import { nativeConnection } from "../src/native/connection.js";
import { NativeProbe } from "../src/native/probe.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { ProcessTerminal } from "../src/terminal.js";
import { parseOscColorResponse } from "../src/terminal-colors.js";

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal alternate screen handoff", () => {
	it("keeps raw input active and discards keys until the next fullscreen TUI starts", () => {
		const originalWrite = process.stdout.write;
		const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
		const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
		const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
		let isRaw = false;
		const rawModeChanges: boolean[] = [];
		const firstInputs: string[] = [];
		const secondInputs: string[] = [];

		Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: (enabled: boolean) => {
				isRaw = enabled;
				rawModeChanges.push(enabled);
				return process.stdin;
			},
		});
		Object.defineProperty(process.stdin, "resume", { configurable: true, value: () => process.stdin });
		Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
		process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		try {
			const first = new ProcessTerminal();
			first.start(
				(data) => firstInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			assert.equal(isRaw, true);
			process.stdin.emit("data", "\x1b[B");
			assert.deepEqual(firstInputs, []);

			const second = new ProcessTerminal();
			second.start(
				(data) => secondInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			process.stdin.emit("data", "x");

			assert.equal(isRaw, true);
			assert.deepEqual(secondInputs, ["x"]);
			second.stop();
			assert.equal(isRaw, false);
			assert.deepEqual(rawModeChanges, [true, true, false]);
		} finally {
			process.stdout.write = originalWrite;
			restoreProperty(process.stdin, "isRaw", originalIsRaw);
			restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
			restoreProperty(process.stdin, "resume", originalResume);
			restoreProperty(process.stdin, "pause", originalPause);
		}
	});

	it("does not inherit an active alternate screen before it is preserved", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
			second.stop();

			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 0);
			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("inherits a preserved alternate screen into the next terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			second.stop();
			assert.equal(second.altScreenActive, false);

			const third = new ProcessTerminal();
			assert.equal(third.altScreenActive, false);
			assert.ok(writes.includes("\x1b[?1049h"));
			assert.ok(writes.includes("\x1b[?1049l"));
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("lets the preserving terminal cancel a handoff before it is consumed", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });
			assert.equal(first.altScreenActive, false);

			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("only hands a preserved alternate screen to one terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			const third = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			assert.equal(third.altScreenActive, false);

			second.stop();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});
});

describe("OSC 10/11 color replies", () => {
	const cases: Array<[name: string, reply: string, parsed: ReturnType<typeof parseOscColorResponse>]> = [
		[
			"OSC 10 foreground with 16-bit components and an ST terminator",
			"\x1b]10;rgb:ffff/8000/0000\x1b\\",
			{ kind: "foreground", rgb: { r: 255, g: 128, b: 0 } },
		],
		[
			"OSC 10 foreground with 12-bit components",
			"\x1b]10;rgb:fff/800/000\x1b\\",
			{ kind: "foreground", rgb: { r: 255, g: 128, b: 0 } },
		],
		[
			"OSC 11 background with 8-bit components and a BEL terminator",
			"\x1b]11;rgb:00/5f/87\x07",
			{ kind: "background", rgb: { r: 0, g: 95, b: 135 } },
		],
		["an unsupported OSC number", "\x1b]12;rgb:ffff/ffff/ffff\x1b\\", undefined],
		["a malformed color payload", "\x1b]11;not-a-color\x1b\\", undefined],
	];

	for (const [name, reply, parsed] of cases) {
		it(`parses ${name}`, () => {
			assert.deepStrictEqual(parseOscColorResponse(reply), parsed);
		});
	}
});

function restoreProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}

const nativeHello = '\x1b_tsp;r;{"r":"hello","v":1,"apc":65536,"credits":2,"cols":120}\x1b\\';
const nativeDa1 = "\x1b[?1;2c";
function ignoreInput(): void {}
function nativeTerminal(t: TestContext, gate: string | undefined, term = "tern", tmux = "") {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const savedEnv = {
		PI_TUI_NATIVE: process.env.PI_TUI_NATIVE,
		TERM_PROGRAM: process.env.TERM_PROGRAM,
		TMUX: process.env.TMUX,
	};
	if (gate === undefined) delete process.env.PI_TUI_NATIVE;
	else process.env.PI_TUI_NATIVE = gate;
	process.env.TERM_PROGRAM = term;
	process.env.TMUX = tmux;
	const savedProbe = nativeConnection.probe;
	Reflect.set(nativeConnection, "probe", new NativeProbe());
	const inputs: string[] = [];
	const writes: string[] = [];
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => writes.push(String(chunk)) > 0);
	t.mock.method(process.stdin, "resume", () => process.stdin);
	t.mock.method(process.stdin, "pause", () => process.stdin);
	t.mock.method(process.stdin, "setEncoding", () => process.stdin);
	t.mock.method(process, "kill", () => true);
	const terminal = new ProcessTerminal();
	t.after(() => {
		terminal.stop();
		Reflect.set(nativeConnection, "probe", savedProbe);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	terminal.start((text) => inputs.push(text), ignoreInput);
	return { terminal, inputs, writes };
}
describe("ProcessTerminal native probe gate", () => {
	for (const [gate, term, tmux] of [
		["1", "tern", ""],
		["1", "WarpTerminal", ""],
		["1", "tern", "/tmp/tmux"],
		[undefined, "tern", ""],
		["0", "tern", ""],
		["true", "tern", ""],
		["", "tern", ""],
	] as const) {
		it(`probes only for exact gate ${JSON.stringify(gate)}, terminal ${term}, tmux ${tmux}`, (t) => {
			const { terminal, writes } = nativeTerminal(t, gate, term, tmux);
			const probeWrites = writes.filter((text) => text.includes("tsp;") || text === "\x1b[c");
			assert.deepEqual(
				probeWrites,
				gate === "1"
					? ['\x1b_tsp;q;{"q":"hello","v":[1],"app":"prime-agent","ver":"0.9.8+fork.3"}\x1b\\', "\x1b[c"]
					: [],
			);
			terminal.stop();
			writes.length = 0;
			terminal.start(ignoreInput, ignoreInput);
			assert.deepEqual(
				writes.filter((text) => text.includes("tsp;") || text === "\x1b[c"),
				[],
			);
		});
	}
});
describe("ProcessTerminal native stdin hookup", () => {
	for (const [name, reads, expected, kitty] of [
		["hello and DA1 together", [nativeHello + nativeDa1], [], false],
		[
			"keys and bracketed paste around TSP",
			[`a\x1b[200~before\x1b[201~${nativeHello}\x1b[200~after\x1b[201~b`],
			["a", "\x1b[200~before\x1b[201~", "\x1b[200~after\x1b[201~", "b"],
			false,
		],
		["Unicode beside TSP", [`é界${nativeHello}ñ文`], ["é", "界", "ñ", "文"], false],
		["Kitty reply", [`${nativeHello}\x1b[?7u`], [], true],
		["split Kitty reply", [`${nativeHello}\x1b[?`, "7u"], [], true],
		["OSC 11 reply", [`${nativeHello}\x1b]11;rgb:00/5f/87\x07`], [], false],
	] as const) {
		it(`preserves ${name}`, (t) => {
			const stdin = t.mock.method(StdinBuffer.prototype, "process");
			const { terminal, inputs, writes } = nativeTerminal(t, "1");
			for (const read of reads) process.stdin.emit("data", read);
			assert.equal(terminal.native?.probe.state.kind, "available");
			assert.deepEqual(inputs, expected);
			assert.equal(terminal.kittyProtocolActive, kitty);
			assert.equal(writes.includes("\x1b[>7u"), kitty);
			if (name === "OSC 11 reply")
				assert.deepEqual(
					stdin.mock.calls.map((call) => call.arguments[0]),
					["\x1b]11;rgb:00/5f/87\x07"],
				);
		});
	}
	it("keeps a recognized TSP reply open past the idle flush", (t) => {
		const { terminal, inputs } = nativeTerminal(t, "1");
		process.stdin.emit("data", nativeHello.slice(0, 7));
		t.mock.timers.tick(11);
		process.stdin.emit("data", nativeHello.slice(7) + nativeDa1);
		assert.equal(terminal.native?.probe.state.kind, "available");
		assert.deepEqual(inputs, []);
	});
	it("flushes a lone Escape through both timeouts exactly once", (t) => {
		const { inputs } = nativeTerminal(t, "1");
		process.stdin.emit("data", `${nativeHello}\x1b`);
		t.mock.timers.tick(9);
		assert.deepEqual(inputs, []);
		t.mock.timers.tick(1);
		assert.deepEqual(inputs, []);
		t.mock.timers.tick(10);
		assert.deepEqual(inputs, ["\x1b"]);
		t.mock.timers.tick(10);
		assert.deepEqual(inputs, ["\x1b"]);
	});
	it("routes reads directly after DA1 fallback and flushes held keys last", (t) => {
		const { terminal, inputs } = nativeTerminal(t, "1");
		process.stdin.emit("data", `${nativeDa1}a\x1b`);
		assert.equal(terminal.native?.probe.state.kind, "off");
		t.mock.timers.tick(10);
		assert.deepEqual(inputs, ["a", "\x1b"]);
		process.stdin.emit("data", "\x1b[?1;2c");
		assert.deepEqual(inputs, ["a", "\x1b", "\x1b[?1;2c"]);
	});
	it("clears the parser flush timer on stop", (t) => {
		const { terminal } = nativeTerminal(t, "1");
		const flush = t.mock.method(InputParser.prototype, "flush");
		process.stdin.emit("data", `${nativeHello}\x1b`);
		terminal.stop();
		const callsAtStop = flush.mock.callCount();
		t.mock.timers.tick(20);
		assert.equal(flush.mock.callCount(), callsAtStop);
	});
});
