import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	createQuestionnaireToolDefinition,
	type QuestionnaireForm,
	type QuestionnaireOutcome,
	type QuestionnaireResult,
	type questionnaireSchema,
} from "../src/core/tools/questionnaire.js";
import { QuestionnaireComponent } from "../src/modes/interactive/components/questionnaire.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const questions = [
	{
		id: "scope",
		label: "Scope",
		prompt: "Choose scope",
		options: [
			{ value: "small", label: "Small", recommended: true },
			{ value: "large", label: "Large" },
		],
		allowOther: false,
	},
	{
		id: "priority",
		label: "Priority",
		prompt: "Choose priority",
		options: [{ value: "now", label: "Now" }],
		allowOther: true,
	},
];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sessionFor(factory?: ExtensionFactory) {
	const dir = mkdtempSync(join(tmpdir(), "prime-questionnaire-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const authStorage = AuthStorage.inMemory();
	const extensionsResult = await createTestExtensionsResult(factory ? [factory] : [], dir);
	const eventBus = createEventBus();
	const event = vi.fn();
	eventBus.on("questionnaire:needs_input", event);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: getCodingAgentFixtureModel("anthropic", "claude-sonnet-5") } }),
		cwd: dir,
		agentDir: dir,
		eventBus,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory(),
		modelRegistry: ModelRegistry.create(authStorage, join(dir, "models.json")),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		includeGoals: false,
	});
	cleanups.push(() => session.disposeAsync({ kernelSnapshot: false }));
	const ui = {
		...session.extensionRunner.createContext().ui,
		questionnaire: vi.fn<ExtensionUIContext["questionnaire"]>(async () => undefined),
		select: vi.fn<ExtensionUIContext["select"]>(async () => undefined),
		input: vi.fn<ExtensionUIContext["input"]>(async () => undefined),
		notify: vi.fn(),
	} satisfies ExtensionUIContext;
	await session.bindExtensions({ uiContext: ui });
	const entries = () =>
		session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "questionnaire_retry_state");
	const tool = session.agent.state.tools.find((tool) => tool.name === "questionnaire") as AgentTool<
		typeof questionnaireSchema,
		QuestionnaireResult
	>;
	if (!tool) throw new Error("Questionnaire missing");
	const execute = (form = { questions }, signal?: AbortSignal) => tool.execute("form", form, signal);

	return { session, ui, entries, event, execute };
}

function drive(form: QuestionnaireForm, keys: string[]): Promise<QuestionnaireOutcome> {
	initTheme("dark", false);
	const previous = getKeybindings();
	setKeybindings(
		new KeybindingsManager({
			"tui.select.confirm": "ctrl+s",
			"tui.select.down": "ctrl+n",
			"tui.input.tab": "ctrl+t",
			"tui.editor.cursorLeft": "ctrl+p",
		}),
	);
	return new Promise((resolve) => {
		const component = new QuestionnaireComponent(form, resolve);
		try {
			expect(component.render(80).join("\n")).toContain("Choose scope");
			for (const key of keys) component.handleInput(key);
		} finally {
			component.dispose();
			setKeybindings(previous);
		}
	});
}

