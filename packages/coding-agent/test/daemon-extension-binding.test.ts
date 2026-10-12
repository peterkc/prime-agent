import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";

import { SessionManager } from "../src/core/session-manager.js";
import type { QuestionnaireResult } from "../src/core/tools/questionnaire.js";
import type { ExtensionAPI, ExtensionFactory, RenderModeChangeEvent } from "../src/index.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState, reportRenderMode } from "../src/modes/daemon/daemon-extension-binding.js";
import { detachClientFromActiveSession } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon extension binding", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	function uiClient(id: string): DaemonSocketClient {
		const socket = new Socket();
		cleanups.push(() => {
			socket.destroy();
		});
		return {
			id,
			socket,
			attachedActiveSessionIds: new Set(["questionnaire"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["extension_ui", "questionnaire_ui"]),
		};
	}

	async function questionnaireState() {
		const runtime = await createRuntimeForTest(() => {}, []);
		const state: ActiveSessionState = {
			activeSessionId: "questionnaire",
			runtime,
			clients: new Set([uiClient("primary")]),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "form",
			lastEventSequence: 0,
		};
		return state;
	}
	const form = {
		questions: [
			{ id: "scope", prompt: "Choose scope", options: [{ value: "small", label: "Small" }], allowOther: false },
		],
	};

	it.each([
		[
			"unknown question",
			{
				status: "submitted",
				answers: { scope: { value: "small", wasCustom: false }, other: { value: "small", wasCustom: false } },
			},
		],
		["unknown option", { status: "submitted", answers: { scope: { value: "large", wasCustom: false } } }],
		["forbidden custom text", { status: "submitted", answers: { scope: { value: "custom", wasCustom: true } } }],
		["unanswered Submit", { status: "submitted", answers: {} }],
	] as const)("TM-16 cancels %s with an error and saves nothing submitted", async (_name, response) => {
		const state = await questionnaireState();
		const requests: DaemonOutbound[] = [];
		await bindActiveSessionState(state, {
			shutdown: () => {},
			broadcast: (_state, message) => {
				if (message.type !== "extension_ui_request") return;
				requests.push(message);
				state.extensionUiRequests.get(message.id)?.resolve(response);
			},
		});
		const tool = state.runtime.session.agent.state.tools.find((tool) => tool.name === "questionnaire");
		if (!tool) throw new Error("Questionnaire missing");
		const result = await tool.execute("malformed", form);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Invalid questionnaire reply") }]);
		expect(requests).toMatchObject([{ method: "questionnaire" }]);
		expect(
			state.runtime.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "questionnaire_retry_state"),
		).toEqual([]);
		expect(state.extensionUiRequests.size).toBe(0);
	});

	it.each(["client detached", "abort"])("TM-19 cancels a pending form on %s without submitting", async (change) => {
		const state = await questionnaireState();
		const controller = new AbortController();
		const methods: string[] = [];
		await bindActiveSessionState(state, {
			shutdown: () => {},
			broadcast: (_state, message) => {
				if (message.type !== "extension_ui_request") return;
				methods.push(message.method);
				if (message.method === "questionnaire") {
					if (change === "abort") controller.abort();
					else {
						state.clients.add(uiClient("remaining"));
						detachClientFromActiveSession([...state.clients][0], state);
					}
				} else if (message.method === "select")
					state.extensionUiRequests.get(message.id)?.resolve({ cancelled: true });
			},
		});
		const tool = state.runtime.session.agent.state.tools.find((tool) => tool.name === "questionnaire");
		if (!tool) throw new Error("Questionnaire missing");
		const result = await tool.execute("changed", form, controller.signal);
		expect(result.details as QuestionnaireResult).toMatchObject({ cancelled: true, answers: [] });
		expect(methods).toEqual(change === "abort" ? ["questionnaire"] : ["questionnaire", "select"]);
		expect(state.extensionUiRequests.size).toBe(0);
	});

	it("reports window render-mode changes once with the previous mode", async () => {
		const events: RenderModeChangeEvent[] = [];
		const runtime = await createRuntimeForTest((pi) => {
			pi.on("render_mode_change", (event) => {
				events.push(event);
			});
		}, []);
		const state: ActiveSessionState = {
			activeSessionId: "render",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "render",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, { broadcast: () => {}, shutdown: () => {} });
		const ui = runtime.session.extensionRunner.createContext().ui;
		expect(ui.getRenderMode()).toBeUndefined();
		reportRenderMode(state, "native");
		reportRenderMode(state, "native");
		reportRenderMode(state, "ansi");
		expect(ui.getRenderMode()).toBe("ansi");
		expect(events).toEqual([
			{ type: "render_mode_change", mode: "native", previousMode: undefined },
			{ type: "render_mode_change", mode: "ansi", previousMode: "native" },
		]);
	});

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});
});
