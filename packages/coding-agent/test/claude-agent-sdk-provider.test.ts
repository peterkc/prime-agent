import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type AssistantMessageEvent,
	type Context,
	calculateCost,
	getApiProvider,
	isContextOverflow,
	type Model,
	resetApiProviders,
} from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ClaudeSdkProvider } from "../src/core/extensions/builtin/claude-agent-sdk.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resolveCliModel } from "../src/core/model-resolver.js";
import { providerStreamFailureDetails } from "../src/core/provider-retry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createHarness } from "./suite/harness.js";
import { createDeferred } from "./suite/scheduling.js";

const model: Model<string> = {
	id: "fixture",
	name: "fixture",
	provider: "claude-sdk",
	api: "claude-agent-sdk",
	baseUrl: "https://example.invalid",
	contextWindow: 20000,
	maxTokens: 1000,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 4 },
};
const context: Context = {
	systemPrompt: "Prime instructions",
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};
const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };
const result = (stop_reason = "end_turn") => ({
	type: "result",
	subtype: "success",
	is_error: false,
	usage,
	stop_reason,
});
const raw = (type: string, fields: Record<string, unknown> = {}) => ({
	type: "stream_event",
	event: { type, ...fields },
});
function* textTurn(stop: string) {
	yield raw("message_start", { message: { usage: { ...usage, output_tokens: 1 } } });
	for (const [index, type, field, value] of [
		[0, "thinking", "thinking", "hmm"],
		[1, "text", "text", "yes"],
	] as const) {
		yield raw("content_block_start", { index, content_block: { type, [field]: "" } });
		yield raw("content_block_delta", { index, delta: { type: `${type}_delta`, [field]: value } });
		yield raw("content_block_stop", { index });
	}
	yield raw("message_delta", { delta: { stop_reason: stop }, usage });
	yield raw("message_stop");
	// Result usage is session-wide, not a single assistant turn.
	yield { ...result(stop), usage: { ...usage, input_tokens: 999 } };
}
type Args = { options: Options; prompt: AsyncIterable<SDKUserMessage> };
type Fake = (args: Args) => AsyncIterable<unknown>;
function fixture(
	query: Fake,
	initializationResult: () => Promise<{ claude_code_version?: string }> = async () => ({
		claude_code_version: "2.1.248",
	}),
) {
	const dir = mkdtempSync(join(getAgentDir(), "instance-"));
	const path = join(dir, "claude");
	writeFileSync(path, "fixture", { mode: 0o700 });
	chmodSync(path, 0o700);
	writeFileSync(join(dir, "claude-sdk.json"), JSON.stringify({ enabled: true, claudePath: path }));
	return {
		dir,
		path,
		provider: new ClaudeSdkProvider(dir, (args) =>
			Object.assign(query(args) as AsyncIterable<SDKMessage>, { initializationResult }),
		),
	};
}
beforeEach(() => {
	resetApiProviders();
	vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
it.each([
	["end_turn", "stop"],
	["max_tokens", "length"],
])("streams %s with catalog cost", async (stop, reason) => {
	let options: Options | undefined;
	const f = fixture(async function* (args) {
		options = args.options;
		yield* textTurn(stop);
	});
	const stream = f.provider.streamSimple(model, context, { reasoning: "high" });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "text_delta", delta: "yes" }),
			expect.objectContaining({ type: "thinking_delta", delta: "hmm" }),
		]),
	);
	expect(events.at(-1)?.type).toBe("done");
	expect(message.stopReason).toBe(reason);
	expect(message.usage).toMatchObject({ input: 11, output: 7, cacheRead: 5, cacheWrite: 3, totalTokens: 26 });
	expect(message.usage.cost.total).toBeGreaterThan(0);
	expect(message.usage.cost).toEqual(
		calculateCost(model, { ...message.usage, cost: { ...message.usage.cost, total: 0 } }),
	);
	expect(options).toMatchObject({
		pathToClaudeCodeExecutable: f.path,
		model: model.id,
		effort: "high",
		systemPrompt: context.systemPrompt,
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		settings: { disableClaudeAiConnectors: true },
		verbatimPrompts: true,
		maxTurns: 1,
	});
});
it.each([undefined])("disables thinking when reasoning is %s", async (reasoning) => {
	let thinking: Options["thinking"];
	const f = fixture(async function* ({ options }) {
		thinking = options.thinking;
		yield* textTurn("end_turn");
	});
	await f.provider.streamSimple(model, context, { reasoning, maxTokens: 64 }).result();
	expect(thinking).toEqual({ type: "disabled" });
});
const tools = [
	{ name: "one", description: "first", parameters: Type.Object({ nested: Type.Object({ count: Type.Number() }) }) },
	{ name: "two", description: "second", parameters: Type.Object({}) },
];
it.each(["tool list"])("preserves the MCP %s and refuses direct calls", async () => {
	const f = fixture(async function* ({ options }) {
		const server = options.mcpServers?.prime;
		if (server?.type !== "sdk") throw Error("missing server");
		const client = new Client({ name: "fixture", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.instance.connect(a);
		try {
			await client.connect(b);
			expect((await client.listTools()).tools).toEqual(
				tools.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.parameters,
					_meta: { "anthropic/alwaysLoad": true },
				})),
			);
			expect((await client.callTool({ name: "one", arguments: { nested: { count: 1 } } })).isError).toBe(true);
		} finally {
			await client.close();
			await server.instance.close();
		}
		yield* textTurn("end_turn");
	});
	expect((await f.provider.streamSimple(model, { ...context, tools }).result()).stopReason).toBe("stop");
});
it.each(["two calls", "two calls with max_tokens", "no calls", "cancel"])(
	"handles held denials: %s",
	async (scenario) => {
		const controller = new AbortController();
		let querySignal: AbortSignal | undefined;
		const order: string[] = [];
		const f = fixture(async function* ({ options }) {
			yield raw("message_start");
			const hook = options.hooks?.PreToolUse?.[0].hooks[0];
			if (!hook) throw Error("missing hook");
			const denials: Promise<unknown>[] = [];
			if (scenario !== "no calls")
				for (const [index, t] of tools.entries()) {
					const id = `call-${index}`,
						name = `mcp__prime__${t.name}`,
						input = { n: index };
					yield raw("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } });
					yield raw("content_block_stop", { index });
					const promise = hook(
						{ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id } as HookInput,
						id,
						{ signal: controller.signal },
					);
					denials.push(
						promise.then((response) => {
							expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
							order.push(id);
						}),
					);
				}
			await Promise.resolve();
			order.push("boundary");
			if (scenario === "cancel") {
				controller.abort();
				querySignal = options.abortController?.signal;
			} else yield raw("message_delta", { delta: { stop_reason: "tool_use" }, usage });
			await Promise.all(denials);
			yield {
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				errors: [],
				stop_reason: scenario === "two calls with max_tokens" ? "max_tokens" : null,
			};
			throw Error("SDK exited after one turn");
		});
		const msg = await f.provider.streamSimple(model, { ...context, tools }, { signal: controller.signal }).result();
		expect(msg.stopReason).toBe(
			scenario === "cancel" ? "aborted" : scenario.startsWith("two calls") ? "toolUse" : "error",
		);
		if (scenario === "cancel") expect(querySignal?.aborted).toBe(true);
		if (scenario !== "no calls") expect(order).toEqual(["boundary", "call-0", "call-1"]);
		if (scenario.startsWith("two calls"))
			expect(msg.content.filter((b) => b.type === "toolCall")).toEqual(
				tools.map((t, n) => ({ type: "toolCall", id: `call-${n}`, name: t.name, arguments: { n } })),
			);
	},
);
it.each(["missing binary", "missing login", "superseded output", "execution error with max_tokens"])(
	"fails visibly: %s",
	async (scenario) => {
		let calls = 0;
		const f = fixture(async function* () {
			calls++;
			if (scenario === "superseded output") {
				yield raw("content_block_start", { index: 0, content_block: { type: "text", text: "retracted" } });
				yield { type: "assistant", uuid: checkpointAt };
				yield { type: "assistant", uuid: forkedSession, supersedes: [checkpointAt] };
				yield result();
				return;
			}
			if (scenario === "execution error with max_tokens") {
				yield {
					type: "result",
					subtype: "error_during_execution",
					is_error: true,
					errors: ["execution failed"],
					stop_reason: "max_tokens",
				};
				return;
			}
			yield { type: "assistant", error: "authentication_failed", message: { content: [] } };
		});
		if (scenario === "missing binary") {
			writeFileSync(join(f.dir, "claude-sdk.json"), JSON.stringify({ enabled: true }));
			vi.stubEnv("PATH", join(f.dir, "empty"));
		}
		const msg = await f.provider.streamSimple(model, context).result();
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toMatch(
			scenario === "missing binary"
				? /PATH.*claudePath|claudePath.*PATH/
				: scenario === "missing login"
					? /claude auth login/
					: scenario === "superseded output"
						? /superseded/i
						: /execution failed/,
		);
		if (scenario === "missing binary") expect(providerStreamFailureDetails(msg)?.kind).toBe("invalid_request");
		if (scenario === "missing login")
			expect(providerStreamFailureDetails(msg)).toMatchObject({
				kind: "permission",
				providerErrorType: "authentication_failed",
			});
		expect(calls).toBe(scenario === "missing binary" ? 0 : 1);
		expect(msg.content).toEqual([]);
	},
);
it.each([
	["oauth_org_not_allowed", "permission"],
	["account_on_hold", "permission"],
	["verification_required", "permission"],
	["billing_error", "permission"],
	["invalid_request", "invalid_request"],
	["model_not_found", "invalid_request"],
	["rate_limit", "rate_limit"],
])("reports the SDK error %s as %s", async (error, kind) => {
	const f = fixture(async function* () {
		yield { type: "assistant", error, message: { content: [] } };
	});
	const msg = await f.provider.streamSimple(model, context).result();
	expect(providerStreamFailureDetails(msg)).toMatchObject({ kind, providerErrorType: error });
});
it.each([
	["model_not_found", ["This model is unavailable.", "Choose a different model."], false],
	["invalid_request", ["Prompt is too long"], true],
] as const)("preserves Claude Code error text for %s", async (error, text, overflow) => {
	const f = fixture(async function* () {
		yield { type: "assistant", error, message: { content: text.map((text) => ({ type: "text", text })) } };
	});
	const msg = await f.provider.streamSimple(model, context).result();
	expect(isContextOverflow(msg)).toBe(overflow);
	expect(msg.errorMessage).toBe(text.join("\n"));
	expect(providerStreamFailureDetails(msg)).toMatchObject({ kind: "invalid_request", providerErrorType: error });
});
it("refuses a turn after opt-out before /reload", async () => {
	const query = vi.fn(async function* () {
		yield result();
	});
	const f = fixture(query);
	vi.stubEnv("PATH", f.dir);
	const file = join(f.dir, "claude-sdk.json");
	writeFileSync(file, JSON.stringify({ enabled: false }));
	const msg = await f.provider.streamSimple(model, context).result();
	expect(msg.errorMessage).toBe(`claude-sdk is switched off in ${file}. Run /reload.`);
	expect(providerStreamFailureDetails(msg)?.kind).toBe("invalid_request");
	expect(query).not.toHaveBeenCalled();
});
it.each(["bad settings", "unsupported image"])("reports %s as invalid input", async (scenario) => {
	const f = fixture(async function* () {
		yield result();
	});
	const messages: Context["messages"] =
		scenario === "unsupported image"
			? [{ role: "user", content: [{ type: "image", mimeType: "image/svg+xml", data: "" }], timestamp: 0 }]
			: context.messages;
	if (scenario === "bad settings") writeFileSync(join(f.dir, "claude-sdk.json"), "{bad");
	const msg = await f.provider.streamSimple(model, { messages }).result();
	expect(msg.stopReason).toBe("error");
	expect(providerStreamFailureDetails(msg)?.kind).toBe("invalid_request");
});
it.each([
	["2.1.247", "reported: 2.1.247"],
	[undefined, "cannot confirm the version"],
] as const)("refuses CLI version %s without yielding a prompt", async (version, detail) => {
	let input: Promise<SDKUserMessage[]> | undefined;
	const f = fixture(
		({ prompt }) => {
			input = collectPrompt(prompt);
			return (async function* () {
				yield result();
			})();
		},
		async () => ({ claude_code_version: version }),
	);
	const msg = await f.provider.streamSimple(model, context).result();
	expect(await input).toEqual([]);
	expect(msg.stopReason).toBe("error");
	expect(msg.errorMessage).toContain("2.1.248");
	expect(msg.errorMessage).toContain(detail);
	expect(providerStreamFailureDetails(msg)?.kind).toBe("invalid_request");
});
const quietEnvironment = {
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	DISABLE_TELEMETRY: "1",
	DISABLE_ERROR_REPORTING: "1",
	DISABLE_FEEDBACK_COMMAND: "1",
	CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
	DISABLE_AUTOUPDATER: "1",
	CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
	CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
	ENABLE_CLAUDEAI_MCP_SERVERS: "false",
	CLAUDE_CODE_MAX_RETRIES: "0",
};
it.each(["allowlist"])("restricts the child environment by %s", async () => {
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_SESSION_ACCESS_TOKEN",
		"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_UNRELATED",
		"ANTHROPIC_UNRELATED",
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
		...Object.keys(quietEnvironment),
		"DISABLE_AUTO_COMPACT",
		"OTHER",
	])
		vi.stubEnv(key, "sentinel");
	vi.stubEnv("LC_FIXTURE", "kept");
	let env: Options["env"];
	const f = fixture(async function* ({ options }) {
		env = options.env;
		yield* textTurn("end_turn");
	});
	await f.provider.streamSimple(model, context, { maxTokens: 64 }).result();
	expect(env).toMatchObject({
		...quietEnvironment,
		CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64",
		LC_FIXTURE: "kept",
		DISABLE_AUTO_COMPACT: "1",
	});
	expect(
		Object.keys(env ?? {}).filter(
			(k) =>
				!Object.hasOwn(quietEnvironment, k) &&
				k !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS" &&
				!/^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_.*|TZ|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CLAUDE_CONFIG_DIR|DISABLE_AUTO_COMPACT)$/.test(
					k,
				),
		),
	).toEqual([]);
	expect(Object.values(env ?? {})).not.toContain("sentinel");
});
it.each(["images"])("retains user and tool-result %s", async () => {
	const blocks: unknown[] = [];
	const f = fixture(async function* ({ prompt }) {
		for await (const user of prompt) {
			if (Array.isArray(user.message.content)) blocks.push(...user.message.content);
		}
		yield* textTurn("end_turn");
	});
	const pic = (mimeType: string) => ({ type: "image" as const, mimeType, data: "YQ==" });
	await f.provider
		.streamSimple(model, {
			messages: [
				{ role: "user", content: [pic("image/png")], timestamp: 1 },
				{
					role: "toolResult",
					toolName: "one",
					toolCallId: "x",
					content: [pic("image/jpeg")],
					isError: false,
					timestamp: 2,
				},
			],
		})
		.result();
	expect(blocks.filter((b) => typeof b === "object" && b !== null && "type" in b && b.type === "image")).toEqual(
		["image/png", "image/jpeg"].map((media_type) => ({
			type: "image",
			source: { type: "base64", media_type, data: "YQ==" },
		})),
	);
});
it.each(["availability at registration"])("loads three source models only when builtins are enabled: %s", async () => {
	const dir = mkdtempSync(join(getAgentDir(), "path-"));
	vi.stubEnv("PATH", dir);
	for (const [enabled, installed] of [
		[true, false],
		[true, true],
		[false, true],
	]) {
		writeFileSync(join(dir, "claude-sdk.json"), JSON.stringify({ enabled: true }));
		if (installed) writeFileSync(join(dir, "claude"), "fixture", { mode: 0o700 });
		const authStorage = AuthStorage.inMemory(),
			modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider("anthropic", {
			...model,
			apiKey: "local",
			models: ["a", "b", "c"].map((id) => ({ ...model, id })),
		});
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ enableBuiltinExtensions: enabled }),
			telemetryDisabled: true,
		});
		try {
			expect(
				modelRegistry
					.getAll()
					.filter((m) => m.provider === "claude-sdk")
					.map((m) => [m.id, m.api]),
			).toEqual(enabled ? ["a", "b", "c"].map((id) => [id, "claude-agent-sdk"]) : []);
			expect(
				modelRegistry
					.getAvailable()
					.filter((m) => m.provider === "claude-sdk")
					.map((m) => m.id),
			).toEqual(enabled && installed ? ["a", "b", "c"] : []);
		} finally {
			services.mcpManager.dispose();
		}
	}
});
it.each([undefined, { enabled: false }, { enabled: false, claudePath: "bin/claude" }, { claudePath: "~/bin/claude" }])(
	"does not register a provider with settings %j even with claude on PATH",
	async (settings) => {
		const dir = mkdtempSync(join(getAgentDir(), "opt-in-"));
		vi.stubEnv("PATH", dir);
		writeFileSync(join(dir, "claude"), "fixture", { mode: 0o700 });
		if (settings) writeFileSync(join(dir, "claude-sdk.json"), JSON.stringify(settings));
		const authStorage = AuthStorage.inMemory(),
			modelRegistry = ModelRegistry.inMemory(authStorage);
		const cliModel = modelRegistry.getAll().find((m) => m.provider === "anthropic")!.id;
		const baseline = resolveCliModel({ cliModel, modelRegistry });
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			telemetryDisabled: true,
		});
		try {
			expect(modelRegistry.hasProvider("claude-sdk")).toBe(false);
			expect(modelRegistry.getAll().some((m) => m.provider === "claude-sdk")).toBe(false);
			expect(resolveCliModel({ cliModel, modelRegistry })).toEqual(baseline);
		} finally {
			services.mcpManager.dispose();
		}
	},
);
function clearProviderEnv() {
	for (const key of Object.keys(process.env)) {
		if (/(?:_API_KEY|_TOKEN)$/.test(key) || /^(?:AWS_|GOOGLE_CLOUD_|GCLOUD_)/.test(key)) vi.stubEnv(key, undefined);
	}
}
it.each(["restored", "default", "none", "compact", "restart after opt-out"])(
	"explains why there is no model (saved provider: %s)",
	async (source) => {
		clearProviderEnv();
		const dir = mkdtempSync(join(getAgentDir(), "no-model-"));
		writeFileSync(
			join(dir, "claude-sdk.json"),
			JSON.stringify({ enabled: source !== "restart after opt-out", claudePath: join(dir, "missing") }),
		);
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(
				source === "default" ? { defaultModel: "claude", defaultProvider: "claude-sdk" } : {},
			),
			telemetryDisabled: true,
		});
		const sessionManager = SessionManager.inMemory(dir);
		if (source !== "default" && source !== "none") sessionManager.appendModelChange("claude-sdk", "claude");
		const { session, modelFallbackMessage } = await createAgentSessionFromServices({
			services,
			sessionManager,
			telemetryDisabled: true,
		});
		try {
			if (source === "none") {
				await expect(session.prompt("test")).rejects.toThrow(
					/No API key found for the selected model\.[\s\S]*Use \/login/,
				);
				return;
			}
			if (source === "restart after opt-out") {
				expect(modelFallbackMessage).toBe(
					"Provider claude-sdk is not registered. Use /model to pick another model.",
				);
			} else {
				expect(modelFallbackMessage).toContain("Cannot find the claude executable");
			}
			expect(modelFallbackMessage).not.toMatch(/API key|\/login/i);
			expect(session.model?.provider).toBe("unknown");
			const request = source === "compact" ? session.compact() : session.prompt("test");
			await expect(request).rejects.not.toThrow(/API key|\/login/i);
			await expect(request).rejects.toEqual(Error(modelFallbackMessage));
		} finally {
			session.dispose();
			await session.modelRegistry.waitForPendingModelRefreshes(2_000);
		}
	},
);
it.each(["absent", "discovery down", "config only"])("reports the saved provider state: %s", async (state) => {
	clearProviderEnv();
	const dir = mkdtempSync(join(getAgentDir(), "absent-"));
	const provider = "custom-provider";
	if (state !== "absent") {
		const config = {
			baseUrl: "https://discovery.invalid",
			api: "openai-completions",
			discover: state === "discovery down" ? {} : undefined,
		};
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [provider]: config } }));
	}
	vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		authStorage: AuthStorage.inMemory(),
		telemetryDisabled: true,
		settingsManager: SettingsManager.inMemory({ defaultModel: "gone", defaultProvider: provider }),
	});
	const { session, modelFallbackMessage } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(dir),
		telemetryDisabled: true,
	});
	try {
		expect(session.modelRegistry.getAll().some((m) => m.provider === provider)).toBe(false);
		if (state === "absent") {
			expect(modelFallbackMessage).toBe(
				"Provider custom-provider is not registered. Use /model to pick another model.",
			);
		} else {
			expect.soft(modelFallbackMessage).toMatch(/^No models available\. Use \/login/);
			session.agent.state.model = { ...model, provider };
			await expect(session.prompt("test")).rejects.toThrow(/No API key found for custom-provider\./);
		}
	} finally {
		session.dispose();
		await session.modelRegistry.waitForPendingModelRefreshes(2_000);
	}
});
it.each(["prompt", "compact"])("removes the provider on /reload after opt-out: %s", async (operation) => {
	clearProviderEnv();
	const dir = mkdtempSync(join(getAgentDir(), "reload-"));
	const file = join(dir, "claude-sdk.json");
	const path = join(dir, "claude");
	writeFileSync(path, "fixture", { mode: 0o700 });
	writeFileSync(file, JSON.stringify({ enabled: true, claudePath: path }));
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		authStorage: AuthStorage.inMemory(),
		telemetryDisabled: true,
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(dir),
		telemetryDisabled: true,
	});
	try {
		const hasRows = () => session.modelRegistry.getAll().some((m) => m.provider === "claude-sdk");
		expect(hasRows()).toBe(true);
		await session.setModel(session.modelRegistry.getAvailable().find((m) => m.provider === "claude-sdk")!);
		writeFileSync(file, JSON.stringify({ enabled: false }));
		await session.reload();
		expect(hasRows()).toBe(false);
		const request = operation === "compact" ? session.compact() : session.prompt("test");
		await expect(request).rejects.not.toThrow(/API key|\/login/i);
		await expect(request).rejects.toEqual(
			Error("Provider claude-sdk is not registered. Use /model to pick another model."),
		);
	} finally {
		session.dispose();
		await session.modelRegistry.waitForPendingModelRefreshes(2_000);
	}
});
it.each([true, false])("R2-2 re-registers when claude was initially available=%s", async (initiallyAvailable) => {
	const dir = mkdtempSync(join(getAgentDir(), "reregister-"));
	const authStorage = AuthStorage.inMemory(),
		modelRegistry = ModelRegistry.inMemory(authStorage);
	const path = join(dir, "claude");
	writeFileSync(path, "fixture", { mode: 0o700 });
	for (const available of [initiallyAvailable, !initiallyAvailable]) {
		writeFileSync(
			join(dir, "claude-sdk.json"),
			JSON.stringify({ enabled: true, claudePath: available ? path : join(dir, "missing") }),
		);
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			telemetryDisabled: true,
		});
		try {
			expect(modelRegistry.getAvailable().some((m) => m.provider === "claude-sdk")).toBe(available);
			expect(modelRegistry.getProviderMissingAuthMessage("claude-sdk")).toEqual(
				available ? undefined : expect.stringContaining("claudePath"),
			);
		} finally {
			services.mcpManager.dispose();
		}
	}
});
it.each([
	['{"enabled":true}', /PATH.*claudePath/],
	['{"enabled":"false"}', /claude-sdk\.json: expected a boolean enabled/],
	["{", /Cannot read .*claude-sdk\.json/],
] as const)("R2-2 reports the registration failure for settings %s", async (settings, cause) => {
	const dir = mkdtempSync(join(getAgentDir(), "unavailable-"));
	// Use the PATH from setup-env: registration must not discover the host’s claude.
	writeFileSync(join(dir, "claude-sdk.json"), settings);
	const h = await createHarness({ extensionFactories: [new ClaudeSdkProvider(dir).extension] });
	try {
		await h.session.bindExtensions({});
		const selected = h.session.modelRegistry.getAll().find((m) => m.provider === "claude-sdk")!;
		await expect(h.session.setModel(selected)).rejects.toThrow(cause);
		h.session.agent.state.model = selected;
		await expect(h.session.prompt("test")).rejects.toThrow(cause);
	} finally {
		h.cleanup();
	}
});
it.each(["transient"])("AgentSession retries a late %s failure", async () => {
	let calls = 0;
	const f = fixture(async function* () {
		calls++;
		if (calls === 1) {
			yield raw("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			yield raw("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } });
			throw Error("temporary failure");
		}
		yield* textTurn("end_turn");
	});
	const h = await createHarness({
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		extensionFactories: [f.provider.extension],
	});
	try {
		await h.session.bindExtensions({});
		const selected = h.session.modelRegistry.getAll().find((m) => m.provider === "claude-sdk");
		if (!selected) throw Error("no claude-sdk model");
		await h.session.setModel(selected);
		await h.session.prompt("test");
		expect(h.eventsOfType("auto_retry_end")).toEqual([expect.objectContaining({ success: true })]);
		expect(calls).toBe(2);
	} finally {
		h.cleanup();
	}
});

