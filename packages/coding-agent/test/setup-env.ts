import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// A run started from a daemon session inherits that session's daemon wiring and its real agent folder.
// Drop the wiring, and give each test file its own empty agent folder. The names are literal: importing
// src/config.js here would load source modules before a test file's vi.mock calls apply.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("PRIME_AGENT_INTERNAL_") || name.startsWith("RLM_")) delete process.env[name];
}
delete process.env.PRIME_AGENT_SESSION_DIR;
delete process.env.PRIME_AGENT_KERNEL_OWNER_PID;
const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-test-home-"));
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
