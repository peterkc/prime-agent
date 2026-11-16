import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateDiffString, generateEditDiff } from "../src/core/tools/edit-diff.js";

describe("generateEditDiff", () => {
	it.each([
		{ name: "merged windows", secondLine: 50 },
		{ name: "disjoint windows", secondLine: 150 },
	])("keeps whole-file formatting and shifted line numbers for $name (pi #8544)", ({ secondLine }) => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}\n`);
		const base = lines.join("");
		const secondOffset = lines.slice(0, secondLine - 1).join("").length;
		const newText = "first\nextra\n";
		const changed =
			newText +
			base.slice(lines[0].length, secondOffset) +
			"last\n" +
			base.slice(secondOffset + lines[secondLine - 1].length);
		const replacements = [
			{ matchIndex: 0, matchLength: lines[0].length, newText },
			{ matchIndex: secondOffset, matchLength: lines[secondLine - 1].length, newText: "last\n" },
		];
		const diff = generateEditDiff(base, changed, replacements);
		expect(diff).toEqual(generateDiffString(base, changed));
		expect(diff.firstChangedLine).toBe(1);
		expect(diff.diff.split("\n").filter((line) => /^[+-]/.test(line))).toEqual([
			"-  1 line 1",
			"+  1 first",
			"+  2 extra",
			`-${String(secondLine).padStart(3)} line ${secondLine}`,
			`+${String(secondLine + 1).padStart(3)} last`,
		]);
	});

	it("keeps generateDiffString's exported startLine offset (pi #8544)", () => {
		expect(generateDiffString("a\nb\n", "a\nB\n", 4, 100)).toEqual({
			diff: " 100 a\n-101 b\n+101 B",
			firstChangedLine: 101,
		});
	});

	it.each(["execution", "preview"])("diffs a 20 MB file in the %s path with a 96 MB heap (pi #8544)", (mode) => {
		const editDiffUrl = pathToFileURL(resolve(__dirname, "../src/core/tools/edit-diff.ts")).href;
		const script = `
			import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import * as editDiff from ${JSON.stringify(editDiffUrl)};
			const filler = "x".repeat(99) + "\\n";
			const half = filler.repeat(100000);
			const base = half + "TARGET = 1\\n" + half;
			let result;
			if (${JSON.stringify(mode)} === "execution") {
				const replacement = { matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" };
				result = editDiff.generateEditDiff(base, half + "TARGET = 2\\n" + half, [replacement]);
			} else {
				const dir = mkdtempSync(join(tmpdir(), "edit-diff-"));
				try {
					writeFileSync(join(dir, "big.txt"), base);
					result = await editDiff.computeEditsDiff("big.txt", [{ oldText: "TARGET = 1", newText: "TARGET = 2" }], dir);
				} finally { rmSync(dir, { recursive: true, force: true }); }
			}
			if ("error" in result) throw new Error(result.error);
			process.stdout.write(JSON.stringify({
				diff: result.diff,
				firstChangedLine: result.firstChangedLine,
			}));
		`;
		const child = spawnSync(
			process.execPath,
			["--max-old-space-size=96", "--import", "tsx", "--input-type=module", "--eval", script],
			{
				encoding: "utf-8",
				timeout: 30000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const filler = "x".repeat(99);
		expect(JSON.parse(child.stdout)).toEqual({
			diff: [
				"        ...",
				...[99997, 99998, 99999, 100000].map((line) => ` ${String(line).padStart(6)} ${filler}`),
				"-100001 TARGET = 1",
				"+100001 TARGET = 2",
				...[100002, 100003, 100004, 100005].map((line) => ` ${line} ${filler}`),
				"        ...",
			].join("\n"),
			firstChangedLine: 100001,
		});
	});
});