it.each(["unbound after inline child disposal", "bound after an in-memory fork"])(
	"routes a turn with an unknown session ID: %s",
	async (scenario) => {
		const f = fixture(async function* () {
			yield* textTurn("end_turn");
		});
		const h = await createHarness({ extensionFactories: [f.provider.extension] });
		try {
			const handler = getApiProvider(model.api)!.streamSimple;
			if (scenario === "unbound after inline child disposal") {
				const turn = () => handler(model, context, { sessionId: h.session.sessionId }).result();
				expect((await turn()).stopReason).toBe("stop");
				// Inline children share their parent's resource loader and extension runtime.
				const child = await createHarness({ resourceLoader: h.session.resourceLoader });
				child.cleanup();
				expect((await turn()).stopReason).toBe("stop");
			} else {
				await h.session.bindExtensions({});
				h.session.sessionManager.newSession();
				await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "fork" });
				await h.session.bindExtensions({});
				expect((await handler(model, context, { sessionId: "inline-child" }).result()).stopReason).toBe("stop");
			}
		} finally {
			h.cleanup();
		}
	},
);
it.each(["sessions"])("isolates %s under the last handler, including compaction", async () => {
	const release = createDeferred();
	const paths: string[] = [];
	let hold = false;
	const generate: Fake = ({ options }) => {
		paths.push(String(options.pathToClaudeCodeExecutable));
		return (async function* () {
			if (hold) await release.promise;
			yield* textTurn("end_turn");
		})();
	};
	const a = fixture(generate),
		b = fixture(generate);
	const ha = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [a.provider.extension],
	});
	const hb = await createHarness({ extensionFactories: [b.provider.extension] });
	try {
		// createHarness does not set Agent.sessionId; createAgentSession in sdk.ts does.
		ha.session.agent.sessionId = ha.session.sessionId;
		hb.session.agent.sessionId = hb.session.sessionId;
		await ha.session.bindExtensions({});
		await hb.session.bindExtensions({});
		const selected = ha.session.modelRegistry.getAll().find((m) => m.provider === "claude-sdk");
		if (!selected) throw Error("missing model");
		await ha.session.setModel(selected);
		await ha.session.prompt("first");
		await ha.session.prompt("second");
		await ha.session.compact();
		expect(paths.length).toBeGreaterThan(2);
		expect(new Set(paths)).toEqual(new Set([a.path]));
		const handler = getApiProvider(model.api)!.streamSimple;
		await handler(model, context, { sessionId: hb.session.sessionId }).result();
		await handler(model, context).result();
		expect(paths.slice(-2)).toEqual([b.path, b.path]);
		hold = true;
		const stream = handler(model, context, { sessionId: ha.session.sessionId });
		const closing = handler(model, context, { sessionId: hb.session.sessionId });
		expect(paths.slice(-2)).toEqual([a.path, b.path]);
		const aId = ha.session.sessionId;
		const bId = hb.session.sessionId;
		hb.session.sessionManager.newSession();
		await hb.session.extensionRunner.emit({ type: "session_shutdown", reason: "fork" });
		release.resolve();
		expect((await stream.result()).stopReason).toBe("stop");
		expect((await closing.result()).stopReason).toBe("aborted");
		await handler(model, context).result();
		expect(paths.at(-1)).toBe(b.path);
		ha.session.modelRegistry.refresh();
		const aHandler = getApiProvider(model.api)!.streamSimple;
		await aHandler(model, context, { sessionId: bId }).result();
		expect(paths.at(-1)).toBe(a.path);
		ha.session.dispose();
		await handler(model, context, { sessionId: aId }).result();
		expect(paths.at(-1)).toBe(b.path);
	} finally {
		release.resolve();
		ha.cleanup();
		hb.cleanup();
	}
});

