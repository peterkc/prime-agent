import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	type CodemodeHost,
	type CodemodeToolDetails,
	createCodemodeToolDefinition,
} from "../src/core/tools/codemode.js";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

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
		if (fixture.expected.fullText !== undefined)
			expect(readFileSync(result.details.fullOutputPath!, "utf8")).toBe(fixture.expected.fullText);
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
		expect(text(await execute("globalThis.leaked = 1; text(leaked);"))).toContain("1");
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

	it.each(["completed", "failed"])("TM-07 cancels an unawaited call when the script %s", async (end) => {
		const cancelled = deferred<void>();
		const never = deferred<AgentToolResult<unknown>>();
		const tool = stub("pending", async (_id, _args, signal) => {
			signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return never.promise;
		});
		try {
			const result = await execute(
				`tools.pending({value:"x"}); text("partial"); ${end === "failed" ? 'throw new Error("failure");' : ""}`,
				[tool],
			);
			await cancelled.promise;
			expect(result.isError).toBe(end === "failed");
			expect(text(result)).toContain("partial");
			expect(result.details.calls).toMatchObject([{ name: "pending", status: "cancelled" }]);
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
				vi.useFakeTimers();
				await vi.advanceTimersByTimeAsync(0);
				expect(starts).toEqual(["one"]);
				if (abort) controller.abort();
				else release.resolve(reply("one"));
				const result = await running;
				expect(starts).toEqual(abort ? ["one"] : ["one", "two"]);
				expect(result.details.calls.map((call) => call.status)).toEqual(
					abort ? ["cancelled", "cancelled"] : ["ok", "ok"],
				);
			} finally {
				vi.useRealTimers();
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
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir),
			tools,
			includeGoals: false,
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).toEqual(active);
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
});
