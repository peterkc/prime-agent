import { readFileSync } from "node:fs";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { conversationMessages, createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

const MODELS = [
	{ id: "faux-1", name: "One", reasoning: true },
	{ id: "faux-2", name: "Two", reasoning: true },
	{ id: "faux-3", name: "Three", reasoning: true },
];

type Deferred<T = void> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function createDeferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHeartbeat(): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "Check whether the long-running task needs another step.",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 2,
	};
}

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			const h = harnesses.pop()!;
			h.session.dispose();
			h.cleanup();
		}
	});

	const secret = "dummy-secret-value-0123456789abcdef";
	async function secretHarness(
		factory: ExtensionFactory,
		execute: AgentTool["execute"] = async () => ({
			content: [{ type: "text", text: secret }],
			details: { value: secret },
		}),
		abortResultGraceMs?: number,
	) {
		const echo = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({ required: Type.String() }),
			execute,
			abortResultGraceMs,
		};
		const h = await createHarness({
			tools: [],
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerTool(echo);
					return factory(pi);
				},
			],
		});
		harnesses.push(h);
		return h;
	}
	async function secretSdkSession(h: Harness) {
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			model: h.getModel(),
			modelRegistry: h.session.modelRegistry,
			authStorage: h.authStorage,
			settingsManager: h.settingsManager,
			sessionManager: h.sessionManager,
			resourceLoader: h.session.resourceLoader,
			tools: ["echo"],
			includeGoals: false,
		});
		return session;
	}
	function secretConnection(h: Harness) {
		return new InProcessAgentConnection({
			session: h.session,
			setRebindSession: () => {},
		} as unknown as AgentSessionRuntime);
	}
	async function secretTurn(
		h: Harness,
		name = "echo",
		args: Record<string, unknown> = { required: "ok" },
		resume = false,
	) {
		let request: unknown;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			(ctx) => {
				request = structuredClone(ctx.messages.filter((m) => m.role === "toolResult"));
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("run");
		if (resume) await h.session.prompt("resume");
		const ends = h.eventsOfType("tool_execution_end").map((e) => e.result);
		const messages = h
			.eventsOfType("message_end")
			.flatMap((e) =>
				e.message.role === "toolResult" ? [{ content: e.message.content, details: e.message.details }] : [],
			);
		const saved = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((e) => e.type === "message" && e.message.role === "toolResult")
			.map((e) => ({ content: e.message.content, details: e.message.details }));
		expect(ends.length).toBeGreaterThan(0);
		expect(messages.length).toBe(ends.length);
		expect(saved.length).toBe(ends.length);
		expect(request).toBeDefined();
		return { ends, messages, saved, request };
	}
	it("TM-20 shares the union across sessions, rebuilds and reload, rejects atomically and releases sinks", async () => {
		let pi!: ExtensionAPI;
		const retired = "retired-fake-1234",
			rotated = "rotated-fake-5678",
			rejected = "rejected-fake-9012";
		const h = await secretHarness(
			(api) => {
				pi = api;
				api.registerSecretValues([{ label: "old", value: retired }]);
			},
			async () => ({ content: [{ type: "text", text: `${retired} ${rotated} ${rejected}` }], details: {} }),
		);
		const original = h.session,
			second = await secretSdkSession(h);
		second.subscribe((event) => h.events.push(event));
		const runtime = original.resourceLoader.getExtensions().runtime;
		try {
			expect(() =>
				pi.registerSecretValues([
					{ label: "bad", value: rejected },
					{ label: "", value: secret },
				]),
			).toThrow("entry 1");
			const unused = async () => {
				throw new Error("unused");
			};
			h.session.setRlmHeartbeatController({
				listRlmHeartbeats: () => [],
				createRlmHeartbeat: unused,
				updateRlmHeartbeat: unused,
				deleteRlmHeartbeat: unused,
			});
			const streamSimple = getApiProvider(h.faux.api)!.streamSimple;
			await h.session.reload();
			pi.registerProvider(h.getModel().provider, { api: h.faux.api, streamSimple });
			pi.registerSecretValues([{ label: "new", value: rotated }]);
			pi.registerSecretValues([{ label: "new", value: rotated }]);
			for (const session of [original, second]) {
				h.session = session;
				const output = await secretTurn(h);
				for (const sink of Object.values(output))
					expect(JSON.stringify(sink)).toContain("[old] [new] rejected-fake-9012");
			}
			expect(runtime.secretValueSinks.size).toBe(2);
			original.dispose();
			expect(runtime.secretValueSinks.size).toBe(1);
		} finally {
			second.dispose();
			h.session = original;
		}
		expect(runtime.secretValueSinks.size).toBe(0);
	});
	it("TM-21 TM-23 TM-25 masks final output and message_end rewrites while withholding split updates", async () => {
		const seen: string[] = [];
		const h = await secretHarness(
			(pi) => {
				pi.registerSecretValues([{ label: "fake", value: secret }]);
				pi.on("tool_execution_end", (event) => void seen.push(JSON.stringify(event)));
				pi.on("message_start", (event) => void seen.push(JSON.stringify(event)));
				pi.on("turn_end", (event) => void seen.push(JSON.stringify(event)));
				pi.on("agent_end", (event) => void seen.push(JSON.stringify(event)));
				pi.on("message_end", (event) => {
					seen.push(JSON.stringify(event));
					return event.message.role === "toolResult"
						? {
								message: {
									...event.message,
									content: [{ type: "text", text: `rewrite ${secret}` }],
									details: { rewrite: secret },
								},
							}
						: undefined;
				});
			},
			async (_id, _args, _signal, update) => {
				update?.({ content: [{ type: "text", text: secret.slice(0, 6) }], details: {} });
				update?.({ content: [{ type: "text", text: secret.slice(6) }], details: {} });
				return { content: [{ type: "text", text: secret }], details: { value: secret } };
			},
		);
		const output = await secretTurn(h);
		expect(output.ends[0]).toMatchObject({ content: [{ text: "[fake]" }], details: { value: "[fake]" } });
		for (const sink of [output.messages, output.saved])
			expect(sink).toMatchObject([{ content: [{ text: "rewrite [fake]" }], details: { rewrite: "[fake]" } }]);
		expect(JSON.stringify(output)).not.toContain(secret);
		expect(JSON.stringify(output.request)).toContain("[fake]");
		expect(seen.join()).toContain("[fake]");
		expect(seen.join()).not.toContain(secret);
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(h.eventsOfType("tool_execution_update")).toEqual([]);
		let later: unknown;
		h.setResponses([
			(ctx) => {
				later = ctx.messages;
				return fauxAssistantMessage("later");
			},
		]);
		await h.session.prompt("later");
		expect(JSON.stringify(later)).toContain("rewrite [fake]");
		expect(JSON.stringify(later)).not.toContain(secret);
	});
	it.each(["unknown", "bad args", "block", "abort"])("TM-22 masks immediate %s results", async (kind) => {
		const h = await secretHarness(
			(pi) => {
				pi.registerSecretValues([
					{ label: "fake", value: secret },
					{ label: "abort", value: "Request was aborted" },
				]);
				if (kind === "block") pi.on("tool_call", () => ({ block: true, reason: secret }));
			},
			async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
		);
		if (kind === "abort")
			h.session.agent.beforeToolCall = async () => {
				h.session.requestAbort();
				return undefined;
			};
		const output =
			kind === "abort"
				? await secretTurn(h, "echo", { required: "ok" }, true)
				: await secretTurn(
						h,
						kind === "unknown" ? secret : "echo",
						kind === "bad args" ? { required: { fake: secret } } : { required: "ok" },
					);
		for (const sink of [output.ends, output.messages, output.saved]) {
			expect(JSON.stringify(sink)).toContain(kind === "abort" ? "[abort]" : "[fake]");
			expect(JSON.stringify(sink)).not.toContain(secret);
		}
	});
	it("TM-22 masks the executed result retained after a tool_result abort deadline", async () => {
		const started = createDeferred(),
			release = createDeferred();
		let h: Harness;
		h = await secretHarness(
			(pi) => {
				pi.registerSecretValues([{ label: "fake", value: secret }]);
				pi.on("tool_result", async () => {
					h.session.requestAbort();
					started.resolve();
					await release.promise;
				});
			},
			undefined,
			1,
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = secretTurn(h, "echo", { required: "ok" }, true);
		try {
			await started.promise;
			await vi.advanceTimersByTimeAsync(1);
			const output = await running;
			for (const sink of Object.values(output)) {
				expect(JSON.stringify(sink)).toContain("[fake]");
				expect(JSON.stringify(sink)).not.toContain(secret);
			}
		} finally {
			release.resolve();
			vi.useRealTimers();
			await running;
		}
	});

	it.each(["message_end", "tool_execution_end"] as const)(
		"TM-29 masks context requests and client snapshots while %s waits",
		async (kind) => {
			const started = createDeferred(),
				release = createDeferred(),
				requested = createDeferred();
			let completed = false,
				captured: unknown;
			const h = await secretHarness((pi) => {
				pi.registerSecretValues([{ label: "fake", value: secret }]);
				const hold = async () => {
					started.resolve();
					await release.promise;
					completed = true;
				};
				if (kind === "message_end")
					pi.on(kind, (event) => (event.message.role === "toolResult" ? hold() : undefined));
				else pi.on(kind, hold);
				pi.on("context", (event) => ({
					messages: event.messages.map((m) =>
						m.role === "toolResult"
							? { ...m, content: [{ type: "text", text: `context ${secret}` }], details: { value: secret } }
							: m,
					),
				}));
			});
			const original = h.session;
			const session = await secretSdkSession(h);
			h.session = session;
			await session.bindExtensions({});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { required: "ok" }), { stopReason: "toolUse" }),
				(ctx) => {
					captured = structuredClone(ctx.messages.filter((m) => m.role === "toolResult"));
					requested.resolve();
					return fauxAssistantMessage("done");
				},
			]);
			const connection = secretConnection(h);
			const running = h.session.prompt(secret);
			try {
				await started.promise;
				await requested.promise;
				expect(completed).toBe(false);
				expect(captured).toMatchObject([{ content: [{ text: "context [fake]" }], details: { value: "[fake]" } }]);
				const messages = await connection.getMessages();
				expect(messages.filter((m) => m.role === "toolResult")).toMatchObject([
					{ content: [{ text: "[fake]" }], details: { value: "[fake]" } },
				]);
				expect(getMessageText(messages.find((m) => m.role === "user"))).toBe(secret);
			} finally {
				release.resolve();
				await running;
				original.dispose();
			}
		},
	);

	it.each([
		["split around an image", [secret.slice(0, 17), "image", secret.slice(17), "plain"], ["[fake]plain", "image"]],
		["whole parts", [secret, "image", "plain"], ["[fake]", "image", "plain"]],
	])("TM-21 matches text parts as one text: %s", async (_name, parts, expected) => {
		const image = { type: "image" as const, mimeType: "image/png", data: "ZHVtbXk=" };
		const content = (texts: string[]) =>
			texts.map((text) => (text === "image" ? image : { type: "text" as const, text }));
		const h = await secretHarness(
			(pi) => pi.registerSecretValues([{ label: "fake", value: secret }]),
			async () => ({ content: content(parts), details: {} }),
		);
		const output = await secretTurn(h);
		for (const sink of Object.values(output)) expect(sink).toMatchObject([{ content: content(expected) }]);
	});
	it.each(["tool_result", "tool_execution_end"] as const)(
		"TM-21 TM-23 masks %s handlers and forwarded error message and stack",
		async (kind) => {
			const seen: unknown[] = [],
				errors: unknown[] = [];
			const h = await secretHarness((pi) => {
				pi.registerSecretValues([{ label: "fake", value: secret }]);
				const fail = (value: unknown) => {
					seen.push(value);
					throw new Error(`${secret}: ${JSON.stringify(value)}`);
				};
				if (kind === "tool_result") pi.on(kind, (event) => fail(event.content));
				else pi.on(kind, (event) => fail(event.result.content));
			});
			await h.session.bindExtensions({ onError: (error) => errors.push(error) });
			await secretTurn(h);
			expect(JSON.stringify(seen)).toContain("[fake]");
			expect(JSON.stringify(seen)).not.toContain(secret);
			expect
				.soft(errors)
				.toMatchObject([
					{ error: expect.stringContaining("[fake]"), stack: expect.stringContaining("Error: [fake]") },
				]);
			expect.soft(JSON.stringify(errors)).not.toContain(secret);
			const client: unknown[] = [],
				connection = secretConnection(h);
			connection.subscribe((event) => {
				if (event.type === "extension_error") client.push(event);
			});
			await connection.bindHeadlessExtensions();
			await secretTurn(h);
			expect(client).toMatchObject([
				{ type: "extension_error", event: kind, error: expect.stringContaining("[fake]") },
			]);
			expect(JSON.stringify(client)).not.toContain(secret);
		},
	);
	it.each(["compaction", "refinement", "auto-review"])(
		"TM-30 late registration masks %s requests and session state, not the file",
		async (kind) => {
			let api!: ExtensionAPI;
			const h = await secretHarness((pi) => {
				api = pi;
				pi.on("session_before_compact", () => pi.registerSecretValues([{ label: "late", value: secret }]));
			});
			h.settingsManager.applyOverrides({
				autoRefine: { enabled: false },
				compaction: { enabled: false, keepRecentTokens: 1 },
			});
			await secretTurn(h);
			await secretTurn(h);
			if (kind !== "compaction") api.registerSecretValues([{ label: "late", value: secret }]);
			const captured: unknown[] = [];
			h.setResponses(
				[1, 2].map(() => (ctx) => {
					captured.push(structuredClone(ctx.messages));
					return fauxAssistantMessage(
						'{"summary":"none","rationale":"probe","expectedOutcome":"none","edits":[],"shouldRefine":false}',
					);
				}),
			);
			if (kind === "compaction") await h.session.compact();
			else if (kind === "refinement") await h.session.refine({});
			else {
				h.settingsManager.applyOverrides({ autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } });
				await h.session.disposeAsync({ kernelSnapshot: false });
			}
			expect(captured).toHaveLength(kind === "compaction" ? 2 : 1);
			expect(JSON.stringify(captured)).toContain("[late]");
			expect(JSON.stringify(captured)).not.toContain(secret);
			expect(JSON.stringify(h.session.messages)).not.toContain(secret);
			expect(readFileSync(h.session.sessionFile!, "utf8")).toContain(secret);
		},
	);

	it("TM-30 late registration masks tool results and send receipts that tree navigation restores", async () => {
		let api!: ExtensionAPI;
		const h = await secretHarness((pi) => {
			api = pi;
		});
		await secretTurn(h);
		const late = {
			id: "agentmsg_1",
			message: secret,
			deliveryStatus: "delivered",
			target: { activeSessionId: "a", sessionId: "s" },
		};
		h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "ipython_1",
			toolName: "ipython",
			content: [],
			isError: false,
			timestamp: 0,
		});
		h.sessionManager.appendCustomEntry("ipython_sent_agent_message", { toolCallId: "ipython_1", message: late });
		const leaf = h.sessionManager.getLeafId()!;
		const user = h.sessionManager.getEntries().find((e) => e.type === "message" && e.message.role === "user")!;
		await h.session.navigateTree(user.id, { summarize: false });
		api.registerSecretValues([{ label: "late", value: secret }]);
		await h.session.navigateTree(leaf, { summarize: false });
		expect(JSON.stringify(h.session.messages)).toContain('"id":"agentmsg_1","message":"[late]"');
		expect(JSON.stringify(h.session.messages)).not.toContain(secret);
	});

	/** Harness whose model_select handler blocks until the returned deferred is resolved. */
	async function createSlowModelSelectHarness(options?: { nextTurnMessage?: string }): Promise<{
		harness: Harness;
		handlerStarted: Deferred;
		finishHandler: Deferred;
		handlerCompleted: () => boolean;
	}> {
		const handlerStarted = createDeferred();
		const finishHandler = createDeferred();
		let completed = false;
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						handlerStarted.resolve();
						await finishHandler.promise;
						completed = true;
						if (options?.nextTurnMessage) {
							await pi.sendMessage(
								{ customType: "model-context", content: options.nextTurnMessage, display: false },
								{ deliverAs: "nextTurn" },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, handlerStarted, finishHandler, handlerCompleted: () => completed };
	}

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it.each(["set", "cycle"] as const)(
		"applies a %s model switch before slow model_select handlers finish",
		async (kind) => {
			const { harness, handlerStarted, finishHandler, handlerCompleted } = await createSlowModelSelectHarness();

			if (kind === "set") {
				await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
			} else {
				const result = await harness.session.cycleModel("forward", { waitForExtensions: false });
				expect(result?.model.id).toBe("faux-2");
			}
			await handlerStarted.promise;

			expect(harness.session.model?.id).toBe("faux-2");
			expect(handlerCompleted()).toBe(false);

			finishHandler.resolve();
			await flushAsyncWork();

			expect(handlerCompleted()).toBe(true);
		},
	);

	it("serializes nonblocking model_select handlers across quick switches", async () => {
		const firstHandlerStarted = createDeferred();
		const finishFirstHandler = createDeferred();
		const events: string[] = [];
		const harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							firstHandlerStarted.resolve();
							await finishFirstHandler.promise;
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await firstHandlerStarted.promise;
		await harness.session.setModel(harness.getModel("faux-3")!, { waitForExtensions: false });
		await flushAsyncWork();

		expect(harness.session.model?.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2"]);

		finishFirstHandler.resolve();
		await flushAsyncWork();
		await flushAsyncWork();

		expect(events).toEqual(["start:faux-2", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("queues cycle model_select handlers behind pending nonblocking switches", async () => {
		const firstHandlerStarted = createDeferred();
		const finishFirstHandler = createDeferred();
		const events: string[] = [];
		const harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							firstHandlerStarted.resolve();
							await finishFirstHandler.promise;
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await firstHandlerStarted.promise;

		let cycleResolved = false;
		const cycle = harness.session.cycleModel().then((result) => {
			cycleResolved = true;
			return result;
		});
		await flushAsyncWork();

		expect(cycleResolved).toBe(false);
		expect(events).toEqual(["start:faux-2"]);

		finishFirstHandler.resolve();
		const result = await cycle;

		expect(result?.model.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("waits for pending model_select handlers before starting the next prompt", async () => {
		const { harness, handlerStarted, finishHandler } = await createSlowModelSelectHarness();
		harness.setResponses([fauxAssistantMessage("after model select")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		await handlerStarted.promise;

		const prompt = harness.session.prompt("hi");
		await flushAsyncWork();

		expect(getAssistantTexts(harness)).not.toContain("after model select");

		finishHandler.resolve();
		await prompt;

		expect(getAssistantTexts(harness)).toContain("after model select");
	});

	it.each([
		["a user prompt", (harness: Harness) => harness.session.prompt("hi"), { role: "user", text: "hi" }],
		[
			"an accepted agent-message prompt",
			(harness: Harness) =>
				harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false }),
			{ role: "user", text: "agent-to-agent payload" },
		],
		[
			"an injected heartbeat prompt",
			(harness: Harness) => harness.session.promptHeartbeat(createHeartbeat()),
			{
				role: "custom",
				text: "[heartbeat: every 5m run#2]\n\nCheck whether the long-running task needs another step.",
			},
		],
	])(
		"delivers nextTurn messages queued by pending model_select handlers before %s",
		async (_name, start, expected) => {
			const { harness, handlerStarted, finishHandler } = await createSlowModelSelectHarness({
				nextTurnMessage: "model context",
			});
			harness.setResponses([fauxAssistantMessage("after model context")]);

			await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
			await handlerStarted.promise;

			const started = start(harness);
			await flushAsyncWork();

			// The turn must not open while a model_select handler is still pending.
			expect(conversationMessages(harness.session)).toHaveLength(0);

			finishHandler.resolve();
			await started;
			await harness.session.agent.waitForIdle();

			expect(
				conversationMessages(harness.session)
					.slice(0, 2)
					.map((message) => ({ role: message.role, text: getMessageText(message) })),
			).toEqual([{ role: "custom", text: "model context" }, expected]);
			expect(getAssistantTexts(harness)).toContain("after model context");
		},
	);

	it("keeps streaming injected prompts under turn admission when the turn becomes idle", async () => {
		const toolStarted = createDeferred();
		const finishTool = createDeferred();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("heartbeat"),
		]);

		const turn = harness.session.prompt("start");
		await toolStarted.promise;
		await harness.session.promptHeartbeat(createHeartbeat(), { streamingBehavior: "followUp" });

		finishTool.resolve();
		await turn;
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["", "turn complete", "heartbeat"]);
	});

	it("allows model_select handlers to enqueue user messages without waiting on themselves", async () => {
		const harness = await createHarness({
			models: MODELS.slice(0, 2),
			extensionFactories: [
				(pi) => {
					pi.on("model_select", () => {
						pi.sendUserMessage("from model_select");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued from hook")]);

		await harness.session.setModel(harness.getModel("faux-2")!, { waitForExtensions: false });
		for (let i = 0; i < 5 && !getAssistantTexts(harness).includes("queued from hook"); i++) {
			await flushAsyncWork();
		}

		expect(getAssistantTexts(harness)).toContain("queued from hook");
	});

	it("allows model_select handlers to switch models without waiting on themselves", async () => {
		const events: string[] = [];
		let harness: Harness;
		harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						events.push(`start:${event.model.id}`);
						if (event.model.id === "faux-2") {
							await harness.session.setModel(harness.getModel("faux-3")!);
							events.push("nested-returned");
						}
						events.push(`end:${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		for (let i = 0; i < 5 && !events.includes("end:faux-3"); i++) {
			await flushAsyncWork();
		}

		expect(harness.session.model?.id).toBe("faux-3");
		expect(events).toEqual(["start:faux-2", "nested-returned", "end:faux-2", "start:faux-3", "end:faux-3"]);
	});

	it("cycles through scoped models and clamps thinking to model capabilities", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		harness.session.setScopedModels([
			{ model: harness.getModel("faux-1")!, thinkingLevel: "high" },
			{ model: harness.getModel("faux-2")! },
		] as Array<{ model: Model<string>; thinkingLevel?: ThinkingLevel }>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({ models: MODELS.slice(0, 2), withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: { customType: "before-start", content: "injected", display: true, details: {} },
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
