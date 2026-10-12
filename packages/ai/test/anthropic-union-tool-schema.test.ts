import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model, Tool } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

interface ToolsPayload {
	tools: { name: string; input_schema: { properties: unknown; required: string[] } }[];
}

async function captureTools(tools: Tool[]): Promise<ToolsPayload["tools"]> {
	const model: Model<"anthropic-messages"> = {
		...getFixtureModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5")!,
		baseUrl: "http://127.0.0.1:9",
	};
	let payload: ToolsPayload | undefined;
	const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }], tools };
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (body) => {
			payload = body as ToolsPayload;
			return body;
		},
	});
	await stream.result();
	return payload!.tools;
}

describe("Anthropic tool input_schema", () => {
	it("merges a top-level union of objects and requires only fields every branch requires", async () => {
		const target = { root: Type.String() };
		const parameters = Type.Union([
			Type.Object({ ...target, action: Type.Union([Type.Literal("ready"), Type.Literal("close")]) }),
			Type.Object({ ...target, action: Type.Literal("reply"), threadId: Type.String() }),
		]);
		const plain = Type.Object({ path: Type.String() });
		const [union, object] = await captureTools([
			{ name: "lifecycle", description: "d", parameters },
			{ name: "read", description: "d", parameters: plain },
		]);

		expect(union.input_schema.properties).toEqual({
			root: { type: "string" },
			action: { anyOf: [Type.Literal("ready"), Type.Literal("close"), Type.Literal("reply")] },
			threadId: { type: "string" },
		});
		expect(union.input_schema.required).toEqual(["root", "action"]);
		expect(object.input_schema).toMatchObject({ properties: plain.properties, required: ["path"] });
	});
});
