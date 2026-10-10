import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CodeMode, OpenAPI, Tool } from "@opencode/codemode";

import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	type CodemodeGeneratedTool,
	type CodemodeHost,
	type CodemodeToolDetails,
	createCodemodeToolDefinition,
} from "../src/core/tools/codemode.js";
import { createIpythonToolDefinition } from "../src/core/tools/ipython.js";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

vi.mock("@opencode/codemode", async (original) => {
	const actual = await original<{ CodeMode: typeof CodeMode; OpenAPI: typeof OpenAPI; Tool: typeof Tool }>();
	return { ...actual, CodeMode: { ...actual.CodeMode } };
});

interface Fixture {
	id: string;
	tm: string;
	code: string;
	replies: Record<string, string | { error: string }>;
	expected: {
		isError: boolean;
		text?: string[];
		absent?: string[];
		fullText?: string;
		images?: unknown[];
		calls: { name: string; status: string }[];
	};
}
const fixtures: Fixture[] = readFileSync(new URL("./fixtures/codemode/cases.jsonl", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function text(result: Pick<AgentToolResult<unknown>, "content">): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}
const stubSchema = Type.Object({ value: Type.String() });
function stub(
	name: string,
	execute: AgentTool<typeof stubSchema>["execute"],
	sequential = false,
): AgentTool<typeof stubSchema> {
	return {
		name,
		label: name,
		description: `Stub ${name}`,
		parameters: stubSchema,
		executionMode: sequential ? "sequential" : "parallel",
		execute,
	};
}
function reply(value: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: value }], details: {} };
}

