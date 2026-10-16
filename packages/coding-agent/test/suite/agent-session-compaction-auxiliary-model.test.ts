import type * as PiAi from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.js";
import { type CompactionSettings, InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.js";
import { createHarness } from "./harness.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, completeSimple: completeSimpleMock };
});
interface SummaryOptions {
	auxiliaryModel?: string;
	window?: number;
	reasoning?: boolean;
	compaction?: CompactionSettings;
	project?: CompactionSettings;
	map?: PiAi.Model<string>["thinkingLevelMap"];
	caller?: string;
	expected?: string;
}

describe("AgentSession compaction auxiliary model", () => {
	const cases: Array<[string, SummaryOptions, string, string?]> = [
		["routes compaction summaries to the auxiliary model", { auxiliaryModel: "faux/aux-model" }, "aux-model"],
		["falls back when the auxiliary model is unusable", { auxiliaryModel: "faux/missing-model" }, "session-model"],
		["falls back when the window is too small", { auxiliaryModel: "faux/aux-model", window: 8192 }, "session-model"],
		["falls back to the session model when no auxiliary model is configured", {}, "session-model"],
		["TM-31 medium", { compaction: { thinkingLevel: "medium" } }, "session-model", "medium"],
		[
			"TM-33 non-reasoning",
			{ auxiliaryModel: "faux/aux-model", compaction: { thinkingLevel: "medium" } },
			"aux-model",
		],
		[
			"TM-34 defaults before caller",
			{
				compaction: { summaryInstructions: "Keep constraints" },
				caller: "Focus",
				expected: "Keep constraints\n\nAdditional instructions for this compaction:\nFocus",
			},
			"session-model",
		],
		[
			"TM-35 estimate includes defaults",
			{
				auxiliaryModel: "faux/aux-model",
				window: 20000,
				compaction: { summaryInstructions: "default ".repeat(12000) },
			},
			"session-model",
		],
		[
			"TM-37 project merge and auxiliary clamp",
			{
				auxiliaryModel: "faux/aux-model",
				reasoning: true,
				compaction: { thinkingLevel: "low", summaryInstructions: "Global default" },
				project: { thinkingLevel: "medium" },
				map: { medium: null },
				expected: "Global default",
			},
			"aux-model",
			"high",
		],
	];
	it.each(cases)("%s", async (_label, options, expectedModel, expectedReasoning) => {
		completeSimpleMock.mockReset().mockResolvedValue(fauxAssistantMessage("Test summary"));
		const warnSpy = vi.spyOn(console, "warn");
		warnSpy.mockReset().mockImplementation(() => {});
		vi.spyOn(SettingsManager, "inMemory").mockImplementationOnce((global) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify(global));
			storage.withLock("project", () => JSON.stringify({ compaction: options.project }));
			return SettingsManager.fromStorage(storage);
		});
		const harness = await createHarness({
			models: [
				{ id: "session-model", name: "Session Model", reasoning: true },
				{ id: "aux-model", name: "Aux Model", contextWindow: options.window, reasoning: options.reasoning },
			],
			settings: {
				auxiliaryModel: options.auxiliaryModel,
				compaction: { keepRecentTokens: 1, ...options.compaction },
			},
			persistSession: true,
		});
		harness.session.modelRegistry.registerProvider("faux", {
			api: harness.faux.api,
			baseUrl: harness.models[0].baseUrl,
			apiKey: "faux-key",
			models: harness.models.map((model) => ({
				...model,
				thinkingLevelMap: model.id === "aux-model" ? options.map : undefined,
			})),
		});
		onTestFinished(() => {
			harness.cleanup();
			vi.restoreAllMocks();
		});
		harness.session.setThinkingLevel("low");
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const result = await harness.session.compact(options.caller);
		const calls = completeSimpleMock.mock.calls.filter(
			(call) => (call[1] as { systemPrompt?: string }).systemPrompt === SUMMARIZATION_SYSTEM_PROMPT,
		);
		expect(calls.length).toBeGreaterThan(0);
		expect(result.summary).toContain("Test summary");
		for (const call of calls) {
			expect(call[0]).toMatchObject({ provider: "faux", id: expectedModel });
			if (expectedReasoning) expect(call[2]).toHaveProperty("reasoning", expectedReasoning);
			else expect(call[2]).not.toHaveProperty("reasoning");
		}
		if (options.expected)
			expect(JSON.stringify(calls[0][1])).toContain(JSON.stringify(options.expected).slice(1, -1));
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "compaction",
			customInstructions: options.caller,
		});
		const fallbackWarn = expectedModel === "session-model" ? options.auxiliaryModel : undefined;
		const expectedWarnings = fallbackWarn
			? [`Warning: auxiliaryModel "${fallbackWarn}" unusable for compaction summary; using the session model.`]
			: [];
		expect(warnSpy.mock.calls.map(([message]) => String(message))).toStrictEqual(expectedWarnings);
	});
});
