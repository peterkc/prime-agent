import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import initialize from "../src/core/extensions/builtin/observation-pack.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ContextEventResult, ExtensionContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const head = `${"é".repeat(254)}\r\n`;
const tail = `${"界".repeat(170)}\r\n`;
const text = `${head}${"m".repeat(12288)}\n${tail}`;
function tool(value = text, toolCallId = "kept", toolName = "ipython"): ToolResultMessage {
	return {
		role: "toolResult",
		toolName,
		toolCallId,
		content: [{ type: "text", text: value }],
		isError: false,
		timestamp: 1,
		details: { retained: true },
	};
}
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "next" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	stopReason: "stop",
	timestamp: 2,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function archive(sm: SessionManager, message: ToolResultMessage): string {
	const joined = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	return join(
		sm.getSessionDir(),
		"observation-pack",
		sm.getSessionId(),
		`obs_${digest(`${message.toolName}\0${message.toolCallId}\0${digest(joined)}`).slice(0, 24)}.txt`,
	);
}
async function loadRunner(root: string, sm: SessionManager, copies = 1) {
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: Array.from({ length: copies }, () => (pi) => initialize(pi)),
	});
	await loader.reload();
	const { extensions, runtime, errors } = loader.getExtensions();
	expect(errors).toEqual([]);
	expect(extensions).toHaveLength(copies);
	runtime.getActiveTools = () => ["ipython"];
	runtime.appendEntry = (type, data) => {
		sm.appendCustomEntry(type, data);
	};
	return {
		runner: new ExtensionRunner(extensions, runtime, root, sm, ModelRegistry.inMemory(AuthStorage.inMemory())),
		runtime,
		handler: extensions[0].handlers.get("context")![0],
	};
}
async function runner(root: string, sm: SessionManager, copies = 1) {
	return (await loadRunner(root, sm, copies)).runner;
}
function entries(sm: SessionManager, customType: string) {
	return sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

it.each(["joined UTF-8", "custom text tool", "TM-55 two fork copies"])(
	"TM-51/TM-55: %s packs after compaction, keeps history and next-turn bytes",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "observation-move-"));
		try {
			const sm = SessionManager.create(root, root);
			const message = tool(text, "kept", kind === "custom text tool" ? "custom-text-tool" : "ipython");
			message.content = [
				{ type: "text", text: head + "m".repeat(12288) },
				{ type: "text", text: tail },
			];
			if (kind === "custom text tool") {
				const prior = sm.appendMessage({ role: "user", content: "older cycle", timestamp: 0 });
				sm.appendCompaction("older summary", prior, 30000);
			}
			const kept = sm.appendMessage(message);
			sm.appendMessage(assistant);
			const copies = kind === "TM-55 two fork copies" ? 2 : 1;
			const firstRunner = await runner(root, sm, copies);
			expect(await firstRunner.emitContext([message])).toEqual([message]);
			expect(existsSync(join(root, "observation-pack"))).toBe(false);
			const cycle = sm.appendCompaction("summary", kept, 20000);
			const born = tool(text, "born");
			sm.appendMessage(born);
			const input: AgentMessage[] = [message, born, assistant];
			const before = structuredClone(input);
			const stored = readFileSync(sm.getSessionFile()!, "utf8");
			const history = structuredClone(sm.getEntries().filter((entry) => entry.type === "message"));
			const first = await firstRunner.emitContext(input);
			const path = archive(sm, message);
			const { content: _content, ...properties } = message;
			expect(first[0]).toMatchObject(properties);
			const note = (first[0] as ToolResultMessage).content[0];
			if (note.type !== "text") throw new Error("Expected a text placeholder");
			expect(note.text).toContain("[large tool result shrunk when a new context cycle began]");
			expect(note.text).toContain(`\nid: ${basename(path, ".txt")}\ntool: ${message.toolName}\n`);
			for (const part of [head, tail, `original_bytes: ${Buffer.byteLength(text)}`, "original_lines: 3", path])
				expect(note.text).toContain(part);
			expect(first.slice(1)).toEqual(input.slice(1));
			expect(input).toEqual(before);
			expect(sm.getEntries().filter((entry) => entry.type === "message")).toEqual(history);
			expect(readFileSync(sm.getSessionFile()!, "utf8").startsWith(stored)).toBe(true);
			expect(readFileSync(path)).toEqual(Buffer.from(text));
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
			expect(entries(sm, "observation-pack-cycle")).toMatchObject([
				{ data: { compactionId: cycle, noteIds: [basename(path, ".txt")] } },
			]);
			utimesSync(path, 1, 1);
			sm.appendMessage(assistant);
			expect(await (await runner(root, sm, copies)).emitContext(input)).toEqual(first);
			expect(statSync(path).mtimeMs).toBe(1000);
			expect(readdirSync(dirname(path))).toEqual([basename(path)]);
			expect(entries(sm, "observation-pack-cycle")).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([
	"root-symlink",
	"session-symlink",
	"target-symlink",
	"root-file",
	"session-file",
	"target-directory",
	"hash-mismatch",
])("TM-56: %s rejects the archive without editing history", async (failure) => {
	const root = mkdtempSync(join(tmpdir(), "observation-reject-"));
	try {
		const sm = SessionManager.create(root, root);
		const message = tool();
		const kept = sm.appendMessage(message);
		sm.appendMessage(assistant);
		const cycle = sm.appendCompaction("summary", kept, 20000);
		const path = archive(sm, message);
		const archiveRoot = join(root, "observation-pack");
		const outside = join(root, "outside");
		mkdirSync(outside);
		if (failure === "root-symlink") symlinkSync(outside, archiveRoot);
		else if (failure === "root-file") writeFileSync(archiveRoot, "untouched");
		else {
			mkdirSync(archiveRoot);
			if (failure === "session-symlink") symlinkSync(outside, dirname(path));
			else if (failure === "session-file") writeFileSync(dirname(path), "untouched");
			else {
				mkdirSync(dirname(path));
				if (failure === "target-symlink") symlinkSync(join(outside, "target"), path);
				if (failure === "target-directory") mkdirSync(path);
				if (failure === "hash-mismatch") writeFileSync(path, "wrong");
			}
		}
		const input = [message];
		const before = structuredClone(input);
		const stored = readFileSync(sm.getSessionFile()!, "utf8");
		const extension = await runner(root, sm);
		expect(await extension.emitContext(input)).toEqual(before);
		expect(await (await runner(root, sm)).emitContext(input)).toEqual(before);
		expect(input).toEqual(before);
		expect(
			sm
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message),
		).toEqual([message, assistant]);
		expect(readFileSync(sm.getSessionFile()!, "utf8").startsWith(stored)).toBe(true);
		expect(entries(sm, "observation-pack-error")).toMatchObject([
			{ data: { id: basename(path, ".txt"), compactionId: cycle, message: expect.any(String) } },
		]);
		expect(entries(sm, "observation-pack-cycle")).toMatchObject([{ data: { compactionId: cycle, noteIds: [] } }]);
		expect(readdirSync(outside)).toEqual([]);
		if (failure === "hash-mismatch") expect(readFileSync(path, "utf8")).toBe("wrong");
		if (failure.endsWith("-file"))
			expect(readFileSync(failure === "root-file" ? archiveRoot : dirname(path), "utf8")).toBe("untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("TM-57 extension behavior port", () => {
	let root: string;
	let cleanupRoot: string;
	beforeEach(() => {
		root = cleanupRoot = mkdtempSync(join(tmpdir(), "observation-port-"));
	});
	afterEach(() => {
		rmSync(cleanupRoot, { recursive: true, force: true });
	});
	const input = (message: Message = tool()): Message[] => [message, assistant, assistant];
	function tree(messages = input()) {
		const sm = SessionManager.inMemory(root, root);
		const ids = messages.map((message) => sm.appendMessage(message));
		const cycle = sm.appendCompaction("summary", ids[0], 20000);
		return { sm, cycle, ids };
	}
	async function fixture(
		sm: SessionManager,
		options: {
			tools?: string[];
			hasUI?: boolean;
			sessionDir?: string;
			sessionId?: string;
			appendThrows?: boolean;
			getEntriesThrowsAt?: number;
			toolsThrow?: boolean;
			uiThrow?: boolean;
		} = {},
	) {
		const { runner, runtime, handler } = await loadRunner(root, sm);
		let scans = 0;
		const notifications: Array<{ message: string; type?: string }> = [];
		runtime.getActiveTools = () => {
			if (options.toolsThrow) throw new Error("host tools");
			return options.tools ?? ["ipython"];
		};
		runtime.appendEntry = (type, data) => {
			sm.appendCustomEntry(type, data);
			if (options.appendThrows) throw new Error("recorded then threw");
		};
		const manager = new Proxy(sm, {
			get(target, key) {
				if (key === "getSessionDir") return () => options.sessionDir ?? root;
				if (key === "getSessionId") return () => options.sessionId ?? sm.getSessionId();
				if (key === "getEntries")
					return () => {
						if (++scans === options.getEntriesThrowsAt) throw new Error("host scan");
						return sm.getEntries();
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const ctx: ExtensionContext = {
			...runner.createContext(),
			sessionManager: manager,
			get hasUI() {
				if (options.uiThrow) throw new Error("host UI");
				return options.hasUI ?? false;
			},
			ui: {
				...runner.getUIContext(),
				notify: (message, type) => {
					notifications.push({ message, type });
				},
			},
		};
		return {
			notifications,
			ctx,
			run: async (messages: AgentMessage[], override = ctx) =>
				((await handler({ type: "context", messages }, override)) as ContextEventResult).messages!,
		};
	}
	function customs(sm: SessionManager, type?: string) {
		return sm.getEntries().flatMap((entry) =>
			entry.type === "custom" && (!type || entry.customType === type)
				? [
						{
							type: entry.customType,
							data: entry.data as {
								id?: string;
								compactionId?: string;
								message?: string;
								noteIds?: string[];
							},
						},
					]
				: [],
		);
	}
	async function setup<T extends Message>(
		messages: T[] = input() as T[],
		options: Parameters<typeof fixture>[1] = {},
	) {
		const t = tree(messages);
		return { ...t, messages, f: await fixture(t.sm, options) };
	}
	function decision(cycle: string, notes: string[] = []) {
		return [{ type: "observation-pack-cycle", data: { compactionId: cycle, noteIds: notes } }];
	}
	function note(messages: AgentMessage[]): string {
		const first = (messages[0] as ToolResultMessage).content[0];
		if (first.type !== "text") throw new Error("expected note text");
		return first.text;
	}
	function firstLine(messages: AgentMessage[]) {
		expect(note(messages).split("\n")[0]).toBe("[large tool result shrunk when a new context cycle began]");
	}
	const user: Message = { role: "user", content: "u".repeat(12288), timestamp: 3 };

	it.each(["error", "image", "threshold", "empty", "user"])("AC-004 excluded %s", async (kind) => {
		const result =
			kind === "user" ? user : tool(kind === "threshold" ? "é".repeat(5120) : kind === "empty" ? "" : text);
		if (result.role === "toolResult" && kind === "error") result.isError = true;
		if (result.role === "toolResult" && kind === "image")
			result.content.push({ type: "image", data: "AA==", mimeType: "image/png" });
		const { sm, f, messages } = await setup(input(result));
		const output = await f.run(messages);
		expect(customs(sm)).toEqual([]);
		expect(output).toEqual(messages);
		expect(output).not.toBe(messages);
		expect(output[0]).toBe(result);
		expect(readdirSync(root)).toEqual([]);
	});
	it.each([{ tools: ["bash"] }, { sessionDir: "" }, { sessionId: "../x" }, { sessionId: "" }])(
		"AC-005 invalid host %j",
		async (options) => {
			const { messages, sm, cycle, f } = await setup(input(), options);
			const output = await f.run(messages);
			expect(output).toEqual(messages);
			expect(output).not.toBe(messages);
			expect(output[0]).toBe(messages[0]);
			expect(readdirSync(root)).toEqual([]);
			expect(customs(sm)).toEqual(options.tools ? decision(cycle) : []);
			expect(f.notifications).toEqual([]);
		},
	);
	it("FR-004 oversized end lines and quoted path", async () => {
		root = join(root, 'quotes-"-\\');
		mkdirSync(root);
		const message = tool("界".repeat(4096));
		const { sm } = tree(input(message));
		const value = note(await (await fixture(sm)).run(input(message)));
		const path = archive(sm, message);
		expect(value).toContain(
			`read in ipython: print(open(${JSON.stringify(path)}, encoding="utf-8", newline="").read()[0:16000])`,
		);
		expect(value).toContain("original_lines: 1\n");
		expect(value).toContain(
			"[first complete lines, up to 512 bytes]\n\n[middle omitted; last complete lines, up to 512 bytes]\n\n",
		);
	});
	it("FR-008 independent result failures and per-session warnings", async () => {
		const messages = [tool(text, "good"), tool(), tool(text, "bad-2")];
		const { sm } = tree(messages);
		const bad = archive(sm, messages[1]);
		mkdirSync(dirname(bad), { recursive: true });
		writeFileSync(bad, "!".repeat(12288));
		writeFileSync(archive(sm, messages[2]), "wrong");
		const f = await fixture(sm, { hasUI: true });
		const output = await f.run(messages);
		expect(output[0]).not.toBe(messages[0]);
		expect(output[1]).toBe(messages[1]);
		expect(output[2]).toBe(messages[2]);
		expect(readFileSync(archive(sm, messages[0]), "utf8")).toBe(text);
		expect(readFileSync(bad, "utf8")).toBe("!".repeat(12288));
		expect(customs(sm, "observation-pack-error")).toHaveLength(2);
		expect(customs(sm, "observation-pack-cycle")).toHaveLength(1);
		expect(f.notifications).toHaveLength(1);
		const next = tool(text, "next");
		const nextTree = tree(input(next));
		const path = archive(nextTree.sm, next);
		mkdirSync(dirname(path));
		writeFileSync(path, "wrong");
		await f.run(input(next), { ...f.ctx, sessionManager: nextTree.sm });
		expect(f.notifications).toHaveLength(2);
	});
	it.each(["deleted", "changed", "inactive"].flatMap((failure) => [false, true].map((hasUI) => ({ failure, hasUI }))))(
		"AC-015 recorded archive $failure UI=$hasUI",
		async ({ failure, hasUI }) => {
			const tools = ["ipython"];
			const { messages, sm, cycle, f } = await setup(input(), { tools, hasUI });
			const first = await f.run(messages);
			const path = archive(sm, tool());
			if (failure === "deleted") rmSync(path);
			if (failure === "changed") writeFileSync(path, "wrong");
			if (failure === "inactive") tools.length = 0;
			expect(await f.run(messages)).toEqual(first);
			const reload = await fixture(sm, { tools, hasUI });
			expect(await reload.run(messages)).toEqual(first);
			expect(customs(sm, "observation-pack-error")).toEqual([
				{
					type: "observation-pack-error",
					data: { compactionId: cycle, id: basename(path, ".txt"), message: expect.any(String) },
				},
			]);
			expect(customs(sm, "observation-pack-error")[0].data.message).toBeTruthy();
			expect(f.notifications).toHaveLength(hasUI ? 1 : 0);
			expect(reload.notifications).toEqual([]);
			if (failure === "deleted") expect(existsSync(path)).toBe(false);
			if (failure === "changed") expect(readFileSync(path, "utf8")).toBe("wrong");
		},
	);
	it.each([true, false])("AC-016 existing cycle assistant=%s", async (assistantPresent) => {
		const messages = input(assistantPresent ? tool() : tool("small"));
		const { sm } = tree(messages);
		if (assistantPresent) {
			sm.appendMessage(user);
			sm.appendMessage(assistant);
			sm.appendMessage(user);
		}
		const f = await fixture(sm);
		expect(await f.run(messages)).toEqual(messages);
		expect(await f.run(messages)).toEqual(messages);
		expect(customs(sm)).toEqual([]);
		expect(readdirSync(root)).toEqual([]);
	});
	it("AC-017 inactive read-back locks full result", async () => {
		const tools: string[] = [];
		const { messages, sm, cycle, f } = await setup(input(), { tools });
		expect(await f.run(messages)).toEqual(messages);
		tools.push("ipython");
		expect(await f.run(messages)).toEqual(messages);
		expect(customs(sm)).toEqual(decision(cycle));
		expect(readdirSync(root)).toEqual([]);
	});
	it.each([false, true])("AC-019 sibling branches noted=%s", async (noted) => {
		const tools = noted ? ["ipython"] : [];
		const { messages, sm, cycle, f } = await setup(input(), { tools });
		const first = await f.run(messages);
		sm.branch(cycle);
		sm.appendCustomEntry("sibling");
		expect(
			sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === "observation-pack-cycle"),
		).toBe(false);
		tools.push("ipython");
		const path = archive(sm, tool());
		if (noted) rmSync(path);
		expect(await f.run(messages)).toEqual(first);
		sm.branch(cycle);
		sm.appendCustomEntry("another-sibling");
		expect(await (await fixture(sm, { tools })).run(messages)).toEqual(first);
		expect(customs(sm, "observation-pack-cycle")).toHaveLength(1);
		expect(customs(sm, "observation-pack-error")).toHaveLength(noted ? 1 : 0);
		expect(existsSync(path)).toBe(false);
	});
	it("AC-020 append records then throws", async () => {
		const { messages, sm, cycle, f } = await setup(input(), { appendThrows: true, hasUI: true });
		const first = await f.run(messages);
		firstLine(first);
		expect(await f.run(messages)).toEqual(first);
		expect(customs(sm)).toEqual(decision(cycle, [basename(archive(sm, tool()), ".txt")]));
		expect(f.notifications).toHaveLength(1);
		expect(f.notifications[0].message).toMatch(/observation-pack/);
	});
	it.each(["separate", "uncompacted", "nested"])("AC-021 assistant in %s cycle", async (other) => {
		const { messages, sm, cycle, ids, f } = await setup();
		if (other !== "nested") sm.branch(ids[0]);
		if (other !== "uncompacted") sm.appendCompaction("other", ids[0], 20000);
		sm.appendMessage(assistant);
		sm.branch(cycle);
		if (other === "nested") sm.appendMessage(user);
		const output = await f.run(messages);
		firstLine(output);
		expect(customs(sm)).toEqual(decision(cycle, [basename(archive(sm, tool()), ".txt")]));
	});
	it("AC-022 error identity includes cycle and result", async () => {
		const { messages, sm, cycle: c, ids, f } = await setup();
		const firstC = await f.run(messages);
		sm.appendMessage(assistant);
		const d = sm.appendCompaction("next", ids[0], 20000);
		const firstD = await f.run(messages);
		expect(firstD).toEqual(firstC);
		const path = archive(sm, tool());
		const id = basename(path, ".txt");
		rmSync(path);
		sm.appendCustomEntry("observation-pack-error", { id, message: "legacy" });
		expect(await f.run(messages)).toEqual(firstD);
		sm.branch(c);
		expect(await f.run(messages)).toEqual(firstC);
		expect(await (await fixture(sm)).run(messages)).toEqual(firstC);
		expect(
			customs(sm, "observation-pack-error").flatMap((entry) =>
				entry.data.compactionId ? [{ id: entry.data.id, compactionId: entry.data.compactionId }] : [],
			),
		).toEqual([
			{ id, compactionId: d },
			{ id, compactionId: c },
		]);
		expect(customs(sm, "observation-pack-cycle")).toHaveLength(2);
		expect(existsSync(path)).toBe(false);
	});
	it.each([1, 2])("FR-017 PROBE-1 host entry scan %s", async (getEntriesThrowsAt) => {
		const { messages, sm, cycle, f } = await setup([tool(), tool(text, "second")], { getEntriesThrowsAt });
		sm.appendMessage(user);
		const path = archive(sm, messages[1]);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "wrong");
		const first = await f.run(messages);
		if (getEntriesThrowsAt === 1) {
			expect(first).toEqual(messages);
			expect(customs(sm)).toEqual([]);
		} else {
			firstLine(first);
			expect(first[1]).toEqual(messages[1]);
			expect(customs(sm)).toEqual(decision(cycle, [basename(archive(sm, messages[0]), ".txt")]));
		}
		sm.appendMessage(assistant);
		expect(await f.run(messages)).toEqual(first);
	});
	it.each(["tools", "entries", "ui"])("FR-017 PROBE-2 host %s fault", async (fault) => {
		const options = { toolsThrow: false, getEntriesThrowsAt: -1, uiThrow: false };
		const { messages, sm, f } = await setup(input(), options);
		const first = await f.run(messages);
		firstLine(first);
		sm.appendMessage(assistant);
		if (fault === "tools") options.toolsThrow = true;
		else {
			rmSync(archive(sm, tool()));
			if (fault === "entries") options.getEntriesThrowsAt = 3;
			else options.uiThrow = true;
		}
		expect(await f.run(messages)).toEqual(first);
		expect(await f.run(messages)).toEqual(first);
		expect(customs(sm, "observation-pack-cycle")).toHaveLength(1);
	});
	it("FR-017 PROBE-4 late-loop content fault", async () => {
		const malformed = tool(text, "second");
		malformed.content.map = () => {
			throw new Error("late-loop content fault");
		};
		const { messages, sm, f } = await setup([tool(), malformed]);
		const first = await f.run(messages);
		expect(first).toEqual(messages);
		expect(existsSync(archive(sm, tool()))).toBe(true);
		expect(customs(sm)).toEqual([]);
		sm.appendMessage(assistant);
		expect(await f.run(messages)).toEqual(messages);
		expect(customs(sm)).toEqual([]);
	});
});
