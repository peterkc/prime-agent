import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	ENV_AGENT_DIR,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludePiDocumentation,
	resolveDocumentationVariant,
	resolveHostCredentialFile,
	resolveModelSelection,
	verifySystemPrompt,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { PI_PROVIDER: "openai-codex" }, { PI_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("PI_EVAL_VARIANT", "with_docs");
		vi.stubEnv("PI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env[ENV_AGENT_DIR]).toBe("/tmp/eval-agent");
				expect(process.env.PI_EVAL_VARIANT).toBeUndefined();
				expect(process.env.PI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.PI_EVAL_VARIANT).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("host credential isolation", () => {
	it.each(["container copy", "host source"] as const)("handles the %s before the sandbox boundary", async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pi-eval-credentials-"));
		const home = join(root, "home");
		const source = join(root, "source");
		const temporary = join(root, "tmp");
		const bootstrap = join(temporary, "pi-eval-host-agent");
		const isolated = join(root, "session-agent");
		const synthetic = JSON.stringify({ synthetic: "not-a-real-credential" });
		try {
			for (const directory of [home, source, temporary, bootstrap, isolated])
				mkdirSync(directory, { recursive: true });
			writeFileSync(join(source, "auth.json"), synthetic);
			writeFileSync(join(bootstrap, "auth.json"), synthetic);
			vi.stubEnv("HOME", home);
			vi.stubEnv("TMPDIR", temporary);
			vi.stubEnv(ENV_AGENT_DIR, mode === "container copy" ? bootstrap : source);
			vi.stubEnv("PI_EVAL_CONTAINER", mode === "container copy" ? "1" : undefined);
			vi.stubEnv("PI_EVAL_SANDBOX_UID", "65532");
			vi.stubEnv("PI_EVAL_SANDBOX_GID", "65532");
			const credentials = resolveHostCredentialFile();
			expect(credentials.authPath).toBe(join(mode === "container copy" ? bootstrap : source, "auth.json"));
			expect(existsSync(credentials.authPath)).toBe(true);
			const restore = applyIsolatedEnvironment(home, isolated);
			try {
				expect(getAgentDir()).toBe(isolated);
				const child = spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`
import { getAgentDir } from ${JSON.stringify(new URL("../../coding-agent/src/config.ts", import.meta.url).href)};
process.stdout.write(getAgentDir());
`,
					],
					{ env: process.env, encoding: "utf8" },
				);
				expect(child.status).toBe(0);
				expect(child.stdout).toBe(isolated);
				await credentials.removeBootstrapCopy();
				// This is the point where runPiCodingAgent can enter its tool sandbox.
				expect(existsSync(credentials.authPath)).toBe(mode === "host source");
				expect(readFileSync(join(source, "auth.json"), "utf8")).toBe(synthetic);
				expect(existsSync(join(isolated, "auth.json"))).toBe(false);
			} finally {
				restore();
			}
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["wrong folder", "missing sandbox IDs"])(
		"refuses container settings with %s before removing anything",
		(mode) => {
			const root = mkdtempSync(join(tmpdir(), "pi-eval-invalid-credentials-"));
			try {
				const bootstrap = join(root, "pi-eval-host-agent");
				mkdirSync(bootstrap);
				const authPath = join(bootstrap, "auth.json");
				writeFileSync(authPath, "synthetic source");
				vi.stubEnv("HOME", root);
				vi.stubEnv("TMPDIR", mode === "wrong folder" ? join(root, "other") : root);
				vi.stubEnv(ENV_AGENT_DIR, bootstrap);
				vi.stubEnv("PI_EVAL_CONTAINER", "1");
				vi.stubEnv("PI_EVAL_SANDBOX_UID", mode === "wrong folder" ? "65532" : undefined);
				vi.stubEnv("PI_EVAL_SANDBOX_GID", mode === "wrong folder" ? "65532" : undefined);
				expect(() => resolveHostCredentialFile()).toThrow("entrypoint bootstrap copy and sandbox IDs");
				expect(readFileSync(authPath, "utf8")).toBe("synthetic source");
			} finally {
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

describe("documentation variant", () => {
	it.each(["without_docs", "with_docs"] as const)("accepts %s", (variant) => {
		expect(resolveDocumentationVariant(variant)).toBe(variant);
	});

	it.each([undefined, "", "other"])("rejects invalid variant %s", (variant) => {
		expect(() => resolveDocumentationVariant(variant)).toThrow("PI_EVAL_VARIANT");
	});

	it("strips only the documentation routing section from the default Pi prompt", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(prompt).toContain("\n<docs>\nPi documentation (read only");
		expect(prompt).toContain("\n<rules>\n");
		expect(prompt).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludePiDocumentation(prompt);
		expect(stripped).toContain("\n<rules>\n");
		expect(stripped).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(stripped).not.toContain("<docs>");
		expect(stripped).not.toContain("Pi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("verifies the prompt that was sent", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		const stripped = excludePiDocumentation(prompt);

		expect(verifySystemPrompt(stripped, { name: "without_docs", expectedPiDocumentation: false })).toBe(stripped);
		expect(() => verifySystemPrompt(prompt, { name: "without_docs", expectedPiDocumentation: false })).toThrow(
			"does not match",
		);
	});

	it("fails closed when prompt markers are missing", () => {
		expect(() => excludePiDocumentation("Instructions")).toThrow("no Pi documentation section");
		expect(() => excludePiDocumentation("\n<docs>\nPi documentation\n</docs>")).toThrow(
			"no working-directory section",
		);
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
