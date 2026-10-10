import { describe, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("notification settings toggles", () => {
	test.each(["finished", "failed", "waiting"])("persists the %s notification toggle", async (label) => {
		initTheme("dark");
		const settings = SettingsManager.inMemory();
		const ignore = vi.fn();
		const config: SettingsConfig = {
			autoCompact: true,
			idleEvictionMinutes: 90,
			showImages: true,
			autoResizeImages: true,
			blockImages: false,
			enableSkillCommands: true,
			enableBuiltinSkills: true,
			steeringMode: "all",
			followUpMode: "all",
			transport: "sse",
			defaultServiceTier: "default",
			thinkingLevel: "medium",
			availableThinkingLevels: ["medium"],
			currentTheme: "dark",
			availableThemes: ["dark"],
			mermaidRenderingMode: "off",
			treeFilterMode: "default",
			showHardwareCursor: false,
			editorPaddingX: 0,
			autocompleteMaxVisible: 5,
			quietStartup: false,
			clearOnShrink: false,
			showTerminalProgress: false,
			fullscreen: true,
			warnings: {},
			notifyOnCompletion: true,
			notifyOnError: true,
			notifyOnInput: true,
		};
		const callbacks = new Proxy(
			{
				onNotifyOnCompletionChange: (enabled: boolean) => settings.setNotifyOnCompletion(enabled),
				onNotifyOnErrorChange: (enabled: boolean) => settings.setNotifyOnError(enabled),
				onNotifyOnInputChange: (enabled: boolean) => settings.setNotifyOnInput(enabled),
			},
			{ get: (target, key) => Reflect.get(target, key) ?? ignore },
		) as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(config, callbacks);
		const list = selector.getSettingsList();
		for (const char of label) list.handleInput(char);
		list.handleInput("\r");
		await settings.flush();
		const values = () => [settings.getNotifyOnCompletion(), settings.getNotifyOnError(), settings.getNotifyOnInput()];
		expect(values()).toEqual(["finished", "failed", "waiting"].map((name) => name !== label));
		list.handleInput("\r");
		expect(values()).toEqual([true, true, true]);
	});
});
