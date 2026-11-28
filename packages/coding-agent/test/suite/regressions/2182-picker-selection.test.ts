import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, Input, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../../../src/core/keybindings.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import type { ConfigurationMenuComponent } from "../../../src/modes/interactive/components/configuration-menu.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(scoped = false) {
	const harness = await createHarness({
		models: [
			{ id: "plain", name: "Plain", reasoning: false },
			{ id: "reason", name: "Reason", reasoning: true },
		],
	});
	harnesses.push(harness);
	const model = harness.getModel("reason")!;
	const plain = harness.getModel("plain")!;
	const editor = new Input();
	editor.setValue("preserved draft");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setThinkingLevel = vi.fn(async (_level: ModelThinkingLevel) => {});
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
		editor,
		editorContainer,
		ui: { terminal: { rows: 30 }, requestRender: vi.fn(), setFocus: vi.fn() },
		uiServices: {
			modelRegistry: harness.session.modelRegistry,
			settingsManager: {
				getRecentModels: () => [],
				getDefaultThinkingLevel: () => "medium",
			},
		},
		connectionConfiguredProviders: new Set([model.provider]),
		connectionState: { thinkingLevel: "off" },
		getCurrentModel: () => plain,
		getScopedModelState: () => (scoped ? [{ model }] : []),
		getCachedModelCandidates: () => (scoped ? [model, plain] : [model]),
		getModelSelectorRefreshPromise: () => undefined,
		createAuthFlows: () => ({ getLoginProviderOptions: () => [] }),
		ensureModelProviderConfigured: async () => true,
		completeModelSelection: vi.fn(async () => {}),
		agentConnection: { setThinkingLevel },
		patchConnectionState: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as unknown as {
		showConfigurationMenu(tab: "models"): Promise<void>;
		closeConfigurationMenu(): void;
		configurationModelSelection: Promise<void>;
		completeModelSelection: ReturnType<typeof vi.fn<() => Promise<void>>>;
		ui: { setFocus: ReturnType<typeof vi.fn> };
		showError: ReturnType<typeof vi.fn>;
	};
	return {
		harness,
		model,
		mode,
		editor,
		editorContainer,
		setThinkingLevel,
		menu: () => editorContainer.children[0] as ConfigurationMenuComponent,
	};
}

it.each(["Cannot find the claude executable"])("explains %s before offering login", async (cause) => {
	const f = await fixture();
	const registry = f.harness.session.modelRegistry;
	registry.registerProvider("claude-sdk", { modelsFrom: "anthropic", missingAuthMessage: cause });
	const model = registry.getAll().find((m) => m.provider === "claude-sdk")!;
	const loginProvider = vi.fn();
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const mode = Object.assign(f.mode, { ensureModelProviderConfigured: prototype.ensureModelProviderConfigured });
	expect(
		await mode.ensureModelProviderConfigured(model, { loginProvider }, [{ id: "claude-sdk", authType: "api_key" }]),
	).toBe(false);
	expect(f.mode.showError).toHaveBeenCalledWith(cause);
	expect(loginProvider).not.toHaveBeenCalled();
});
it.each([true, false])("does not label external models as requiring sign in (inline=%s)", async (inline) => {
	const f = await fixture();
	const model = { ...f.model, provider: "external-fixture" };
	f.harness.session.modelRegistry.registerProvider(model.provider, { missingAuthMessage: "unavailable" });
	const selector = new ModelSelectorComponent(
		{ requestRender: () => {} } as TUI,
		f.model,
		f.harness.session.modelRegistry,
		[],
		vi.fn(),
		vi.fn(),
		undefined,
		{ availableModels: [model], inline },
	);
	const row = stripAnsi(selector.render(120).join("\n"));
	expect(row).toContain("unavailable");
	expect(row).not.toContain("require sign in");
});
it("retains picker focus and draft until model and explicit effort both complete", async () => {
	const f = await fixture();
	const modelApplied = deferred();
	const effortApplied = deferred();
	f.mode.completeModelSelection.mockImplementation(() => modelApplied.promise);
	f.setThinkingLevel.mockImplementation(() => effortApplied.promise);
	const done = f.mode.showConfigurationMenu("models");
	const menu = f.menu();
	expect(stripAnsi(menu.render(100).join("\n"))).toContain("medium");
	menu.handleInput("\x1b[C");
	menu.handleInput("\r");
	await vi.waitFor(() => expect(f.mode.completeModelSelection).toHaveBeenCalledOnce());
	let finished = false;
	void done.then(() => {
		finished = true;
	});
	menu.handleInput("\x1b");
	menu.handleInput("\r");
	const competing = f.mode.showConfigurationMenu("models");
	expect(f.menu()).toBe(menu);
	expect(f.mode.ui.setFocus).toHaveBeenLastCalledWith(menu);
	expect(f.setThinkingLevel).not.toHaveBeenCalled();
	modelApplied.resolve();
	await vi.waitFor(() => expect(f.setThinkingLevel).toHaveBeenCalledWith("high"));
	expect(finished).toBe(false);
	expect(f.menu()).toBe(menu);
	effortApplied.resolve();
	await Promise.all([done, competing]);
	expect(f.mode.completeModelSelection).toHaveBeenCalledOnce();
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.editor.getValue()).toBe("preserved draft");
});

