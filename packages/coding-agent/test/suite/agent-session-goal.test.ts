import { existsSync } from "node:fs";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import {
	createGoalContextMessage,
	emptyGoalState,
	GOAL_STATE_CUSTOM_TYPE,
	GOAL_USER_STOP_PAUSE_REASON,
	type GoalStatus,
} from "../../src/core/goals.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import {
	conversationMessages,
	createHarness,
	getAssistantTexts,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "./harness.js";

function assistantWithUsage(message: string | AssistantMessage, usage: Partial<Usage>): AssistantMessage {
	const base = typeof message === "string" ? fauxAssistantMessage(message) : message;
	return {
		...base,
		usage: { ...base.usage, ...usage, cost: { ...base.usage.cost, ...usage.cost } },
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function visibleAssistantTexts(harness: Harness): string[] {
	return getAssistantTexts(harness).filter(Boolean);
}

function currentAgentContext(harness: Harness): AgentContext {
	const state = harness.session.agent.state;
	return {
		systemPrompt: state.systemPrompt,
		messages: [...state.messages],
		tools: [...state.tools],
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

/**
 * Stand-in for the real ipython tool. Goal calls reach the host over the
 * kernel comm bridge while an ipython cell executes; this stub mirrors that
 * timing by dispatching `goal.*` host requests from inside tool execution.
 *
 * Cell format: `goal.<op>` optionally followed by a JSON payload, e.g.
 * `goal.create {"objective": "write a note"}`.
 */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) {
				throw new Error("test session is not initialized");
			}
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

const COMPLETE_GOAL_CELL = { code: "goal.complete" };

function completeGoalResponses(): AssistantMessage[] {
	return [
		fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
		fauxAssistantMessage("Goal complete."),
	];
}

function createWaitingTool(): {
	tool: AgentTool;
	release: () => void;
	waitForStart: (harness: Harness) => Promise<void>;
} {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const abort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				toolRelease.then(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
			return { content: [{ type: "text", text: "released" }], details: {}, terminate: true };
		},
	};
	return {
		tool,
		release: () => releaseToolExecution?.(),
		waitForStart: (harness) =>
			new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "wait") {
						unsubscribe();
						resolve();
					}
				});
			}),
	};
}

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(
		extraTools: AgentTool[] = [],
		settings?: HarnessOptions["settings"],
	): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef), ...extraTools], settings });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("keeps continuing until the model completes the goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			...completeGoalResponses(),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toMatch(/^\[goal: continuation\]\n\n/);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns goal snapshots over the host bridge and allows a fresh goal after completion", async () => {
		const harness = await createGoalHarness();

		expect(harness.session.handleGoalHostRequest("goal.get")).toEqual({
			goal: null,
			remaining_tokens: null,
			completion_budget_report: null,
		});

		const created = harness.session.handleGoalHostRequest("goal.create", {
			objective: "write a benchmark note",
			token_budget: 50,
		});
		expect(created.goal).toMatchObject({
			objective: "write a benchmark note",
			status: "active",
			token_budget: 50,
			tokens_used: 0,
		});
		expect(created.remaining_tokens).toBe(50);

		const completed = harness.session.handleGoalHostRequest("goal.complete");
		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(completed.completion_budget_report).toContain("tokens used: 0 of 50");

		const second = harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" });
		expect(second.goal).toMatchObject({ objective: "second goal", status: "active", tokens_used: 0 });
		expect(second.goal?.goal_id).not.toBe(created.goal?.goal_id);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "second goal",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "goal.create without an objective",
			type: "goal.create",
			payload: {},
			active: false,
			error: "goal.create objective must be a string",
		},
		{
			name: "an unknown request type",
			type: "goal.nonsense",
			payload: {},
			active: false,
			error: 'unknown goal request type "goal.nonsense"',
		},
		{
			name: "goal.complete without a goal",
			type: "goal.complete",
			payload: {},
			active: false,
			error: "cannot complete goal because this thread has no goal",
		},
		{
			name: "goal.create while a goal is active",
			type: "goal.create",
			payload: { objective: "second" },
			active: true,
			error: "already has an active goal",
		},
	])("rejects $name", async ({ type, payload, active, error }) => {
		const harness = await createGoalHarness();
		if (active) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		}

		expect(() => harness.session.handleGoalHostRequest(type, payload)).toThrow(error);
	});

	it("does not count post-completion turns against the finished goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 4, output: 2, totalTokens: 6 },
			),
			assistantWithUsage("Goal complete; here is a long closing summary.", {
				input: 20,
				output: 10,
				totalTokens: 30,
			}),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState.status).toBe("complete");
		const completeUpdates = harness.eventsOfType("goal_update").filter((event) => event.goal.status === "complete");
		const tokensAtCompletion = completeUpdates[0]?.goal.tokensUsed ?? 0;
		expect(tokensAtCompletion).toBeGreaterThan(0);
		// The closing-summary turn runs after goal.complete() over the host bridge;
		// it must not increase the finished goal's token usage.
		expect(harness.session.goalState.tokensUsed).toBe(tokensAtCompletion);
	});

	it.each([
		{ name: "without an active goal", withGoal: false, expected: [] as string[] },
		{ name: "with an active goal", withGoal: true, expected: ["ipython"] },
	])("runtime rebuild restores tools $name", async ({ withGoal, expected }) => {
		const harness = await createGoalHarness();
		if (withGoal) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		} else {
			harness.session.setActiveToolsByName([]);
		}

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual(expected);
	});

	it("reloads goal state after tree navigation", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([fauxAssistantMessage("before goal")]);
		await harness.session.prompt("normal prompt");
		const beforeGoalEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!beforeGoalEntry) {
			throw new Error("expected assistant entry before goal");
		}

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
	});

	it.each([
		{ command: "/goal clear", status: "idle" },
		{ command: "/goal pause", status: "paused" },
	])("removes queued goal context after $command while streaming", async ({ command, status }) => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale goal response"),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("start a blocking turn");
		await waitForStart;
		await harness.session.prompt("/goal stale goal");
		await harness.session.prompt(command);
		waiting.release();
		await promptPromise;

		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(visibleAssistantTexts(harness)).toEqual([]);
		expect(harness.session.goalState.status).toBe(status);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses a goal, rejects a replacement, then resumes it with /goal resume", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "Paused by user",
		});
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "replacement" })).toThrow(
			"a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
		);

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "completed",
			status: "complete",
			start: async (harness: Harness) => {
				harness.setResponses([...completeGoalResponses(), fauxAssistantMessage("should not run")]);
				await harness.session.prompt("/goal finish the task");
			},
			expected: {},
		},
		{
			name: "errored",
			status: "error",
			start: async (harness: Harness) => {
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
					fauxAssistantMessage("should not run"),
				]);
				await harness.session.prompt("/goal do work");
			},
			expected: { lastError: "invalid_api_key\n\nRun /login to update credentials." },
		},
	])("does not resume a $name goal", async ({ status, start, expected }) => {
		const harness = await createGoalHarness([], { retry: { enabled: false } });
		await start(harness);

		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({ active: false, status, ...expected });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["/goal clear", "/goal status"])("runs %s without consuming a provider response", async (command) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt(command);

		expect(
			conversationMessages(harness.session).map((message) =>
				message.role === "custom" ? message.customType : message.role,
			),
		).toEqual(["session_slash_command", "session_slash_command_result"]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["/goal --budget=1abc task", "/goal --budget 1.5 task", "/goal --budget 1e6 task"])(
		"rejects malformed goal budget %s",
		async (command) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);

			await harness.session.prompt(command);

			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "custom",
				customType: "session_slash_command_result",
				details: { success: false, error: "Goal token budget must be a positive integer." },
			});
			expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await harness.session.prompt("/goal do task");

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "session_slash_command_result",
			details: { success: false },
		});
	});

	it("completes a goal whose completing turn crosses the budget without a stale budget-limit steer", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 6, output: 5, totalTokens: 11 },
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal --budget 10 finish the task");

		const contextKinds = goalContextMessages(harness).map(
			(message) => (message as { details?: { kind?: string } }).details?.kind,
		);
		expect(contextKinds).not.toContain("budget_limit");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			tokenBudget: 10,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("checks goal budget before continuation while event processing is delayed", async () => {
		let releaseMessageEnd: (() => void) | undefined;
		const blockedMessageEnd = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let didBlock = false;
		const extension: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !didBlock) {
					didBlock = true;
					await blockedMessageEnd;
				}
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
			fauxAssistantMessage("Should not continue."),
		]);

		const promptPromise = harness.session.prompt("/goal --budget 10 do work");
		try {
			await waitForCondition(() => harness.session.goalState.status === "budget_limited");
		} finally {
			releaseMessageEnd?.();
		}
		await promptPromise;
		await harness.session.waitForIdle();
		await vi.waitFor(() => expect(visibleAssistantTexts(harness)).toHaveLength(2));

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
	});

	describe("pi-9waqh user-stop goal pause", () => {
		async function blockedGoal(options: HarnessOptions = {}, status: GoalStatus = "active") {
			const waiting = createWaitingTool();
			const sessionRef: { current?: AgentSession } = {};
			const tools = [createFauxIpythonTool(sessionRef), waiting.tool];
			let harness = await createHarness({
				...options,
				persistSession: status !== "active" || options.persistSession,
				tools,
			});
			sessionRef.current = harness.session;
			harnesses.push(harness);
			if (status === "paused") {
				harness.session.handleGoalHostRequest("goal.create", { objective: "existing task" });
				await harness.session.prompt("/goal pause");
			} else if (status !== "active") {
				harness.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
					...emptyGoalState(),
					status,
					objective: status === "idle" ? undefined : "existing task",
					lastReason: "existing reason",
				});
				harness.sessionManager.flushNow();
				const existingSessionFile = harness.sessionManager.getSessionFile();
				if (!existingSessionFile) throw new Error("missing goal fixture session");
				harness = await createHarness({ existingSessionFile, tools });
				sessionRef.current = harness.session;
				harnesses.push(harness);
			}
			harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
			const started = waiting.waitForStart(harness);
			const running = harness.session.prompt(status === "active" ? "/goal finish the task" : "ordinary work");
			await started;
			return { harness, running };
		}

		async function stoppedGoal(options: HarnessOptions = {}) {
			const { harness, running } = await blockedGoal(options);
			await harness.session.abort({ userStop: true });
			await running;
			return harness;
		}

		function expectStopPaused(harness: Harness) {
			expect(harness.session.goalState).toMatchObject({
				status: "paused",
				active: false,
				lastReason: GOAL_USER_STOP_PAUSE_REASON,
			});
		}

		it("pi-9waqh pauses an active goal and removes queued continuation on user stop", async () => {
			const { harness, running } = await blockedGoal();
			await harness.session.sendCustomMessage(createGoalContextMessage(harness.session.goalState, "continuation"), {
				deliverAs: "followUp",
			});
			await harness.session.abort({ userStop: true });
			await running;
			await harness.session.waitForSessionInputIdle();

			expectStopPaused(harness);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
			expect(goalContextMessages(harness)).toHaveLength(1);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		});

		it("pi-9waqh still stops active work if goal-pause persistence fails", async () => {
			const { harness, running } = await blockedGoal();
			const flush = vi.spyOn(harness.sessionManager, "flushNow").mockImplementationOnce(() => {
				throw new Error("goal pause flush failed");
			});
			try {
				await expect(harness.session.abort({ userStop: true })).resolves.toBeUndefined();
				await running;
				expectStopPaused(harness);
				expect(harness.session.isStreaming).toBe(false);
			} finally {
				flush.mockRestore();
				await harness.session.abort();
				await running;
			}
		});

		const heartbeat: AgentCronJob = {
			id: "stop-heartbeat",
			status: "active",
			source: "heartbeat",
			activeSessionId: "test",
			sessionId: "test",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp",
			prompt: "check progress",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			runCount: 0,
		};

		it.each(["agent steer", "bash notice", "heartbeat", "extension custom", "extension user"] as const)(
			"pi-9waqh keeps a stopped goal paused after %s",
			async (input) => {
				const harness = await stoppedGoal();
				harness.setResponses([fauxAssistantMessage("input handled")]);
				if (input === "agent steer") {
					const payload: AgentSessionMessagePayload = {
						id: "agentmsg_stop-steer",
						source: AGENT_MESSAGE_SOURCE,
						message: "FYI",
						target: { activeSessionId: "test", sessionId: harness.session.sessionId },
					};
					await expect(
						harness.session.acceptAgentMessagePrompt(createAgentSessionMessagePrompt(payload), {
							customMessage: createAgentSessionMessage(payload),
							streamingBehavior: "steer",
							queueIfBusy: true,
						}),
					).rejects.toThrow("queued session input is suspended");
				} else if (input === "bash notice") {
					const host = harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers };
					await host._createKernelHostHandlers()["bash.completed"]!({
						pid: 42,
						command: "echo done",
						exitCode: 0,
					});
				} else if (input === "heartbeat") {
					await harness.session.promptHeartbeat(heartbeat);
				} else if (input === "extension custom") {
					await harness.session.sendCustomMessage(
						{ customType: "extension", content: "FYI", display: true },
						{ triggerTurn: true },
					);
				} else {
					await harness.session.sendUserMessage("extension input");
				}
				await harness.session.waitForSessionInputIdle();
				expectStopPaused(harness);
				expect(goalContextMessages(harness)).toHaveLength(1);
				expect(harness.session.goalState.continuationsUsed).toBe(0);
			},
		);

		it.each(["interactive", "rpc"] as const)(
			"pi-9waqh resumes on a %s prompt without a goal run ahead of it",
			async (source) => {
				const harness = await stoppedGoal();
				expectStopPaused(harness);
				harness.setResponses([
					(context) => {
						expect(harness.session.goalState.status).toBe("active");
						expect(getMessageText(context.messages.at(-1))).toBe("user interjection");
						return fauxAssistantMessage("interjection answered");
					},
					...completeGoalResponses(),
				]);
				await harness.session.prompt("user interjection", { source });
				expect(visibleAssistantTexts(harness)).toEqual(["interjection answered", "Goal complete."]);
				expect(harness.session.goalState).toMatchObject({ status: "complete", continuationsUsed: 1 });
			},
		);

		it.each(["idle", "paused", "complete", "budget_limited", "error"] satisfies GoalStatus[])(
			"pi-9waqh leaves a %s goal unchanged through stop and prompt",
			async (status) => {
				const { harness, running } = await blockedGoal({}, status);
				const before = harness.session.goalState;
				await harness.session.abort({ userStop: true });
				await running;
				harness.setResponses([fauxAssistantMessage("new request answered")]);
				await harness.session.prompt("new request");
				expect(harness.session.goalState).toEqual(before);
			},
		);

		it.each(["compaction", "update restart", "extension"] as const)(
			"pi-9waqh leaves the goal active on %s abort",
			async (cause) => {
				let abortExtension: (() => void) | undefined;
				const { harness, running } = await blockedGoal({
					extensionFactories: [
						(pi) => {
							pi.on("before_agent_start", (_event, ctx) => {
								abortExtension = () => ctx.abort();
							});
						},
					],
				});
				if (cause === "update restart") harness.session.abortForUpdateRestart();
				else if (cause === "extension") {
					if (!abortExtension) throw new Error("extension context was not initialized");
					abortExtension();
				} else await harness.session.abort({ userStop: false });
				await running;
				expect(harness.session.goalState.status).toBe("active");
			},
		);

		it("pi-9waqh leaves an idle session's active goal unchanged on stop", async () => {
			const harness = await createGoalHarness();
			harness.session.handleGoalHostRequest("goal.create", { objective: "not started" });
			const before = harness.session.goalState;
			await harness.session.abort({ userStop: true });
			expect(harness.session.goalState).toEqual(before);
		});

		it("pi-9waqh persists a stop pause across reopen and resumes on the next prompt", async () => {
			const original = await stoppedGoal({ persistSession: true });
			const sessionFile = original.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("missing persisted session");
			const reopened = await createHarness({ existingSessionFile: sessionFile });
			harnesses.push(reopened);
			expectStopPaused(reopened);
			reopened.setResponses([
				(context) => {
					expect(reopened.session.goalState.status).toBe("active");
					expect(getMessageText(context.messages.at(-1))).toBe("new user prompt");
					reopened.session.handleGoalHostRequest("goal.complete");
					return fauxAssistantMessage("done after restart");
				},
			]);
			await reopened.session.prompt("new user prompt");
			expect(reopened.session.goalState.status).toBe("complete");
		});

		it("pi-9waqh keeps an explicit /goal pause after a stop paused", async () => {
			const harness = await stoppedGoal();
			await harness.session.prompt("/goal pause");
			harness.setResponses([fauxAssistantMessage("new request answered")]);
			await harness.session.prompt("new request");
			expect(harness.session.goalState).toMatchObject({ status: "paused", lastReason: "Paused by user" });
		});

		it.each(["resume", "clear"] as const)("pi-9waqh supports /goal %s after user stop", async (command) => {
			const harness = await stoppedGoal();
			harness.setResponses(completeGoalResponses());
			await harness.session.prompt(`/goal ${command}`);
			expect(harness.session.goalState.status).toBe(command === "resume" ? "complete" : "idle");
			expect(harness.getPendingResponseCount()).toBe(command === "resume" ? 0 : 2);
		});
	});

	it("lets the user abort a goal turn, prompt in between, then resume the goal", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.abort();
		await promptPromise;

		// An aborted provider turn leaves the goal active.
		expect(harness.session.goalState).toMatchObject({ active: true, status: "active" });

		harness.setResponses([fauxAssistantMessage("answered the interjection"), ...completeGoalResponses()]);
		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({ active: false, status: "complete" });
	});
});

