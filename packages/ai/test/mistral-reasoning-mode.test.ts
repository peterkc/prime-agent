import type { CompletionEvent } from "@mistralai/mistralai/models/components";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions, Tool } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";
import { getFixtureModel } from "./fixture-models.js";

const malformedToolArguments = [
	'{"action":"apply","actions":[{"kind":"seek","time":.5}]}',
	'{"kind":"seek","clipId":"clip-fl',
	"[1,2]",
];
const repairedToolArguments = String.raw`{"kind":"seek","note":"\url"}`;
const optionalArgumentsTool: Tool = {
	name: "work",
	description: "Work",
	parameters: Type.Object({ kind: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }),
};

const mistralMock = vi.hoisted(() => ({ stream: undefined as AsyncIterable<CompletionEvent> | undefined }));
vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		chat = {
			stream: async () => {
				if (!mistralMock.stream) throw new Error("mock stream");
				return mistralMock.stream;
			},
		};
	},
}));
afterEach(() => {
	mistralMock.stream = undefined;
});

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
	tools?: Array<{ type: "function"; function: { name: string; parameters: Record<string, unknown> } }>;
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const payloadCaptureModel: Model<"mistral-conversations"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const stream = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-small-2603")!, {
			reasoning: "medium",
		});

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Small 4 when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-small-2603")!);

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses prompt_mode for Magistral reasoning models", async () => {
		const payload = await capturePayload(
			getFixtureModel<"mistral-conversations">("mistral", "magistral-medium-latest")!,
			{
				reasoning: "medium",
			},
		);

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("uses reasoning_effort for Mistral Medium 3.5", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-medium-3.5")!, {
			reasoning: "medium",
		});

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Medium 3.5 when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-medium-3.5")!);

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});
});

describe("Mistral tool schema serialization", () => {
	it("strips TypeBox symbol keys before the SDK validates tool schemas", async () => {
		const model = {
			...getFixtureModel<"mistral-conversations">("mistral", "devstral-medium-latest")!,
			baseUrl: "http://127.0.0.1:9",
		} as Model<"mistral-conversations">;
		let capturedPayload: MistralPayload | undefined;

		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools: [
					{
						name: "inspect_schema",
						description: "Inspect the schema",
						parameters: Type.Object({ nested: Type.Object({ value: Type.String() }) }),
					},
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as MistralPayload;
					return payload;
				},
			},
		).result();

		const parameters = capturedPayload?.tools?.[0]?.function.parameters;
		const properties = parameters?.properties as Record<string, unknown> | undefined;
		expect(capturedPayload?.tools).toHaveLength(1);
		for (const value of [parameters, properties, properties?.nested]) {
			expect(value).toBeTruthy();
			expect(Object.getOwnPropertySymbols(value as object)).toHaveLength(0);
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("Input validation failed");
	});
});

describe("Mistral final tool arguments (pi #10897)", () => {
	it.each([...malformedToolArguments, repairedToolArguments])("finalizes %s", async (raw) => {
		mistralMock.stream = (async function* () {
			yield {
				data: {
					id: "response-1",
					model: "devstral-medium-latest",
					created: 1,
					choices: [
						{
							index: 0,
							finishReason: "tool_calls",
							delta: {
								toolCalls: [
									{ index: 0, id: "tool12345", type: "function", function: { name: "work", arguments: raw } },
								],
							},
						},
					],
				},
			};
		})();
		const result = await streamSimple(
			getFixtureModel<"mistral-conversations">("mistral", "devstral-medium-latest"),
			{ ...makeContext(), tools: [optionalArgumentsTool] },
			{ apiKey: "test" },
		).result();
		expect(result.stopReason).toBe("toolUse");
		const call = result.content[0];
		if (call?.type !== "toolCall") throw new Error("Expected toolCall");
		expect(call).not.toHaveProperty("partialArgs");
		if (raw === repairedToolArguments) {
			expect(call.arguments).toEqual({ kind: "seek", note: "\\url" });
			expect(call.argumentsError).toBeUndefined();
		} else {
			expect(call.arguments).toEqual({});
			expect(call.argumentsError).toEqual(expect.stringContaining(`\n\nReceived arguments:\n${raw}`));
			expect(call.argumentsError?.endsWith(raw)).toBe(true);
			expect(() => validateToolArguments(optionalArgumentsTool, call)).toThrow('Invalid arguments for tool "work"');
		}
	});
});