const sourceSession = "11111111-1111-4111-a111-111111111111";
const forkedSession = "22222222-2222-4222-a222-222222222222";
const checkpointAt = "33333333-3333-4333-a333-333333333333";
const toolCalls = tools.map((tool, i) => ({
	type: "toolCall" as const,
	id: `call-${i}`,
	name: tool.name,
	arguments: { n: i },
}));
const toolResults = toolCalls.map((call, i) => ({
	role: "toolResult" as const,
	toolCallId: call.id,
	toolName: call.name,
	isError: i === 1,
	timestamp: i,
	content: [{ type: "text" as const, text: `answer ${i}` }],
}));
const picture = { type: "image" as const, mimeType: "image/png", data: "YQ==" };
const initial: Context = {
	...context,
	tools,
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }, picture], timestamp: 0 }],
};
async function checkpointFixture() {
	const f = fixture(async function* ({ options }) {
		for (const call of toolCalls) {
			await options.hooks?.PreToolUse?.[0].hooks[0](
				{
					hook_event_name: "PreToolUse",
					tool_name: `mcp__prime__${call.name}`,
					tool_input: call.arguments,
				} as HookInput,
				call.id,
				{ signal: new AbortController().signal },
			);
			yield {
				type: "assistant",
				session_id: sourceSession,
				uuid: call.id === "call-1" ? checkpointAt : forkedSession,
			};
		}
		yield result();
	});
	const checkpoint = await f.provider.streamSimple(model, initial).result();
	expect(checkpoint.stopReason).toBe("toolUse");
	// This projection is built from the input fixtures, not the provider serializer.
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				"claude-sdk",
				"claude-agent-sdk",
				"fixture",
				"Prime instructions",
				tools.map((t) => [t.name, t.description, t.parameters]),
				[
					["user", initial.messages[0].content],
					["assistant", toolCalls],
				],
			]),
		)
		.digest("hex");
	expect(checkpoint.responseId).toBe(`${sourceSession}.${checkpointAt}.${hash}`);
	return {
		checkpoint,
		history: { ...initial, messages: [...initial.messages, checkpoint, ...toolResults] },
		dir: f.dir,
	};
}
const collectPrompt = async (prompt: Args["prompt"]) => {
	const messages: SDKUserMessage[] = [];
	for await (const m of prompt) messages.push(m);
	return messages;
};
it.each(["in memory", "disk round trip"])("forks the tool checkpoint: %s", async (scenario) => {
	const { history, dir } = await checkpointFixture();
	if (scenario === "disk round trip") {
		const session = SessionManager.create(dir, dir);
		for (const m of history.messages) session.appendMessage(m);
		history.messages = SessionManager.open(session.getSessionFile()!).buildSessionContext()
			.messages as Context["messages"];
	}
	const calls: Options[] = [];
	const prompts: SDKUserMessage[][] = [];
	const f = fixture(async function* ({ options, prompt }) {
		calls.push(options);
		prompts.push(await collectPrompt(prompt));
		yield { type: "assistant", uuid: checkpointAt, session_id: forkedSession };
		yield* textTurn("end_turn");
	});
	const reply = await f.provider.streamSimple(model, history).result();
	expect(calls[0]).toMatchObject({ resume: sourceSession, resumeSessionAt: checkpointAt, forkSession: true });
	expect(prompts[0]).toEqual([
		{
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: toolResults.map((r) => ({
					type: "tool_result",
					tool_use_id: r.toolCallId,
					is_error: r.isError,
					content: r.content,
				})),
			},
		},
	]);
	await f.provider
		.streamSimple(model, { ...history, messages: [...history.messages, reply, ...context.messages] })
		.result();
	expect(calls[1].resume).toBe(forkedSession);
});
it.each([
	"no state",
	"foreign",
	"error",
	"unparsable",
	"system prompt",
	"tools",
	"earlier message",
	"checkpoint message",
	"model",
	"tool tail",
])("replays divergent history: %s", async (scenario) => {
	const { checkpoint, history } = await checkpointFixture();
	let selected = model;
	const newer = { type: "text" as const, text: "edited checkpoint" };
	if (scenario === "no state") delete checkpoint.responseId;
	if (scenario === "tool tail") history.messages.pop();
	if (scenario === "foreign") checkpoint.provider = "foreign";
	if (scenario === "error") checkpoint.stopReason = "error";
	if (scenario === "unparsable") checkpoint.responseId = "not-sdk-state";
	if (scenario === "system prompt") history.systemPrompt = "different";
	if (scenario === "tools") history.tools = tools.slice(1);
	if (scenario === "earlier message")
		history.messages[0] = { role: "user", content: [{ type: "text", text: "Edited" }, picture], timestamp: 1 };
	if (scenario === "checkpoint message") checkpoint.content.push(newer);
	if (scenario === "model") selected = { ...model, id: "other" };
	let opts: Options | undefined;
	let users: SDKUserMessage[] = [];
	const f = fixture(async function* ({ options, prompt }) {
		opts = options;
		users = await collectPrompt(prompt);
		yield* textTurn("end_turn");
	});
	expect((await f.provider.streamSimple(selected, history).result()).stopReason).toBe("stop");
	expect(opts?.resume).toBeUndefined();
	expect(opts?.forkSession).toBeUndefined();
	expect(opts?.resumeSessionAt).toBeUndefined();
	const text = (value: string) => ({ type: "text", text: value });
	expect(users.map((u) => u.message.content)).toEqual([
		[
			text("user:"),
			text(scenario === "earlier message" ? "Edited" : "Hello"),
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
			text("assistant:"),
			...toolCalls.map((c) => text(JSON.stringify(c))),
			...(scenario === "checkpoint message" ? [newer] : []),
			text("Tool result one (call-0):"),
			text("answer 0"),
			...(scenario === "tool tail" ? [] : [text("Tool result two (call-1):"), text("answer 1")]),
		],
	]);
});
it.each([
	["CLI configuration is invalid", false],
	["No conversation found with session ID", true],
] as const)("R2-1 handles startup result %s", async (error, replay) => {
	const { history } = await checkpointFixture();
	const inputs: SDKUserMessage[][] = [];
	const f = fixture(
		async function* ({ options, prompt }) {
			inputs.push(await collectPrompt(prompt));
			if (options.resume) yield { type: "result", subtype: "error_during_execution", errors: [error] };
			else yield* textTurn("end_turn");
		},
		vi
			.fn()
			.mockRejectedValueOnce(Error("control response closed"))
			.mockResolvedValue({ claude_code_version: "2.1.248" }),
	);
	const reply = await f.provider.streamSimple(model, history).result();
	if (replay) {
		expect(reply.stopReason).toBe("stop");
		expect(inputs[1]).toHaveLength(1);
	} else {
		expect(reply.errorMessage).toContain(error);
		expect(inputs).toHaveLength(1);
	}
	expect(inputs[0]).toEqual([]);
});
it.each([
	["No conversation found with session ID", false, true],
	["No message found with message.uuid of", false, true],
	["login required", false, false],
	["No conversation found with session ID", true, false],
] as const)("resume error %s after output=%s retries=%s", async (error, late, retry) => {
	const { history } = await checkpointFixture();
	const calls: Options[] = [];
	const prompts: SDKUserMessage[][] = [];
	const order: string[] = [];
	const f = fixture(async function* ({ options, prompt }) {
		calls.push(options);
		prompts.push(await collectPrompt(prompt));
		order.push("start");
		try {
			if (calls.length === 1) {
				if (late) yield raw("content_block_start", { index: 0, content_block: { type: "text", text: "partial" } });
				yield { type: "result", subtype: "error_during_execution", errors: [error] };
			} else yield* textTurn("end_turn");
		} finally {
			order.push("closed");
		}
	});
	const reply = await f.provider.streamSimple(model, history).result();
	expect(calls[0].resume).toBe(sourceSession);
	expect(reply.stopReason).toBe(retry ? "stop" : "error");
	expect(order).toEqual(retry ? ["start", "closed", "start", "closed"] : ["start", "closed"]);
	if (retry) {
		expect(calls[1].resume).toBeUndefined();
		expect(reply.diagnostics?.length).toBeGreaterThan(0);
		expect(prompts[1]).toHaveLength(1);
		expect(prompts[1][0].message.content).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Hello" },
				{ type: "text", text: "answer 1" },
			]),
		);
	} else expect(reply.errorMessage).toContain(error);
});

