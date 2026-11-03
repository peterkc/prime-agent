import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalStoragePath,
	isSessionArchivePath,
	requireActiveSessionPath,
	sessionArchivePath,
} from "../src/core/session-storage-paths.js";

describe("session storage paths", () => {
	it.each([
		["/tmp/archive/project/sessions/live.jsonl", false],
		["sessions/archive/not-a-uuid/x.jsonl", false],
		["sessions/archive/019a3e10-1234-7123-8123-123456789abc/0.jsonl", true],
		["sessions/ARCHIVE/019a3e10-1234-7123-8123-123456789abc/missing.jsonl", true],
		["sessions/archive/019A3E10-1234-7123-8123-123456789ABC/missing.jsonl", true],
		["sessions/archived/s.jsonl", false],
		["session-artifacts/root/sub-deadbeef/archive/019a3e10-1234-7123-8123-123456789abc/0.jsonl", true],
		["sessions/session-archive.jsonl", false],
	])("classifies exact storage components: %s", (path, expected) => {
		expect(isSessionArchivePath(String(path))).toBe(expected);
	});
	it("resolves missing descendants and dangling file/parent aliases before any write", () => {
		const root = mkdtempSync(join(tmpdir(), "storage-path-"));
		try {
			const archive = join(root, "sessions", "archive", "019a3e10-1234-7123-8123-123456789abc", "0.jsonl");
			mkdirSync(join(archive, ".."), { recursive: true });
			const parent = join(root, "alias");
			const file = join(root, "file.jsonl");
			symlinkSync(join(root, "sessions", "archive"), parent);
			symlinkSync(archive, file);
			for (const path of [
				archive,
				file,
				join(parent, "019a3e10-1234-7123-8123-123456789abc", "0.jsonl"),
				join(parent, "019a3e10-1234-7123-8123-123456789abd", "0.jsonl"),
				relative(process.cwd(), archive),
			]) {
				expect(isSessionArchivePath(path)).toBe(true);
				expect(() => requireActiveSessionPath(path)).toThrow(/archive/);
			}
			writeFileSync(archive, "evidence");
			expect(canonicalStoragePath(file)).toBe(canonicalStoragePath(archive));
			expect(() => sessionArchivePath(join(root, "sessions", "s.jsonl"), "../escape", 0)).toThrow(/identity/);
			expect(() =>
				sessionArchivePath(join(root, "sessions", "s.jsonl"), "019a3e10-1234-7123-8123-123456789abc", -1),
			).toThrow(/identity/);
			expect(() => requireActiveSessionPath(join(root, "source.jsonl.relocated"))).toThrow(/redirect/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
