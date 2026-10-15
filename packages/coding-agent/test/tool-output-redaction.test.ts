import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import * as redaction from "../src/core/tool-output-redaction.js";
import { createHarness, type Harness } from "./suite/harness.js";

const secret = "dummy-secret-value-0123456789abcdef";
describe("tool output redaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) h.cleanup();
	});
	async function observe(value: string, register: (pi: ExtensionAPI) => void, details: unknown = value) {
		const h = await createHarness({
			persistSession: true,
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Echo",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: value }], details }),
				},
			],
			extensionFactories: [register],
		});
		harnesses.push(h);
		const events: unknown[] = [],
			requests: unknown[] = [];
		h.session.subscribe((event) => {
			if (event.type === "tool_execution_end") events.push(structuredClone(event.result));
			if (event.type === "message_start" || event.type === "message_end") {
				if (event.message.role === "toolResult") events.push(structuredClone(event.message));
			}
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(context.messages.filter((m) => m.role === "toolResult"));
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("run");
		const saved = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
			.map((entry) => entry.message);
		expect(events).toHaveLength(3);
		expect(saved).toHaveLength(1);
		expect(requests).toHaveLength(1);
		return [...events, ...saved, ...requests];
	}
	it.each([
		null,
		secret,
		[{ label: 1, value: secret }],
		[{ label: "", value: secret }],
		[{ label: "x", value: 1 }],
		[{ label: "x", value: "1234567" }],
		[null],
	])("TM-26 rejects registration %j atomically without echoing values", async (bad) => {
		const output = await observe(`${secret} | dummy-rejected-value`, (pi) => {
			pi.registerSecretValues([{ label: "old", value: secret }]);
			const input = Array.isArray(bad) ? [{ label: "new", value: "dummy-rejected-value" }, ...bad] : bad;
			expect(() => pi.registerSecretValues(input as Parameters<ExtensionAPI["registerSecretValues"]>[0])).toThrow(
				`Invalid secret registration at entry ${Array.isArray(bad) ? 1 : 0}`,
			);
		});
		expect(JSON.stringify(output)).not.toContain(secret);
		expect(JSON.stringify(output)).toContain("[old] | dummy-rejected-value");
	});
	it.each([
		["eight", "fake1234", "x fake1234 y", "x [doppler:NAME] y"],
		["fifteen", "fake123456789ab", "fake12345678", "fake12345678"],
		["sixteen windows", "fake123456789abc", "x ke123456789a y", "x [doppler:NAME] y"],
		["overlap", secret, secret + secret.slice(-12), "[doppler:NAME]"],
	])("TM-27 %s masks text and both aliased details paths", async (_name, value, text, expected) => {
		const alias = { nested: [text] };
		const output = await observe(text, (pi) => pi.registerSecretValues([{ label: "doppler:NAME", value }]), {
			first: alias,
			second: alias,
		});
		for (const item of output.flat())
			expect(item).toMatchObject({
				content: [{ type: "text", text: expected }],
				details: { first: { nested: [expected] }, second: { nested: [expected] } },
			});
	});
	it("TM-28 withholds output at every sink when masking throws", async () => {
		vi.spyOn(redaction, "redactToolOutput").mockImplementation(() => {
			throw new Error(secret);
		});
		const output = await observe(secret, (pi) => pi.registerSecretValues([{ label: "fake", value: secret }]));
		for (const item of output.flat())
			expect(item).toMatchObject({
				content: [{ type: "text", text: "Tool output was withheld because secret masking failed." }],
			});
		expect(JSON.stringify(output)).not.toContain(secret);
	});
});
