import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { findAgentTraceFiles } from "../../src/core/agent-traces.js";
import { computeOwnAndTotalUsage, loadContextTreeChildFromDisk } from "../../src/core/context-tree.js";
import { acquireSessionDeleteLeases, deleteSessionFile } from "../../src/core/session-file-actions.js";
import {
	acquireSessionLease,
	bindSessionWriterLease,
	SESSION_LEASES_ENABLED_ENV,
} from "../../src/core/session-lease.js";
import {
	appendCustomMessageToExistingFile,
	appendSessionInfoToExistingFile,
	appendSessionStateToExistingFile,
	buildSessionContext,
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	parseSessionEntries,
	readSessionInfo,
	SESSION_ROTATION_THRESHOLD_BYTES,
	type SessionHeader,
	SessionManager,
	type SessionStateEntry,
} from "../../src/core/session-manager.js";
import { preflightSessionMove, relocateSession } from "../../src/core/session-move.js";
import { restartOf, serializeSessionEntries, withRotationRestart } from "../../src/core/session-rotation-state.js";
import { sessionArchivePath } from "../../src/core/session-storage-paths.js";
import { inactiveLifecycleForSession } from "../../src/modes/daemon/daemon-session-list.js";
import * as atomicFile from "../../src/utils/atomic-file.js";
import { createHarness } from "../suite/harness.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager session state", () => {
	it("persists lifecycle state and exposes it through list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendSessionState({ status: "crash" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const stateEntries = loadEntriesFromFile(sessionFile!).filter(
				(entry): entry is SessionStateEntry => entry.type === "session_state",
			);
			expect(stateEntries).toHaveLength(1);
			expect(stateEntries[0]!.state).toEqual({ status: "crash" });
			expect(session.getSessionState()).toEqual({ status: "crash" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "crash" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes lifecycle state for sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionInfo("empty");
			session.appendSessionState({ status: "archived" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				name: "empty",
				messageCount: 0,
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists renamed sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-rename-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			SessionManager.open(sessionFile!, sessionDir).appendSessionInfo("Renamed draft");

			await expect(SessionManager.list(cwd, sessionDir)).resolves.toEqual([
				expect.objectContaining({ id: session.getSessionId(), name: "Renamed draft" }),
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("archives a deactivated session that has no prior state entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deactivate-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile()!;

			const reopened = SessionManager.open(sessionFile, sessionDir);
			expect(reopened.getSessionState()).toBeUndefined();
			if (reopened.getSessionState()?.status !== "archived") {
				reopened.appendSessionState({ status: "archived" });
			}

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]!.state).toEqual({ status: "archived" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("archived");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Guards the agents-view deactivate path: opening a deleted file and appending
	// would recreate a stub session at the old path, so the caller must skip it.
	it("recreates a stub when archiving a deleted file, which the existsSync guard prevents", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deleted-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi")); // forces a flush to disk
			const sessionFile = session.getSessionFile()!;
			rmSync(sessionFile);
			expect(existsSync(sessionFile)).toBe(false);

			// Without the guard, the open+append recreates a fresh stub on disk.
			SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			expect(existsSync(sessionFile)).toBe(true);

			// The guard the caller uses skips a missing file, leaving nothing behind.
			rmSync(sessionFile);
			if (existsSync(sessionFile)) {
				SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			}
			expect(existsSync(sessionFile)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coerces legacy sleep and hidden lifecycle state to archived on read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-hidden-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hide me"));
			// Flush a header + state entry, then append the legacy raw "sleep"/"hidden"
			// entries older daemons wrote; both must normalize to "archived" on read.
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "sleep" } })}\n`);
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "hidden" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "archived" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the last valid status when the newest entry is unrecognized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-bad-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hi"));
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "bogus" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "active" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]).toMatchObject({ id: session.getSessionId(), state: { status: "active" } });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate entries when lifecycle state is followed by a normal turn", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-turn-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionState({ status: "archived" });
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recreates the session directory when lifecycle state is the first persisted entry", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-dir-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			rmSync(sessionDir, { recursive: true, force: true });
			session.appendSessionState({ status: "archived" });

			expect(existsSync(sessionFile!)).toBe(true);
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rewrites the full session if the session file disappears after flushing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-file-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			rmSync(sessionFile!, { force: true });
			session.appendSessionState({ status: "archived" });

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
describe("SessionManager agent status", () => {
	it("persists the latest agent status append-only, per branch, and keeps it out of model context", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-"));
		try {
			const session = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));

			const m1 = session.appendMessage(userMsg("add a login endpoint"));
			const m2 = session.appendMessage(assistantMsg("done"));
			session.appendAgentStatus({ summary: "Working", taskState: undefined, basedOnMessageCount: 2 });
			session.appendAgentStatus({ summary: "Added login endpoint", taskState: "completed", basedOnMessageCount: 2 });

			// Latest entry wins.
			expect(session.getLatestAgentStatus()).toEqual({
				summary: "Added login endpoint",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			// Append-only: re-reading the raw file recovers both status entries and
			// the two conversation messages untouched.
			const entries = loadEntriesFromFile(session.getSessionFile()!);
			expect(entries.filter((entry) => entry.type === "agent_status")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);

			// Status never reaches the model.
			const context = buildSessionContext(session.getEntries(), session.getLeafId());
			expect(context.messages).toHaveLength(2);
			expect(context.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
				true,
			);

			// Branch A off m1, then branch B off m2 with a later status in the file.
			session.branch(m1);
			const branchAStatus = session.appendAgentStatus({ summary: "branch A", basedOnMessageCount: 1 });
			session.branch(m2);
			session.appendAgentStatus({ summary: "branch B", basedOnMessageCount: 1 });

			// Re-activating branch A reads its own status, not the later sibling entry.
			session.branch(branchAStatus);
			expect(session.getLatestAgentStatus()?.summary).toBe("branch A");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("SessionManager.hasUserContent", () => {
	// createAgentSession writes the model/thinking/tier defaults for every new
	// session, so only edits made after creation count as real user content.
	const defaults = (s: SessionManager): void => {
		s.appendModelChange("anthropic", "claude-opus-4-8");
		s.appendThinkingLevelChange("off");
	};
	const cases: Array<{ name: string; setup: (session: SessionManager) => void; expected: boolean }> = [
		{
			name: "creation defaults only",
			setup: (s) => {
				defaults(s);
				s.appendServiceTierChange("default");
			},
			expected: false,
		},
		{ name: "no model available at creation", setup: (s) => s.appendThinkingLevelChange("off"), expected: false },
		{
			name: "model changed after creation",
			setup: (s) => {
				defaults(s);
				s.appendModelChange("openai", "gpt-5");
			},
			expected: true,
		},
		{
			name: "thinking level changed after creation",
			setup: (s) => {
				defaults(s);
				s.appendThinkingLevelChange("high");
			},
			expected: true,
		},
		{
			name: "thinking level changed on a no-model session",
			setup: (s) => {
				s.appendThinkingLevelChange("off");
				s.appendThinkingLevelChange("high");
			},
			expected: true,
		},
		{
			name: "Fast mode enabled after creation",
			setup: (s) => {
				defaults(s);
				s.appendServiceTierChange("default");
				s.appendServiceTierChange("priority");
			},
			expected: true,
		},
		{ name: "a message was sent", setup: (s) => s.appendMessage(userMsg("hello")), expected: true },
		{
			name: "the session was named",
			setup: (s) => {
				defaults(s);
				s.appendSessionInfo("my draft");
			},
			expected: true,
		},
	];

	it.each(cases)("is $expected for: $name", ({ setup, expected }) => {
		const tempDir = mkdtempSync(join(tmpdir(), "has-user-content-"));
		try {
			const session = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			setup(session);
			expect(session.hasUserContent()).toBe(expected);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
function replaceRestartRecords(lines: string[], header: SessionHeader, rows: readonly unknown[]): void {
	const serialized = rows.map((row) => JSON.stringify(row));
	lines.splice(1, header.rotation!.restart.count, ...serialized);
	const sha256 = createHash("sha256")
		.update(serialized.map((line) => `${line}\n`).join(""))
		.digest("hex");
	header.rotation = { ...header.rotation!, restart: { version: 1, count: rows.length, sha256 } };
}
function rotationFixture(
	setup: (manager: SessionManager) => void = () => {},
	oversizedAssistant = false,
	firstMessage = "original first preview",
) {
	const directory = mkdtempSync(join(tmpdir(), "rotation-state-"));
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	let lease: ReturnType<typeof acquireSessionLease>;
	try {
		const old = manager.appendMessage(userMsg(firstMessage));
		const assistant = manager.appendMessage(
			assistantMsg(oversizedAssistant ? "x".repeat(SESSION_ROTATION_THRESHOLD_BYTES) : "old reply"),
		);
		const padding = oversizedAssistant
			? assistant
			: manager.appendMessage({
					role: "toolResult",
					toolCallId: "fixture",
					toolName: "fixture",
					content: [{ type: "text", text: "x".repeat(SESSION_ROTATION_THRESHOLD_BYTES) }],
					isError: false,
					timestamp: Date.now(),
				});
		setup(manager);
		const kept = manager.appendMessage(userMsg("kept"));
		const model = manager.buildSessionContext().model;
		manager.appendMessage({
			...assistantMsg("last reply"),
			...(model ? { provider: model.provider, model: model.modelId } : {}),
		});
		const compaction = manager.appendCompaction("summary", kept, 1000, { source: "fixture" }, false, "instructions");
		const path = manager.getSessionFile()!;
		const agentDir = join(directory, "agent");
		lease = acquireSessionLease(path, agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
		bindSessionWriterLease(manager, lease);
		onTestFinished(() => {
			lease?.release();
			rmSync(directory, { recursive: true, force: true });
		});
		return {
			manager,
			directory,
			path,
			old,
			assistant,
			padding,
			compaction,
			agentDir,
			release: () => lease?.release(),
			bind(target: SessionManager) {
				bindSessionWriterLease(target, lease);
			},
		};
	} catch (error) {
		lease?.release();
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
describe("rotation state", () => {
	it("peterkc/prime-agent#60 keeps copies out of owner archives", () => {
		const f = rotationFixture();
		const original = readFileSync(f.path);
		const legacy = join(f.manager.getSessionDir(), `2026-01-01_${f.manager.getSessionId()}.jsonl`);
		symlinkSync("0-cycle.jsonl", join(f.manager.getSessionDir(), "0-cycle.jsonl"));
		const incoming = join(f.directory, basename(f.path));
		writeFileSync(incoming, original);
		expect(() => SessionManager.assertImportEvidence(incoming, legacy)).toThrow(/archive owner/);
		expect(() => SessionManager.assertImportEvidence(incoming, f.path)).not.toThrow();
		expect(existsSync(legacy)).toBe(false);
		expect(f.manager.rotateAfterCompaction(f.compaction, f.agentDir).status).toBe("rotated");
		const archive = sessionArchivePath(f.path, f.manager.getSessionId(), 0);
		const bytes = readFileSync(archive);
		const path = join(f.manager.getSessionDir(), "session-export.jsonl");
		writeFileSync(path, original);
		const copy = SessionManager.open(path);
		copy.appendCustomEntry("copy only", {});
		const lease = acquireSessionLease(path, f.agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
		onTestFinished(() => lease?.release());
		bindSessionWriterLease(copy, lease);
		const temporary = `${archive}.999999.11111111-1111-4111-8111-111111111111.tmp`;
		writeFileSync(temporary, "owner temp");
		copy.cleanupRotationTemps(f.agentDir);
		const result = copy.rotateAfterCompaction(f.compaction, f.agentDir);
		expect(readFileSync(archive).equals(bytes)).toBe(true);
		expect(existsSync(temporary)).toBe(true);
		expect(result).toMatchObject({ status: "skipped", reason: expect.stringContaining("filename") });
	});

	it("preserves an original ID named __proto__ in the persisted ancestry map", () => {
		const fixture = rotationFixture();
		const compaction = fixture.manager.getEntry(fixture.compaction);
		if (compaction?.type !== "compaction") throw new Error("missing compaction");
		writeFileSync(
			fixture.path,
			readFileSync(fixture.path, "utf8").replaceAll(
				JSON.stringify(compaction.firstKeptEntryId),
				JSON.stringify("__proto__"),
			),
		);
		const manager = SessionManager.open(fixture.path);
		fixture.bind(manager);
		expect(manager.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("rotated");
		const cold = SessionManager.open(fixture.path);
		expect(Object.hasOwn(restartOf(cold.getHeader())!.originalParents, "__proto__")).toBe(true);
		expect(cold.getEntry("__proto__")).toMatchObject({ type: "message", id: "__proto__" });
		expect(cold.isEntryOnBranch("__proto__")).toBe(true);
	});
	it.each(["active", "paused", "cleared"])(
		"retains ordered state before the kept boundary (%s)",
		async (goalStatus) => {
			const fixture = rotationFixture((manager) => {
				manager.appendThinkingLevelChange("off");
				manager.appendServiceTierChange("default");
				manager.appendModelChange("faux", "changed-model");
				for (const customType of [
					"rlm_max_depth_state",
					"thread_goal_state",
					"ipython_sent_agent_message",
					"codemode-store",
					"questionnaire_retry_state",
					"provider_quota_park",
					"provider_quota_resume",
					"prime-agent.refinement",
					"unknown_future_state",
				]) {
					for (const action of ["set", "update", "delete"])
						manager.appendCustomEntry(customType, { action, goalStatus, consumed: 21 });
				}
				manager.appendCustomEntry("codemode-store", { set: { deleted: 1, preserved: 1 }, delete: [] });
				manager.appendCustomEntry("codemode-store", { set: { deleted: 2, preserved: 2 }, delete: [] });
				manager.appendCustomEntry("codemode-store", { set: {}, delete: ["deleted"] });
				for (const status of ["active", "cleared", "active"])
					manager.appendCustomEntry("questionnaire_retry_state", {
						version: 1,
						formKey: "fixture-form",
						status,
						answers: [{ id: "q", index: 1, value: "saved", label: "Saved", wasCustom: false }],
					});
				manager.appendCustomEntry("provider_quota_park", { resumeAt: "2099-01-01T00:00:00Z", parkCount: 1 });
				manager.appendCustomEntry("provider_quota_resume", { outcome: "resumed" });
				manager.appendCustomEntry("rlm_max_depth_state", { maxDepth: 4 });
				manager.appendCustomEntry("thread_goal_state", {
					active: goalStatus === "active",
					status: goalStatus === "cleared" ? "idle" : goalStatus,
					goalId: goalStatus === "cleared" ? undefined : "fixture-goal",
					objective: goalStatus === "cleared" ? undefined : "preserve the goal",
					tokenBudget: goalStatus === "cleared" ? undefined : 100,
					tokensUsed: goalStatus === "cleared" ? 0 : 21,
					timeUsedSeconds: 3,
					continuationsUsed: 2,
					createdAt: 1,
					updatedAt: 2,
				});
				manager.appendCustomMessageEntry("unknown_message", "retained state", false, { value: 2 });
				manager.appendSessionInfo("same name");
				manager.appendSessionState({ status: "archived" });
				manager.appendAgentStatus({ summary: "status", taskState: "completed", basedOnMessageCount: 4 });
				manager.appendGitState({ repoUrl: "https://example.invalid/repository", branch: "fixture" });
				const target = manager.getLeafId()!;
				manager.appendLabelChange(target, "mark");
				manager.appendLabelChange(target, undefined);
				const activeLeaf = manager.getLeafId()!;
				manager.appendCustomEntry("rlm_max_depth_state", { maxDepth: 99 });
				manager.branch(activeLeaf);
			}, goalStatus === "cleared");
			vi.useFakeTimers({ toFake: ["Date"] });
			onTestFinished(() => void vi.useRealTimers());
			const { path, compaction, agentDir } = fixture;
			const warmNative = await createHarness({ existingSessionFile: path, models: [{ id: "changed-model" }] });
			onTestFinished(() => warmNative.cleanup());
			const manager = warmNative.sessionManager;
			fixture.bind(manager);
			const state = manager.getEntries().filter((entry) => entry.type !== "message");
			const context = manager.buildSessionContext();
			const before = await SessionManager.listAll(undefined, manager.getSessionDir());
			const usage = computeOwnAndTotalUsage(manager.getBranch(), manager.getEntries());
			expect(manager.rotateAfterCompaction(compaction, agentDir)).toEqual({ status: "rotated", segment: 1 });
			const cold = SessionManager.open(path);
			expect(cold.getEntries()).toEqual(manager.getEntries());
			expect(cold.getLeafId()).toBe(manager.getLeafId());
			expect(cold.buildSessionContext()).toEqual(context);
			for (const entry of state) expect({ ...cold.getEntry(entry.id), parentId: entry.parentId }).toEqual(entry);
			expect(cold.getEntries().filter((entry) => entry.type === "custom")).toEqual(
				manager.getEntries().filter((entry) => entry.type === "custom"),
			);
			expect(computeOwnAndTotalUsage(cold.getBranch(), cold.getEntries(), cold.getHeader())).toEqual(usage);
			const after = await SessionManager.listAll(undefined, manager.getSessionDir());
			expect(after[0].usage).toEqual({
				inputTokens: usage.ownUsage.input + usage.ownUsage.cacheRead + usage.ownUsage.cacheWrite,
				outputTokens: usage.ownUsage.output,
				cost: usage.ownUsage.cost.total,
			});
			if (goalStatus === "cleared")
				expect(before[0].usage?.inputTokens).toBe(1); // Known base defect: oversized assistant usage is skipped.
			else expect(before[0].usage).toEqual(after[0].usage);
			expect({ ...after[0], usage: undefined, allMessagesText: undefined }).toEqual({
				...before[0],
				usage: undefined,
				allMessagesText: undefined,
			});
			expect(after[0].allMessagesText).toBe("kept last reply");
			const next = cold.appendCustomEntry("after", { action: "delta" });
			expect(next).toMatch(/^s1-/);
			expect(SessionManager.open(path).getEntries()).toEqual(cold.getEntries());
			const coldNative = await createHarness({
				existingSessionFile: path,
				models: [{ id: "changed-model" }],
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			});
			onTestFinished(() => coldNative.cleanup());
			expect(coldNative.session.goalState).toEqual(warmNative.session.goalState);
			expect(coldNative.session.goalState).toMatchObject({
				status: goalStatus === "cleared" ? "idle" : goalStatus,
				tokensUsed: goalStatus === "cleared" ? 0 : 21,
			});
			for (const view of [coldNative, warmNative]) expect(view.session.rlmMaxDepth).toBe(4);
			expect(coldNative.session.getOwnUsageSummary()).toEqual(warmNative.session.getOwnUsageSummary());
			expect(coldNative.faux.state.callCount).toBe(0);
			coldNative.sessionManager.appendMessage(userMsg("next turn"));
			coldNative.sessionManager.appendMessage(assistantMsg("next reply"));
			coldNative.session.agent.state.messages = coldNative.sessionManager.buildSessionContext().messages;
			coldNative.setResponses([assistantMsg("next summary"), assistantMsg("next turn summary")]);
			const inputPause = coldNative.session.acquireSessionInputPause();
			try {
				await coldNative.session.compact();
				expect(coldNative.session.goalState).toEqual(warmNative.session.goalState);
				expect(coldNative.session.rlmMaxDepth).toBe(4);
				expect(coldNative.sessionManager.getEntries().at(-1)?.id).toMatch(/^s1-/);
				expect(SessionManager.open(path).getEntries()).toEqual(coldNative.sessionManager.getEntries());
			} finally {
				coldNative.session.dispose();
				inputPause.release();
			}
		},
	);
	it.each(["unbound", "equal", "below", "unknown", "nonshrinking", "negative-tokens", "negative-cost"])(
		"refuses unsafe or ineligible rotation (%s)",
		(condition) => {
			const fixture = rotationFixture();
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			onTestFinished(() => error.mockRestore());
			const { manager, path, agentDir } = fixture;
			if (condition === "equal" || condition === "below") {
				const entries = manager.getEntries();
				const big = entries.find((entry) => entry.id === fixture.padding)!;
				if (big.type !== "message" || (big.message.role !== "assistant" && big.message.role !== "toolResult"))
					throw new Error("fixture assistant missing");
				big.message.content = [];
				manager.appendCustomEntry("padding", { value: "" });
				const raw = `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
				// The actual file size, not a mocked stat, exercises both sides of the limit.
				const replaced = raw.replace(
					'"value":""',
					`"value":"${"x".repeat(SESSION_ROTATION_THRESHOLD_BYTES - raw.length - (condition === "below" ? 1 : 0))}"`,
				);
				writeFileSync(path, replaced);
			}
			if (condition === "unknown")
				appendFileSync(
					path,
					`${JSON.stringify({ type: "future_top_level", id: "unknown", parentId: fixture.compaction, timestamp: "2026-11-02" })}\n`,
				);
			if (condition === "nonshrinking") {
				const big = manager.getEntry(fixture.padding)!;
				if (big.type !== "message" || (big.message.role !== "assistant" && big.message.role !== "toolResult"))
					throw new Error("fixture assistant missing");
				big.message.content = [];
				manager.appendCustomEntry("huge_state", { value: "x".repeat(SESSION_ROTATION_THRESHOLD_BYTES) });
				writeFileSync(
					path,
					`${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
			}
			if (condition.startsWith("negative")) {
				const assistant = manager.getEntry(fixture.assistant);
				if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("assistant");
				if (condition === "negative-tokens") assistant.message.usage.input = -1;
				else assistant.message.usage.cost.total = -1;
				writeFileSync(path, serializeSessionEntries([manager.getHeader()!, ...manager.getEntries()]));
			}
			const opened = SessionManager.open(path);
			if (condition !== "unbound") fixture.bind(opened);
			const bytes = readFileSync(path);
			const result = opened.rotateAfterCompaction(fixture.compaction, agentDir);
			expect(result.status).not.toBe("rotated");
			expect(readFileSync(path).equals(bytes)).toBe(true);
			expect(existsSync(join(manager.getSessionDir(), "archive"))).toBe(false);
			if (condition === "unbound") expect(error).toHaveBeenCalledWith(expect.stringContaining("lease"));
		},
	);
	it.each(["archive-before", "archive-after", "active-before", "active-after"])(
		"recovers a real process interruption at %s",
		(fault) => {
			const fixture = rotationFixture();
			const original = readFileSync(fixture.path);
			fixture.release();
			const managerUrl = pathToFileURL(resolve("src/core/session-manager.ts")).href;
			const leaseUrl = pathToFileURL(resolve("src/core/session-lease.ts")).href;
			const driver = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {SessionManager} from ${JSON.stringify(managerUrl)}; import {realpathSync} from 'node:fs';
import {acquireSessionLease,bindSessionWriterLease,SESSION_LEASES_ENABLED_ENV} from ${JSON.stringify(leaseUrl)};
const [path,agentDir,fault]=process.argv.slice(1); const manager=SessionManager.open(path);
const lease=acquireSessionLease(path,agentDir,{[SESSION_LEASES_ENABLED_ENV]:'1'}); bindSessionWriterLease(manager,lease);
const rename=fs.renameSync; const active=realpathSync(path); fs.renameSync=(from,to)=>{const kind=String(to)===active?'active':'archive';
if(fault===kind+'-before') process.exit(86); rename(from,to); if(fault===kind+'-after') process.exit(86);};
syncBuiltinESMExports(); manager.rotateAfterCompaction(manager.getLeafId(),agentDir); process.exit(87);`;
			const result = spawnSync(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", driver, fixture.path, fixture.agentDir, fault],
				{ encoding: "utf8", timeout: 15000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(86);
			const cold = SessionManager.open(fixture.path);
			expect(cold.getHeader()?.rotation?.segment ?? 0).toBe(fault === "active-after" ? 1 : 0);
			const lease = acquireSessionLease(fixture.path, fixture.agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" });
			onTestFinished(() => lease?.release());
			bindSessionWriterLease(cold, lease);
			cold.cleanupRotationTemps(fixture.agentDir);
			if (fault !== "active-after") {
				const id = cold.appendCustomEntry("after failed rotation", { saved: true });
				const authoritative = readFileSync(fixture.path);
				const archive = sessionArchivePath(fixture.path, cold.getSessionId(), 0);
				const differing = Buffer.alloc(authoritative.length, 120);
				writeFileSync(archive, differing);
				expect(cold.rotateAfterCompaction(fixture.compaction, fixture.agentDir)).toMatchObject({
					status: "failed",
					step: "archive publication",
					reason: expect.stringContaining("Existing archive segment differs"),
				});
				expect(readFileSync(archive).equals(differing) && readFileSync(fixture.path).equals(authoritative)).toBe(
					true,
				);
				writeFileSync(archive, authoritative);
				expect(cold.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("rotated");
				expect(readFileSync(archive).equals(authoritative)).toBe(true);
				expect(SessionManager.open(fixture.path).getEntry(id)).toBeDefined();
			} else {
				expect(readFileSync(sessionArchivePath(fixture.path, cold.getSessionId(), 0)).equals(original)).toBe(true);
				const id = cold.appendCustomEntry("after commit", {});
				const bytes = readFileSync(fixture.path);
				expect(cold.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("skipped");
				expect(readFileSync(fixture.path).equals(bytes)).toBe(true);
				expect(SessionManager.open(fixture.path).getEntry(id)).toBeDefined();
			}
			for (const directory of [cold.getSessionDir(), join(cold.getSessionDir(), "archive", cold.getSessionId())])
				expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		},
	);
	describe("segmented writers and exact lookup", () => {
		it.each(["forkFrom", "createBranchedSession"])(
			"keeps two namespaces, closed writers and the %s source cutoff",
			(forkKind) => {
				let sibling = "",
					archivedLabel = "";
				const fixture = rotationFixture(
					(manager) => {
						const entries = manager.getEntries();
						manager.branch(entries[0].id);
						sibling = manager.appendMessage(userMsg("sibling only"));
						manager.appendMessage(assistantMsg("sibling reply"));
						manager.branch(entries[1].id);
						archivedLabel = manager.appendLabelChange(entries[0].id, "archived target");
					},
					false,
					"漢😀".repeat(200_000),
				);
				const { manager, agentDir, path } = fixture;
				expect(manager.rotateAfterCompaction(fixture.compaction, agentDir).status).toBe("rotated");
				const first = manager.appendCustomEntry("first segment", {});
				const label = manager.appendLabelChange(first, "label");
				expect(manager.branchWithSummary(first, "branch summary")).toMatch(/^s1-/);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "next",
					toolName: "fixture",
					content: [{ type: "text", text: "x".repeat(SESSION_ROTATION_THRESHOLD_BYTES) }],
					isError: false,
					timestamp: Date.now(),
				});
				const keep = manager.appendMessage(userMsg("next kept"));
				manager.appendMessage(assistantMsg("next reply"));
				const compaction = manager.appendCompaction("second summary", keep, 2000);
				expect(manager.rotateAfterCompaction(compaction, agentDir)).toEqual({ status: "rotated", segment: 2 });
				expect(manager.getEntry(fixture.old)?.id).toBe(fixture.old);
				expect(manager.isEntryOnBranch(fixture.old)).toBe(true);
				expect(manager.getEntry(sibling)?.id).toBe(sibling);
				expect(manager.isEntryOnBranch(sibling)).toBe(false);
				expect(manager.getEntry("missing")).toBeUndefined();
				expect(manager.isEntryOnBranch("missing")).toBe(false);
				expect(manager.getFlatTree().map((node) => node.entry.id)).not.toContain(fixture.old);
				fixture.release();
				const fast = appendCustomMessageToExistingFile(
					path,
					"interruption",
					"x".repeat(300_000),
					false,
					{},
					agentDir,
				);
				const fallback = appendSessionInfoToExistingFile(path, "closed rename", agentDir);
				const state = appendSessionStateToExistingFile(path, { status: "crash" }, agentDir);
				for (const id of [fast, fallback, state]) expect(id).toMatch(/^s2-/);
				const source = SessionManager.open(path);
				const boundary = source.getLeafId()!;
				const fork =
					forkKind === "forkFrom"
						? SessionManager.forkFrom(path, fixture.directory, join(fixture.directory, "forks"))
						: SessionManager.open(path);
				if (forkKind === "createBranchedSession") fork.createBranchedSession(boundary);
				for (const view of [manager, fork]) {
					const preview = restartOf(view.getHeader())!.firstMessage;
					expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(64 * 1024);
					expect(preview).toMatch(/^(漢😀)*漢?$/u);
				}
				if (forkKind === "forkFrom") {
					for (const id of [archivedLabel, label]) expect(fork.getEntry(id)).toEqual(source.getEntry(id));
					expect(fork.getEntry(label)?.parentId).toBe(first);
					for (const target of [first, label])
						expect(() => fork.assertRestorableContext(target)).toThrow(/archived ancestry/);
				}
				expect(fork.getHeader()?.rotation?.parent).toMatchObject({
					sessionId: source.getSessionId(),
					leafId: boundary,
					segment: 2,
				});
				expect(fork.appendCustomEntry("local fork", {})).toMatch(/^s3-/);
				const later = source.appendMessage(userMsg("post-fork"));
				expect(fork.getEntry(fixture.old)?.id).toBe(fixture.old);
				expect(fork.isEntryOnBranch(fixture.old)).toBe(true);
				expect(fork.getEntry(sibling)).toBeUndefined();
				expect(fork.getEntry(later)).toBeUndefined();
				expect(fork.isEntryOnBranch(sibling)).toBe(false);
				expect(fork.isEntryOnBranch(later)).toBe(false);
				expect(fork.getHeader()?.rotation?.archives).toEqual([]);
			},
		);
	});
	it("accounts for later child attribution to an archived assistant once in hot, cold, catalog and disk views", async () => {
		const fixture = rotationFixture();
		const { manager, path, agentDir, assistant } = fixture;
		expect(manager.rotateAfterCompaction(fixture.compaction, agentDir).status).toBe("rotated");
		const original = manager.getEntry(assistant);
		if (original?.type !== "message" || original.message.role !== "assistant") throw new Error("missing assistant");
		const child = { ...original.message.usage, input: 5, output: 5, totalTokens: 10 };
		const aggregate = { ...original.message.usage, input: 6, output: 6, totalTokens: 12 };
		manager.appendChildUsageAttribution(assistant, child, aggregate);
		const cold = SessionManager.open(path);
		for (const view of [manager, cold])
			expect(computeOwnAndTotalUsage(view.getBranch(), view.getEntries(), view.getHeader())).toMatchObject({
				ownUsage: { input: 2, output: 2 },
				totalUsage: { input: 7, output: 7 },
			});
		expect((await readSessionInfo(path))?.usage).toMatchObject({ inputTokens: 2, outputTokens: 2 });
		expect(loadContextTreeChildFromDisk(manager.getSessionDir(), () => 200_000)).toMatchObject({
			ownUsage: { input: 2, output: 2 },
			totalUsage: { input: 7, output: 7 },
			label: "original first preview",
		});
	});
	it("retains published bytes and reconciles later appends when publication returns an error after rename", () => {
		const fixture = rotationFixture();
		const actual = atomicFile.writeFileAtomicSync;
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});
		const writer = vi.spyOn(atomicFile, "writeFileAtomicSync").mockImplementation((path, data, options) => {
			actual(path, data, options);
			if (!path.includes("/archive/")) {
				appendFileSync(
					path,
					`${JSON.stringify({ type: "custom", customType: "after commit", id: "s1-after-commit", parentId: fixture.compaction, timestamp: "2026-11-02", data: { saved: true } })}\n`,
				);
				throw new Error("injected lost publication response");
			}
		});
		onTestFinished(() => warning.mockRestore());
		onTestFinished(() => writer.mockRestore());
		expect(fixture.manager.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe(
			"committed-with-warning",
		);
		const appended = fixture.manager.appendCustomEntry("next append", {});
		expect(fixture.manager.getEntry(appended)?.parentId).toBe("s1-after-commit");
		expect(SessionManager.open(fixture.path).getEntries()).toEqual(fixture.manager.getEntries());
		expect(warning).toHaveBeenCalledTimes(1);
	});
	it.each([
		"missing",
		"digest",
		"foreign",
		"duplicate",
		"conflict",
		"cycle",
		"counter",
		"lineage",
		"version",
		"ancestry",
		"utf8",
		"accounting-id",
		"accounting-usage",
	])("fails closed on committed storage corruption (%s)", (kind) => {
		const fixture = rotationFixture();
		const { manager, path, agentDir } = fixture;
		expect(manager.rotateAfterCompaction(fixture.compaction, agentDir).status).toBe("rotated");
		const archive = sessionArchivePath(path, manager.getSessionId(), 0);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		const header = JSON.parse(lines[0]) as SessionHeader;
		if (kind === "missing") rmSync(archive);
		if (kind === "digest") {
			const bytes = readFileSync(archive);
			bytes[bytes.length - 2] ^= 1;
			writeFileSync(archive, bytes);
		}
		if (kind === "foreign" || kind === "utf8") {
			const archived = readFileSync(archive, "utf8").split("\n");
			const foreign = JSON.parse(archived[0]) as SessionHeader;
			if (kind === "foreign") foreign.id = "foreign";
			archived[0] = JSON.stringify(foreign);
			const bytes = Buffer.from(archived.join("\n"));
			if (kind === "utf8") {
				const index = bytes.indexOf("original first preview");
				expect(index).toBeGreaterThanOrEqual(0);
				bytes[index] = 0xff;
			}
			writeFileSync(archive, bytes);
			header.rotation = {
				...header.rotation!,
				archives: [{ segment: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
			};
		}
		const storage = lines.slice(1, 1 + header.rotation!.restart.count).map((line) => JSON.parse(line));
		const assistant = storage
			.find((row) => row.kind === "accounting")
			.data.find((row: { kind: string }) => row.kind === "assistant").entry;
		if (kind === "accounting-id") assistant.id = 1;
		if (kind === "accounting-usage") assistant.message.usage.input = null;
		if (kind === "counter") header.rotation = { ...header.rotation!, segment: -1 };
		if (kind === "lineage") header.rotation = { ...header.rotation!, archives: [] };
		if (kind === "version") Reflect.set(header.rotation!, "version", 2);
		if (kind === "ancestry" || kind === "cycle")
			storage
				.find((row) => row.kind === "cut_edges")
				.data.push([fixture.old, kind === "cycle" ? fixture.old : fixture.compaction]);
		replaceRestartRecords(lines, header, storage);
		lines[0] = JSON.stringify(header);
		if (kind === "duplicate") lines.push(lines.at(-1)!);
		if (kind === "conflict")
			lines.push(
				JSON.stringify({
					type: "message",
					id: fixture.old,
					parentId: fixture.compaction,
					timestamp: "2026-11-02",
					message: userMsg("forged payload"),
				}),
			);
		writeFileSync(path, `${lines.join("\n")}\n`);
		const bytes = readFileSync(path);
		expect(() => {
			const cold = SessionManager.open(path);
			if (kind === "cycle") cold.isEntryOnBranch(fixture.old);
			else cold.getEntry(kind === "conflict" ? fixture.padding : fixture.old);
		}).toThrow(/archive|lineage|duplicate|ancestry|Conflicting|rotation|UTF-8|accounting/);
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});
});
describe("bounded restart records", () => {
	it("keeps multi-record accounting bounded, hidden and correct across rotations and fork cutoffs", async () => {
		let a0 = "",
			a1 = "",
			sibling = "";
		const fixture = rotationFixture((manager) => {
			const first = assistantMsg("a0");
			a0 = manager.appendMessage({ ...first, usage: { ...first.usage, input: 10, totalTokens: 11 } });
			manager.appendMessage(userMsg("u0"));
			const second = assistantMsg("a1");
			a1 = manager.appendMessage({ ...second, usage: { ...second.usage, input: 20, totalTokens: 21 } });
			manager.appendMessage(userMsg("u1"));
			const active = manager.getLeafId()!;
			manager.branch(a0);
			sibling = manager.appendMessage(assistantMsg("excluded sibling"));
			manager.appendCustomEntry("sibling control", {});
			manager.branch(active);
			manager.appendCustomEntry("bridge witness", {});
			for (let i = 0; i < 3000; i++) {
				manager.appendMessage(userMsg("old"));
				manager.appendMessage(assistantMsg("reply"));
			}
		});
		const { manager, path, agentDir } = fixture;
		const expected = computeOwnAndTotalUsage(manager.getBranch(), manager.getEntries());
		expect(expected.totalUsage.input).toBe(3032);
		const original = readFileSync(path);
		expect(manager.rotateAfterCompaction(fixture.compaction, agentDir).status).toBe("rotated");
		for (let turn = 0; turn < 2; turn++) {
			const lines = readFileSync(path, "utf8").trimEnd().split("\n");
			const header = JSON.parse(lines[0]) as SessionHeader;
			expect(Buffer.byteLength(lines[0]) + 1).toBeLessThan(65536);
			const storage = lines.slice(1, 1 + header.rotation!.restart.count);
			expect(storage.length).toBeGreaterThan(2);
			for (const line of storage) expect(Buffer.byteLength(line) + 1).toBeLessThan(1024 * 1024);
			expect(
				createHash("sha256")
					.update(`${storage.join("\n")}\n`)
					.digest("hex"),
			).toBe(header.rotation!.restart.sha256);
			const cold = await SessionManager.openAsync(path);
			const sync = SessionManager.open(path);
			expect(parseSessionEntries(readFileSync(path, "utf8"))).toEqual(loadEntriesFromFile(path));
			expect(await loadEntriesFromFileAsync(path, { streamThresholdBytes: 0 })).toEqual(loadEntriesFromFile(path));
			for (const view of [manager, cold, sync]) {
				expect(computeOwnAndTotalUsage(view.getBranch(), view.getEntries(), view.getHeader())).toEqual(expected);
				expect(view.getEntries().some((e) => (e as { type: string }).type === "rotation_state")).toBe(false);
				expect(view.getFlatTree().map((n) => n.entry.id)).toEqual(view.getEntries().map((e) => e.id));
				const state = restartOf(view.getHeader())!;
				for (const id of Object.keys(state.originalParents))
					expect(view.getEntry(id)?.parentId).not.toBe(state.originalParents[id]);
				expect(state.accounting.some((r) => r.kind === "bridge")).toBe(true);
			}
			expect((await readSessionInfo(path))?.usage?.inputTokens).toBe(expected.ownUsage.input + 1); // catalog includes the sibling assistant too
			expect(loadContextTreeChildFromDisk(manager.getSessionDir(), () => 200000)?.totalUsage).toEqual(
				expected.totalUsage,
			);
			if (turn === 0) {
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "pad",
					toolName: "fixture",
					content: [{ type: "text", text: "x".repeat(SESSION_ROTATION_THRESHOLD_BYTES) }],
					isError: false,
					timestamp: Date.now(),
				});
				const keep = manager.appendMessage(userMsg("next keep"));
				const compaction = manager.appendCompaction("next summary", keep, 100);
				expect(manager.rotateAfterCompaction(compaction, agentDir).status).toBe("rotated");
			}
		}
		expect(readFileSync(sessionArchivePath(path, manager.getSessionId(), 0)).equals(original)).toBe(true);
		for (const id of [a0, a1]) expect(manager.isEntryOnBranch(id)).toBe(true);
		expect(manager.isEntryOnBranch(sibling)).toBe(false);
		const row = restartOf(manager.getHeader())!.accounting.find((r) => r.kind === "assistant" && r.entry.id === a0);
		if (row?.kind !== "assistant") throw new Error("missing accounting row");
		manager.appendChildUsageAttribution(
			a0,
			{ ...row.entry.message.usage, input: 5, output: 0, totalTokens: 5 },
			{ ...row.entry.message.usage, input: 15, totalTokens: 16 },
		);
		expected.totalUsage.input += 5;
		expected.totalUsage.totalTokens += 5;
		expect(computeOwnAndTotalUsage(manager.getBranch(), manager.getEntries(), manager.getHeader())).toEqual(expected);
		expect(SessionManager.continueRecent(manager.getCwd(), manager.getSessionDir()).getSessionId()).toBe(
			manager.getSessionId(),
		);
		expect(await findAgentTraceFiles(manager.getSessionDir())).toEqual([path]);
		fixture.release();
		const beforePrefix = restartOf(manager.getHeader())!.lines;
		appendSessionInfoToExistingFile(path, "closed", agentDir);
		appendCustomMessageToExistingFile(path, "large-tail", "x".repeat(300000), false, {}, agentDir);
		appendSessionStateToExistingFile(path, { status: "crash" }, agentDir);
		expect(restartOf(SessionManager.open(path).getHeader())!.lines).toEqual(beforePrefix);
		const fork = SessionManager.forkFrom(path, fixture.directory, join(fixture.directory, "fork"));
		const next = SessionManager.forkFrom(fork.getSessionFile()!, fixture.directory, join(fixture.directory, "fork2"));
		for (const view of [fork, next])
			expect(computeOwnAndTotalUsage(view.getBranch(), view.getEntries(), view.getHeader())).toEqual(expected);
		const targetSessionDir = join(fixture.directory, "moved", "sessions");
		mkdirSync(targetSessionDir, { recursive: true });
		const { paths } = await preflightSessionMove({
			sourceFile: path,
			sourceSessionDir: manager.getSessionDir(),
			targetSessionDir,
			agentDir,
		});
		const archive1 = readFileSync(sessionArchivePath(path, manager.getSessionId(), 1));
		expect(archive1.indexOf(0x0a) + 1).toBeLessThan(65536);
		const moved = await relocateSession({
			paths,
			targetCwd: fixture.directory,
			targetSocket: "fixture.sock",
			callbacks: {
				suspend: async () => false,
				resume: async () => {},
				writeMeshRecords: async () => {},
				releaseClaim: () => {},
				releaseLeases: () => {},
			},
		});
		expect(moved.status).toBe("moved");
		expect(readFileSync(sessionArchivePath(paths.targetFile, manager.getSessionId(), 1)).equals(archive1)).toBe(true);
		expect(next.getEntry(a0)?.id).toBe(a0);
		const reservation = acquireSessionDeleteLeases(paths.targetFile, agentDir);
		onTestFinished(() => reservation.release());
		expect((await deleteSessionFile(paths.targetFile)).ok).toBe(true);
		expect(existsSync(sessionArchivePath(paths.targetFile, manager.getSessionId(), 0))).toBe(false);
		expect(() => next.getEntry(a0)).toThrow(/unavailable/);
		expect(computeOwnAndTotalUsage(next.getBranch(), next.getEntries(), next.getHeader())).toEqual(expected);
	});
	it.each([
		"whole-prefix",
		"leading",
		"chunk",
		"json",
		"version",
		"kind",
		"segment",
		"index",
		"duplicate",
		"bridge",
		"extra",
		"witness",
	])("rejects %s before tolerant repair on all full loaders", async (fault) => {
		const fixture = rotationFixture();
		expect(fixture.manager.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("rotated");
		const lines = readFileSync(fixture.path, "utf8").trimEnd().split("\n");
		const h = JSON.parse(lines[0]) as SessionHeader;
		const n = h.rotation!.restart.count;
		const rows = lines.slice(1, n + 1).map((line) => JSON.parse(line));
		if (fault === "whole-prefix") lines.splice(1, n);
		else if (fault === "chunk") lines.splice(1, 1);
		else if (fault === "json") lines[1] = "{not-json";
		else if (fault === "extra") lines.push(lines[1]);
		else if (fault === "witness") Reflect.deleteProperty(h.rotation!, "restart");
		else if (fault === "leading") {
		} else {
			if (fault === "duplicate") rows.push({ ...rows[0], index: n });
			else if (fault === "bridge")
				rows
					.find((r) => r.kind === "accounting")
					.data.push({ kind: "bridge", id: "foreign", accountingParentId: null });
			else Reflect.set(rows[0], fault, fault === "kind" ? "future" : 99);
			replaceRestartRecords(lines, h, rows);
		}
		lines[0] = JSON.stringify(h);
		if (fault === "leading") lines.unshift("{}");
		const bytes = `${lines.join("\n")}\n{torn`;
		writeFileSync(fixture.path, bytes);
		fixture.release();
		const untouched = SessionManager.inMemory(fixture.directory);
		const oldHeader = untouched.getHeader();
		expect(() => untouched.setSessionFile(fixture.path)).toThrow();
		expect(untouched.getSessionFile()).toBeUndefined();
		expect(untouched.getHeader()).toBe(oldHeader);
		expect(() => appendSessionInfoToExistingFile(fixture.path, "refused", fixture.agentDir)).toThrow();
		expect(() => SessionManager.open(fixture.path)).toThrow();
		await expect(SessionManager.openAsync(fixture.path)).rejects.toThrow();
		expect(() => parseSessionEntries(bytes)).toThrow();
		await expect(loadEntriesFromFileAsync(fixture.path, { streamThresholdBytes: 0 })).rejects.toThrow();
		expect(await readSessionInfo(fixture.path)).toBeNull();
		expect(() => loadContextTreeChildFromDisk(fixture.manager.getSessionDir(), () => 1000)).toThrow();
		expect(readFileSync(fixture.path, "utf8")).toBe(bytes);
		const fallback =
			bytes.slice(0, -5) +
			JSON.stringify({
				type: "custom_message",
				id: "large-tail",
				parentId: fixture.compaction,
				timestamp: "2026-01-01",
				customType: "tail",
				content: "x".repeat(300000),
				display: false,
			}) +
			"\n";
		writeFileSync(fixture.path, fallback);
		expect(() => appendSessionInfoToExistingFile(fixture.path, "fallback refused", fixture.agentDir)).toThrow();
		expect(readFileSync(fixture.path, "utf8")).toBe(fallback);
	});
	it("preserves a zero-assistant null bridge without archive reads for usage", () => {
		const fixture = rotationFixture();
		const entries = loadEntriesFromFile(fixture.path);
		const removed = entries.find((entry) => entry.type === "message" && entry.id === fixture.assistant);
		if (removed?.type !== "message") throw new Error("missing fixture message");
		removed.message = userMsg("removed ordinary node");
		writeFileSync(fixture.path, serializeSessionEntries(entries));
		const manager = SessionManager.open(fixture.path);
		fixture.bind(manager);
		expect(manager.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("rotated");
		expect(restartOf(manager.getHeader())!.accounting).toEqual([
			{ kind: "bridge", id: fixture.padding, accountingParentId: null },
		]);
		rmSync(sessionArchivePath(fixture.path, manager.getSessionId(), 0));
		expect(
			computeOwnAndTotalUsage(manager.getBranch(), manager.getEntries(), manager.getHeader()).totalUsage.input,
		).toBe(1);
	});
	it("accepts an explicit zero prefix and refuses an oversized archive-0 header without publication", () => {
		const fixture = rotationFixture();
		const entries = loadEntriesFromFile(fixture.path);
		const header = entries[0] as SessionHeader;
		const empty = withRotationRestart(
			{
				...header,
				rotation: {
					version: 1,
					segment: 0,
					archives: [],
					restart: { version: 1, count: 0, sha256: createHash("sha256").digest("hex") },
					accounting: { messageCount: 0 },
				},
			},
			{ originalParents: {}, accounting: [], firstMessage: "" },
		);
		const bytes = serializeSessionEntries([empty, ...entries.slice(1)]);
		expect(parseSessionEntries(bytes).length).toBe(entries.length);
		const zeroPath = join(fixture.directory, "zero.jsonl");
		writeFileSync(zeroPath, bytes);
		appendSessionInfoToExistingFile(zeroPath, "empty prefix", fixture.agentDir);
		expect(SessionManager.open(zeroPath).getHeader()?.rotation?.restart).toEqual(empty.rotation!.restart);
		writeFileSync(
			fixture.path,
			`${JSON.stringify({ ...header, opaque: "é".repeat(33000) })}\n${entries
				.slice(1)
				.map((e) => JSON.stringify(e))
				.join("\n")}\n`,
		);
		const current = SessionManager.open(fixture.path);
		fixture.bind(current);
		const original = readFileSync(fixture.path);
		expect(current.rotateAfterCompaction(fixture.compaction, fixture.agentDir).status).toBe("failed");
		expect(readFileSync(fixture.path).equals(original)).toBe(true);
		expect(existsSync(join(current.getSessionDir(), "archive"))).toBe(false);
	});
});
