import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.js";
import { appendSessionInfoToExistingFile, SessionManager } from "../src/core/session-manager.js";
import { findSessionNameHolder } from "../src/core/session-name-holder.js";
import { createHarness, type Harness } from "./suite/harness.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	rmSync(join(getAgentDir(), "mesh"), { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "session-name-"));
	dirs.push(dir);
	return dir;
}

/** Enrolls a session in the mesh directory under `agentDir`, with a transcript header at `rlmDepth`. */
function enroll(agentDir: string, sessionId: string, name: string, rlmDepth = 0): void {
	const mesh = join(agentDir, "mesh");
	mkdirSync(join(mesh, "directory"), { recursive: true });
	mkdirSync(join(mesh, "enrollments"), { recursive: true });
	const sessionFile = join(mesh, `${sessionId}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, rlmDepth })}\n`);
	writeFileSync(join(mesh, "enrollments", `${sessionId}.json`), JSON.stringify({ sessionId, sessionFile }));
	writeFileSync(
		join(mesh, "directory", `${sessionId}.json`),
		JSON.stringify({
			sessionId,
			name,
			principal: `local.${sessionId.replaceAll("-", "_")}`,
			homeSocket: "/run/a.sock",
		}),
	);
}

describe("findSessionNameHolder", () => {
	it("finds another session that holds the name, ignoring case, and never the session itself", () => {
		const agentDir = tempDir();
		enroll(agentDir, "root-a", "agx-research");
		expect(findSessionNameHolder(agentDir, "root-b", "AGX-Research", 0)).toBe("root-a");
		expect(findSessionNameHolder(agentDir, "root-b", " agx-research ", 0)).toBe("root-a");
		expect(findSessionNameHolder(agentDir, "root-a", "agx-research", 0)).toBeUndefined();
		expect(findSessionNameHolder(agentDir, "root-b", "agx-temp", 0)).toBeUndefined();
	});

	it("finds nothing without a mesh directory and skips invalid entries", () => {
		const agentDir = tempDir();
		expect(findSessionNameHolder(agentDir, "root-b", "agx-research", 0)).toBeUndefined();
		enroll(agentDir, "root-a", "agx-research");
		writeFileSync(join(agentDir, "mesh", "directory", "broken.json"), "{");
		writeFileSync(join(agentDir, "mesh", "directory", "wrong-id.json"), JSON.stringify({ sessionId: "other" }));
		expect(findSessionNameHolder(agentDir, "root-b", "agx-research", 0)).toBe("root-a");
	});

	it("lets RLM children share a name, but not a top-level session's name", () => {
		const agentDir = tempDir();
		enroll(agentDir, "child-a", "reviewer", 1);
		enroll(agentDir, "root-a", "pi-review");
		expect(findSessionNameHolder(agentDir, "child-b", "reviewer", 1)).toBeUndefined();
		expect(findSessionNameHolder(agentDir, "child-b", "pi-review", 1)).toBe("root-a");
		// A top-level session may not take a child's name either: sends to that name would be ambiguous.
		expect(findSessionNameHolder(agentDir, "root-b", "reviewer", 0)).toBe("child-a");
	});

	it("keeps the name of a holder whose depth cannot be read", () => {
		const agentDir = tempDir();
		enroll(agentDir, "unknown", "worker", 1);
		rmSync(join(agentDir, "mesh", "enrollments", "unknown.json"));
		expect(findSessionNameHolder(agentDir, "child-b", "worker", 1)).toBe("unknown");
	});
});

describe("naming a session", () => {
	it("refuses a live rename to a name another session holds and keeps the old name", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.setSessionName("mine");
		enroll(getAgentDir(), "root-a", "agx-research");
		expect(() => harness.session.setSessionName("Agx-Research")).toThrow(
			/"Agx-Research" is already used by session root-a/,
		);
		expect(harness.session.sessionName).toBe("mine");
		harness.session.setSessionName("agx-temp");
		expect(harness.session.sessionName).toBe("agx-temp");
	});

	it("refuses an RLM child a top-level session's name, but not another child's", async () => {
		const harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		harnesses.push(harness);
		enroll(getAgentDir(), "root-a", "pi-review");
		enroll(getAgentDir(), "child-a", "reviewer", 1);
		expect(() => harness.session.setSessionName("pi-review")).toThrow(/already used by top-level session root-a/);
		harness.session.setSessionName("reviewer");
		expect(harness.session.sessionName).toBe("reviewer");
	});

	it("does not check a session that is not saved, since it is never enrolled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		enroll(getAgentDir(), "root-a", "agx-research");
		harness.session.setSessionName("agx-research");
		expect(harness.session.sessionName).toBe("agx-research");
	});

	it("refuses a rename of a closed session file and leaves the file unchanged", () => {
		const dir = tempDir();
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendSessionInfo("closed");
		const file = manager.getSessionFile()!;
		const agentDir = tempDir();
		enroll(agentDir, "root-a", "agx-research");
		const before = readFileSync(file, "utf8");
		expect(() => appendSessionInfoToExistingFile(file, "agx-research", agentDir)).toThrow(
			/already used by session root-a/,
		);
		expect(readFileSync(file, "utf8")).toBe(before);
		appendSessionInfoToExistingFile(file, "agx-temp", agentDir);
		expect(SessionManager.open(file).getSessionName()).toBe("agx-temp");
	});
});