describe("codemode", () => {
	let dir: string;
	const sessions: AgentSession[] = [];
	const spills: string[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-codemode-test-"));
	});
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.disposeAsync({ kernelSnapshot: false });
		for (const path of spills.splice(0)) rmSync(path, { force: true });
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	async function execute(
		code: string,
		tools: AgentTool[] = [],
		signal?: AbortSignal,
		storeEntries: unknown[] = [],
		onUpdate?: AgentToolUpdateCallback<CodemodeToolDetails>,
	) {
		const host: CodemodeHost = {
			callableTools: () => tools,
			runTool: (id, name, args, signal) =>
				runToolCall(
					{ type: "toolCall", id, name, arguments: args as Record<string, unknown> },
					{
						tools,
						context: { messages: [], tools, systemPrompt: "" },
						assistantMessage: assistantMsg("script"),
						signal,
					},
				),
			storeEntries: () => storeEntries,
			appendStore: (delta) => {
				storeEntries.push(delta);
			},
		};
		const tool = wrapToolDefinition(createCodemodeToolDefinition(dir, host));
		const result = await tool.execute("parent", { code }, signal, onUpdate);
		if (result.details.fullOutputPath) spills.push(result.details.fullOutputPath);
		return result;
	}

	async function makeSession(factory?: ExtensionFactory, settings = SettingsManager.inMemory()) {
		const extensionsResult = await createTestExtensionsResult(factory ? [factory] : [], dir);
		const resourceLoader = createTestResourceLoader({ extensionsResult });
		const model = getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5");
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(dir, "models.json"));
		const agent = new Agent({
			initialState: { model, messages: [assistantMsg("script")] },
			getApiKey: () => "test-key",
		});
		const session = new AgentSession({
			agent,
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: settings,
			modelRegistry,
			resourceLoader,
			includeGoals: false,
		});
		sessions.push(session);
		return { session, resourceLoader, settingsManager: settings, modelRegistry, authStorage, model };
	}
	function sessionTool(session: AgentSession) {
		const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
		if (!tool) throw new Error("missing production codemode");
		return tool;
	}

	it.each(fixtures)("$tm $id crosses the real sandbox", async (fixture) => {
		const tools = Object.entries(fixture.replies).map(([name, result]) =>
			stub(name, async () => {
				if (typeof result !== "string") throw new Error(result.error);
				return reply(result);
			}),
		);
		const result = await execute(fixture.code, tools);
		expect(result.isError).toBe(fixture.expected.isError);
		for (const expected of fixture.expected.text ?? []) expect(text(result)).toContain(expected);
		for (const absent of fixture.expected.absent ?? []) expect(text(result)).not.toContain(absent);
		expect(result.details.calls.map(({ name, status }) => ({ name, status }))).toEqual(fixture.expected.calls);
		expect(result.content.filter((item) => item.type === "image")).toEqual(fixture.expected.images ?? []);
		if (fixture.expected.fullText !== undefined) {
			expect(readFileSync(result.details.fullOutputPath!, "utf8")).toBe(fixture.expected.fullText);
			expect(statSync(result.details.fullOutputPath!).mode & 0o777).toBe(0o600);
		}
	});

	it("TM-04 TM-15 applies registered hooks, validation and the active-tool boundary without nested messages", async () => {
		const executed: string[] = [];
		const seen: string[] = [];
		const longError = "E".repeat(600);
		const { session } = await makeSession((pi) => {
			for (const name of ["echo", "blocked", "fail", "inactive"])
				pi.registerTool({
					...stub(name, async (_id, args) => {
						executed.push(name);
						if (name === "fail") throw new Error(longError);
						return reply(args.value);
					}),
				});
			pi.on("tool_call", (event) => {
				seen.push(event.toolCallId);
				return event.toolName === "blocked" ? { block: true, reason: "permission denied" } : undefined;
			});
			pi.on("tool_result", (event) =>
				event.toolName === "echo" ? { content: [{ type: "text", text: "after-hook change" }] } : undefined,
			);
		});
		session.setActiveToolsByName(["codemode", "echo", "blocked", "fail"]);
		const before = [...session.agent.state.messages];
		const result = await sessionTool(session).execute("parent", {
			code: `for (const [name,args] of [["echo",{value:"${"x".repeat(250)}"}],["blocked",{value:"b"}],["echo",{}],["unknown",{}],["inactive",{}],["codemode",{}],["fail",{value:"e"}]]) { try { text(await tools[name](args)); } catch(e) { text(e.message); } }`,
		});
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("after-hook change");
		expect(text(result)).toContain("permission denied");
		expect(text(result)).toContain("value");
		expect(executed).toEqual(["echo", "fail"]);
		expect(seen).toEqual(["parent/1", "parent/2", "parent/4"]);
		const calls = (result.details as CodemodeToolDetails).calls;
		expect(calls.map(({ id, name, status }) => ({ id, name, status }))).toEqual([
			{ id: "parent/1", name: "echo", status: "ok" },
			{ id: "parent/2", name: "blocked", status: "error" },
			{ id: "parent/3", name: "echo", status: "error" },
			{ id: "parent/4", name: "fail", status: "error" },
		]);
		expect(calls[0].args).toHaveLength(200);
		expect(calls[3].error).toHaveLength(500);
		for (const call of calls) expect(call.durationMs).toBeGreaterThanOrEqual(0);
		expect(session.agent.state.messages).toEqual(before);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
	});

	it("TM-08 folds only the current branch and persists completed writes including exit and deletion", async () => {
		const { session } = await makeSession();
		const manager = session.sessionManager;
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const tool = sessionTool(session);
		await tool.execute("set", { code: 'store("k",1); exit();' });
		const entries = manager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "codemode-store");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ data: { set: { k: 1 }, delete: [] } });
		expect(text(await tool.execute("load", { code: 'text(load("k"));' }))).toContain("1");
		const failed = await tool.execute("failed", { code: 'store("k",2); throw new Error("failed store");' });
		expect(failed.isError).toBe(true);
		expect(
			manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		).toHaveLength(1);
		expect(text(await tool.execute("load", { code: 'text(load("k"));' }))).toContain("1");
		const storedLeaf = manager.getLeafId()!;
		manager.branch(root);
		expect(text(await tool.execute("branch", { code: 'text(typeof load("k"));' }))).toContain("undefined");
		manager.branch(storedLeaf);
		await tool.execute("delete", { code: 'store("k",undefined);' });
		expect(manager.getBranch().at(-1)).toMatchObject({ data: { set: {}, delete: ["k"] } });
		expect(text(await tool.execute("gone", { code: 'text(typeof load("k"));' }))).toContain("undefined");
	});

	it("TM-14 creates a fresh VM and TM-06 preserves failure when spilling fails", async () => {
		expect(text(await execute("const leaked = 1; text(leaked);"))).toContain("1");
		expect(text(await execute("text(typeof leaked);"))).toContain("undefined");
		const oldTmp = process.env.TMPDIR;
		try {
			process.env.TMPDIR = join(dir, "absent");
			const result = await execute(
				'// @options: {"max_output_tokens":0}\ntext("full text"); throw new Error("keep this error");',
			);
			expect(result.isError).toBe(true);
			expect(result.details.fullOutputPath).toBeUndefined();
			expect(text(result)).not.toContain("[Full output:");
			expect(text(result)).toContain("[Could not save the full output:");
			expect(text(result)).toContain("keep this error");
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringMatching(/^Script failed\nWall time .* seconds\nOutput:\n$/),
			});
		} finally {
			if (oldTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = oldTmp;
		}
	});

	it.each(["completed", "failed", "exit"])("TM-07 cancels running/queued calls when the script %s", async (end) => {
		const started = deferred<void>();
		const cancelled = deferred<void>();
		const never = deferred<AgentToolResult<unknown>>();
		const starts: string[] = [];
		const entries: unknown[] = [];
		const tool = stub(
			"pending",
			async (_id, args, signal) => {
				starts.push(args.value);
				started.resolve();
				signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
				return never.promise;
			},
			true,
		);
		const ready = stub("ready", async () => {
			await started.promise;
			return reply("ready");
		});
		try {
			const result = await execute(
				`tools.pending({value:"one"}); tools.pending({value:"two"}); await tools.ready({value:"gate"}); text("partial"); store("k",1); ${end === "failed" ? 'throw new Error("failure");' : end === "exit" ? 'exit(); text("after");' : ""}`,
				[tool, ready],
				undefined,
				entries,
			);
			await cancelled.promise;
			expect(result.isError).toBe(end === "failed");
			expect(text(result)).toContain("partial");
			expect(text(result)).not.toContain("after");
			expect(starts).toEqual(["one"]);
			expect(result.details.calls).toMatchObject([
				{ name: "pending", status: "cancelled" },
				{ name: "pending", status: "cancelled" },
				{ name: "ready", status: "ok" },
			]);
			expect(entries).toEqual(end === "failed" ? [] : [{ set: { k: 1 }, delete: [] }]);
		} finally {
			never.resolve(reply("late"));
		}
	});

	it.each([false, true])(
		"TM-09 serializes sequential tools and queued abort=%s never starts a waiting call",
		async (abort) => {
			const first = deferred<void>();
			const release = deferred<AgentToolResult<unknown>>();
			const queued = deferred<void>();
			const starts: string[] = [];
			const controller = new AbortController();
			const hostTools = [
				stub(
					"seq",
					async (_id, args) => {
						starts.push(args.value);
						if (args.value === "one") {
							first.resolve();
							return release.promise;
						}
						return reply("two");
					},
					true,
				),
			];
			const running = execute(
				'text(await Promise.all([tools.seq({value:"one"}), tools.seq({value:"two"})]));',
				hostTools,
				controller.signal,
				[],
				(update) => {
					if (update.details.calls.length === 2) queued.resolve();
				},
			);
			try {
				await first.promise;
				await queued.promise;
				expect(starts).toEqual(["one"]);
				if (abort) controller.abort();
				else release.resolve(reply("one"));
				const result = await running;
				expect(starts).toEqual(abort ? ["one"] : ["one", "two"]);
				expect(result.details.calls.map((call) => call.status)).toEqual(
					abort ? ["cancelled", "cancelled"] : ["ok", "ok"],
				);
			} finally {
				controller.abort();
				release.resolve(reply("late"));
				await running;
			}
		},
	);

	it.each([
		{ enabled: undefined, tools: undefined, active: ["ipython", "codemode"] },
		{ enabled: false, tools: undefined, active: ["ipython"] },
		{ enabled: true, tools: ["ipython"], active: ["ipython"] },
		{ enabled: false, tools: ["codemode"], active: ["codemode"] },
	])("TM-10 defaults and SDK lists $enabled $tools", async ({ enabled, tools, active }) => {
		const settings = SettingsManager.inMemory(enabled === undefined ? {} : { codemode: enabled });
		const setup = await makeSession(undefined, settings);
		expect(setup.session.getActiveToolNames()).toEqual(enabled === false ? ["ipython"] : ["ipython", "codemode"]);
		const { session } = await createAgentSession({
			...setup,
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(dir),
			tools,
			includeGoals: false,
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).toEqual(active);
	});

	it("TM-19 native active-tool guidelines follow activation without a kernel or model", async () => {
		const { session } = await makeSession();
		const tools = [createCodemodeToolDefinition(dir), createIpythonToolDefinition(dir)];
		for (const active of [["codemode", "ipython"], ["codemode"], ["ipython"], [], ["codemode", "ipython"]]) {
			session.setActiveToolsByName(active);
			const prompt = session.agent.state.systemPrompt;
			const lines = active.flatMap((name) => tools.find((t) => t.name === name)?.promptGuidelines ?? []);
			expect(prompt.split("# Additional Guidance\n\n")[1] ?? "").toBe(lines.map((t) => `- ${t}`).join("\n"));
			if (active.includes("ipython")) expect(prompt).toContain("reachable from Python: use Python");
		}
	});

	it("leaves tools named in codemodeExcludeTools out of scripts", async () => {
		const executed: string[] = [];
		const { session } = await makeSession(
			(pi) => {
				for (const name of ["echo", "ask_user"])
					pi.registerTool({
						...stub(name, async (_id, args) => {
							executed.push(name);
							return reply(args.value);
						}),
					});
			},
			SettingsManager.inMemory({ codemodeExcludeTools: ["ask_user"] }),
		);
		session.setActiveToolsByName(["codemode", "echo", "ask_user"]);
		const result = await sessionTool(session).execute("parent", {
			code: `text(ALL_TOOLS.map((tool) => tool.name).join(",")); text(String(await describeTool("ask_user"))); text(await tools.echo({value: "ok"})); try { await tools.ask_user({value: "x"}); } catch (e) { text("blocked: " + e.message); }`,
		});
		expect(result.isError).toBe(false);
		const lines = text(result).split("\n");
		expect(lines).toEqual(expect.arrayContaining(["echo", "undefined", "ok"]));
		expect(lines.filter((line) => line.includes("ask_user"))).toEqual([expect.stringMatching(/^blocked: /)]);
		expect(executed).toEqual(["echo"]);
	});

	it("codemodeExcludeTools keeps only string names", () => {
		expect(
			SettingsManager.inMemory({
				codemodeExcludeTools: ["a", 1, null] as unknown as string[],
			}).getCodemodeExcludeTools(),
		).toEqual(["a"]);
		expect(SettingsManager.inMemory({}).getCodemodeExcludeTools()).toEqual([]);
	});

	it("TM-10 persists the boolean setting and lets project settings override global settings", async () => {
		mkdirSync(join(dir, ".prime", "agent"), { recursive: true });
		writeFileSync(join(dir, "settings.json"), '{"codemode":false}');
		expect(SettingsManager.create(dir, dir).getCodemode()).toBe(false);
		writeFileSync(join(dir, ".prime", "agent", "settings.json"), '{"codemode":true}');
		expect(SettingsManager.create(dir, dir).getCodemode()).toBe(true);
	});

	it("TM-11 keeps the exact model schema and description in the port doc; host-less execution rejects", async () => {
		const doc = readFileSync(new URL("../docs/codemode.md", import.meta.url), "utf8");
		const definition = createCodemodeToolDefinition(dir);
		for (const tool of [definition, createIpythonToolDefinition(dir)]) {
			const block = doc
				.split(`<!-- ${tool.name}-guidelines:start -->\n\`\`\`json\n`)[1]
				.split(`\n\`\`\`\n<!-- ${tool.name}-guidelines:end -->`)[0];
			expect(tool.promptGuidelines).toEqual(JSON.parse(block));
		}
		expect(doc.split("<!-- description:start -->\n")[1].split("\n<!-- description:end -->")[0]).toBe(
			definition.description,
		);
		expect(
			JSON.parse(doc.split("<!-- schema:start -->\n```json\n")[1].split("\n```\n<!-- schema:end -->")[0]),
		).toEqual(JSON.parse(JSON.stringify(definition.parameters)));
		await expect(
			wrapToolDefinition(createCodemodeToolDefinition(dir)).execute("none", { code: "text(1);" }),
		).rejects.toThrow("codemode needs an agent session");
	});

	it("TM-19 records partial script output and completed/cancelled calls through the production session loop", async () => {
		const started = deferred<void>();
		const before = deferred<string>();
		const after = deferred<string>();
		const never = deferred<AgentToolResult<unknown>>();
		const { session } = await makeSession((pi) => {
			pi.on("tool_call", (event) => {
				if (event.toolName === "echo") before.resolve(event.toolCallId);
			});
			pi.on("tool_result", (event) => {
				if (event.toolName === "echo") after.resolve(event.toolCallId);
			});
			pi.registerTool(stub("echo", async () => reply("done")));
			pi.registerTool(
				stub("pending", async () => {
					started.resolve();
					return never.promise;
				}),
			);
		});
		const code = 'text(await tools.echo({value:"one"})); await tools.pending({value:"two"});';
		const message = {
			...assistantMsg(""),
			stopReason: "toolUse" as const,
			content: [{ type: "toolCall" as const, id: "outer", name: "codemode", arguments: { code } }],
		};
		session.agent.streamFn = () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end();
			return stream;
		};
		const running = session.prompt("run script");
		try {
			expect(await before.promise).toBe("outer/1");
			expect(await after.promise).toBe("outer/1");
			await started.promise;
			await session.abort();
			await running;
			const messages = session.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult");
			expect(messages).toHaveLength(1);
			const result = messages[0];
			if (result.role !== "toolResult") throw new Error("expected tool result");
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("done");
			expect(text(result)).toContain("Script aborted:");
			expect(result.details).toMatchObject({
				calls: [
					{ id: "outer/1", status: "ok" },
					{ id: "outer/2", status: "cancelled" },
				],
			});
			expect(createToolDefinitionFromAgentTool(sessionTool(session)).abortResultGraceMs).toBe(5000);
		} finally {
			never.resolve(reply("late"));
			await session.abort();
			await running;
		}
	});
	it("TM-21 combines checked calls, console aliases/dir/table, image, final value and branch writes", async () => {
		const { session } = await makeSession((pi) =>
			pi.registerTool(stub("echo", async (_id, args) => reply(args.value))),
		);
		session.setActiveToolsByName(["codemode", "echo"]);
		const result = await sessionTool(session).execute("combined", {
			code: 'text("first"); const log = console.info; log({a:1},undefined); console.warn("warn"); console.error("error"); console.debug("debug"); console.dir({d:2}); console.table([{t:3}]); image("data:image/png;base64,iVBORw0KGgo="); text(Array.isArray(ALL_TOOLS)); text(await describeTool("echo")); text(await tools.echo({value:"checked"})); store("k",1); 42',
		});
		expect(result.isError).toBe(false);
		expect(text(result)).toContain('first\n{"a":1} undefined\nwarn\nerror\ndebug\n{"d":2}\n[{"t":3}]\ntrue');
		expect(text(result)).toContain("Promise<string>\nchecked\n42");
		expect(result.content.filter((item) => item.type === "image")).toEqual([
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
		expect(session.sessionManager.getBranch().at(-1)).toMatchObject({
			customType: "codemode-store",
			data: { set: { k: 1 }, delete: [] },
		});
		const exit = await sessionTool(session).execute("exit", {
			code: 'store("exit",1); text("before"); try { exit(); } catch(e) {text("catch");} finally {text("finally");} store("bad",1); text(await tools.echo({value:"after"}));',
		});
		expect(exit.isError).toBe(false);
		expect(text(exit)).toContain("before");
		expect(text(exit)).not.toMatch(/catch|finally|after/);
		expect((exit.details as CodemodeToolDetails).calls).toEqual([]);
		expect(session.sessionManager.getBranch().at(-1)).toMatchObject({ data: { set: { exit: 1 }, delete: [] } });
	});

	it("TM-21 generated operation uses actual checked session registry and structured post-hook JSON", async () => {
		const requests: string[] = [];
		const hooks: string[] = [];
		const generated = OpenAPI.fromSpec({
			baseUrl: "http://127.0.0.1:1",
			spec: JSON.parse(readFileSync(new URL("./fixtures/codemode/openapi-faux.json", import.meta.url), "utf8")),
		});
		const operation = generated.tools.echo;
		if (!Tool.isTool(operation)) throw new Error("missing generated operation");
		const client = HttpClient.make((request, url) => {
			requests.push(url.href);
			return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ value: "native" })));
		});
		const { session } = await makeSession((pi) => {
			pi.on("tool_call", (event) => {
				hooks.push(`before:${event.toolName}`);
				return "value" in event.input && event.input.value === "block"
					? { block: true, reason: "REFUSED" }
					: undefined;
			});
			pi.on("tool_result", (event) => {
				hooks.push(`after:${event.toolName}`);
				return { content: [{ type: "text", text: '{"value":"hook-json"}' }] };
			});
		});
		const tool: AgentTool = {
			name: "openapi.echo",
			label: "echo",
			description: operation.description,
			parameters: operation.input as AgentTool["parameters"],
			execute: async (_id, args, signal) => {
				const value = await Effect.runPromise(
					operation.execute(args).pipe(Effect.provideService(HttpClient.HttpClient, client)),
					{ signal },
				);
				return reply(JSON.stringify(value));
			},
		};
		const registry: CodemodeGeneratedTool[] = [{ tool, output: operation.output ?? Schema.Unknown }];
		const host: CodemodeHost = {
			callableTools: () => [],
			generatedTools: () => registry,
			runTool: (id, name, args, signal, extra) => session.runNestedToolCall(id, name, args, signal, extra),
			storeEntries: () => [],
			appendStore: () => {
				throw new Error("unexpected store write");
			},
		};
		const directBefore = session.getActiveToolNames();
		const adapter = wrapToolDefinition(createCodemodeToolDefinition(dir, host));
		const success = await adapter.execute("op", { code: 'await tools.openapi.echo({value:"x"})' });
		expect(success.isError).toBe(false);
		expect(text(success)).toContain('{"value":"hook-json"}');
		for (const args of ["{}", '{value:"block"}']) {
			const rejected = await adapter.execute("no", { code: `await tools.openapi.echo(${args})` });
			expect(rejected.isError).toBe(true);
		}
		expect(requests).toEqual(["http://127.0.0.1:1/echo?value=x"]);
		expect(hooks).toEqual(["before:openapi.echo", "after:openapi.echo", "before:openapi.echo"]);
		expect(session.getActiveToolNames()).toEqual(directBefore);
		host.excludedTools = () => [tool.name];
		const excluded = await adapter.execute("excluded", {
			code: 'text(ALL_TOOLS); text(search({})); try {await tools.openapi.echo({value:"x"});} catch(e) {text(e.message);}',
		});
		expect(excluded.isError).toBe(false);
		expect((excluded.details as CodemodeToolDetails).calls).toEqual([]);
		expect(text(excluded)).toContain('"items":[]');
		expect(requests).toHaveLength(1);
	});

	it("TM-21 keeps user coordinates, producer refusal and aborted partial capture without store commits", async () => {
		const entries: unknown[] = [];
		const cap = await execute(
			'store("bad",1); try { const chunk = "x".repeat(8388608); console.log(chunk,chunk); } catch(e) {} text("after");',
			[],
			undefined,
			entries,
		);
		expect(cap.isError).toBe(true);
		expect(text(cap)).toContain("script output exceeded");
		expect(text(cap)).not.toContain("after");
		expect(entries).toEqual([]);
		const located = await execute('// @options: {}\ntext("before");\nmissing();');
		expect(located.details.diagnostics).toMatchObject([{ location: { line: 3, column: 1 } }]);
		const started = deferred<void>();
		const cancelled = deferred<void>();
		const controller = new AbortController();
		const pending = stub("pending", async (_id, _args, signal) => {
			started.resolve();
			return new Promise((_resolve, reject) =>
				signal!.addEventListener(
					"abort",
					() => {
						cancelled.resolve();
						reject(new Error("aborted"));
					},
					{ once: true },
				),
			);
		});
		const running = execute(
			'text("partial"); console.log("logged"); store("bad",1); await tools.pending({value:"x"});',
			[pending],
			controller.signal,
			entries,
		);
		try {
			await started.promise;
			controller.abort();
			const aborted = await running;
			await cancelled.promise;
			expect(aborted.isError).toBe(true);
			expect(text(aborted)).toContain("partial\nlogged");
			expect(aborted.details.calls).toMatchObject([{ status: "cancelled" }]);
			expect(entries).toEqual([]);
		} finally {
			controller.abort();
			await running;
		}
	});

	it("TM-21 cleanup TimeoutExceeded on native success cannot commit; ordinary warnings can", async () => {
		const entries: unknown[] = [];
		const cleanup = Deferred.makeUnsafe<void>();
		const release = Deferred.makeUnsafe<void>();
		const make = CodeMode.make;
		const spy = vi.spyOn(CodeMode, "make").mockImplementation((options) => {
			expect(options?.limits).not.toHaveProperty("maxOutputBytes");
			const runtime = make({
				...options,
				tools: {
					slow: Tool.make({
						description: "cleanup",
						input: Schema.Struct({}),
						output: Schema.String,
						execute: () =>
							Effect.never.pipe(
								Effect.onInterrupt(() =>
									Effect.andThen(Deferred.succeed(cleanup, undefined), Deferred.await(release)),
								),
							),
					}),
				},
			});
			return {
				...runtime,
				execute: (code) =>
					Effect.gen(function* () {
						const fiber = yield* Effect.forkChild(runtime.execute(code));
						yield* Deferred.await(cleanup);
						yield* TestClock.adjust(20);
						yield* Deferred.succeed(release, undefined);
						return yield* Fiber.join(fiber);
					}).pipe(Effect.provide(TestClock.layer())),
			};
		});
		const timedOut = await execute(
			'// @options: {"timeout_ms":10}\ntext("kept"); store("bad",1); tools.slow({}); 42',
			[],
			undefined,
			entries,
		);
		expect(timedOut.details.diagnostics).toMatchObject([{ kind: "TimeoutExceeded" }]);
		expect(text(timedOut)).toContain("kept\n42");
		expect(timedOut.isError).toBe(true);
		expect(entries).toEqual([]);
		spy.mockImplementation((options) =>
			make({
				...options,
				tools: {
					fail: Tool.make({
						description: "ordinary warning",
						input: Schema.Struct({}),
						output: Schema.String,
						execute: () => Effect.fail(new Error("ordinary warning")),
					}),
				},
			}),
		);
		const warning = await execute('store("good",1); tools.fail({}); 42', [], undefined, entries);
		expect(warning.isError).toBe(false);
		expect(warning.details.diagnostics).toMatchObject([{ kind: "ToolFailure" }]);
		expect(entries).toEqual([{ set: { good: 1 }, delete: [] }]);
	});

	it("TM-02 native search, namespaces, pagination and aliases keep canonical effects", async () => {
		const tools = [
			stub("math.add", async () => reply("sum")),
			stub("math.sub", async () => reply("difference")),
			stub("my-tool", async () => reply("dash")),
			stub("my_tool", async () => reply("exact")),
			stub("search", async () => reply("Prime search")),
		];
		const result = await execute(
			'text(search({namespace:"math",limit:1})); text(search({namespace:"math",offset:1,limit:1})); text(search({query:"my-tool"})); text(toolExpression("my-tool")); text(searchSignature()); text(await tools.my_tool({value:"x"})); text(await tools["my-tool"]({value:"x"})); text(await tools.search({value:"x"})); text(ALL_TOOLS.map(t=>t.name)); text(search({query:"math_add"})); await tools.math.add({value:"x"});',
			tools,
		);
		expect(result.isError).toBe(false);
		expect(text(result)).toContain('"remaining":1');
		expect(text(result)).toContain('tools["my-tool"]');
		expect(text(result)).toContain("exact\ndash\nPrime search");
		expect(text(result)).not.toContain("math_add");
		expect(result.details.calls.map((call) => call.name)).toEqual(["my_tool", "my-tool", "search", "math.add"]);
		expect(result.details.toolCalls).toHaveLength(8);
		const duplicate = await execute('text("no effect");', [tools[0], tools[0]]);
		expect(duplicate.isError).toBe(true);
		expect(text(duplicate)).toContain("Ambiguous canonical");
		const prefix = await execute('text("no effect");', [stub("math", async () => reply("root")), tools[0]]);
		expect(prefix.isError).toBe(true);
		expect(prefix.details.calls).toEqual([]);
	});

	it("TM-03 returns native values and preserves user locations with bootstrap and options", async () => {
		for (const [code, value] of [
			["42", 42],
			['return "explicit";', "explicit"],
			["undefined", null],
			["return null;", null],
			['RegExp.escape("a+b")', "\\x61\\+b"],
			["crypto.randomUUID().length", 36],
		] as const) {
			const result = await execute(code);
			expect(result.isError).toBe(false);
			expect(result.content.slice(1)).toEqual(value === null ? [] : [{ type: "text", text: value.toString() }]);
		}
		const parse = await execute("// @options: {}\nconst = ;");
		expect(parse.isError).toBe(true);
		expect(text(parse)).toContain("(2:");
		const unsupported = await execute("class Example {}");
		expect(unsupported.isError).toBe(true);
		expect(unsupported.details.diagnostics).toMatchObject([{ kind: "UnsupportedSyntax", location: { line: 1 } }]);
	});

	it("TM-05 store copies, quotas, invalid helper inputs and timeout cannot persist failure", async () => {
		const entries: unknown[] = [];
		const set = await execute(
			'store("k",{n:1}); const copy = load("k"); copy.n = 2; text(load("k")); store("max","x".repeat(262142));',
			[],
			undefined,
			entries,
		);
		expect(set.isError).toBe(false);
		expect(text(set)).toContain('{"n":1}');
		expect(entries).toHaveLength(1);
		for (const code of [
			'store("tooBig","x".repeat(262143));',
			"store(1,1);",
			"load(1);",
			'image({type:"text",text:"no"});',
			'image("data:image/png;base64,AAAA");',
			"describeTool(1);",
			"toolExpression(1);",
		]) {
			const rejected = await execute(code, [], undefined, entries);
			expect(rejected.isError).toBe(true);
			expect(entries).toHaveLength(1);
		}
		const total = await execute('for (let i=0;i<4;i++) store(String(i),"x".repeat(262142));', [], undefined, entries);
		expect(total.isError).toBe(true);
		expect(text(total)).toContain("store is full");
		const boundary: unknown[] = [];
		const full = await execute(
			'for(let i=0;i<4;i++) store(String(i),"x".repeat(262141)); exit();',
			[],
			undefined,
			boundary,
		);
		expect(full.isError).toBe(false);
		const beyond = await execute('store("extra",1);', [], undefined, boundary);
		expect(beyond.isError).toBe(true);
		expect(boundary).toHaveLength(1);
		const timeout = await execute(
			'// @options: {"timeout_ms":10}\ntext("partial"); store("bad",1); while(true) {}',
			[],
			undefined,
			entries,
		);
		expect(timeout.isError).toBe(true);
		expect(text(timeout)).toContain("partial");
		expect(entries).toHaveLength(1);
	});
	it("TM-04 unmarked native interruption is never a successful exit", async () => {
		const make = CodeMode.make;
		vi.spyOn(CodeMode, "make").mockImplementation((options) => {
			const runtime = make(options);
			return { ...runtime, execute: (code) => Effect.andThen(runtime.execute(code), Effect.interrupt) };
		});
		const entries: unknown[] = [];
		const result = await execute('text("kept"); store("bad",1);', [], undefined, entries);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("kept");
		expect(entries).toEqual([]);
	});
	it("TM-06 producer character/item boundaries reject only the next output operation", async () => {
		const accepted = await execute('"x".repeat(16777216)');
		expect(accepted.isError).toBe(false);
		expect(accepted.details).not.toHaveProperty("native");
		expect(readFileSync(accepted.details.fullOutputPath!, "utf8")).toHaveLength(16777216);
		const items = await execute('for(let i=0;i<100000;i++) console.log("");');
		expect(items.isError).toBe(false);
		const excess = await execute('for(let i=0;i<100001;i++) console.log("");');
		expect(excess.isError).toBe(true);
		expect(text(excess)).toContain("script output exceeded");
	});
});