describe("native questionnaire", () => {
	it.each(["deferred", "cancelled", "aborted"] as const)("TM-11 TM-13 native form closes once when %s", (status) => {
		initTheme("dark", false);
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const controller = new AbortController();
		const done = vi.fn();
		const component = new QuestionnaireComponent({ questions, answers: {} }, done, { signal: controller.signal });
		try {
			component.handleInput("\r");
			if (status === "deferred") {
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\r");
			} else if (status === "cancelled") component.handleInput("\x1b");
			else controller.abort();
			component.handleInput("\r");
			controller.abort();
			expect(done).toHaveBeenCalledTimes(1);
			expect(done).toHaveBeenCalledWith({
				status: status === "aborted" ? "cancelled" : status,
				answers: { scope: { value: "small", wasCustom: false } },
			});
		} finally {
			component.dispose();
			setKeybindings(previous);
		}
	});

	it("TM-10 an extension questionnaire overrides the default built-in", async () => {
		const { session } = await sessionFor((pi) =>
			pi.registerTool({
				...createQuestionnaireToolDefinition("."),
				execute: async () => ({
					content: [{ type: "text", text: "extension ran" }],
					details: { questions: [], answers: [], cancelled: false },
				}),
			}),
		);
		const tool = session.agent.state.tools.find((tool) => tool.name === "questionnaire");
		if (!tool) throw new Error("Questionnaire was not enabled by default");
		expect(await tool.execute("override", { questions })).toMatchObject({
			content: [{ type: "text", text: "extension ran" }],
		});
	});

	it("TM-11 configurable keys answer two native tabs and return raw values", async () => {
		const { execute, ui } = await sessionFor();
		ui.questionnaire.mockImplementation((form) =>
			drive(form, ["\x0e", "\x13", "\x0e", "\x13", "\x1b[200~later\x1b[201~", "\x13", "\x13"]),
		);
		const result = await execute();
		expect(result.details).toMatchObject({
			cancelled: false,
			answers: [
				{ id: "scope", value: "large", label: "Large", wasCustom: false, index: 2 },
				{ id: "priority", value: "later", label: "later", wasCustom: true },
			],
		});
		expect(ui.select).not.toHaveBeenCalled();
	});

	it.each([
		["no questions", [], "No questions"],
		["empty ID", [{ ...questions[0], id: "" }], "Question #1"],
		["duplicate ID", [questions[0], questions[0]], "Question scope"],
		["empty prompt", [{ ...questions[0], prompt: " " }], "Question scope"],
		[
			"duplicate option",
			[{ ...questions[0], options: [questions[0].options[1], questions[0].options[1]] }],
			"Question scope",
		],
		["no answer path", [{ ...questions[0], options: [] }], "Question scope"],
		[
			"two recommendations",
			[{ ...questions[0], options: questions[0].options.map((option) => ({ ...option, recommended: true })) }],
			"Question scope",
		],
	])("TM-12 rejects %s before UI or persistence", async (_name, invalid, error) => {
		const { execute, ui, entries, event } = await sessionFor();
		const result = await execute({ questions: invalid });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(error) }]);
		expect(ui.questionnaire).not.toHaveBeenCalled();
		expect(ui.select).not.toHaveBeenCalled();
		expect(entries()).toEqual([]);
		expect(event).not.toHaveBeenCalled();
	});

	it.each(["submitted", "cancelled"] as const)("TM-13 Defer reopens saved progress; %s clears it", async (status) => {
		const { execute, ui, entries } = await sessionFor();
		ui.questionnaire.mockResolvedValueOnce({
			status: "deferred",
			answers: { scope: { value: "small", wasCustom: false } },
		});
		const deferred = await execute();
		expect(deferred).toMatchObject({
			terminate: true,
			details: { deferred: true, cancelled: false, retry: { available: true, savedAnswers: 1 } },
		});
		expect(entries()).toMatchObject([
			{
				data: {
					version: 1,
					status: "active",
					formKey: "467816029a3a3818423e2a9f3c56833e644decba0459f21cf6e200eeb88ba3e0",
				},
			},
		]);
		ui.questionnaire.mockResolvedValueOnce({
			status,
			answers: { scope: { value: "small", wasCustom: false }, priority: { value: "now", wasCustom: false } },
		});
		await execute();
		expect(ui.questionnaire.mock.calls[1][0].answers).toEqual({ scope: { value: "small", wasCustom: false } });
		expect(entries()).toMatchObject([{ data: { status: "active" } }, { data: { version: 1, status: "cleared" } }]);
		ui.questionnaire.mockResolvedValueOnce({ status: "cancelled", answers: {} });
		await execute();
		expect(ui.questionnaire.mock.calls[2][0].answers).toEqual({});
	});

	it("TM-18 the production host emits needs_input exactly once and supports fallback editing", async () => {
		const { execute, ui, event } = await sessionFor();
		const selections = [0, 0, 1, 1, 0];
		ui.select.mockImplementation(async (_title, options) => options[selections.shift() ?? 0]);
		const result = await execute();
		expect(result.details.answers.map((answer) => answer.value)).toEqual(["large", "now"]);
		expect(event).toHaveBeenCalledTimes(1);
		expect(ui.select).toHaveBeenCalledTimes(5);
	});
});
