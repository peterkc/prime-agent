import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

vi.mock("node:crypto", () => ({ randomBytes: () => Buffer.alloc(8) }));

describe("OutputAccumulator temp spill", () => {
	let realTmp: string | undefined;
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-accumulator-"));
		realTmp = process.env.TMPDIR;
	});

	afterEach(() => {
		if (realTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = realTmp;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("creates a private spill with the full bytes (pi #10310)", async () => {
		process.env.TMPDIR = scratch;
		const previousUmask = process.umask(0);
		try {
			const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
			const first = Buffer.from("start\n");
			const middle = Buffer.from([0xf0, 0x9f, 0x90, 0x88, 0xff, 0x0a]);
			const last = Buffer.from("tail\n");
			accumulator.append(first);
			expect(accumulator.snapshot().fullOutputPath).toBeUndefined();
			accumulator.append(middle);
			accumulator.append(last);
			accumulator.finish();
			await accumulator.closeTempFile();
			const path = accumulator.snapshot().fullOutputPath;
			expect(path).toBeDefined();
			expect(readFileSync(path!)).toEqual(Buffer.concat([first, middle, last]));
			expect(statSync(path!).mode & 0o777).toBe(0o600);
			accumulator.finish();
			await accumulator.closeTempFile();
			expect(accumulator.snapshot().fullOutputPath).toBe(path);
		} finally {
			process.umask(previousUmask);
		}
	});

	it.each(["file", "symlink"])("keeps an occupied %s and degrades the spill (pi #10310)", async (kind) => {
		process.env.TMPDIR = scratch;
		const path = join(scratch, "pi-output-0000000000000000.log");
		const original = kind === "file" ? path : join(scratch, "existing.log");
		writeFileSync(original, "keep private");
		if (kind === "symlink") symlinkSync(original, path);
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();
		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		expect(accumulator.snapshot().fullOutputPath).toBeUndefined();
		expect(accumulator.snapshot().content).toBe("tail\n");
		expect(readFileSync(original, "utf8")).toBe("keep private");
		expect(lstatSync(path).isSymbolicLink()).toBe(kind === "symlink");
		if (kind === "symlink") expect(readlinkSync(path)).toBe(original);
		accumulator.finish();
		await accumulator.closeTempFile();
		expect(accumulator.snapshot().fullOutputPath).toBeUndefined();
	});

	// The open error lands while the close is waiting: degraded spill, not a tool failure.
	it.each([
		["a missing TMPDIR (ENOENT)", (dir: string) => join(dir, "does-not-exist")],
		[
			"a TMPDIR that is a file (ENOTDIR, so cleanup fails too)",
			(dir: string) => {
				const blocker = join(dir, "not-a-dir");
				writeFileSync(blocker, "x");
				return blocker;
			},
		],
	])("degrades a failed spill to the in-memory tail with %s", async (_label, makeTmpdir) => {
		process.env.TMPDIR = makeTmpdir(scratch);
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});
});
