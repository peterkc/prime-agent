import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import * as enrollment from "../src/modes/daemon/cotal/enrollment.js";
import {
	claimEnrollment,
	credentialSource,
	deprovisionEnrollment,
	directoryPath,
	enrollmentPath,
	ensureEnrollmentRecord,
	publishDirectory,
	readDirectory,
	readDirectoryAsync,
	readEnrollment,
	readSigner,
	redactMeshError,
	removeEnrollment,
	renameDirectory,
	updateEnrollmentPath,
	withDirectoryLock,
} from "../src/modes/daemon/cotal/enrollment.js";
import { MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import * as rlmLedger from "../src/modes/daemon/rlm-ledger.js";
import { RlmSpawnLedger, readDeletedRlmChildPaths } from "../src/modes/daemon/rlm-ledger.js";
import { createDeferred } from "./suite/scheduling.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fsPromises>()) }));

vi.mock("@cotal-ai/core", async (original) => ({
	...(await original<typeof core>()),
	CotalEndpoint: function (options: core.EndpointOptions) {
		if (!new.target) throw new TypeError("CotalEndpoint requires new");
		return new FakeEndpoint(options);
	},
}));

class FakeEndpoint extends EventEmitter {
	static instances: FakeEndpoint[] = [];
	static failStart = false;
	static afterProvision?: () => void;
	readonly start = vi.fn(async () => {
		if (FakeEndpoint.failStart) throw new Error("start failed");
	});
	readonly stop = vi.fn(async () => undefined);
	readonly provisionDmInbox = vi.fn(async () => FakeEndpoint.afterProvision?.());
	readonly provisionDlvInbox = vi.fn(async () => undefined);
	readonly reissueAcl = vi.fn(async () => undefined);
	constructor(readonly options: core.EndpointOptions) {
		super();
		FakeEndpoint.instances.push(this);
	}
}

const roots: string[] = [];
const meshes: MeshEndpoints[] = [];
afterEach(async () => {
	for (const mesh of meshes.splice(0)) await mesh.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	FakeEndpoint.instances = [];
	FakeEndpoint.failStart = false;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-mesh-enrollment-"));
	roots.push(root);
	vi.stubEnv(ENV_AGENT_DIR, root); // Supervisor logs follow this variable, not defaultSessionConfig.
	const meshRoot = join(root, "mesh");
	mkdirSync(meshRoot);
	const auth = core.stripSpaceAuth(await core.createSpaceAuth("prime"));
	writeFileSync(join(meshRoot, "signer.json"), JSON.stringify(auth), { mode: 0o600 });
	writeFileSync(join(meshRoot, "mesh.json"), JSON.stringify({ space: "prime", server: "nats://127.0.0.1:1" }));
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendSessionInfo("root-a");
	const sessionId = session.getSessionId();
	const sessionFile = session.getSessionFile()!;
	const log = vi.fn();
	const mesh = new MeshEndpoints({ meshRoot, homeSocket: join(root, "daemon.sock"), log, handoff: vi.fn() });
	meshes.push(mesh);
	return { root, meshRoot, auth, session, sessionId, sessionFile, mesh, log };
}

describe("mesh enrollment", () => {
	it.each(["creation", "publication"] as const)(
		"AC-34 rejects a parked enrollment after a committed delete (%s)",
		async (phase) => {
			const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
			const entered = createDeferred();
			const release = createDeferred();
			let holding: Promise<void> | undefined;
			if (phase === "creation") {
				holding = withDirectoryLock(meshRoot, sessionId, async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
			} else
				FakeEndpoint.afterProvision = async () => {
					entered.resolve();
					await release.promise;
				};
			const enrolling = mesh.enqueueEnrollment(sessionId, sessionFile);
			void enrolling.catch(() => undefined);
			try {
				if (phase === "publication") await entered.promise;
				await new RlmSpawnLedger(root, join(root, "sessions")).appendDelete({
					childId: "retained",
					child: sessionFile,
					reason: "user",
				});
				release.resolve();
				await holding;
				await expect(enrolling).rejects.toThrow("RLM child was deliberately deleted");
				expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(phase === "publication");
				expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
				expect(existsSync(sessionFile)).toBe(true);
			} finally {
				release.resolve();
				await holding;
				await enrolling.catch(() => undefined);
				FakeEndpoint.afterProvision = undefined;
			}
		},
	);

	it.each([
		["creation", "unreadable", 0],
		["creation", "unreadable", 1],
		["publication", "unreadable", 0],
		["publication", "unreadable", 1],
		["creation", "malformed", 0],
		["creation", "malformed", 1],
		["publication", "malformed", 0],
		["publication", "malformed", 1],
	] as const)(
		"AC-34 refuses bad shared ledgers without creation, publication or cleanup (%s, %s, %s)",
		async (phase, failure, badIndex) => {
			const { root, meshRoot, sessionId, sessionFile, session, mesh, log } = await fixture();
			await mesh.enroll(sessionId, sessionFile);
			const record = readEnrollment(meshRoot, sessionId);
			const directory = readDirectory(meshRoot, sessionId);
			const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
			const ledgers = [new RlmSpawnLedger(root, join(root, "a")), new RlmSpawnLedger(root, join(root, "b"))];
			for (const ledger of ledgers)
				await ledger.appendDelete({ childId: "same", child: sessionFile, reason: "user" });
			const paths = ledgers.map((ledger) => ledger.ledgerPath).sort();
			const bad = paths[badIndex]!;
			const candidate = SessionManager.create(root, join(root, "new-sessions"));
			candidate.appendSessionInfo("new");
			candidate.flushNow();
			const candidateId = candidate.getSessionId();
			const candidateFile = candidate.getSessionFile()!;
			function poison(): void {
				expect(readDeletedRlmChildPaths(root).has(canonicalSessionPath(sessionFile))).toBe(true);
				const before = statSync(bad);
				if (failure === "unreadable") {
					chmodSync(bad, 0);
					const after = statSync(bad);
					expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
				} else writeFileSync(bad, `${readFileSync(bad, "utf8")}malformed\n`);
			}
			try {
				if (phase === "creation") poison();
				else FakeEndpoint.afterProvision = poison;
				const enrolling = mesh.enroll(candidateId, candidateFile);
				await expect(enrolling).rejects.toThrow(bad);
				await expect(enrolling).rejects.toThrow(failure === "unreadable" ? "EACCES" : "Malformed RLM ledger line");
				expect(existsSync(enrollmentPath(meshRoot, candidateId))).toBe(phase === "publication");
				expect(readDirectory(meshRoot, candidateId)).toBeUndefined();
				await mesh.reconcileDeletedChildren();
				expect(readEnrollment(meshRoot, sessionId)).toEqual(record);
				expect(readDirectory(meshRoot, sessionId)).toEqual(directory);
				expect(remove).not.toHaveBeenCalled();
				expect(log).toHaveBeenCalledWith(expect.stringContaining(bad));
				expect(session.getSessionFile()).toBe(sessionFile);
			} finally {
				chmodSync(bad, 0o600);
				FakeEndpoint.afterProvision = undefined;
			}
		},
	);

	it("AC-34 waits for its own parked enrollment before removing a deleted inbox", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh, log } = await fixture();
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		await publishDirectory(meshRoot, record, join(root, "daemon.sock"));
		const entered = createDeferred();
		const release = createDeferred();
		const lock = enrollment.withDirectoryLock;
		vi.spyOn(enrollment, "withDirectoryLock").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return lock(...args);
		});
		const removeEnrollment = enrollment.removeEnrollment;
		vi.spyOn(enrollment, "removeEnrollment").mockImplementation(async (...args) => {
			const removed = await removeEnrollment(...args);
			// Let unenroll observe the still-held claim before the enrollment resumes next turn.
			setImmediate(() => release.resolve());
			return removed;
		});
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		const enrolling = mesh.enqueueEnrollment(sessionId, sessionFile);
		void enrolling.catch(() => undefined);
		try {
			await entered.promise;
			await new RlmSpawnLedger(root, join(root, "sessions")).appendDelete({
				childId: "child",
				child: sessionFile,
				reason: "user",
			});
			await mesh.reconcileDeletedChildren();
			await expect(enrolling).rejects.toThrow("RLM child was deliberately deleted");
			expect(remove).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ targetId: record.identity.id, lifecycleUid: record.lifecycleUid }),
			);
			expect(log.mock.calls.flat().some((message) => message.includes("claimed by another daemon"))).toBe(false);
			expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
			expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
		} finally {
			release.resolve();
			await enrolling.catch(() => undefined);
		}
	});

	it("AC-34 removes only exact tombstoned paths in one shared reconciliation", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const record = readEnrollment(meshRoot, sessionId);
		const endpoint = FakeEndpoint.instances.at(-1)!;
		const before = readFileSync(sessionFile);
		const other = SessionManager.create(root, join(root, "others"));
		other.appendSessionInfo("other");
		other.flushNow();
		await mesh.enroll(other.getSessionId(), other.getSessionFile()!);
		const otherRecord = readEnrollment(meshRoot, other.getSessionId());
		const ledger = new RlmSpawnLedger(root, join(root, "sessions"));
		for (const [parent, child] of [
			[sessionFile, sessionFile],
			[other.getSessionFile()!, other.getSessionFile()!],
		])
			await ledger.appendSpawn({ childId: "same", parent: parent!, child: child!, depth: 1, name: "child" });
		await ledger.appendDelete({ childId: "same", child: sessionFile, reason: "user" });
		const remove = vi.spyOn(core, "deprovisionAgent").mockImplementation(async () => {
			expect(endpoint.stop).toHaveBeenCalledTimes(1);
			expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
			expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
			return {} as core.DeprovisionResourceAccounting;
		});
		const rm = fsPromises.rm;
		vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
			if (path === enrollmentPath(meshRoot, sessionId)) expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
			return rm(path, options);
		});
		const lookup = vi.spyOn(rlmLedger, "readDeletedRlmChildPaths");
		await mesh.reconcileDeletedChildren();
		expect(lookup).toHaveBeenCalledTimes(2);
		await mesh.reconcileDeletedChildren();
		expect(lookup).toHaveBeenCalledTimes(3);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove.mock.calls[0]![0]).toMatchObject({
			targetId: record.identity.id,
			lifecycleUid: record.lifecycleUid,
		});
		expect(readEnrollment(meshRoot, other.getSessionId())).toEqual(otherRecord);
		expect(readFileSync(sessionFile)).toEqual(before);
		const claim = claimEnrollment(meshRoot, sessionId, sessionFile);
		claim.release();
		await expect(mesh.resolveAddress(sessionId)).rejects.toThrow("Unknown mesh target");
	});

	it("AC-34 keeps a live child when a caller's deletion proof is stale", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const record = readEnrollment(meshRoot, sessionId);
		const directory = readDirectory(meshRoot, sessionId);
		const endpoint = FakeEndpoint.instances.at(-1)!;
		const ledger = new RlmSpawnLedger(root, join(root, "sessions"));
		await ledger.appendDelete({ childId: "child", child: sessionFile, reason: "user" });
		const deleted = readDeletedRlmChildPaths(root);
		await ledger.appendSpawn({ childId: "child", parent: sessionFile, child: sessionFile, depth: 1, name: "child" });
		const deletedPath = canonicalSessionPath(sessionFile);
		expect(deleted.has(deletedPath)).toBe(true);
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		expect(await removeEnrollment(meshRoot, sessionId, deletedPath, true)).toBe("mismatch");
		await mesh.unenroll(sessionId, sessionFile, true);
		writeFileSync(ledger.ledgerPath, "malformed\n", { flag: "a" });
		await expect(removeEnrollment(meshRoot, sessionId, deletedPath, true)).rejects.toThrow(ledger.ledgerPath);
		expect(readEnrollment(meshRoot, sessionId)).toEqual(record);
		expect(readDirectory(meshRoot, sessionId)).toEqual(directory);
		expect(endpoint.stop).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("AC-34 skips a badly named enrollment and still removes a deleted child", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh, log } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const record = readEnrollment(meshRoot, sessionId);
		copyFileSync(enrollmentPath(meshRoot, sessionId), join(meshRoot, "enrollments", "abc copy.json"));
		await new RlmSpawnLedger(root, join(root, "sessions")).appendDelete({
			childId: "child",
			child: sessionFile,
			reason: "user",
		});
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		await expect(mesh.reconcileDeletedChildren()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("Mesh session abc copy: unenrollment failed: Error: Invalid mesh session ID");
		expect(remove).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ targetId: record.identity.id, lifecycleUid: record.lifecycleUid }),
		);
		expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
		expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
	});

	it.each(["rerun", "stop", "removed"] as const)("AC-34 drains one reconciliation before %s", async (mode) => {
		const { root, meshRoot, sessionId, sessionFile, mesh, log } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const other = SessionManager.create(root, join(root, "other-sessions"));
		other.appendSessionInfo("other");
		other.flushNow();
		await mesh.enroll(other.getSessionId(), other.getSessionFile()!);
		const [first, second] = readdirSync(join(meshRoot, "enrollments"))
			.filter((file) => file.endsWith(".json"))
			.map((file) => readEnrollment(meshRoot, file.slice(0, -5)));
		if (!first || !second) throw new Error("Two enrollment records required");
		const ledger = new RlmSpawnLedger(root, join(root, "sessions"));
		await ledger.appendDelete({ childId: "first", child: first.sessionFile, reason: "user" });
		if (mode === "stop") await ledger.appendDelete({ childId: "second", child: second.sessionFile, reason: "user" });
		const entered = createDeferred();
		const release = createDeferred();
		const remove = vi.spyOn(core, "deprovisionAgent").mockImplementation(async (options) => {
			if (options.targetId === first.identity.id) {
				entered.resolve();
				await release.promise;
			}
			return {} as core.DeprovisionResourceAccounting;
		});
		const lookup = vi.spyOn(rlmLedger, "readDeletedRlmChildPaths");
		const pending = [mesh.reconcileDeletedChildren()];
		let stopped = false;
		let stopping: Promise<void> | undefined;
		try {
			await entered.promise;
			if (mode !== "stop")
				await ledger.appendDelete({ childId: "second", child: second.sessionFile, reason: "user" });
			if (mode === "removed") await mesh.unenroll(second.sessionId, second.sessionFile, true);
			else {
				pending.push(mesh.reconcileDeletedChildren(), mesh.reconcileDeletedChildren());
				expect(lookup).toHaveBeenCalledTimes(2);
				if (mode === "stop") {
					vi.useFakeTimers();
					stopping = mesh.stop().then(() => {
						stopped = true;
					});
					await vi.advanceTimersByTimeAsync(0);
					expect(stopped).toBe(false);
				}
			}
			release.resolve();
			await Promise.all(pending);
			await stopping;
			expect(existsSync(enrollmentPath(meshRoot, first.sessionId))).toBe(false);
			expect(existsSync(enrollmentPath(meshRoot, second.sessionId))).toBe(mode === "stop");
			expect(remove).toHaveBeenCalledTimes(mode === "stop" ? 1 : 2);
			if (mode !== "removed") expect(lookup).toHaveBeenCalledTimes(mode === "rerun" ? 4 : 2);
			expect(log.mock.calls.some(([message]) => message.includes("unenrollment failed"))).toBe(false);
			const claim = claimEnrollment(meshRoot, first.sessionId, first.sessionFile);
			claim.release();
		} finally {
			release.resolve();
			await Promise.allSettled(pending);
			await stopping;
		}
	});

	it("AC-34 keeps readiness independent of startup deprovisioning", async () => {
		const { root, meshRoot, sessionId, sessionFile } = await fixture();
		const socket = join(root, "daemon.sock");
		writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		await publishDirectory(meshRoot, record, socket);
		await new RlmSpawnLedger(root, join(root, "sessions")).appendDelete({
			childId: "deleted",
			child: sessionFile,
			reason: "user",
		});
		const entered = createDeferred();
		const release = createDeferred();
		vi.spyOn(core, "deprovisionAgent").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return {} as core.DeprovisionResourceAccounting;
		});
		const supervisor = new DaemonSupervisor(socket, { defaultSessionConfig: { cwd: root, agentDir: root } });
		const order: string[] = [];
		const starting = supervisor.start().then(() => {
			order.push("ready");
		});
		try {
			await entered.promise;
			expect(order).toEqual(["ready"]);
			expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
		} finally {
			release.resolve();
			await starting;
			await (supervisor as unknown as { cleanupSupervisorResources(): Promise<void> }).cleanupSupervisorResources();
		}
	});

	it.each(["rebind", "cancelled", "failed"] as const)(
		"preserves the enrollment lifecycle through %s",
		async (outcome) => {
			const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
			await mesh.enroll(sessionId, sessionFile);
			const before = readEnrollment(meshRoot, sessionId);
			const target = join(root, "replacement.jsonl");
			copyFileSync(sessionFile, target);
			const endpoint = FakeEndpoint.instances.at(-1)!;
			const token = await mesh.beginReplacement(sessionId, mesh, randomUUID());
			expect(endpoint.stop).toHaveBeenCalledTimes(1);
			expect(token).toEqual(expect.any(String));
			const count = FakeEndpoint.instances.length;
			await mesh.finishReplacement(sessionId, token!, outcome === "rebind" ? "completed" : outcome, target);
			if (outcome === "failed") {
				expect(FakeEndpoint.instances).toHaveLength(count);
				await mesh.enqueueEnrollment(sessionId, target);
				expect(FakeEndpoint.instances).toHaveLength(count);
				const reopened = await mesh.beginReplacement(sessionId, mesh, randomUUID());
				await mesh.finishReplacement(sessionId, reopened!, "completed", target);
			}
			const expectedPath = canonicalSessionPath(outcome === "cancelled" ? sessionFile : target);
			expect(readEnrollment(meshRoot, sessionId)).toEqual({ ...before, sessionFile: expectedPath });
			expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(before.identity.id);
			if (outcome !== "cancelled") {
				rmSync(sessionFile);
				const remove = vi
					.spyOn(core, "deprovisionAgent")
					.mockResolvedValue({} as core.DeprovisionResourceAccounting);
				await mesh.unenroll(sessionId, canonicalSessionPath(sessionFile));
				expect(remove).not.toHaveBeenCalled();
				expect(readDirectory(meshRoot, sessionId)).toBeDefined();
				expect(readEnrollment(meshRoot, sessionId).sessionFile).toBe(expectedPath);
			}
		},
	);

	it.each(["disconnect", "failed", "stop-failed"] as const)(
		"recovers a replacement through a disk open (%s)",
		async (mode) => {
			const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
			await mesh.enroll(sessionId, sessionFile);
			const before = readEnrollment(meshRoot, sessionId);
			const target = join(root, "reopened.jsonl");
			copyFileSync(sessionFile, target);
			const endpoint = FakeEndpoint.instances.at(-1)!;
			const requester = {};
			if (mode === "stop-failed") {
				endpoint.stop.mockRejectedValueOnce(new Error("stop-failed"));
				await expect(mesh.beginReplacement(sessionId, requester, randomUUID())).rejects.toThrow("stop-failed");
				await expect(mesh.beginReplacement(sessionId, requester, randomUUID())).rejects.toThrow("stop-failed");
				return;
			}
			const token = await mesh.beginReplacement(sessionId, requester, randomUUID());
			if (mode === "disconnect") mesh.disconnect(requester);
			else await mesh.finishReplacement(sessionId, token!, "failed", target);
			const count = FakeEndpoint.instances.length;
			await mesh.enqueueEnrollment(sessionId, target);
			expect(FakeEndpoint.instances).toHaveLength(count);
			await mesh.openSession(sessionId, target);
			expect(FakeEndpoint.instances.at(-1)).not.toBe(endpoint);
			expect(readEnrollment(meshRoot, sessionId)).toEqual({ ...before, sessionFile: canonicalSessionPath(target) });
			expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(before.identity.id);
		},
	);

	it.each(["enrollment", "close"] as const)("cancels an in-flight begin (%s)", async (phase) => {
		const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
		const entered = createDeferred();
		const resume = createDeferred();
		const token = randomUUID();
		const target = join(root, "cancelled-begin.jsonl");
		copyFileSync(sessionFile, target);
		if (phase === "enrollment") {
			FakeEndpoint.afterProvision = async () => {
				entered.resolve();
				await resume.promise;
			};
		}
		const enrolling = mesh.enroll(sessionId, sessionFile);
		try {
			if (phase === "close") {
				await enrolling;
				FakeEndpoint.instances.at(-1)!.stop.mockImplementationOnce(async () => {
					entered.resolve();
					await resume.promise;
				});
			} else await entered.promise;
			const beginning = mesh.beginReplacement(sessionId, mesh, token);
			if (phase === "close") await entered.promise;
			const cancelled = mesh.finishReplacement(sessionId, token, "cancelled", target);
			void cancelled.catch(() => undefined);
			await expect(mesh.beginReplacement(sessionId, mesh, token)).rejects.toThrow();
			resume.resolve();
			await enrolling;
			await beginning;
			expect(await cancelled).toBe("cancelled");
			const before = readEnrollment(meshRoot, sessionId);
			expect(before.sessionFile).toBe(canonicalSessionPath(sessionFile));
			expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(before.identity.id);
			await expect(mesh.finishReplacement(sessionId, token, "failed", target)).rejects.toThrow(
				"stale replacement token",
			);
			const next = randomUUID();
			await mesh.beginReplacement(sessionId, mesh, next);
			await expect(mesh.beginReplacement(sessionId, mesh, next)).rejects.toThrow();
			await mesh.finishReplacement(sessionId, next, "failed", target);
			await expect(mesh.beginReplacement(sessionId, mesh, next)).rejects.toThrow();
			await expect(mesh.finishReplacement(sessionId, token, "completed", target)).rejects.toThrow(
				"stale replacement token",
			);
			expect(readEnrollment(meshRoot, sessionId)).toEqual(before);
		} finally {
			resume.resolve();
			FakeEndpoint.afterProvision = undefined;
			await enrolling;
		}
	});

	it("rejects an in-flight begin after requester failure", async () => {
		const { meshRoot, sessionId, sessionFile, mesh } = await fixture();
		const entered = createDeferred();
		const resume = createDeferred();
		FakeEndpoint.afterProvision = async () => {
			entered.resolve();
			await resume.promise;
		};
		const enrolling = mesh.enroll(sessionId, sessionFile);
		try {
			await entered.promise;
			const requester = {};
			const beginning = mesh.beginReplacement(sessionId, requester, randomUUID());
			const rejected = expect(beginning).rejects.toThrow(`Session ${sessionId}: replacement begin failed`);
			mesh.disconnect(requester);
			resume.resolve();
			await enrolling;
			await rejected;
			expect(readEnrollment(meshRoot, sessionId).sessionFile).toBe(canonicalSessionPath(sessionFile));
			expect(FakeEndpoint.instances.at(-1)!.stop).not.toHaveBeenCalled();
		} finally {
			resume.resolve();
			FakeEndpoint.afterProvision = undefined;
			await enrolling;
		}
	});

	it("rebinds a moved file during ordinary enrollment", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const before = readEnrollment(meshRoot, sessionId);
		const endpoint = FakeEndpoint.instances.at(-1)!;
		const target = join(root, "moved.jsonl");
		renameSync(sessionFile, target);
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		await mesh.enqueueEnrollment(sessionId, target);
		expect(endpoint.stop).toHaveBeenCalledTimes(1);
		expect(FakeEndpoint.instances.at(-1)).not.toBe(endpoint);
		expect(FakeEndpoint.instances.at(-1)!.start).toHaveBeenCalledTimes(1);
		expect(readEnrollment(meshRoot, sessionId)).toEqual({ ...before, sessionFile: canonicalSessionPath(target) });
		expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(before.identity.id);
		expect(remove).not.toHaveBeenCalled();
	});

	it("never recreates an enrollment deleted while a path update waits for the lock", async () => {
		const { root, meshRoot, sessionId, sessionFile } = await fixture();
		const before = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		await publishDirectory(meshRoot, before, "home");
		const target = join(root, "moved.jsonl");
		copyFileSync(sessionFile, target);
		rmSync(sessionFile);
		let deleting!: () => void;
		let resume!: () => void;
		const ready = new Promise<void>((resolve) => {
			deleting = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const remove = fsPromises.rm;
		vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
			if (path === enrollmentPath(meshRoot, sessionId)) {
				deleting();
				await gate;
			}
			await remove(path, options);
		});
		const deleted = removeEnrollment(meshRoot, sessionId, canonicalSessionPath(sessionFile));
		await ready;
		const updated = expect(updateEnrollmentPath(meshRoot, sessionId, target)).rejects.toThrow(
			"removed during replacement",
		);
		resume();
		await deleted;
		await updated;
		expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
		expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
	});
	it("AC-18 deleting a copy with the same ID preserves the enrolled session and inbox", async () => {
		const { root, meshRoot, sessionId, sessionFile, mesh, log } = await fixture();
		await mesh.enroll(sessionId, sessionFile);
		const record = readEnrollment(meshRoot, sessionId);
		const entry = readDirectory(meshRoot, sessionId);
		const endpoint = FakeEndpoint.instances.at(-1)!;
		const copy = join(root, "copied.jsonl");
		copyFileSync(sessionFile, copy);
		const deletedPath = canonicalSessionPath(copy);
		rmSync(copy);
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		await mesh.unenroll(sessionId, deletedPath);
		expect(readDirectory(meshRoot, sessionId)).toEqual(entry);
		expect(readEnrollment(meshRoot, sessionId)).toEqual(record);
		expect(endpoint.stop).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("deleted file is not the enrolled file"));
	});

	it("AC-18 removes the directory before the record and mints only a lifecycle-exact deprovisioner", async () => {
		const { meshRoot, sessionId, sessionFile, mesh, log } = await fixture();
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		await publishDirectory(meshRoot, record, "home");
		const removeFile = fsPromises.rm;
		vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
			if (path === enrollmentPath(meshRoot, sessionId))
				expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
			await removeFile(path, options);
		});
		const deletedPath = canonicalSessionPath(sessionFile);
		rmSync(sessionFile);
		expect(await removeEnrollment(meshRoot, sessionId, deletedPath)).toEqual(record);
		expect(readDirectory(meshRoot, sessionId)).toBeUndefined();
		expect(await readDirectoryAsync(meshRoot, sessionId)).toBeUndefined();
		expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
		await mesh.unenroll(sessionId, canonicalSessionPath(sessionFile));
		expect(log).not.toHaveBeenCalled();
		const remove = vi.spyOn(core, "deprovisionAgent").mockResolvedValue({} as core.DeprovisionResourceAccounting);
		await deprovisionEnrollment(meshRoot, { space: "prime", server: "nats://127.0.0.1:1" }, record);
		const call = remove.mock.calls[0]![0];
		expect(call).toMatchObject({
			targetId: record.identity.id,
			lifecycleUid: record.lifecycleUid,
			space: "prime",
			servers: "nats://127.0.0.1:1",
		});
		const claims = core.credsClaims(call.creds!);
		const permissions = JSON.stringify(claims.nats);
		for (const stream of ["DM_prime", "DLV_prime"])
			expect(permissions).toContain(`$JS.API.CONSUMER.DELETE.${stream}.`);
		expect(permissions).toContain(record.lifecycleUid);
		expect(permissions).toContain(record.identity.id);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("preserves validation errors when failed cleanup also fails", async () => {
		const { root, sessionId, sessionFile, mesh } = await fixture();
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { cwd: root, agentDir: root },
		});
		const internals = supervisor as unknown as {
			handleCommand(client: never, command: DaemonCommand): Promise<unknown>;
			cleanupSupervisorResources(): Promise<void>;
		};
		const validationError = new Error("roster validation failed");
		const finishError = Object.assign(new Error("private cleanup credential"), {
			code: "CLEANUP_FAILED",
			cause: { request: "private request credential" },
		});
		const finish = vi.spyOn(mesh, "finishReplacement").mockRejectedValueOnce(finishError);
		const log = vi.fn();
		Object.assign(internals, {
			mesh,
			findWorkerForClient: async () => ({ worker: { meshDeliveryCapable: true, meshReplacementCapable: true } }),
			refreshWorkerSummaries: async () => {
				throw validationError;
			},
			log,
		});
		try {
			await expect(
				internals.handleCommand({} as never, {
					type: "mesh_replace",
					phase: "completed",
					fromActiveSessionId: "source",
					sessionId,
					sessionFile,
					token: "replacement",
				}),
			).rejects.toBe(validationError);
			expect(finish).toHaveBeenCalledTimes(1);
			expect(finish).toHaveBeenCalledWith(sessionId, "replacement", "failed", sessionFile);
			expect(log.mock.calls).toEqual([["Mesh replacement cleanup failed: Error (CLEANUP_FAILED)"]]);
		} finally {
			await internals.cleanupSupervisorResources();
		}
	});

	it.each(["mesh.json", "signer.json", "invalid mesh.json", "signer mode"])(
		"keeps the supervisor ready with refusing Cotal mode for %s",
		async (missing) => {
			const { root, meshRoot } = await fixture();
			writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
			const file =
				missing === "invalid mesh.json" ? "mesh.json" : missing === "signer mode" ? "signer.json" : missing;
			if (missing === "invalid mesh.json") writeFileSync(join(meshRoot, file), "{");
			else if (missing === "signer mode") chmodSync(join(meshRoot, file), 0o644);
			else rmSync(join(meshRoot, file));
			const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
				defaultSessionConfig: { cwd: root, agentDir: root },
			});
			const internals = supervisor as unknown as {
				startupComplete: boolean;
				mesh: MeshEndpoints;
				cleanupSupervisorResources(): Promise<void>;
			};
			try {
				await supervisor.start();
				expect(internals.startupComplete).toBe(true);
				await expect(internals.mesh.send({ sessionId: "absent" }, "target", "hello")).rejects.toThrow(
					"not stored: mesh unavailable: Error: Mesh",
				);
				await expect(internals.mesh.send({ sessionId: "absent" }, "target", "hello")).rejects.toThrow(
					join(meshRoot, file),
				);
				expect(FakeEndpoint.instances).toHaveLength(0);
			} finally {
				await internals.cleanupSupervisorResources();
			}
		},
	);

	it.each(["record", "provisioning"])(
		"starts home enrollment after readiness and continues past a failed home %s",
		async (failure) => {
			const { root, meshRoot, sessionId, sessionFile } = await fixture();
			const socket = join(root, "daemon.sock");
			writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
			const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			await publishDirectory(meshRoot, record, socket);
			writeFileSync(
				directoryPath(meshRoot, "0"),
				JSON.stringify({ sessionId: "0", name: "bad", principal: "local.bad", homeSocket: socket }),
			);
			const badRecord = { ...record, sessionId: "0" };
			writeFileSync(enrollmentPath(meshRoot, "0"), failure === "record" ? "{" : JSON.stringify(badRecord), {
				mode: 0o600,
			});
			const enroll = MeshEndpoints.prototype.enroll;
			vi.spyOn(MeshEndpoints.prototype, "enroll").mockImplementation(async function (this: MeshEndpoints, id, file) {
				expect(ready).toHaveBeenCalledTimes(1);
				if (failure === "provisioning" && id === "0") FakeEndpoint.failStart = true;
				try {
					return await enroll.call(this, id, file);
				} finally {
					FakeEndpoint.failStart = false;
				}
			});
			const start = vi.spyOn(MeshEndpoints.prototype, "start");
			const supervisor = new DaemonSupervisor(socket, { defaultSessionConfig: { cwd: root, agentDir: root } });
			const internals = supervisor as unknown as {
				startupComplete: boolean;
				mesh: MeshEndpoints;
				log(message: string): void;
				markReady(): void;
				cleanupSupervisorResources(): Promise<void>;
			};
			const log = vi.spyOn(internals, "log");
			const ready = vi.spyOn(internals, "markReady");
			try {
				await supervisor.start();
				expect(internals.startupComplete).toBe(true);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await start.mock.results[0]!.value;
				expect(FakeEndpoint.instances).toHaveLength(failure === "record" ? 2 : 3);
				await expect(internals.mesh.send({ sessionId: "0" }, sessionId, "hello")).rejects.toThrow(
					"enrollment failed",
				);
				expect(log).toHaveBeenCalledWith(expect.stringContaining("Mesh session 0:"));
				const claim = claimEnrollment(meshRoot, "0", sessionFile);
				claim.release();
				expect(log).toHaveBeenCalledWith(expect.stringMatching(/Mesh home enrollment: 2 sessions in \d+ ms/));
			} finally {
				await internals.cleanupSupervisorResources();
			}
		},
	);

	it("uses the same fresh enrollment claim through a symlink alias and its real path", async () => {
		const { root, meshRoot, sessionId, sessionFile } = await fixture();
		const alias = join(root, "alias");
		symlinkSync(meshRoot, alias);
		const claim = claimEnrollment(alias, sessionId, sessionFile);
		try {
			ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			expect(() => claimEnrollment(meshRoot, sessionId, sessionFile)).toThrow("already active");
		} finally {
			claim.release();
		}
	});

	it.each(["owner", "local.*", "local.a.b", "local.a-b", ".a", "local."])(
		"rejects malformed directory principal %s",
		async (principal) => {
			const { meshRoot, sessionId, sessionFile } = await fixture();
			const entry = await publishDirectory(
				meshRoot,
				ensureEnrollmentRecord(meshRoot, sessionId, sessionFile),
				"home",
			);
			expect(readDirectory(meshRoot, sessionId)).toEqual(entry);
			writeFileSync(directoryPath(meshRoot, sessionId), JSON.stringify({ ...entry, principal }));
			expect(() => readDirectory(meshRoot, sessionId)).toThrow("invalid entry");
		},
	);

	it.each(["mint", "identity"])(
		"retains safe %s error fields and bounds redacted diagnostic messages",
		async (boundary) => {
			const { auth, meshRoot, sessionId, sessionFile } = await fixture();
			const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			const error = Object.assign(
				new Error(`nkeys failed ${auth.account.signingSeed} ${record.identity.seed} opaque-private-fragment`),
				{ name: "MintError", code: "EKEY" },
			);
			if (boundary === "mint") {
				vi.spyOn(core, "mintCreds").mockRejectedValueOnce(error);
				await expect(credentialSource(meshRoot, "prime", record)()).rejects.toMatchObject({
					message: `Mesh signer ${join(meshRoot, "signer.json")}: credential mint failed: MintError (EKEY)`,
				});
			} else {
				vi.spyOn(core, "newIdentity").mockImplementationOnce(() => {
					throw error;
				});
				expect(() => ensureEnrollmentRecord(meshRoot, "fresh", sessionFile)).toThrow(
					/^Mesh session fresh: identity creation failed: MintError \(EKEY\)$/,
				);
			}
			expect(redactMeshError(error, false)).toBe("MintError (EKEY)");
			expect(redactMeshError(new Error("x".repeat(1000)))).toHaveLength(519);
			expect(redactMeshError(error)).not.toContain(record.identity.seed);
		},
	);

	it("reuses one private identity across concurrent enrollment and restart, and provisions before publication", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		await Promise.all([mesh.enroll(sessionId, sessionFile), mesh.enroll(sessionId, sessionFile)]);
		const path = enrollmentPath(meshRoot, sessionId);
		const before = readFileSync(path, "utf8");
		expect(FakeEndpoint.instances).toHaveLength(2);
		expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledTimes(1);
		expect(FakeEndpoint.instances[0]!.stop).toHaveBeenCalledTimes(1);
		const record = JSON.parse(before);
		expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledWith(
			"local",
			record.identity.id,
			record.lifecycleUid,
		);
		expect(FakeEndpoint.instances[1]!.options.lifecycleUid).toBe(record.lifecycleUid);
		expect(readFileSync(directoryPath(meshRoot, sessionId), "utf8")).not.toContain(record.identity.seed);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		await mesh.stop();
		const restarted = new MeshEndpoints({
			meshRoot,
			homeSocket: join(meshRoot, "../daemon.sock"),
			log: vi.fn(),
			handoff: vi.fn(),
		});
		meshes.push(restarted);
		await restarted.start();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(FakeEndpoint.instances).toHaveLength(4);
		expect(FakeEndpoint.instances[3]!.options.card?.id).toBe(record.identity.id);
	});

	it("recovers after a stop at the record or at provisioning, and refuses fileless sessions", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		await expect(mesh.enroll("memory")).rejects.toThrow("no session file");
		await expect(mesh.resolveAddress("memory")).rejects.toThrow("no session file");
		await expect(mesh.send({ sessionId: "never" }, sessionId, "hello")).rejects.toThrow("is not enrolled");
		await expect(mesh.send({ sessionId: "memory" }, sessionId, "hello")).rejects.toThrow(
			"enrollment failed: Error: Session memory has no session file",
		);
		expect(existsSync(enrollmentPath(meshRoot, "memory"))).toBe(false);
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		FakeEndpoint.failStart = true;
		await expect(mesh.enroll(sessionId, sessionFile)).rejects.toThrow();
		await expect(mesh.send({ sessionId }, "memory", "hello")).rejects.toThrow(
			"enrollment failed: Error: Mesh session",
		);
		expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
		FakeEndpoint.failStart = false;
		const publish = vi.spyOn(FakeEndpoint.prototype, "emit");
		await mesh.enroll(sessionId, sessionFile);
		expect(JSON.parse(readFileSync(enrollmentPath(meshRoot, sessionId), "utf8")).identity).toEqual(record.identity);
		expect(publish).not.toHaveBeenCalledWith("message", expect.anything());
		expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(record.identity.id);
	});

	it("keeps its record and identity when publication fails after successful provisioning", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		const bytes = readFileSync(sessionFile);
		FakeEndpoint.afterProvision = () => rmSync(sessionFile);
		try {
			await expect(mesh.enroll(sessionId, sessionFile)).rejects.toThrow("missing");
			const before = readFileSync(enrollmentPath(meshRoot, sessionId), "utf8");
			expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledTimes(1);
			expect(FakeEndpoint.instances[0]!.stop).toHaveBeenCalledTimes(1);
			expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
			writeFileSync(sessionFile, bytes);
			FakeEndpoint.afterProvision = undefined;
			await mesh.enroll(sessionId, sessionFile);
			expect(readFileSync(enrollmentPath(meshRoot, sessionId), "utf8")).toBe(before);
			expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(JSON.parse(before).identity.id);
		} finally {
			FakeEndpoint.afterProvision = undefined;
		}
	});

	it("does not restore a directory entry when the session file or enrollment record disappeared", async () => {
		const { meshRoot, sessionId, sessionFile, session } = await fixture();
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		session.appendSessionInfo("latest-name");
		const entry = await publishDirectory(meshRoot, record, "home");
		session.appendSessionInfo("newer-name");
		await renameDirectory(meshRoot, sessionId, sessionFile);
		expect(readDirectory(meshRoot, sessionId)).toEqual({ ...entry, name: "newer-name" });
		rmSync(directoryPath(meshRoot, sessionId));
		await renameDirectory(meshRoot, sessionId, sessionFile);
		rmSync(enrollmentPath(meshRoot, sessionId));
		await expect(publishDirectory(meshRoot, record, "home")).rejects.toThrow("missing");
		expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
	});

	it.each(["missing", "directory", "symlink", "mode", "owner", "json"])(
		"rejects signer %s without exposing contents or creating an enrollment",
		async (reason) => {
			const { meshRoot, mesh, sessionId, sessionFile, auth } = await fixture();
			const path = join(meshRoot, "signer.json");
			if (reason === "missing") rmSync(path);
			if (reason === "directory") {
				rmSync(path);
				mkdirSync(path);
			}
			if (reason === "symlink") {
				const target = join(meshRoot, "seed.json");
				writeFileSync(target, JSON.stringify(auth));
				rmSync(path);
				symlinkSync(target, path);
			}
			if (reason === "mode") chmodSync(path, 0o644);
			if (reason === "owner") vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
			if (reason === "json") writeFileSync(path, `invalid-${auth.account.signingSeed}`);
			let error: unknown;
			try {
				await mesh.enroll(sessionId, sessionFile);
			} catch (failure) {
				error = failure;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(path);
			expect((error as Error).message).not.toContain(auth.account.signingSeed);
			expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
			expect(() => readSigner(meshRoot, "prime")).toThrow();
		},
	);

	it("mints two one-hour credentials with the same identity, lifecycle and read set", async () => {
		vi.useFakeTimers({ toFake: ["Date"] }); // expiry and iat read the clock separately; a second boundary between them gave 3599
		const { meshRoot, sessionId, sessionFile } = await fixture();
		const record = { ...ensureEnrollmentRecord(meshRoot, sessionId, sessionFile), allowSubscribe: ["work"] };
		const source = credentialSource(meshRoot, "prime", record);
		for (const credential of [await source(), await source()]) {
			const claims = core.credsClaims(credential);
			expect(claims.sub).toBe(record.identity.id);
			expect(claims.exp! - claims.iat!).toBe(3600);
			expect(JSON.stringify(claims.nats)).toContain(record.lifecycleUid);
			expect(JSON.stringify(claims.nats)).toContain("work");
		}
	});

	it.each(["native", "project", "invalid"])("selects native for %s and creates no mesh files", async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "prime-mesh-off-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".prime"), { recursive: true });
		writeFileSync(join(root, "settings.json"), mode === "invalid" ? "{" : "{}");
		if (mode === "project")
			writeFileSync(join(cwd, ".prime", "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
		expect(SettingsManager.create(cwd, root).getAgentMessageTransport()).toBe("native");
		const hook = `
			import { registerHooks } from "node:module";
			registerHooks({ resolve(specifier, context, next) {
				if (specifier === "@cotal-ai/core" || specifier === "nats" || specifier.startsWith("@nats-io/"))
					throw new Error("Mode off loaded " + specifier);
				return next(specifier, context);
			} });
		`;
		const script = `
			import ${JSON.stringify(resolve("src/main.ts"))};
			import { DaemonSupervisor } from ${JSON.stringify(resolve("src/modes/daemon/daemon-supervisor.ts"))};
			import ${JSON.stringify(resolve("src/modes/daemon/daemon-mode.ts"))};
			const supervisor = new DaemonSupervisor(${JSON.stringify(join(root, "probe.sock"))}, {
				defaultSessionConfig: { cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(root)} }
			});
			try { await supervisor.start(); console.log("mode off imports clean"); }
			finally { await supervisor.cleanupSupervisorResources(); }
		`;
		const child = spawn(
			process.execPath,
			[
				"--import",
				resolve("../../node_modules/tsx/dist/loader.mjs"),
				"--import",
				`data:text/javascript,${encodeURIComponent(hook)}`,
				"--input-type=module",
				"-e",
				script,
			],
			{
				cwd,
				env: {
					...process.env,
					TSX_TSCONFIG_PATH: resolve("../../tsconfig.json"),
				},
			},
		);
		let output = "";
		child.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			output += data.toString();
		});
		const code = await new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", resolveExit);
		});
		expect({ code, output }).toEqual({ code: 0, output: expect.stringContaining("mode off imports clean") });
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { cwd, agentDir: root },
		});
		try {
			await supervisor.start();
			expect(FakeEndpoint.instances).toHaveLength(0);
			expect(existsSync(join(root, "mesh"))).toBe(false);
		} finally {
			await (supervisor as unknown as { cleanupSupervisorResources(): Promise<void> }).cleanupSupervisorResources();
		}
	});

	it("leaves a live claim in another process alone and reclaims it after that process exits", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		const script = `import { claimEnrollment } from ${JSON.stringify(resolve("src/modes/daemon/cotal/enrollment.ts"))}; claimEnrollment(...JSON.parse(process.argv[1])); console.log("claimed"); process.stdin.resume();`;
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([meshRoot, sessionId, sessionFile])],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve());
				child.once("error", reject);
				child.once("exit", () => reject(new Error("claim child exited before receipt")));
			});
			expect(() => claimEnrollment(meshRoot, sessionId, sessionFile)).toThrow("already active");
			await mesh.enroll(sessionId, sessionFile);
			await expect(mesh.send({ sessionId }, "target", "hello")).rejects.toThrow("claimed by another daemon");
			await expect(mesh.beginReplacement(sessionId, mesh, randomUUID())).rejects.toThrow(
				`Session ${sessionId}: claimed by another daemon`,
			);
			expect(readEnrollment(meshRoot, sessionId)).toEqual(record);
			expect(FakeEndpoint.instances).toHaveLength(0);
		} finally {
			child.kill("SIGTERM");
			await closed;
		}
		const claim = claimEnrollment(meshRoot, sessionId, sessionFile);
		claim.release();
	});
});
