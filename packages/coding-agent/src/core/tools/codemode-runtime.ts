import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CodeMode, Extension, Namespace, searchSignature, Tool, toolExpression } from "@opencode/codemode";
import { Cause, Effect, Exit, Schema } from "effect";

export interface CodemodeStoreWrites {
	readonly set: Record<string, unknown>;
	readonly delete: string[];
}
export interface ParsedCodemodeSource {
	readonly code: string;
	readonly options: { readonly maxOutputTokens?: number; readonly timeoutMs?: number; readonly maxToolCalls?: number };
}
export const CODEMODE_MAX_OUTPUT_CHARS = 16_777_216;
export const CODEMODE_MAX_OUTPUT_ITEMS = 100_000;
const MAX_STORE_VALUE_CHARS = 262_144;
const MAX_STORE_TOTAL_CHARS = 1_048_576;

export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (!input.trim()) throw new Error("Expected JavaScript source text (non-empty).");
	const newline = input.indexOf("\n");
	const first = (newline === -1 ? input : input.slice(0, newline)).trim();
	if (!first.startsWith("// @options:")) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (!code.trim()) throw new Error("The @options line must be followed by JavaScript source on subsequent lines");
	const fields: unknown = JSON.parse(first.slice("// @options:".length));
	if (!isRecord(fields)) throw new Error("@options must be a JSON object");
	for (const key of Object.keys(fields)) {
		if (!["max_output_tokens", "timeout_ms", "max_tool_calls"].includes(key))
			throw new Error(`@options does not support \`${key}\``);
	}
	const maxOutputTokens = limit(fields.max_output_tokens, "max_output_tokens", 0);
	const timeoutMs = limit(fields.timeout_ms, "timeout_ms", 1, 2_147_483_647);
	const maxToolCalls = limit(fields.max_tool_calls, "max_tool_calls", 0);
	return { code, options: { maxOutputTokens, timeoutMs, maxToolCalls } };
}
function limit(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new Error(`@options field \`${name}\` must be a safe integer from ${minimum} to ${maximum}`);
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function format(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	return JSON.stringify(value) ?? String(value);
}
function imageUrl(value: unknown): string {
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		if (typeof value.image_url === "string") return value.image_url;
		if (value.type === "image" && typeof value.data === "string" && value.data)
			return value.data.toLowerCase().startsWith("data:") ? value.data : `data:;base64,${value.data}`;
	}
	throw new TypeError(
		"image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",
	);
}
function parseImage(value: unknown): ImageContent {
	const url = imageUrl(value);
	if (/^https?:/i.test(url))
		throw new TypeError("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
	const matched = /^data:([^,]*),([\s\S]*)$/i.exec(url);
	if (
		!matched ||
		!matched[1]
			.split(";")
			.slice(1)
			.some((part) => part.toLowerCase() === "base64")
	)
		throw new TypeError("invalid image output. Pass a base64 data URI instead");
	const data = matched[2].replace(/\s+/g, "");
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
		throw new TypeError("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
	const signatures: readonly [string, RegExp][] = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];
	const detected = signatures.find(([, pattern]) => pattern.test(data.slice(0, 16)));
	if (!detected) throw new TypeError("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
	return { type: "image", data, mimeType: detected[0] };
}

/** Capture and store state belong to the host, including interrupted runs without a native Result. */
class Capture {
	readonly output: (TextContent | ImageContent)[] = [];
	readonly toolCalls: CodeMode.ToolCall[] = [];
	readonly writes = new Map<string, string | undefined>();
	readonly stored: Map<string, string>;
	private chars = 0;
	private storedChars = 0;
	private state: "running" | "exit" | "finished" = "running";
	failure?: Error;

	constructor(
		store: Record<string, unknown>,
		private readonly signal?: AbortSignal,
	) {
		this.stored = new Map(Object.entries(store).map(([key, value]) => [key, JSON.stringify(value)]));
		for (const [key, json] of this.stored) this.storedChars += key.length + json.length;
	}
	guard(): void {
		if (this.failure) throw this.failure;
		if (this.state !== "running" || this.signal?.aborted) throw new Error("Script is no longer running");
	}
	admit(call: CodeMode.ToolInvocation): void {
		this.guard();
		this.toolCalls.push({ name: call.name });
	}
	add(item: TextContent | ImageContent): void {
		this.guard();
		const size = item.type === "text" ? item.text.length : item.data.length;
		if (this.chars + size > CODEMODE_MAX_OUTPUT_CHARS || this.output.length >= CODEMODE_MAX_OUTPUT_ITEMS) {
			this.failure = new RangeError(
				`script output exceeded the limit of ${CODEMODE_MAX_OUTPUT_CHARS} characters or ${CODEMODE_MAX_OUTPUT_ITEMS} text(), image(), and console calls. Print a summary instead.`,
			);
			throw this.failure;
		}
		this.chars += size;
		this.output.push(item);
	}
	text(value: unknown): void {
		this.guard();
		this.add({ type: "text", text: format(value) });
	}
	log(...values: unknown[]): void {
		this.guard();
		this.add({ type: "text", text: values.map(format).join(" ") });
	}
	image(value: unknown): void {
		this.guard();
		this.add(parseImage(value));
	}
	store(key: unknown, value: unknown): void {
		this.guard();
		if (typeof key !== "string") throw new TypeError("store() key must be a string");
		const previous = this.stored.has(key) ? key.length + this.stored.get(key)!.length : 0;
		if (value === undefined) {
			this.stored.delete(key);
			this.storedChars -= previous;
			this.writes.set(key, undefined);
			return;
		}
		const json = JSON.stringify(value);
		if (json === undefined) throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable`);
		if (json.length > MAX_STORE_VALUE_CHARS)
			throw new RangeError(
				`store(${JSON.stringify(key)}) value has ${json.length} characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}`,
			);
		const next = this.storedChars - previous + key.length + json.length;
		if (next > MAX_STORE_TOTAL_CHARS)
			throw new RangeError(
				`store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined).`,
			);
		this.stored.set(key, json);
		this.storedChars = next;
		this.writes.set(key, json);
	}
	load(key: unknown): unknown {
		this.guard();
		if (typeof key !== "string") throw new TypeError("load() key must be a string");
		const json = this.stored.get(key);
		return json === undefined ? undefined : JSON.parse(json);
	}
	exit(): void {
		this.guard();
		this.state = "exit";
	}
	get exited(): boolean {
		return this.state === "exit";
	}
	finish(): void {
		this.state = "finished";
	}
	delta(): CodemodeStoreWrites {
		const set: Record<string, unknown> = Object.create(null);
		const deleted: string[] = [];
		for (const [key, json] of this.writes) {
			if (json === undefined) deleted.push(key);
			else set[key] = JSON.parse(json);
		}
		return { set, delete: deleted };
	}
}
export interface CodemodeRuntimeResult {
	readonly ok: boolean;
	readonly output: (TextContent | ImageContent)[];
	readonly storeWrites: CodemodeStoreWrites;
	readonly diagnostics: readonly CodeMode.Diagnostic[];
	readonly toolCalls: readonly CodeMode.ToolCall[];
	readonly error?: string;
}
export interface CodemodeRuntimeTool {
	readonly name: string;
	readonly description: string;
	readonly input: Tool.JsonSchema;
	readonly output?: Tool.SchemaType;
	readonly namespace?: { readonly path: string; readonly description: string };
	readonly call: (args: unknown, signal: AbortSignal) => Promise<unknown>;
}
function alias(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_$]/g, "_");
	return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}
type NativeTools = Record<string, Tool.Tool | Namespace.Namespace>;
function nativeTools(entries: readonly CodemodeRuntimeTool[], capture: Capture): NativeTools {
	const tools: Record<string, Tool.Tool> = Object.create(null);
	const names = new Set<string>();
	for (const entry of entries) {
		if (!entry.name || entry.name.split(".").some((segment) => !segment))
			throw new Error(`Invalid canonical tool name: ${entry.name}`);
		if (names.has(entry.name)) throw new Error(`Ambiguous canonical tool registration: ${entry.name}`);
		names.add(entry.name);
	}
	for (const name of names) {
		if ([...names].some((other) => other.startsWith(`${name}.`)))
			throw new Error(`Ambiguous canonical tool registration: ${name}`);
	}
	const aliases = new Map<string, CodemodeRuntimeTool[]>();
	for (const entry of entries) {
		if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(entry.name)) {
			const name = alias(entry.name);
			aliases.set(name, [...(aliases.get(name) ?? []), entry]);
		}
		function call(args: unknown, signal: AbortSignal): Promise<unknown> {
			capture.guard();
			return entry.call(args, signal);
		}
		tools[entry.name] = Tool.make({
			description: entry.description,
			input: entry.input,
			output: entry.output ?? Schema.String,
			execute: (args) => Effect.tryPromise({ try: (signal) => call(args, signal), catch: (error) => error }),
		});
	}
	for (const [name, entries] of aliases) {
		if (entries.length === 1 && !names.has(name) && ![...names].some((path) => path.startsWith(`${name}.`)))
			tools[name] = tools[entries[0].name];
	}
	const namespaces: NativeTools = { ...tools };
	for (const name of names) {
		const prefix = name.split(".")[0];
		if (!name.includes(".") || names.has(prefix) || prefix in tools) continue;
		const members: Record<string, Tool.Tool> = Object.create(null);
		for (const path of Object.keys(tools)) {
			if (!path.startsWith(`${prefix}.`)) continue;
			members[path.slice(prefix.length + 1)] = tools[path];
			delete namespaces[path];
		}
		namespaces[prefix] = Namespace.make({ description: `Tools in ${prefix}`, tools: members });
	}
	for (const entry of entries) {
		if (!entry.namespace) continue;
		const [root, child] = entry.namespace.path.split(".");
		const group = namespaces[root];
		if (!group || Tool.isTool(group) || !Namespace.isNamespace(group) || !child) continue;
		const members = { ...group.tools };
		const selected: Record<string, Tool.Tool> = Object.create(null);
		for (const [path, tool] of Object.entries(members)) {
			if (!path.startsWith(`${child}.`) || !Tool.isTool(tool)) continue;
			selected[path.slice(child.length + 1)] = tool;
			delete members[path];
		}
		if (Object.keys(selected).length) {
			members[child] = Namespace.make({ description: entry.namespace.description, tools: selected });
			namespaces[root] = Namespace.make({ description: group.description, tools: members });
		}
	}
	return namespaces;
}
function userDiagnostic(diagnostic: CodeMode.Diagnostic): CodeMode.Diagnostic {
	const location = diagnostic.location;
	if (location) {
		const userLine = Math.max(1, location.line - 1);
		const suffix = `(line ${location.line}, col ${location.column})`;
		const message = diagnostic.message.endsWith(suffix)
			? `${diagnostic.message.slice(0, -suffix.length)}(line ${userLine}, col ${location.column})`
			: diagnostic.message;
		return { ...diagnostic, message, location: { ...location, line: userLine } };
	}
	// Acorn's parse diagnostic contains its coordinate only in the final message suffix.
	if (diagnostic.kind !== "ParseError") return diagnostic;
	return {
		...diagnostic,
		message: diagnostic.message.replace(
			/\((\d+):(\d+)\)$/,
			(_all, line, col) => `(${Math.max(1, Number(line) - 1)}:${col})`,
		),
	};
}

export async function executeCodemodeRuntime(
	code: string,
	entries: readonly CodemodeRuntimeTool[],
	store: Record<string, unknown>,
	options: ParsedCodemodeSource["options"],
	signal?: AbortSignal,
): Promise<CodemodeRuntimeResult> {
	const capture = new Capture(store, signal);
	function hostConsole() {
		capture.guard();
		const log = capture.log.bind(capture);
		return { log, info: log, warn: log, error: log, debug: log, dir: log, table: log };
	}
	const tools = nativeTools(entries, capture);
	const runtime = CodeMode.make({
		tools,
		limits: { timeoutMs: options.timeoutMs, maxToolCalls: options.maxToolCalls },
		extensions: [
			Extension.make({
				name: "prime",
				globals: {
					text: capture.text.bind(capture),
					image: capture.image.bind(capture),
					store: capture.store.bind(capture),
					load: capture.load.bind(capture),
					exit: capture.exit.bind(capture),
					hostConsole,
					describeTool,
					toolExpression: describeExpression,
					searchSignature: describeSearch,
				},
			}),
		],
		hooks: {
			"extension.before": (call) => (call.name === "exit" && capture.exited ? Effect.interrupt : Effect.void),
			"tool.before": (call) => Effect.sync(() => capture.admit(call)),
		},
	});
	const catalog = runtime.catalog.map((tool) => ({ name: tool.path, description: tool.signature }));
	function describeTool(name: unknown): string | undefined {
		capture.guard();
		if (typeof name !== "string") throw new TypeError("describeTool() expects a tool name");
		return runtime.catalog.find((tool) => tool.path === name)?.signature;
	}
	function describeExpression(path: unknown): string {
		capture.guard();
		if (typeof path !== "string") throw new TypeError("toolExpression() expects a tool path");
		return toolExpression(path);
	}
	function describeSearch(): string {
		capture.guard();
		return searchSignature;
	}
	const prelude = `const console = hostConsole(); const ALL_TOOLS = ${JSON.stringify(catalog)};\n`;
	let native: CodeMode.Result | undefined;
	let deliberateExit = false;
	let error: string | undefined;
	try {
		const ended = await Effect.runPromiseExit(runtime.execute(prelude + code), { signal });
		native = Exit.isSuccess(ended) ? ended.value : undefined;
		deliberateExit =
			capture.exited && !signal?.aborted && Exit.isFailure(ended) && Cause.hasInterruptsOnly(ended.cause);
		if (Exit.isFailure(ended) && !deliberateExit)
			error = signal?.aborted ? "Script aborted: Execution aborted" : Cause.pretty(ended.cause);
	} finally {
		// Guard returned console methods and helpers even if a host promise settles late.
		if (!deliberateExit && native?.ok && native.value !== null && !signal?.aborted && !capture.failure) {
			try {
				capture.text(native.value);
			} catch (failure) {
				error = failure instanceof Error ? failure.message : String(failure);
			}
		}
		capture.finish();
	}
	const diagnostics = native ? (native.ok ? (native.warnings ?? []) : [native.error]).map(userDiagnostic) : [];
	const timeout = diagnostics.some((diagnostic) => diagnostic.kind === "TimeoutExceeded");
	const ok = !signal?.aborted && !capture.failure && !error && !timeout && (deliberateExit || native?.ok === true);
	if (capture.failure) error = capture.failure.message;
	else if (timeout)
		error = `Script timeout: ${diagnostics.find((diagnostic) => diagnostic.kind === "TimeoutExceeded")!.message}`;
	else if (native && !native.ok) error = `${diagnostics[0].kind}: ${diagnostics[0].message}`;
	else if (signal?.aborted) error = "Script aborted: Execution aborted";
	return {
		ok,
		output: capture.output,
		storeWrites: capture.delta(),
		diagnostics,
		toolCalls: capture.toolCalls,
		error,
	};
}