it.each(["arguments and pre-hook rejection"])("AC-20 repairs hook %s without salvaging a rejected tool", async () => {
	const tool = {
		name: "repair",
		description: "repair fixture",
		parameters: Type.Object({ file_path: Type.String() }),
	};
	const input = { filePath: "project" };
	let calls = 0;
	const f = fixture(async function* ({ options }) {
		const id = `call-${++calls}`;
		const name = "mcp__prime__repair";
		await options.hooks?.PreToolUse?.[0].hooks[0](
			{ hook_event_name: "PreToolUse", tool_name: name, tool_input: input } as HookInput,
			id,
			{ signal: new AbortController().signal },
		);
		if (calls === 2) {
			yield raw("content_block_start", {
				index: 0,
				content_block: { type: "tool_use", id: "rejected", name, input: {} },
			});
			yield raw("content_block_stop", { index: 0 });
		}
		yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [] };
	});
	const ctx = { ...context, tools: [tool] };
	const repaired = await f.provider.streamSimple(model, ctx).result();
	const rejected = await f.provider.streamSimple(model, ctx).result();
	expect(rejected.stopReason).toBe("error");
	expect(rejected.content.filter((block) => block.type === "toolCall")).toEqual([]);
	expect(calls).toBe(2);
	expect(repaired.stopReason).toBe("toolUse");
	expect(repaired.content).toEqual([
		{
			type: "toolCall",
			id: "call-1",
			name: "repair",
			arguments: { file_path: "project" },
		},
	]);
});

