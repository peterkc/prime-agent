// Adapted from rynfar/meridian src/proxy/server.ts at commit 510da1d9 (MIT, per its README)
/*
 * MIT License
 *
 * Copyright (c) 2026 Trevor Walker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import type { Options, SDKMessage, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	classifyStreamFailure,
	createAssistantMessageEventStream,
	formatStreamFailureMessage,
	type Model,
	recordStreamFailure,
	registerSessionResourceCleanup,
	type SimpleStreamOptions,
	StreamFailureError,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { comparePackageVersions } from "../../../utils/version-check.js";
import type { ExtensionFactory } from "../types.js";
import { readClaudeSettings } from "./claude-agent-sdk-config.js";

type Query = (args: {
	options: Options;
	prompt: AsyncIterable<SDKUserMessage>;
}) => AsyncIterable<SDKMessage> & { initializationResult(): Promise<{ claude_code_version?: string }>; close?(): void };
const defaultQuery: Query = (args) => {
	// FR-1: load only on the first turn; Bun's bundler needs a literal require.
	const sdk: { query: typeof sdkQuery } =
		typeof require === "function"
			? require("@anthropic-ai/claude-agent-sdk")
			: createRequire(import.meta.url)("@anthropic-ai/claude-agent-sdk");
	return sdk.query(args);
};
const sessions = new Map<string, { provider: ClaudeSdkProvider; running: Set<AbortController> }>();

function closeSession(id: string) {
	const entry = sessions.get(id);
	if (!entry) return;
	for (const controller of entry.running) controller.abort();
	sessions.delete(id);
}
registerSessionResourceCleanup((id) => {
	if (id !== undefined) closeSession(id);
	else for (const key of sessions.keys()) closeSession(key);
});

function childEnv() {
	const env: Record<string, string | undefined> = { DISABLE_AUTO_COMPACT: "1" };
	for (const key of Object.keys(process.env))
		if (
			/^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_.*|TZ|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CLAUDE_CONFIG_DIR)$/.test(
				key,
			)
		)
			env[key] = process.env[key];
	return env;
}
function executable(configured?: string) {
	const candidates = configured
		? [configured]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((p) => resolve(p, "claude"));
	for (const path of candidates) {
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile()) return path;
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw new StreamFailureError("Cannot find the claude executable. Check PATH or the claudePath setting.", {
		kind: "invalid_request",
	});
}
function primeServer(tools: Context["tools"]) {
	const server = new McpServer({ name: "prime", version: "1" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: (tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters,
			_meta: { "anthropic/alwaysLoad": true },
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, () => ({
		isError: true,
		content: [{ type: "text", text: "Only Prime executes tools." }],
	}));
	return server;
}
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
function historyHash(model: Model<string>, context: Context, messages: Context["messages"]) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				model.provider,
				model.api,
				model.id,
				context.systemPrompt ?? "",
				(context.tools ?? []).map((t) => [t.name, t.description, t.parameters]),
				messages.map((m) =>
					m.role === "toolResult" ? [m.role, m.toolCallId, m.toolName, m.isError, m.content] : [m.role, m.content],
				),
			]),
		)
		.digest("hex");
}
function resumePoint(model: Model<string>, context: Context) {
	let index = context.messages.length - 1;
	while (index >= 0 && context.messages[index].role !== "assistant") index--;
	const m = context.messages[index];
	if (
		m?.role !== "assistant" ||
		m.provider !== model.provider ||
		m.api !== model.api ||
		m.model !== model.id ||
		!["stop", "length", "toolUse"].includes(m.stopReason)
	)
		return;
	if (typeof m.responseId !== "string") return;
	const calls = m.content.filter((block) => block.type === "toolCall");
	let matched = 0;
	for (const tail of context.messages.slice(index + 1)) {
		if (tail.role === "user") continue;
		if (tail.role !== "toolResult" || tail.toolCallId !== calls[matched++]?.id) return;
	}
	if (matched !== calls.length) return;
	const parts = m.responseId.split(".");
	if (
		parts.length === 3 &&
		uuid.test(parts[0]) &&
		uuid.test(parts[1]) &&
		parts[2] === historyHash(model, context, context.messages.slice(0, index + 1))
	)
		return { resume: parts[0], resumeSessionAt: parts[1], index };
}
type Block = Exclude<SDKUserMessage["message"]["content"], string>[number];
function imageBlock(part: { mimeType: string; data: string }) {
	const media = part.mimeType;
	if (media !== "image/png" && media !== "image/jpeg" && media !== "image/gif" && media !== "image/webp")
		throw new StreamFailureError(`Unsupported image type ${media}`, { kind: "invalid_request" });
	return { type: "image", source: { type: "base64", media_type: media, data: part.data } } as const;
}
function promptFor(messages: Context["messages"], resumed: boolean): SDKUserMessage {
	const content: Block[] = [];
	for (const msg of messages) {
		if (resumed && msg.role === "toolResult") {
			content.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				is_error: msg.isError,
				content: msg.content.map((p) => (p.type === "image" ? imageBlock(p) : { type: "text", text: p.text })),
			});
			continue;
		}
		if (!resumed && messages.length > 1)
			content.push({
				type: "text",
				text: msg.role === "toolResult" ? `Tool result ${msg.toolName} (${msg.toolCallId}):` : `${msg.role}:`,
			});
		if (typeof msg.content === "string") content.push({ type: "text", text: msg.content });
		else
			for (const part of msg.content) {
				if (part.type === "text") content.push({ type: "text", text: part.text });
				else if (part.type === "image") content.push(imageBlock(part));
				else if (part.type === "toolCall") content.push({ type: "text", text: JSON.stringify(part) });
			}
	}
	return { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}

export class ClaudeSdkProvider {
	constructor(
		private readonly agentDir: string,
		private readonly query: Query = defaultQuery,
	) {}
	extension: ExtensionFactory = (pi) => {
		let missingAuthMessage = "";
		try {
			const settings = readClaudeSettings(this.agentDir);
			if (!settings.enabled) return;
			executable(settings.claudePath);
		} catch (error) {
			missingAuthMessage = error instanceof Error ? error.message : String(error);
		}
		pi.registerProvider("claude-sdk", {
			api: "claude-agent-sdk",
			modelsFrom: "anthropic",
			baseUrl: "https://claude-sdk.invalid",
			// An empty value clears the previous registration; undefined would preserve it.
			apiKey: missingAuthMessage ? "" : "local-claude",
			missingAuthMessage,
			streamSimple: (model, context, options) => {
				let session = options?.sessionId ? sessions.get(options.sessionId) : undefined;
				if (!options?.sessionId) {
					// A late registry refresh can reinstall a handler after its session was disposed.
					for (const live of sessions.values()) {
						session = live;
						if (live.provider === this) break;
					}
				}
				if (!session) throw new StreamFailureError("No live claude-sdk session.", { kind: "invalid_request" });
				return session.provider.streamSimple(model, context, options, session.running);
			},
		});
		pi.on("session_start", (_event, ctx) => {
			sessions.set(ctx.sessionManager.getSessionId(), { provider: this, running: new Set() });
		});
		pi.on("session_shutdown", (event, ctx) => {
			if (event.reason === "reload") pi.unregisterProvider("claude-sdk");
			const id = ctx.sessionManager.getSessionId();
			if (sessions.get(id)?.provider === this) closeSession(id);
		});
	};
	streamSimple = (
		model: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
		running?: Set<AbortController>,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		void this.run(stream, model, context, options, running);
		return stream;
	};
	private async run(
		stream: AssistantMessageEventStream,
		model: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
		running?: Set<AbortController>,
	) {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const ctrl = new AbortController(),
			abort = () => ctrl.abort();
		const indices = new Map<number, number>();
		const captured = new Map<string, ToolCall>();
		const toolOrder = new Map<string, number>();
		let hold: Promise<void> | undefined;
		let releaseHold: (() => void) | undefined;
		const release = () => {
			releaseHold?.();
			hold = undefined;
			releaseHold = undefined;
		};
		running?.add(ctrl);
		options?.signal?.addEventListener("abort", abort, { once: true });
		ctrl.signal.addEventListener("abort", release, { once: true });
		let server: McpServer | undefined;
		try {
			if (options?.signal?.aborted) ctrl.abort();
			ctrl.signal.throwIfAborted();
			const path = executable(readClaudeSettings(this.agentDir).claudePath);
			let point = resumePoint(model, context);
			stream.push({ type: "start", partial: msg });
			for (;;) {
				ctrl.signal.throwIfAborted();
				server = primeServer(context.tools);
				const level = options?.reasoning;
				const attempt = new AbortController(),
					abortAttempt = () => attempt.abort();
				const sdkOptions: Options = {
					...(point ? { resume: point.resume, resumeSessionAt: point.resumeSessionAt, forkSession: true } : {}),
					pathToClaudeCodeExecutable: path,
					model: model.id,
					effort: level === "minimal" ? "low" : level === "off" ? undefined : level,
					thinking: level === "off" ? { type: "disabled" } : undefined,
					systemPrompt: context.systemPrompt ?? "",
					tools: [],
					settingSources: [],
					strictMcpConfig: true,
					settings: { disableClaudeAiConnectors: true },
					verbatimPrompts: true,
					maxTurns: 1,
					includePartialMessages: true,
					env: childEnv(),
					abortController: attempt,
					mcpServers: { prime: { type: "sdk", name: "prime", instance: server } },
					hooks: {
						PreToolUse: [
							{
								hooks: [
									async (input, id) => {
										if (
											input.hook_event_name === "PreToolUse" &&
											id &&
											input.tool_name.startsWith("mcp__prime__") &&
											input.tool_input !== null &&
											typeof input.tool_input === "object" &&
											!Array.isArray(input.tool_input)
										)
											captured.set(id, {
												type: "toolCall",
												id,
												name: input.tool_name.slice("mcp__prime__".length),
												arguments: input.tool_input as Record<string, unknown>,
											});
										// An early denial cancels generation of later parallel calls. Release at the raw message boundary, not at an assistant block.
										await hold;
										return {
											hookSpecificOutput: {
												hookEventName: "PreToolUse",
												permissionDecision: "deny",
												permissionDecisionReason: "Prime runs tools after the turn.",
											},
										};
									},
								],
							},
						],
					},
				};
				let sessionId: string | undefined, assistantUuid: string | undefined;
				let limitAfterTools = false,
					completed = false;
				let query: ReturnType<Query> | undefined;
				let allowPrompt!: (allowed: boolean) => void;
				const versionAccepted = new Promise<boolean>((resolve) => {
					allowPrompt = resolve;
				});
				ctrl.signal.addEventListener("abort", abortAttempt, { once: true });
				try {
					const prompt = promptFor(point ? context.messages.slice(point.index + 1) : context.messages, !!point);
					query = this.query({
						prompt: (async function* () {
							if (await versionAccepted) yield prompt;
						})(),
						options: sdkOptions,
					});
					let version: string | undefined;
					try {
						version = (await query.initializationResult()).claude_code_version;
					} catch (error) {
						allowPrompt(false);
						ctrl.signal.throwIfAborted();
						// The CLI can emit a startup failure result before the SDK rejects its control response.
						for await (const m of query) {
							if (m.type === "result" && m.subtype !== "success" && m.errors.length)
								throw Error(m.errors.join("; "));
						}
						throw error;
					}
					if ((comparePackageVersions(version ?? "", "2.1.248") ?? -1) < 0)
						throw new StreamFailureError(
							`Claude Code 2.1.248 or later is required for verbatim prompts (${version ? `reported: ${version}` : "Prime cannot confirm the version"})`,
							{ kind: "invalid_request" },
						);
					ctrl.signal.throwIfAborted();
					allowPrompt(true);
					for await (const m of query) {
						ctrl.signal.throwIfAborted();
						if (m.type === "assistant" && m.supersedes?.length) {
							// Stream deltas and hooks do not identify their owning assistant UUID.
							msg.content = [];
							throw Error("Claude superseded earlier output; discarding this turn");
						}
						if (m.type === "assistant" && m.error) {
							const error = m.error;
							// Claude owns login. Prime's one auth retry cannot refresh it.
							const kind = [
								"authentication_failed",
								"oauth_org_not_allowed",
								"account_on_hold",
								"verification_required",
								"billing_error",
							].includes(error)
								? "permission"
								: error === "model_not_found"
									? "invalid_request"
									: classifyStreamFailure(error);
							throw new StreamFailureError(
								error === "authentication_failed"
									? "Claude is not logged in. Run claude auth login."
									: formatStreamFailureMessage(Error(error)),
								{ kind, providerErrorType: error },
							);
						}
						if (m.type === "assistant" && !m.parent_tool_use_id) {
							sessionId = m.session_id;
							assistantUuid = m.uuid;
						}
						if (m.type === "result") {
							release();
							if (m.subtype === "error_max_turns" && captured.size) {
								limitAfterTools = true;
							} else if (m.subtype !== "success" || m.is_error) {
								throw Error(m.subtype === "success" ? m.result : m.errors.join("; ") || m.subtype);
							}
							if (m.stop_reason === "max_tokens") msg.stopReason = "length";
							completed = true;
							continue;
						}
						if (m.type !== "stream_event") continue;
						const ev = m.event;
						const usage =
							ev.type === "message_start"
								? ev.message?.usage
								: ev.type === "message_delta"
									? ev.usage
									: undefined;
						if (usage) {
							msg.usage.input = usage.input_tokens ?? msg.usage.input;
							msg.usage.output = usage.output_tokens ?? msg.usage.output;
							msg.usage.cacheRead = usage.cache_read_input_tokens ?? msg.usage.cacheRead;
							msg.usage.cacheWrite = usage.cache_creation_input_tokens ?? msg.usage.cacheWrite;
							msg.usage.totalTokens =
								msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
							calculateCost(model, msg.usage);
						}

						if (ev.type === "message_start") {
							release();
							hold = new Promise<void>((resolve) => {
								releaseHold = resolve;
							});
							continue;
						}
						if (ev.type === "message_stop" || ev.type === "message_delta") {
							release();
							if (ev.type === "message_delta" && ev.delta.stop_reason === "max_tokens")
								msg.stopReason = "length";
							continue;
						}
						if (ev.type === "content_block_start") {
							const b = ev.content_block;
							const index = msg.content.length;
							if (b.type === "text" || b.type === "thinking") {
								indices.set(ev.index, index);
								if (b.type === "text") {
									msg.content.push({ type: "text", text: b.text });
									stream.push({ type: "text_start", contentIndex: index, partial: msg });
								} else {
									msg.content.push({ type: "thinking", thinking: b.thinking });
									stream.push({ type: "thinking_start", contentIndex: index, partial: msg });
								}
							} else if (b.type === "tool_use") toolOrder.set(b.id, ev.index);
							continue;
						}
						if (ev.type !== "content_block_delta" && ev.type !== "content_block_stop") continue;
						const index = indices.get(ev.index);
						if (index === undefined) continue;
						const b = msg.content[index];
						if (ev.type === "content_block_stop") {
							indices.delete(ev.index);
							if (b.type === "text")
								stream.push({ type: "text_end", contentIndex: index, content: b.text, partial: msg });
							else if (b.type === "thinking")
								stream.push({ type: "thinking_end", contentIndex: index, content: b.thinking, partial: msg });
							continue;
						}
						if (ev.delta.type === "text_delta" && b.type === "text") {
							b.text += ev.delta.text;
							stream.push({ type: "text_delta", contentIndex: index, delta: ev.delta.text, partial: msg });
						} else if (ev.delta.type === "thinking_delta" && b.type === "thinking") {
							b.thinking += ev.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: ev.delta.thinking,
								partial: msg,
							});
						}
					}
				} catch (error) {
					allowPrompt(false);
					query?.close?.();
					if (
						point &&
						!ctrl.signal.aborted &&
						!captured.size &&
						!msg.content.length &&
						/^(?:No conversation found with session ID|No message found with message\.uuid of)\b/.test(
							error instanceof Error ? error.message : String(error),
						)
					) {
						release();
						await server.close();
						point = undefined;
						toolOrder.clear();
						msg.diagnostics = [{ type: "claude_sdk_resume_fallback", timestamp: Date.now() }];
						continue;
					}
					if (!limitAfterTools) throw error;
				} finally {
					ctrl.signal.removeEventListener("abort", abortAttempt);
				}
				ctrl.signal.throwIfAborted();
				if (!completed) throw Error("Claude query ended without a result");
				if ([...toolOrder.keys()].some((id) => !captured.has(id)))
					throw Error("Claude rejected a tool call before Prime could capture it");
				for (const call of [...captured.values()].sort(
					(a, b) => (toolOrder.get(a.id) ?? Infinity) - (toolOrder.get(b.id) ?? Infinity),
				)) {
					const contentIndex = msg.content.length;
					msg.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex, partial: msg });
					stream.push({ type: "toolcall_end", toolCall: call, contentIndex, partial: msg });
					msg.stopReason = "toolUse";
				}
				if (sessionId && assistantUuid && uuid.test(sessionId) && uuid.test(assistantUuid))
					msg.responseId = `${sessionId}.${assistantUuid}.${historyHash(model, context, [...context.messages, msg])}`;
				stream.push({
					type: "done",
					reason: captured.size ? "toolUse" : msg.stopReason === "length" ? "length" : "stop",
					message: msg,
				});
				break;
			}
		} catch (error) {
			msg.stopReason = ctrl.signal.aborted ? "aborted" : "error";
			msg.errorMessage = formatStreamFailureMessage(error);
			recordStreamFailure(model, msg, error);
			stream.push({ type: "error", reason: msg.stopReason, error: msg });
		} finally {
			release();
			running?.delete(ctrl);
			options?.signal?.removeEventListener("abort", abort);
			ctrl.signal.removeEventListener("abort", release);
			stream.end();
			await server?.close();
		}
	}
}
