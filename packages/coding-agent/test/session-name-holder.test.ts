import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
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

	it("keeps the name of a holder whose header cannot be read, and skips a stale entry", () => {
		const agentDir = tempDir();
		enroll(agentDir, "unreadable", "worker", 1);
		writeFileSync(join(agentDir, "mesh", "unreadable.jsonl"), "not json\n");
		expect(findSessionNameHolder(agentDir, "child-b", "worker", 1)).toBe("unreadable");
		// A delete or rename outside a mesh-enabled daemon leaves the entry behind; it no longer holds the name.
		enroll(agentDir, "no-record", "gone-a");
		rmSync(join(agentDir, "mesh", "enrollments", "no-record.json"));
		enroll(agentDir, "no-transcript", "gone-b");
		rmSync(join(agentDir, "mesh", "no-transcript.jsonl"));
		expect(findSessionNameHolder(agentDir, "root-b", "gone-a", 0)).toBeUndefined();
		expect(findSessionNameHolder(agentDir, "root-b", "gone-b", 0)).toBeUndefined();
		// Only a missing file frees the name; a record that cannot be read keeps it held.
		enroll(agentDir, "unreadable-record", "held");
		rmSync(join(agentDir, "mesh", "enrollments", "unreadable-record.json"));
		mkdirSync(join(agentDir, "mesh", "enrollments", "unreadable-record.json"));
		enroll(agentDir, "bad-record", "held-too");
		writeFileSync(join(agentDir, "mesh", "enrollments", "bad-record.json"), "{");
		expect(findSessionNameHolder(agentDir, "root-b", "held", 0)).toBe("unreadable-record");
		expect(findSessionNameHolder(agentDir, "root-b", "held-too", 0)).toBe("bad-record");
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
	it("refuses a closed child's rename to a top-level name, but not to another child's name", () => {
		const dir = tempDir();
		const childFile = join(dir, "child.jsonl");
		writeFileSync(
			childFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child-b", timestamp: new Date().toISOString(), cwd: dir, rlmDepth: 1 })}\n`,
		);
		const agentDir = tempDir();
		enroll(agentDir, "root-a", "pi-review");
		enroll(agentDir, "child-a", "reviewer", 1);
		expect(() => appendSessionInfoToExistingFile(childFile, "pi-review", agentDir)).toThrow(
			/top-level session root-a/,
		);
		appendSessionInfoToExistingFile(childFile, "reviewer", agentDir);
		expect(SessionManager.open(childFile).getSessionName()).toBe("reviewer");
	});

	it("adopts a name already on disk without the check", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		enroll(getAgentDir(), "root-a", "agx-research");
		harness.session.setSessionName("agx-research", { adopt: true });
		expect(harness.session.sessionName).toBe("agx-research");
	});

	it("rejects an extension's refused rename and reports it, awaited or not", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
		enroll(getAgentDir(), "root-a", "agx-research");
		// Not awaited: the refusal must not become an unhandled rejection.
		void api!.setSessionName("agx-research");
		await expect(api!.setSessionName("AGX-research")).rejects.toThrow(/already used by session root-a/);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toMatch(/^set_session_name: .*root-a/);
		expect(harness.session.sessionName).toBeUndefined();
	});
});
