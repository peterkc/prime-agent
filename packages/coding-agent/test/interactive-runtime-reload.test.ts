import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { AgentConnectionEventListener } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

interface RuntimeReloadHarness {
	subscribeToAgent(): void;
	unsubscribe(): void;
}

describe("interactive runtime reload", () => {
	it("TM-14 applies fresh editor padding from a push without requesting another reload", async () => {
		const root = mkdtempSync(join(tmpdir(), "interactive-reload-"));
		const settingsPath = join(root, "settings.json");
		writeFileSync(settingsPath, '{"editorPaddingX":1}');
		const settingsManager = SettingsManager.create(root, root);
		initTheme("dark", false);
		let listener: AgentConnectionEventListener = () => {};
		let padding = settingsManager.getEditorPaddingX();
		const footerDataProvider = new FooterDataProvider(root);
		footerDataProvider.setExtensionStatus("demo", "ready");
		const reload = vi.fn(async () => {});
		const editor = {
			setPaddingX: (value: number) => {
				padding = value;
			},
			setAutocompleteMaxVisible: vi.fn(),
		};
		const mode = Object.create(InteractiveMode.prototype) as RuntimeReloadHarness;
		Object.assign(mode, {
			uiServices: { settingsManager, modelRegistry: { getError: () => undefined }, getThemes: () => [] },
			agentConnection: {
				reload,
				subscribe: (callback: AgentConnectionEventListener) => {
					listener = callback;
					return () => {};
				},
			},
			connectionState: { activeSessionId: "active-1" },
			sessionEventGeneration: 0,
			sessionEventQueue: Promise.resolve(),
			toolDefinitionCache: new Map(),
			keybindings: { reload: vi.fn() },
			defaultEditor: editor,
			editor,
			bindLocalSessionExtensions: false,
			ui: {
				setShowHardwareCursor: vi.fn(),
				setClearOnShrink: vi.fn(),
				requestRender: vi.fn(),
				hideOverlay: vi.fn(),
			},
			footerDataProvider,
			footer: { invalidate: vi.fn() },
			inlineAuthPanelClosers: [],
			refreshConnectionCatalog: vi.fn(async () => {}),
			setupAutocompleteProvider: vi.fn(),
			rebuildChatFromMessages: vi.fn(async () => {}),
			showLoadedResources: vi.fn(),
			showError: (message: string) => {
				throw new Error(message);
			},
			showStatus: vi.fn(),
		});
		for (const method of [
			"cancelActiveConnectionExtensionUiRequests",
			"closeHeartbeatManager",
			"reportProgramStatus",
			"clearExtensionTerminalInputListeners",
			"setExtensionFooter",
			"setExtensionHeader",
			"clearExtensionWidgets",
			"setCustomEditorComponent",
			"updateTerminalTitle",
			"refreshTopBarCost",
			"setWorkingIndicator",
		])
			Object.assign(mode, { [method]: vi.fn() });
		try {
			mode.subscribeToAgent();
			writeFileSync(settingsPath, '{"editorPaddingX":4}');
			await listener({ type: "session_runtime_reloaded", activeSessionId: "active-1" });
			expect(footerDataProvider.getExtensionStatuses().get("demo")).toBe("ready");
			expect(padding).toBe(4);
			expect(reload).not.toHaveBeenCalled();
		} finally {
			mode.unsubscribe();
			footerDataProvider.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
