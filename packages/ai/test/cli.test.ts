import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({ modes: [] as number[] }));
const credentials = { access: "new-access", refresh: "new-refresh", expires: 123456789 };

vi.mock("../src/utils/oauth/index.js", () => {
	const provider = {
		id: "stub",
		name: "Stub",
		login: async () => ({ access: "new-access", refresh: "new-refresh", expires: 123456789 }),
	};
	return { getOAuthProvider: () => provider, getOAuthProviders: () => [provider] };
});

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			if (args[0] === "auth.json" && actual.existsSync(args[0])) {
				writes.modes.push(actual.statSync(args[0]).mode & 0o777);
			}
			actual.writeFileSync(...args);
		},
	};
});

describe("pi-ai CLI login", () => {
	it.each([false, true])("pi 89c921d8b saves private credentials with existing file %s", async (existing) => {
		// test-policy: allow environment-gated-path -- POSIX file modes have no equivalent on Windows; CI also runs on Linux.
		if (process.platform === "win32") return;
		const cwd = process.cwd();
		const argv = process.argv;
		const umask = process.umask();
		const dir = fs.mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		const authFile = join(dir, "auth.json");
		const old = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
		let saved: () => void = () => {};
		const completed = new Promise<void>((resolve) => {
			saved = resolve;
		});
		const log = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
			if (message === "\nCredentials saved to auth.json") saved();
		});
		try {
			process.umask(0o022);
			if (existing) {
				fs.writeFileSync(authFile, JSON.stringify({ old }), { mode: 0o644 });
				fs.chmodSync(authFile, 0o644);
			}
			writes.modes.length = 0;
			process.chdir(dir);
			process.argv = [argv[0], "pi-ai", "login", "stub"];
			vi.resetModules();
			await vi.importActual("../src/cli.js");
			await completed;
			expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
			expect(JSON.parse(fs.readFileSync(authFile, "utf8"))).toEqual({
				...(existing ? { old } : {}),
				stub: { type: "oauth", ...credentials },
			});
			expect(writes.modes).toEqual(existing ? [0o600] : []);
		} finally {
			process.chdir(cwd);
			process.argv = argv;
			process.umask(umask);
			log.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
