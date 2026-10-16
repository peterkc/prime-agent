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
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import initialize from "../src/core/extensions/builtin/observation-pack.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

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
async function runner(root: string, sm: SessionManager) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(initialize, root, createEventBus(), runtime);
	runtime.getActiveTools = () => ["ipython"];
	runtime.appendEntry = (type, data) => {
		sm.appendCustomEntry(type, data);
	};
	return new ExtensionRunner([extension], runtime, root, sm, ModelRegistry.inMemory(AuthStorage.inMemory()));
}
function entries(sm: SessionManager, customType: string) {
	return sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

it.each(["joined UTF-8", "custom text tool"])(
	"TM-51: %s packs after compaction, keeps history and next-turn bytes",
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
			const firstRunner = await runner(root, sm);
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
			expect(first[0]).toMatchObject({
				...message,
				content: [
					{
						type: "text",
						text: expect.stringContaining("[large tool result shrunk when a new context cycle began]"),
					},
				],
			});
			const note = JSON.stringify(first[0]);
			for (const part of [head, tail, `original_bytes: ${Buffer.byteLength(text)}`, "original_lines: 3", path])
				expect(note).toContain(JSON.stringify(part).slice(1, -1));
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
			expect(await (await runner(root, sm)).emitContext(input)).toEqual(first);
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