it.each(["no output", "thinking with empty text"])("AC-22 rejects an empty turn with %s", async (kind) => {
	let calls = 0;
	const f = fixture(async function* () {
		calls++;
		if (kind === "thinking with empty text") {
			yield raw("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "hmm" } });
			yield raw("content_block_stop", { index: 0 });
			yield raw("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
			yield raw("content_block_stop", { index: 1 });
		}
		yield result();
	});
	const msg = await f.provider.streamSimple(model, context).result();
	expect(msg.stopReason).toBe("error");
	expect(msg.errorMessage).toMatch(/Claude returned nothing/i);
	expect(providerStreamFailureDetails(msg)?.kind).toBe("invalid_request");
	expect(calls).toBe(1);
});

it.each(["keepalives"])("AC-22 aborts and closes a query stalled on %s", async () => {
	vi.useFakeTimers();
	const waitForClose = createDeferred();
	const releaseClose = createDeferred();
	const nextPing = createDeferred();
	const pending = createDeferred();
	let calls = 0;
	let signal: AbortSignal | undefined;
	let completed = false;
	let closed = false;
	const f = fixture(async function* ({ options }) {
		calls++;
		signal = options.abortController?.signal;
		signal?.addEventListener("abort", () => waitForClose.resolve(), { once: true });
		try {
			yield raw("ping");
			await nextPing.promise;
			yield raw("ping");
			pending.resolve();
			await waitForClose.promise;
		} finally {
			await releaseClose.promise;
			closed = true;
		}
	});
	writeFileSync(join(f.dir, "claude-sdk.json"), JSON.stringify({ claudePath: f.path, idleTimeoutSeconds: 2 }));
	const response = f.provider
		.streamSimple(model, context)
		.result()
		.then((message) => {
			completed = true;
			return message;
		});
	try {
		await vi.advanceTimersByTimeAsync(1_000);
		nextPing.resolve();
		await pending.promise;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(signal?.aborted).toBe(true);
		expect(completed).toBe(false);
		releaseClose.resolve();
		const message = await response;
		expect(closed).toBe(true);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/timed out/i);
		expect(calls).toBe(1);
	} finally {
		nextPing.resolve();
		waitForClose.resolve();
		releaseClose.resolve();
		await response;
		vi.useRealTimers();
	}
});

it.each(["initialization"])("AC-22 aborts a query whose %s stalls", async () => {
	vi.useFakeTimers();
	let input: Promise<SDKUserMessage[]> | undefined;
	let signal: AbortSignal | undefined;
	const f = fixture(
		({ prompt, options }) => {
			signal = options.abortController?.signal;
			input = collectPrompt(prompt);
			return (async function* () {
				yield result();
			})();
		},
		() => new Promise(() => {}),
	);
	writeFileSync(join(f.dir, "claude-sdk.json"), JSON.stringify({ claudePath: f.path, idleTimeoutSeconds: 2 }));
	try {
		const response = f.provider.streamSimple(model, context).result();
		await vi.advanceTimersByTimeAsync(2_000);
		const message = await response;
		expect(signal?.aborted).toBe(true);
		expect(await input).toEqual([]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/timed out after 2 seconds/);
	} finally {
		vi.useRealTimers();
	}
});

it.each(["max_tokens result", "CLI cap assistant error", "CLI cap exception"])(
	"AC-22 discards the partial tool call on %s",
	async (terminal) => {
		let calls = 0;
		let cap: string | undefined;
		const f = fixture(async function* ({ options }) {
			calls++;
			cap = options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
			yield { type: "assistant", session_id: sourceSession, uuid: checkpointAt };
			yield raw("content_block_start", {
				index: 0,
				content_block: { type: "tool_use", id: "cut", name: "mcp__prime__one", input: {} },
			});
			yield raw("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"nest' } });
			const capExceeded =
				"Claude's response exceeded the 32 output token maximum. To configure this limit, set CLAUDE_CODE_MAX_OUTPUT_TOKENS.";
			if (terminal === "CLI cap exception") throw Error(`Claude Code returned an error result: ${capExceeded}`);
			if (terminal === "CLI cap assistant error") {
				yield {
					type: "assistant",
					error: "max_output_tokens",
					message: { content: [{ type: "text", text: capExceeded }] },
					parent_tool_use_id: null,
				};
				yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [capExceeded] };
				throw Error("Claude Code exited with code 1");
			} else yield result("max_tokens");
		});
		const msg = await f.provider.streamSimple(model, { ...context, tools }, { maxTokens: 64 }).result();
		expect({ stop: msg.stopReason, calls, cap }).toEqual({ stop: "length", calls: 1, cap: "64" });
		expect(msg.content.filter((b) => b.type === "toolCall")).toEqual([]);
		expect(msg.responseId).toBeUndefined();
	},
);

it.each(["long and colliding names"])("AC-23 aliases %s and replays the original names", async () => {
	const originals = ["read", "mcp__prime__read", "long-".repeat(16)];
	const collidingTools = originals.map((name, i) => ({ name, description: `tool ${i}`, parameters: Type.Object({}) }));
	const listed: string[] = [];
	const f = fixture(async function* ({ options }) {
		const server = options.mcpServers?.prime;
		if (server?.type !== "sdk") throw Error("missing server");
		const client = new Client({ name: "fixture", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.instance.connect(a);
		try {
			await client.connect(b);
			const available = (await client.listTools()).tools;
			for (const [i, tool] of collidingTools.entries()) {
				const alias = available.find((entry) => entry.description === tool.description)?.name;
				if (!alias) throw Error(`missing ${tool.description}`);
				listed.push(`mcp__prime__${alias}`);
				await options.hooks?.PreToolUse?.[0].hooks[0](
					{ hook_event_name: "PreToolUse", tool_name: listed[i], tool_input: {} } as HookInput,
					`alias-${i}`,
					{ signal: new AbortController().signal },
				);
			}
		} finally {
			await client.close();
			await server.instance.close();
		}
		yield result();
	});
	const ctx = { ...context, tools: collidingTools };
	const msg = await f.provider.streamSimple(model, ctx).result();
	const captured = msg.content.filter((block) => block.type === "toolCall");
	let replay: SDKUserMessage[] = [];
	const replaying = fixture(async function* ({ prompt }) {
		replay = await collectPrompt(prompt);
		yield* textTurn("end_turn");
	});
	await replaying.provider.streamSimple(model, { ...ctx, messages: [...ctx.messages, msg] }).result();
	expect(captured.map((call) => call.name)).toEqual(originals);
	expect(new Set(listed).size).toBe(3);
	expect(listed[0]).toBe("mcp__prime__read");
	for (const name of listed) {
		expect(name).toMatch(/^mcp__prime__(?!mcp__prime__)[a-z0-9_-]+$/i);
		expect(name.length).toBeLessThanOrEqual(64);
	}
	expect(replay[0]?.message.content).toEqual([
		{ type: "text", text: "user:" },
		{ type: "text", text: "Hello" },
		{ type: "text", text: "assistant:" },
		...originals.map((name, i) => ({
			type: "text",
			text: JSON.stringify({ type: "toolCall", id: `alias-${i}`, name, arguments: {} }),
		})),
	]);
});
