import { getModels, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

const model = getModels("openai")[0];
const proxyOptions = { authToken: "token", proxyUrl: "http://proxy.test" };

function stubProxyResponse(sse: string): { options: { serviceTier?: string } }[] {
	const sent: { options: { serviceTier?: string } }[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return new Response(sse, { status: 200 });
	});
	return sent;
}

afterEach(() => vi.unstubAllGlobals());

it("settles a truncated proxy stream with an error result", async () => {
	stubProxyResponse('data: {"type":"start"}\n\n');
	const result = await streamProxy(model, { messages: [] }, proxyOptions).result();
	expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("truncated") });
});

it("serializes serviceTier into the proxy request", async () => {
	const sent = stubProxyResponse("");
	await streamProxy(model, { messages: [] }, { ...proxyOptions, serviceTier: "priority" }).result();
	expect(sent[0]?.options.serviceTier).toBe("priority");
});

it.each([
	'{"action":"apply","actions":[{"kind":"seek","time":.5}]}',
	'{"kind":"seek","clipId":"clip-fl',
	"[1,2]",
	String.raw`{"kind":"seek","note":"\url"}`,
])("finalizes proxy tool arguments %s (pi #10897)", async (raw) => {
	const tool = {
		name: "work",
		description: "Work",
		parameters: Type.Object({ kind: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }),
	};
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	stubProxyResponse(
		[
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "work" },
			{ type: "toolcall_delta", contentIndex: 0, delta: raw },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
	);
	const result = await streamProxy(model, { messages: [], tools: [tool] }, proxyOptions).result();
	expect(result.stopReason).toBe("toolUse");
	const call = result.content[0];
	if (call?.type !== "toolCall") throw new Error("Expected toolCall");
	expect(call).not.toHaveProperty("partialJson");
	if (raw === String.raw`{"kind":"seek","note":"\url"}`) {
		expect(validateToolArguments(tool, call)).toEqual({ kind: "seek", note: "\\url" });
		expect(call.argumentsError).toBeUndefined();
	} else {
		expect(call.arguments).toEqual({});
		expect(call.argumentsError).toEqual(expect.stringContaining(`\n\nReceived arguments:\n${raw}`));
		expect(call.argumentsError?.endsWith(raw)).toBe(true);
		expect(() => validateToolArguments(tool, call)).toThrow('Invalid arguments for tool "work"');
	}
});
