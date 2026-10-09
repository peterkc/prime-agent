// Adapted from pi's codemode execute.ts/tool.ts/renderer.ts at commit 6fb2e781 (MIT).
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeStoreWrites,
	type CodemodeTool,
	loadQuickJSWasm,
	type ParsedCodemodeSource,
	parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getCodemodeRuntimeAssets } from "../../config.js";
import type { ToolDefinition } from "../extensions/types.js";
import { getTextOutput, replaceTabs, str } from "./render-utils.js";

export const codemodeSchema = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });
export const CODEMODE_DESCRIPTION = `Run JavaScript that calls other tools. Pass {code: "..."} with raw JavaScript as the body of an async function; top-level await and return work. No Node, file system, network, process, or timers.
- Every other tool you can call is also tools.<name>(args), with the same arguments. It returns its text joined with newlines, or rejects with an Error carrying the tool's error text. Only active tools are callable; codemode cannot call itself. Use tools["my-tool"] or tools.my_tool for non-identifier names.
- Use Promise.allSettled for independent calls, chain calls, or filter large results. Sequential tools such as ipython run one at a time. Calls still running or queued when the script ends are cancelled; completed effects are not undone.
- text(value), console.log/info/warn/error/debug(...), and return add output in order. image(dataUrlOrImageBlock) adds a PNG, JPEG, GIF, or WebP image; remote URLs are rejected. exit() completes immediately and keeps output and store writes.
- store(key, value) and load(key) keep JSON values on the current session branch. store(key, undefined) deletes a key; missing keys load as undefined. Only completed scripts persist writes.
- ALL_TOOLS lists names and TypeScript declarations. await describeTool(name) returns a declaration. Python skills and MCP servers stay reachable through ipython, not as direct tools.
- Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000}. max_output_tokens is a non-negative safe integer (default 10000, 4 characters per token); timeout_ms is an integer from 1 to 2147483647 (default none). Unknown fields are rejected.
- The budget applies only to user text; over budget it keeps the head and tail and spills the full text to a temp file. Failure keeps partial output and a list of calls already made. Each run is fresh, with a 256 MiB guest heap, 16777216 output characters, 100000 output items, 262144 JSON characters per store value, and 1048576 total store characters (keys plus values). These do not bound host process memory or tool results.`;

export interface CodemodeHost {
	callableTools(): readonly AgentTool[];
	runTool(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ result: AgentToolResult<unknown>; isError: boolean }>;
	storeEntries(): readonly unknown[];
	appendStore(delta: CodemodeStoreWrites): void;
}

export interface CodemodeNestedCall {
	readonly id: string;
	readonly name: string;
	readonly args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs: number;
	error?: string;
}

export interface CodemodeToolDetails {
	readonly calls: CodemodeNestedCall[];
	readonly fullOutputPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStore(entries: readonly unknown[]): Record<string, unknown> {
	const values = new Map<string, unknown>();
	for (const entry of entries) {
		if (!isRecord(entry) || !isRecord(entry.set) || !Array.isArray(entry.delete)) continue;
		if (!entry.delete.every((key) => typeof key === "string")) continue;
		for (const key of entry.delete) values.delete(key);
		for (const [key, value] of Object.entries(entry.set)) values.set(key, value);
	}
	return Object.fromEntries(values);
}

function cut(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function joinQueue(previous: Promise<void>, next: Promise<void>): Promise<void> {
	await previous;
	await next;
}

function waitForQueue(queue: Promise<void>, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		function aborted(): void {
			signal.removeEventListener("abort", aborted);
			reject(new Error("Tool call aborted"));
		}
		async function ready(): Promise<void> {
			await queue;
			signal.removeEventListener("abort", aborted);
			if (signal.aborted) reject(new Error("Tool call aborted"));
			else resolve();
		}
		if (signal.aborted) return aborted();
		signal.addEventListener("abort", aborted, { once: true });
		void ready();
	});
}

