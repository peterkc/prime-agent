import { describe, expect, it } from "vitest";
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.js";

describe("parseStreamingJson (pi #10868)", () => {
	it.each([
		[
			String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`,
			{ path: "a.tex", content: "\\usepackage{x}", mode: "w" },
		],
		[String.raw`{"text":"caf\u00e9 \url"}`, { text: "café \\url" }],
		[String.raw`{"text":"ab\u00`, { text: "ab" }],
	])("preserves fields and streaming unicode behavior for %s", (raw, expected) => {
		expect(parseStreamingJson(raw)).toEqual(expected);
	});
});

describe("parseToolCallArguments (pi #10897)", () => {
	it.each([
		'{"action":"apply","actions":[{"kind":"seek","time":.5}]}',
		'{"kind":"seek","clipId":"clip-fl',
		"[1,2]",
		"null",
		"42",
		'"text"',
	])("rejects final non-object or incomplete JSON: %s", (raw) => {
		const parsed = parseToolCallArguments(raw);
		expect(parsed.arguments).toEqual({});
		expect(parsed.argumentsError).toEqual(expect.stringContaining(`\n\nReceived arguments:\n${raw}`));
		expect(parsed.argumentsError?.endsWith(raw)).toBe(true);
	});

	it.each([undefined, "", " \n ", "{}"])("keeps empty argument behavior for %s", (raw) => {
		expect(parseToolCallArguments(raw)).toEqual({ arguments: {} });
	});

	it("repairs strings without changing nested values or duplicate-key behavior", () => {
		expect(
			parseToolCallArguments(
				String.raw`{"kind":"seek","note":"\url","kind":"seek","items":[{"value":0.5}],"text":"caf\u00e9\n"}`,
			),
		).toEqual({
			arguments: { kind: "seek", note: "\\url", items: [{ value: 0.5 }], text: "café\n" },
		});
		expect(parseStreamingJson('{"kind":"seek","note":"unfinished')).toEqual({ kind: "seek", note: "unfinished" });
	});
});
