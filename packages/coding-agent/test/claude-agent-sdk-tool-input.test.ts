import { Type } from "typebox";
import { expect, it } from "vitest";
import { repairToolInput } from "../src/core/extensions/builtin/claude-agent-sdk-tool-input.js";

it.each([
	{
		kind: "nested snake case and boolean string",
		schema: Type.Object({ groups: Type.Array(Type.Object({ filePath: Type.String(), enabled: Type.Boolean() })) }),
		input: { groups: [{ file_path: "foo", enabled: "true", extra: "[]" }] },
		output: { groups: [{ filePath: "foo", enabled: "true", extra: "[]" }] },
	},
	{
		kind: "malformed JSON, wrong container types and unknown fields",
		schema: Type.Object({ object: Type.Object({}), array: Type.Array(Type.Number()), broken: Type.Object({}) }),
		input: { object: "[]", array: "{}", broken: "{", extra: "{}" },
		output: { object: "[]", array: "{}", broken: "{", extra: "{}" },
	},
	{
		kind: "already present required key and misspelled optional key",
		schema: Type.Object({ file_path: Type.String(), optional_key: Type.Optional(Type.String()) }),
		input: { file_path: "right", filePath: "wrong", optionalKey: "extra" },
		output: { file_path: "right", filePath: "wrong", optionalKey: "extra" },
	},
])("repairs only declared input slips: $kind", ({ schema, input, output }) => {
	const original = structuredClone(input);
	expect(repairToolInput(input, schema)).toEqual(output);
	expect(input).toEqual(original);
});