/** Numbering, cancellation, and the sequential-tool queue live for exactly one script. */
class CodemodeRun {
	readonly controller = new AbortController();
	readonly calls: CodemodeNestedCall[] = [];
	private queue = Promise.resolve();
	private state: "running" | "finished" = "running";

	constructor(
		private readonly parentId: string,
		private readonly host: CodemodeHost,
		private readonly onUpdate?: AgentToolUpdateCallback<CodemodeToolDetails>,
	) {}

	snapshot(): CodemodeToolDetails {
		return { calls: this.calls.map((call) => ({ ...call })) };
	}

	publish(): void {
		if (this.state === "running") this.onUpdate?.({ content: [], details: this.snapshot() });
	}

	async call(tool: AgentTool, args: unknown, callSignal: AbortSignal): Promise<string> {
		const signal = AbortSignal.any([callSignal, this.controller.signal]);
		const startedAt = performance.now();
		const record: CodemodeNestedCall = {
			id: `${this.parentId}/${this.calls.length + 1}`,
			name: tool.name,
			args: cut(JSON.stringify(args) ?? "", 200),
			status: "running",
			durationMs: 0,
		};
		this.calls.push(record);
		function cancelled(): void {
			record.status = "cancelled";
			record.durationMs = performance.now() - startedAt;
		}
		signal.addEventListener("abort", cancelled, { once: true });
		this.publish();
		let release: (() => void) | undefined;
		const previous = this.queue;
		if (tool.executionMode === "sequential") {
			const next = new Promise<void>((resolve) => {
				release = resolve;
			});
			this.queue = joinQueue(previous, next);
		}
		try {
			if (tool.executionMode === "sequential") await waitForQueue(previous, signal);
			if (signal.aborted) throw new Error("Tool call aborted");
			const outcome = await this.host.runTool(record.id, tool.name, args as Record<string, unknown>, signal);
			const text = resultText(outcome.result);
			if (signal.aborted) throw new Error("Tool call aborted");
			if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
			record.status = "ok";
			return text;
		} catch (error) {
			record.status = signal.aborted ? "cancelled" : "error";
			record.error = cut(errorText(error), 500);
			throw error;
		} finally {
			signal.removeEventListener("abort", cancelled);
			release?.();
			record.durationMs = performance.now() - startedAt;
			this.publish();
		}
	}

	finish(): void {
		this.state = "finished";
		this.controller.abort();
		for (const call of this.calls) {
			if (call.status === "running") call.status = "cancelled";
		}
	}
}

async function budgetOutput(text: string, maxTokens: number): Promise<{ text: string; fullOutputPath?: string }> {
	const budget = maxTokens * 4;
	if (text.length <= budget) return { text };
	const head = Math.floor(budget / 2);
	const tail = budget - head;
	let limited = `${text.slice(0, head)}…${Math.ceil((text.length - budget) / 4)} tokens truncated…${tail > 0 ? text.slice(-tail) : ""}`;
	try {
		const fullOutputPath = join(tmpdir(), `prime-codemode-${randomUUID()}.txt`);
		await writeFile(fullOutputPath, text, { flag: "wx", mode: 0o600 });
		limited += `\n[Full output: ${fullOutputPath}]`;
		return { text: limited, fullOutputPath };
	} catch (error) {
		return { text: `${limited}\n[Could not save the full output: ${errorText(error)}]` };
	}
}

