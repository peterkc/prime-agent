import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, UserMessage } from "../src/types.js";

const requestBody = { state: { x: 1 }, questions: { action: { criteria: { left: "go left" } } } };
const replyBody = '{"answers":{"action":{"choice":"left"}},"usage":{"input_tokens":7,"output_tokens":3}}';
function model(baseUrl: string): Model<"systemone"> {
	return {
		id: "decision",
		name: "decision",
		api: "systemone",
		provider: "loopback",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1000000, output: 2000000, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}
async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a loopback address");
	return `http://127.0.0.1:${address.port}/v1///`;
}
async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	const closed = once(server, "close");
	server.close();
	server.closeAllConnections();
	await closed;
}
async function checkTransport(scenario: string): Promise<void> {
	const controller = new AbortController();
	const seen: { req: IncomingMessage; body: unknown }[] = [];
	async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		seen.push({ req, body: JSON.parse(Buffer.concat(chunks).toString()) });
		if (scenario === "string" || scenario === "blocks") res.end(replyBody);
		if (scenario === "HTTP 422") res.writeHead(422).end("x".repeat(500) + "y".repeat(100));
		if (scenario === "abort") controller.abort();
	}
	const server = createServer(respond);
	try {
		const base = await listen(server);
		if (scenario === "network") await close(server);
		const content: UserMessage["content"] =
			scenario === "blocks"
				? [
						{ type: "text", text: '{"state":{"x":1},' },
						{ type: "text", text: '"questions":{"action":{"criteria":{"left":"go left"}}}}' },
					]
				: scenario === "invalid JSON"
					? "not JSON"
					: JSON.stringify(requestBody);
		const messages: Context["messages"] = [
			{ role: "user", content: '{"old":true}', timestamp: 0 },
			{ role: "user", content, timestamp: 1 },
		];
		const stream = streamSimple(
			model(base),
			{ messages },
			{
				apiKey: "test-key",
				headers: { "X-Team": "team" },
				timeoutMs: 200,
				signal: scenario === "abort" ? controller.signal : AbortSignal.timeout(2000),
			},
		);
		const events = [];
		for await (const event of stream) events.push(event.type);
		const output = await stream.result();
		if (scenario === "string" || scenario === "blocks") {
			expect(events).toEqual(["start", "done"]);
			expect(output.stopReason).toBe("stop");
			expect(seen).toHaveLength(1);
			expect(seen[0].body).toEqual(requestBody);
			expect(seen[0].req).toMatchObject({ method: "POST", url: "/v1/systemone" });
			expect(seen[0].req.headers).toMatchObject({
				authorization: "Bearer test-key",
				"x-team": "team",
				"content-type": "application/json",
			});
			expect(output.content).toEqual([{ type: "text", text: replyBody }]);
			expect(output.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
			expect(output.usage.cost).toMatchObject({ input: 7, output: 6, total: 13 });
		} else {
			expect(events.at(-1)).toBe("error");
			expect(output.stopReason).toBe(scenario === "abort" ? "aborted" : "error");
			if (scenario === "HTTP 422")
				expect(output.errorMessage).toBe(`systemone returned HTTP 422: ${"x".repeat(500)}`);
			if (scenario === "network") expect(output.errorMessage).toMatch(/fetch failed/i);
			if (scenario === "timeout") expect(output.errorMessage).toMatch(/timeout|timed out/i);
			if (scenario === "abort") expect(output.errorMessage).toMatch(/abort/i);
			if (scenario === "invalid JSON") {
				expect(output.errorMessage).toContain("newest user message is not JSON");
				expect(seen).toHaveLength(0);
			}
		}
	} finally {
		await close(server);
	}
}
it.each(["string", "blocks", "HTTP 422", "network", "timeout", "abort", "invalid JSON"])(
	"systemone: %s",
	checkTransport,
);