it("leaves untouched effort to the normal model-switch default restoration", async () => {
	const f = await fixture();
	f.harness.session.settingsManager.setDefaultThinkingLevel("high");
	f.mode.completeModelSelection.mockImplementation(async () => {
		await f.harness.session.setModel(f.model);
	});
	const done = f.mode.showConfigurationMenu("models");
	f.menu().handleInput("\r");
	await done;
	expect(f.setThinkingLevel).not.toHaveBeenCalled();
	expect(f.harness.session.thinkingLevel).toBe("high");
});

it("keeps a failed effort selection open and allows retry", async () => {
	const f = await fixture();
	f.setThinkingLevel.mockRejectedValueOnce(new Error("effort update failed"));
	const done = f.mode.showConfigurationMenu("models");
	const menu = f.menu();
	menu.handleInput("\x1b[C");
	menu.handleInput("\r");
	await vi.waitFor(() => expect(f.mode.showError).toHaveBeenCalledWith("effort update failed"));
	expect(f.menu()).toBe(menu);
	menu.handleInput("\r");
	await done;
	expect(f.setThinkingLevel).toHaveBeenCalledTimes(2);
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it.each([false, true])("edits search text with arrows for reasoning=%s", async (reasoning) => {
	const f = await fixture();
	const selected = vi.fn();
	const cancel = vi.fn();
	const model = reasoning ? f.model : f.harness.getModel("plain")!;
	const selector = new ModelSelectorComponent(
		{ requestRender: () => {} } as TUI,
		model,
		f.harness.session.modelRegistry,
		[],
		selected,
		cancel,
		undefined,
		{ availableModels: [model], thinkingLevel: "medium", inline: true },
	);
	selector.handleInput("re");
	selector.handleInput("\x1b[D");
	selector.handleInput("a");
	expect(selector.getSearchInput().getValue()).toBe("rae");
	selector.handleInput("\x1b[C");
	selector.handleInput("b");
	expect(selector.getSearchInput().getValue()).toBe("raeb");
	selector.handleInput("\x01");
	selector.handleInput("\x1b[D");
	expect(cancel).toHaveBeenCalledOnce();
	selector.getSearchInput().setValue("");
	selector.updateState(model, [model]);
	if (reasoning) {
		selector.handleInput("\x1b[C");
		selector.handleInput("\r");
		expect(selected).toHaveBeenLastCalledWith(model, "high");
	} else {
		selector.handleInput("\x1b[D");
		expect(cancel).toHaveBeenCalledTimes(2);
	}
});

it("toggles model scope instead of typing when Option+S arrives as the composed ß (macOS)", async () => {
	const f = await fixture(true);
	const done = f.mode.showConfigurationMenu("models");
	f.menu().handleInput("ß");
	expect(stripAnsi(f.menu().render(100).join("\n"))).toContain("Plain");
	f.menu().handleInput("\x1b");
	await done;
});

it("refreshes a fresh model catalog when the picker opens without a search", async () => {
	const f = await fixture();
	const plain = f.harness.getModel("plain")!;
	const getModelCatalog = vi.fn(async () => ({ models: [f.model, plain], configuredProviders: [plain.provider] }));
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const refresh = vi.fn(prototype.getModelSelectorRefreshPromise);
	Object.assign(f.mode, {
		agentConnection: { getModelCatalog },
		connectionModelCatalog: [f.model],
		connectionModelsFetchedAt: Date.now(),
		connectionModelsRefreshVersion: 0,
		getCurrentModel: () => f.model,
		getCachedModelCandidates: prototype.getCachedModelCandidates,
		getModelSelectorRefreshPromise: refresh,
	});
	const done = f.mode.showConfigurationMenu("models");
	const listed = () => stripAnsi(f.menu().render(100).join("\n"));
	expect(listed()).not.toContain("Plain");
	expect(getModelCatalog).toHaveBeenCalledOnce();
	await refresh.mock.results[0]?.value;
	expect(listed()).toContain("Plain");
	f.menu().handleInput("\x1b");
	await done;
});

it.each([
	"enter",
	"enter default",
	"save",
	"rebound save",
	"failed save",
	"save untouched",
	"save plain",
	"save replaced",
])("picker default action: %s", async (action) => {
	const f = await fixture();
	const settings = SettingsManager.inMemory({ saveModelChangesAsDefault: action === "enter default" });
	const model = action === "save plain" ? f.harness.getModel("plain")! : f.model;
	f.harness.settingsManager.setDefaultThinkingLevel("medium");
	settings.setDefaultModelAndProvider("original", "original");
	settings.setDefaultThinkingLevel("medium");
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const switched = deferred();
	const setModel = vi.fn(async () => {
		if (action === "failed save") throw new Error("model unavailable");
		await f.harness.session.setModel(model);
	});
	Object.assign(f.mode, {
		uiServices: { modelRegistry: f.harness.session.modelRegistry, settingsManager: settings },
		getCachedModelCandidates: () => [model],
		completeModelSelection: prototype.completeModelSelection,
		agentConnection: {
			setModel,
			getState: async () => ({
				sessionId: action === "save replaced" ? "replacement" : undefined,
				model: f.harness.session.model,
				thinkingLevel: f.harness.session.thinkingLevel,
				availableThinkingLevels: ["off", "low", "medium", "high"],
			}),
			setThinkingLevel: async (level: ModelThinkingLevel) => f.harness.session.setThinkingLevel(level),
		},
		applyModelSwitchUiState: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		checkDaxnutsEasterEgg: vi.fn(),
		showError: () => switched.resolve(),
		connectionState: { thinkingLevel: "off", sessionId: action === "save replaced" ? "source" : undefined },
	});
	if (action === "rebound save") setKeybindings(new KeybindingsManager({ "app.model.saveDefault": "ctrl+x" }));
	const done = f.mode.showConfigurationMenu("models");
	if (action !== "save untouched" && action !== "save plain" && action !== "enter default")
		f.menu().handleInput("\x1b[C");
	const key = action.startsWith("enter") ? "\r" : action === "rebound save" ? "\x18" : "\x1b[115;7u";
	f.menu().handleInput(key);
	if (action === "failed save") {
		await switched.promise;
		f.menu().handleInput("\x1b");
	}
	await done;
	if (action === "enter" || action === "failed save" || action === "save replaced") {
		expect([settings.getDefaultProvider(), settings.getDefaultModel(), settings.getDefaultThinkingLevel()]).toEqual([
			"original",
			"original",
			"medium",
		]);
	} else {
		expect([settings.getDefaultProvider(), settings.getDefaultModel(), settings.getDefaultThinkingLevel()]).toEqual([
			model.provider,
			model.id,
			action === "save untouched" || action === "save plain" || action === "enter default" ? "medium" : "high",
		]);
	}
	expect(settings.getRecentModels()).toEqual(
		action === "failed save" || action === "save replaced"
			? ["original/original"]
			: [`${model.provider}/${model.id}`, "original/original"],
	);
	expect(setModel).toHaveBeenCalledExactlyOnceWith(model.provider, model.id);
});

it.each(["cancelled", "session changed", "replacement queued"])(
	"PR #57 does not save defaults when %s while picker state is pending",
	async (change) => {
		const f = await fixture();
		const settings = SettingsManager.inMemory({
			defaultProvider: "original",
			defaultModel: "original",
			defaultThinkingLevel: "medium",
		});
		const stateRequested = deferred();
		const releaseState = deferred();
		const mode = Object.assign(f.mode, {
			uiServices: { modelRegistry: f.harness.session.modelRegistry, settingsManager: settings },
			connectionState: { sessionId: "source", thinkingLevel: "off" },
			sessionEventGeneration: 0,
			agentConnection: {
				getState: async () => {
					stateRequested.resolve();
					await releaseState.promise;
					return { sessionId: "source", thinkingLevel: "high" };
				},
			},
		});
		const done = mode.showConfigurationMenu("models");
		f.menu().handleInput("\x1b[115;7u");
		await stateRequested.promise;
		const selection = mode.configurationModelSelection;
		try {
			if (change === "cancelled") mode.closeConfigurationMenu();
			else if (change === "session changed") mode.connectionState.sessionId = "replacement";
			// session_replaced advances this before the queued UI state change.
			else mode.sessionEventGeneration++;
		} finally {
			releaseState.resolve();
			await selection;
			await done;
		}
		expect([settings.getDefaultProvider(), settings.getDefaultModel(), settings.getDefaultThinkingLevel()]).toEqual([
			"original",
			"original",
			"medium",
		]);
	},
);

it("does not publish the removed configuration tab action", () => {
	expect(Object.keys(KEYBINDINGS)).not.toContain("app.configuration.previousTab");
});