async function executeCodemode(
	parentId: string,
	source: string,
	host: CodemodeHost,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<CodemodeToolDetails>,
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const startedAt = performance.now();
	let parsed: ParsedCodemodeSource;
	try {
		parsed = parseCodemodeSource(source);
	} catch (error) {
		return { content: [{ type: "text", text: errorText(error) }], details: { calls: [] }, isError: true };
	}
	const run = new CodemodeRun(parentId, host, onUpdate);
	const callable = host.callableTools().filter((tool) => tool.name !== "codemode");
	const samples = new Map(
		callable.map((tool) => [
			tool.name,
			renderToolSample({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters as CodemodeJsonSchema,
				outputSchema: { type: "string" },
			}),
		]),
	);
	const tools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: (args, context) => run.call(tool, args, context.signal),
	}));
	function describeTool(args: unknown): string | undefined {
		if (!Array.isArray(args) || typeof args[0] !== "string") throw new Error("describeTool() expects a tool name");
		const name = args[0];
		const tool = callable.find(
			(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
		);
		return tool ? samples.get(tool.name) : undefined;
	}
	const runtimeAssets = getCodemodeRuntimeAssets();
	const sandbox = new CodemodeSandbox({
		tools,
		globals: [{ name: "describeTool", spread: true, execute: describeTool }],
		timeoutMs: parsed.options.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: 256 * 1024 * 1024,
		...(runtimeAssets ? { wasm: loadQuickJSWasm(runtimeAssets.wasmPath), workerUrl: runtimeAssets.workerUrl } : {}),
	});
	let result: CodemodeResult;
	try {
		result = await sandbox.execute(parsed.code, {
			signal: signal ? AbortSignal.any([signal, run.controller.signal]) : run.controller.signal,
			store: readStore(host.storeEntries()),
		});
	} finally {
		run.finish();
		await sandbox.close();
	}
	const output = [...result.output];
	if (result.ok) {
		const writes = result.storeWrites;
		if (Object.keys(writes.set).length > 0 || writes.delete.length > 0) host.appendStore(writes);
		if (result.value !== undefined)
			output.push({
				type: "text",
				text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
			});
	}
	const userText = output
		.filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const truncated = await budgetOutput(userText, parsed.options.maxOutputTokens ?? 10000);
	const images: ImageContent[] = output.filter((item): item is ImageContent => item.type === "image");
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `${result.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - startedAt) / 1000).toFixed(1)} seconds\nOutput:\n`,
		},
	];
	if (truncated.text) content.push({ type: "text", text: truncated.text });
	content.push(...images);
	if (!result.ok) {
		const error =
			result.error.kind === "script"
				? (result.error.stack ?? result.error.message)
				: `Script ${result.error.kind}: ${result.error.message}`;
		const calls = run.calls.map((call) => `${call.name} (${call.status})`).join("\n");
		content.push({
			type: "text",
			text: `Script error:\n${error}\nCalls already made (not undone):\n${calls || "No tool calls were made."}`,
		});
	}
	return {
		content,
		details: { ...run.snapshot(), ...(truncated.fullOutputPath ? { fullOutputPath: truncated.fullOutputPath } : {}) },
		isError: !result.ok,
	};
}

export function createCodemodeToolDefinition(
	_cwd: string,
	host?: CodemodeHost,
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails> {
	return {
		name: "codemode",
		label: "codemode",
		description: CODEMODE_DESCRIPTION,
		parameters: codemodeSchema,
		executionMode: "sequential",
		abortResultGraceMs: 5000,
		async execute(toolCallId, params, signal, onUpdate) {
			if (!host) throw new Error("codemode needs an agent session");
			return executeCodemode(toolCallId, params.code, host, signal, onUpdate);
		},
		renderCall(args, theme) {
			const code = str(args?.code);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("codemode"))}\n${replaceTabs(code ?? "[invalid arg]")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			const lines =
				result.details?.calls?.map(
					(call) => `${call.name} ${call.args} ${call.status} ${Math.round(call.durationMs)}ms`,
				) ?? [];
			const [header, ...rest] = result.content;
			const content =
				header?.type === "text" &&
				/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(header.text)
					? rest
					: result.content;
			const output = getTextOutput({ content }, context.showImages, {
				includeImageDimensions: context.includeImageDimensions,
			});
			return new Text(
				`${lines.join("\n")}${lines.length && output ? "\n" : ""}${theme.fg(context.isError ? "error" : "toolOutput", output)}`,
				0,
				0,
			);
		},
	};
}
