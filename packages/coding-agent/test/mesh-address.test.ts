import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, newIdentity, stripSpaceAuth } from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("mesh directory addressing", () => {
	it.each([
		["id-a", "id-a"],
		["ID-A", "id-b"],
		["scan-error", "Message was not stored: directory lookup failed"],
		["aLpHa", "id-a"],
		["prime/ALPHA", "id-a"],
		["local/name", "id-slash"],
		["otherspace/x", "Mesh space"],
		["missing", "Unknown mesh target"],
		["same", "Ambiguous mesh target"],
	] as const)("resolves or rejects %s", async (selector, expected) => {
		const root = mkdtempSync(join(tmpdir(), "mesh-address-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		const directory = join(root, "directory");
		mkdirSync(directory);
		for (const [sessionId, name] of [
			["id-a", "Alpha"],
			["id-b", "id-a"],
			["id-slash", "local/name"],
			["id-c", "same"],
			["id-d", "SAME"],
		])
			writeFileSync(
				join(directory, `${sessionId}.json`),
				JSON.stringify({ sessionId, name, principal: `local.${newIdentity().id}`, homeSocket: "home" }),
			);
		writeFileSync(join(directory, "broken.json"), "invalid secret content");
		writeFileSync(join(root, "mesh.json"), JSON.stringify({ space: "prime", server: "nats://127.0.0.1:1" }));
		writeFileSync(join(root, "signer.json"), JSON.stringify(stripSpaceAuth(await createSpaceAuth("prime"))), {
			mode: 0o600,
		});
		const logs: string[] = [];
		const mesh = new MeshEndpoints({
			meshRoot: root,
			homeSocket: "home",
			log: (line) => logs.push(line),
			handoff: async () => undefined,
		});
		if (selector === "scan-error") {
			rmSync(directory, { recursive: true });
			writeFileSync(directory, "not a directory");
		}
		try {
			for (let n = 0; n < 2; n++) {
				const resolution = mesh.resolveAddress(selector);
				if (selector === "aLpHa") {
					let finished = false;
					void resolution.then(() => {
						finished = true;
					});
					await new Promise<void>((resolve) => queueMicrotask(resolve));
					expect(finished).toBe(false);
				}
				if (expected.startsWith("id-")) await expect(resolution).resolves.toBe(expected);
				else await expect(resolution).rejects.toThrow(expected);
				if (selector === "same")
					for (const candidate of ["id-c", "id-d", "same", "SAME"])
						await expect(mesh.resolveAddress(selector)).rejects.toThrow(candidate);
			}
			expect(logs).toHaveLength(selector === "id-a" || selector === "scan-error" ? 0 : 1);
			expect(logs.join()).not.toContain("invalid secret content");
			if (logs.length) expect(logs[0]).toContain("broken.json");
		} finally {
			await mesh.stop();
		}
	});
});