describe("initial goal seeding from config", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Reopen the persisted session file with a fresh AgentSession, as a restart does. */
	function createRestartSession(harness: Harness): AgentSession {
		const sessionFile = harness.sessionManager.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(true);
		const newSessionManager = SessionManager.open(sessionFile);
		const model = harness.getModel();
		const newAuth = AuthStorage.inMemory();
		newAuth.setRuntimeApiKey(model.provider, "faux-key");

		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "faux-key",
				initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			}),
			sessionManager: newSessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRegistry: ModelRegistry.inMemory(newAuth),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			initialGoal: { objective: "Should not reseed" },
		});
	}

	it("seeds and persists an active goal from initialGoal config on a fresh top-level session", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "Write tests",
			tokenBudget: 50000,
		});
		// The goal reaches disk before the first prompt.
		expect(
			harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE),
		).toBeDefined();

		// The seeded goal context must reach the model before its first reply.
		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("hello");
		const messages = harness.session.messages;
		const firstContextIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		expect(firstContextIndex).toBeGreaterThanOrEqual(0);
		expect(firstContextIndex).toBeLessThan(messages.findIndex((message) => message.role === "assistant"));
		expect(getMessageText(messages[firstContextIndex])).toContain("Write tests");
		expect(currentAgentContext(harness).messages).toContain(messages[firstContextIndex]);
	});

	it("drops the seeded goal context when the goal is cleared before the first prompt", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("/goal clear");
		expect(harness.session.goalState.status).toBe("idle");

		await harness.session.prompt("hello");
		expect(goalContextMessages(harness)).toHaveLength(0);
	});

	it("does not seed initialGoal for subagent sessions (rlmDepth > 0)", async () => {
		const harness = await createHarness({
			persistSession: true,
			rlmDepth: 1,
			initialGoal: { objective: "Subagent goal" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState).toMatchObject({ status: "idle", active: false });
	});

	it.each([
		{
			name: "cleared",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				harness.setResponses([fauxAssistantMessage("unused")]);
				await harness.session.prompt("/goal clear");
				expect(harness.session.goalState.status).toBe("idle");
			},
			expected: { status: "idle", objective: undefined },
		},
		{
			name: "completed",
			objective: "Complete me",
			prepare: async (harness: Harness) => {
				harness.session.handleGoalHostRequest("goal.complete");
			},
			expected: { status: "complete", objective: "Complete me" },
		},
		{
			name: "used (the branch already has messages)",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				// Append directly so no autonomous goal continuation runs.
				harness.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "do something" }],
					timestamp: Date.now(),
				});
			},
			expected: { status: "active", objective: "Initial goal" },
		},
	])(
		"does not reseed initialGoal after the goal was $name (idempotent restart)",
		async ({ objective, prepare, expected }) => {
			const harness = await createHarness({ persistSession: true, initialGoal: { objective } });
			harnesses.push(harness);
			expect(harness.session.goalState.status).toBe("active");

			await prepare(harness);
			const restarted = createRestartSession(harness);

			try {
				expect(restarted.goalState.status).toBe(expected.status);
				expect(restarted.goalState.objective).toBe(expected.objective);
			} finally {
				restarted.dispose();
			}
		},
	);
});
