import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forkBinaryVersion, setBinaryVersion } from "../scripts/copy-binary-assets.mjs";

let directory: string | undefined;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("fork binary version", () => {
	it("replaces any build metadata with the commit", () => {
		expect(forkBinaryVersion("0.9.8+fork.4", "683337fd4", false)).toBe("0.9.8+fork.683337fd4");
		expect(forkBinaryVersion("0.9.8", "683337fd4", false)).toBe("0.9.8+fork.683337fd4");
	});

	it("marks a build from uncommitted code", () => {
		expect(forkBinaryVersion("0.9.8+fork.4", "683337fd4", true)).toBe("0.9.8+fork.683337fd4.dirty");
	});

	it("stamps the version into the binary's package.json only", () => {
		directory = mkdtempSync(join(tmpdir(), "prime-fork-version-"));
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "x", version: "0.9.8+fork.4" }));
		setBinaryVersion(directory, forkBinaryVersion("0.9.8+fork.4", "683337fd4", false));
		expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).toEqual({
			name: "x",
			version: "0.9.8+fork.683337fd4",
		});
	});
});
