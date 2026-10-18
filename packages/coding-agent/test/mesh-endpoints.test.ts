import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { type AgentFamilyMember, createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import * as enrollment from "../src/modes/daemon/cotal/enrollment.js";
import { type MeshEndpointOptions, MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";

vi.mock("@cotal-ai/core", async (original) => ({
	...(await original<typeof core>()),
	CotalEndpoint: function (options: core.EndpointOptions) {
		if (!new.target) throw new TypeError("CotalEndpoint requires new");
		return new Endpoint(options);
	},
}));
vi.mock("../src/modes/daemon/cotal/enrollment.js", async (original) => ({
	...(await original<typeof enrollment>()),
	loadMeshConfiguration: () => ({ space: "prime", server: "nats://127.0.0.1:1" }),
	readSigner: vi.fn(),
	homeEnrollments: vi.fn(() => []),
	claimEnrollment: vi.fn(() => ({ release: releaseClaim })),
	ensureEnrollmentRecord: (_: string, id: string, path: string) => ({
		sessionId: id,
		sessionFile: path,
		identity: { id, seed: "private-test-seed" },
		lifecycleUid: "same-uid",
		allowSubscribe: [],
	}),
	provisionEnrollment: vi.fn(async () => undefined),
	publishDirectory: vi.fn(async (_: string, record: enrollment.EnrollmentRecord, homeSocket: string) => ({
		sessionId: record.sessionId,
		name: record.sessionId,
		principal: `local.${record.sessionId}`,
		homeSocket,
	})),
	credentialSource: () => async () => "test-only-credential",
	deprovisionEnrollment: vi.fn(async () => undefined),
	removeEnrollment: vi.fn(),
	enrollmentPath: (root: string, id: string) => join(root, `${id}.json`),
	readDirectory: vi.fn((_: string, id: string) => directories.get(id)),
}));

class Endpoint extends EventEmitter {
	static instances: Endpoint[] = [];
	static onStart?: (endpoint: Endpoint) => void;
	readonly start = vi.fn(async () => Endpoint.onStart?.(this));
	readonly stop = vi.fn(async (): Promise<void> => undefined);
	readonly reconnect = vi.fn(async (): Promise<void> => undefined);
	readonly unicastAttributed = vi.fn(async () => ({ msg: { id: "published" }, ack: { seq: 42, duplicate: false } }));
	constructor(readonly options: core.EndpointOptions) {
		super();
		Endpoint.instances.push(this);
	}
}

const directories = new Map<string, enrollment.MeshDirectoryEntry>();
const releaseClaim = vi.fn();
const roots: string[] = [];
const meshes: MeshEndpoints[] = [];
const recipient = {};

afterEach(async () => {
	for (const mesh of meshes.splice(0)) {
		const stopped = mesh.stop();
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5000);
		await stopped;
	}
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	Endpoint.instances = [];
	Endpoint.onStart = undefined;
	directories.clear();
	releaseClaim.mockClear();
	vi.mocked(enrollment.provisionEnrollment).mockReset().mockResolvedValue(undefined);
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

async function fixture(
	handoff: MeshEndpointOptions["handoff"] = async (_record, _message, _count, bind) => {
		bind(recipient);
	},
) {
	const root = mkdtempSync(join(tmpdir(), "prime-mesh-endpoints-"));
	roots.push(root);
	vi.stubEnv(ENV_AGENT_DIR, root);
	mkdirSync(join(root, "directory"));
	for (const id of ["a", "b"]) {
		writeFileSync(join(root, "directory", `${id}.json`), "{}");
		writeFileSync(join(root, `${id}.json`), "{}");
		directories.set(id, { sessionId: id, name: id, principal: `local.${id}`, homeSocket: "home" });
	}
	const log = vi.fn();
	const handoffSpy = vi.fn(handoff);
	const mesh = new MeshEndpoints({ meshRoot: root, homeSocket: "home", log, handoff: handoffSpy });
	meshes.push(mesh);
	await mesh.enroll("a", join(root, "a.json"));
	await mesh.enroll("b", join(root, "b.json"));
	return { mesh, root, log, handoff: handoffSpy, source: Endpoint.instances[0]!, target: Endpoint.instances[1]! };
}

function delivery(id: string, count = 1) {
	const working = vi.fn();
	const ack = vi.fn();
	const message = {
		id,
		ts: 0,
		space: "prime",
		from: { id: "local.a", name: "a" },
		to: "local.b",
		parts: [{ kind: "text", text: "hello" }],
	} as core.CotalMessage;
	return {
		message,
		delivery: { durable: true, ack, nak: vi.fn(), redelivery: { deliveryCount: count, ackWaitMs: 3000, working } },
		ack,
		working,
	};
}

function attempt(mesh: MeshEndpoints, id: string): string {
	return (
		(mesh as unknown as { pending: Map<string, { attemptToken: string }> }).pending.get(id)?.attemptToken ?? "stale"
	);
}

async function settled(mesh: MeshEndpoints, id: string) {
	await (mesh as unknown as { sessions: Map<string, { handoff?: Promise<void> }> }).sessions.get(id)?.handoff;
}

describe("mesh endpoints", () => {
	it.each(["persisted", "cleared", "closed", "other"] as const)(
		"ignores a stale %s delivery attempt",
		async (reason) => {
			const { mesh, target, handoff } = await fixture();
			const first = delivery("same");
			target.emit("message", first.message, first.delivery, { kind: "dm" });
			const oldToken = attempt(mesh, "same");
			mesh.confirmDropped("same", recipient, "other", oldToken);
			await settled(mesh, "b");
			const next = delivery("same", 2);
			target.emit("message", next.message, next.delivery, { kind: "dm" });
			if (reason === "persisted") mesh.confirmPersisted("same", recipient, oldToken);
			else mesh.confirmDropped("same", recipient, reason, oldToken);
			expect(handoff).toHaveBeenCalledTimes(2);
			expect(next.ack).not.toHaveBeenCalled();
			expect(attempt(mesh, "same")).not.toBe(oldToken);
			mesh.confirmPersisted("same", recipient, attempt(mesh, "same"));
			await settled(mesh, "b");
			expect(first.ack).not.toHaveBeenCalled();
			expect(next.ack).toHaveBeenCalledTimes(1);
		},
	);
	it("AC-18 missing session file never provisions or creates an endpoint", async () => {
		const { mesh, root } = await fixture();
		vi.mocked(enrollment.provisionEnrollment).mockClear();
		await expect(mesh.enroll("missing", join(root, "missing.json"))).rejects.toThrow("session file is missing");
		expect(enrollment.provisionEnrollment).not.toHaveBeenCalled();
		expect(Endpoint.instances).toHaveLength(2);
		expect(enrollment.deprovisionEnrollment).not.toHaveBeenCalled();
	});

	it.each(["provision", "start", "read", "deleted"])("AC-18 failed %s removes only after delete", async (stage) => {
		if (stage === "provision")
			vi.mocked(enrollment.provisionEnrollment).mockImplementationOnce(async () => {
				directories.delete("a"); // No first directory publication has happened.
				throw new Error("first failed");
			});
		else if (stage === "deleted")
			vi.mocked(enrollment.publishDirectory).mockImplementationOnce(async (root, record) => {
				rmSync(enrollment.enrollmentPath(root, record.sessionId));
				throw new Error("first failed");
			});
		else {
			Endpoint.onStart = () => {
				throw new Error("first failed");
			};
			if (stage === "read")
				vi.mocked(enrollment.readDirectory).mockImplementationOnce(() => {
					throw new Error("directory unreadable");
				});
		}
		await expect(fixture()).rejects.toThrow("first failed");
		expect(enrollment.deprovisionEnrollment).toHaveBeenCalledTimes(stage === "deleted" ? 1 : 0);
		expect(releaseClaim).toHaveBeenCalledTimes(1);
		if (stage === "read") expect(Endpoint.instances[0]!.stop).toHaveBeenCalledTimes(1);
	});

	it("AC-18 deletion during endpoint start removes and releases once", async () => {
		let finishStart!: () => void;
		let starting!: () => void;
		const ready = new Promise<void>((resolve) => {
			starting = resolve;
		});
		Endpoint.onStart = (endpoint) => {
			if (endpoint.options.card?.id !== "b") return;
			starting();
			return new Promise<void>((resolve) => {
				finishStart = resolve;
			});
		};
		const started = fixture();
		const refused = expect(started).rejects.toThrow("directory entry disappeared");
		await ready;
		const mesh = meshes[0]!;
		const root = roots[0]!;
		directories.delete("b");
		vi.mocked(enrollment.removeEnrollment).mockResolvedValueOnce(
			enrollment.ensureEnrollmentRecord(root, "b", join(root, "b.json")),
		);
		try {
			await mesh.unenroll("b", join(root, "b.json"));
		} finally {
			finishStart();
			await refused;
		}
		expect(Endpoint.instances[1]!.stop).toHaveBeenCalledTimes(1);
		expect(enrollment.deprovisionEnrollment).toHaveBeenCalledTimes(1);
		expect(releaseClaim).toHaveBeenCalledTimes(1);
	});

	it.each(["partial", "stop-failed"])(
		"AC-18 %s removal retains the right custody and never retries",
		async (failure) => {
			const { mesh, target, root, log } = await fixture();
			const record = enrollment.ensureEnrollmentRecord(root, "b", join(root, "b.json"));
			vi.mocked(enrollment.removeEnrollment).mockResolvedValueOnce(record);
			if (failure === "partial")
				vi.mocked(enrollment.deprovisionEnrollment).mockRejectedValueOnce(
					new core.DeprovisionError("DLV consumer left", {
						examined: 3,
						deleted: 2,
						absent: 0,
						refused: 1,
						acknowledged: 1,
						disappeared: 0,
						consumers: { examined: 2, deleted: 1, absent: 0, refused: 1, acknowledged: 1, disappeared: 0 },
						acls: { examined: 1, deleted: 1, absent: 0, refused: 0, disappeared: 0 },
						members: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
					}),
				);
			else target.stop.mockRejectedValueOnce(new Error("stop failed"));
			const removed = mesh.unenroll("b", join(root, "b.json"));
			if (failure === "partial") await removed;
			else await expect(removed).rejects.toThrow("stop failed");
			expect(target.stop).toHaveBeenCalledTimes(1);
			expect(enrollment.deprovisionEnrollment).toHaveBeenCalledTimes(failure === "partial" ? 1 : 0);
			expect(releaseClaim).toHaveBeenCalledTimes(failure === "partial" ? 1 : 0);
			expect(log).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining(failure === "partial" ? "inbox removal failed" : "claim retained"),
			);
			if (failure === "stop-failed") await expect(mesh.enroll("b", join(root, "b.json"))).rejects.toThrow("closed");
		},
	);

	it("AC-32 starts session endpoints without presence or channel watches", async () => {
		const { source, target } = await fixture();
		for (const endpoint of [source, target])
			expect(endpoint.options).toMatchObject({ watchPresence: false, watchChannels: false });
	});

	it.each(["persisted", "cleared", "closed"] as const)(
		"AC-18 close blocks late %s frames and queued wakes until stop completes",
		async (frame) => {
			vi.useFakeTimers();
			let finishWake!: () => void;
			let isOpen!: () => boolean;
			const sent = vi.fn();
			const { mesh, target } = await fixture(async (_record, _message, _count, bind, open) => {
				bind(recipient);
				isOpen = open;
				await new Promise<void>((resolve) => {
					finishWake = resolve;
				});
				if (open()) sent();
			});
			const first = delivery("held");
			const second = delivery("queued");
			target.emit("message", first.message, first.delivery, { kind: "dm" });
			target.emit("message", second.message, second.delivery, { kind: "dm" });
			let finishStop!: () => void;
			target.stop.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishStop = resolve;
					}),
			);
			const stopped = mesh.closeSession("b");
			expect(isOpen()).toBe(false);
			expect(releaseClaim).not.toHaveBeenCalled();
			if (frame === "persisted") mesh.confirmPersisted("held", recipient, attempt(mesh, "held"));
			else mesh.confirmDropped("held", recipient, frame, attempt(mesh, "held"));
			finishWake();
			await settled(mesh, "b");
			await vi.advanceTimersByTimeAsync(6000);
			expect(sent).not.toHaveBeenCalled();
			for (const item of [first, second]) {
				expect(item.ack).not.toHaveBeenCalled();
				expect(item.delivery.nak).not.toHaveBeenCalled();
				expect(item.working).toHaveBeenCalledTimes(1);
			}
			finishStop();
			await stopped;
			expect(mesh.closeSession("b")).toBe(stopped);
			await expect(mesh.enroll("b", "b.json")).rejects.toThrow("closed");
		},
	);

	it.each(["valid", "expired", "timeout"])("AC-27 %s wire credentials before a close event", async (state) => {
		vi.useFakeTimers();
		vi.spyOn(core, "credsClaims").mockImplementation(
			() => ({ exp: Math.floor(Date.now() / 1000) + 120 }) as ReturnType<typeof core.credsClaims>,
		);
		Endpoint.onStart = async (endpoint) => {
			if (typeof endpoint.options.creds !== "function") throw new Error("Expected credential source");
			await endpoint.options.creds();
			endpoint.emit("connection", { connected: true });
		};
		const { mesh, source } = await fixture();
		if (state !== "valid") await vi.advanceTimersByTimeAsync(121_000);
		const send = mesh.send({ sessionId: "a" }, "b", "after expiry");
		const outcome =
			state === "timeout"
				? expect(send).rejects.toThrow("Message was not stored")
				: expect(send).resolves.toMatchObject({ deliveryStatus: "stored" });
		if (state === "valid") expect(source.reconnect).not.toHaveBeenCalled();
		else {
			expect(source.reconnect).toHaveBeenCalledTimes(1);
			expect(source.unicastAttributed).not.toHaveBeenCalled();
			if (state === "expired") {
				source.emit("connection", { connected: false });
				if (typeof source.options.creds !== "function") throw new Error("Expected credential source");
				await source.options.creds();
				source.emit("connection", { connected: true });
			} else await vi.advanceTimersByTimeAsync(30_000);
		}
		await outcome;
		expect(source.reconnect).toHaveBeenCalledTimes(state === "valid" ? 0 : 1);
		expect(source.unicastAttributed).toHaveBeenCalledTimes(state === "timeout" ? 0 : 1);
	});

	it.each(["connection", "transport", "timeout"])(
		"AC-27 waits for %s before publishing, within one deadline",
		async (event) => {
			vi.useFakeTimers();
			const { mesh, source } = await fixture();
			source.emit(event === "transport" ? "transport" : "connection", { connected: false });
			const send = mesh.send({ sessionId: "a" }, "b", "hello");
			const result =
				event === "timeout"
					? expect(send).rejects.toThrow("Message was not stored")
					: expect(send).resolves.toMatchObject({ deliveryStatus: "stored" });
			await vi.advanceTimersByTimeAsync(event === "timeout" ? 30_000 : 8000);
			expect(source.unicastAttributed).not.toHaveBeenCalled();
			if (event !== "timeout") source.emit(event, { connected: true });
			await result;
			expect(source.unicastAttributed).toHaveBeenCalledTimes(event === "timeout" ? 0 : 1);
		},
	);

	it("AC-27 reconnect and held publish share the send's 30-second deadline", async () => {
		vi.useFakeTimers();
		const { mesh, source } = await fixture();
		let finishPublish!: () => void;
		const heldPublish = new Promise<Awaited<ReturnType<typeof source.unicastAttributed>>>((resolve) => {
			finishPublish = () => resolve({ msg: { id: "published" }, ack: { seq: 42, duplicate: false } });
		});
		source.unicastAttributed.mockReturnValueOnce(heldPublish);
		source.emit("connection", { connected: false });
		const rejected = vi.fn();
		const completed = mesh.send({ sessionId: "a" }, "b", "hello").catch(rejected);
		try {
			await vi.advanceTimersByTimeAsync(8000);
			expect(source.unicastAttributed).not.toHaveBeenCalled();
			source.emit("connection", { connected: true });
			await vi.advanceTimersByTimeAsync(21_999);
			expect(rejected).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(rejected).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ message: expect.stringContaining("Message storage outcome is unknown") }),
			);
			expect(source.unicastAttributed).toHaveBeenCalledTimes(1);
		} finally {
			finishPublish();
			await completed;
		}
	});

	it("redacts endpoint diagnostics and publish causes without losing the actionable error", async () => {
		const { mesh, source, target, log } = await fixture();
		const identity = core.newIdentity();
		const auth = core.stripSpaceAuth(await core.createSpaceAuth("prime"));
		const creds = await core.mintCreds(auth, identity, "agent", { lifecycleUid: core.mintLifecycleUid() });
		const jwt = creds.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)![0];
		const error = Object.assign(
			new Error(`connection refused ${identity.seed} ${auth.account.signingSeed} ${creds}`),
			{ code: "ECONNREFUSED" },
		);
		target.emit("error", error);
		target.emit("warning", error);
		expect(log).toHaveBeenCalledTimes(2);
		for (const [diagnostic] of log.mock.calls) {
			expect(diagnostic).toContain("ECONNREFUSED");
			expect(diagnostic).toContain("connection refused");
		}
		source.unicastAttributed.mockRejectedValueOnce(error);
		const failure = await mesh.send({ sessionId: "a" }, "b", "hello").catch((cause: unknown) => cause);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("ECONNREFUSED");
		const diagnostics = `${JSON.stringify(log.mock.calls)} ${(failure as Error).message}`;
		expect(diagnostics).toContain("ECONNREFUSED");
		expect(diagnostics).toContain("connection refused");
		for (const secret of [identity.seed, auth.account.signingSeed, creds, jwt, jwt.slice(0, 64)])
			expect(diagnostics).not.toContain(secret);
		expect(source.unicastAttributed).toHaveBeenCalledTimes(1);
	});

	it("F13 cancels every early delivery renewal when registration fails after endpoint start", async () => {
		vi.useFakeTimers();
		const first = delivery("early-first");
		const second = delivery("early-second");
		const duringStop = delivery("during-stop");
		Endpoint.onStart = (endpoint) => {
			if (endpoint.options.card?.id !== "b") return;
			for (const item of [first, second]) endpoint.emit("message", item.message, item.delivery, { kind: "dm" });
			endpoint.stop.mockImplementationOnce(async () => {
				endpoint.emit("message", duringStop.message, duringStop.delivery, { kind: "dm" });
			});
			directories.delete("b");
		};
		await expect(fixture()).rejects.toThrow("directory entry disappeared");
		expect(Endpoint.instances[1]!.stop).toHaveBeenCalledTimes(1);
		expect(releaseClaim).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(6000);
		for (const item of [first, second]) {
			expect(item.working).toHaveBeenCalledTimes(1);
			expect(item.ack).not.toHaveBeenCalled();
		}
		expect(duringStop.working).not.toHaveBeenCalled();
		expect(duringStop.ack).not.toHaveBeenCalled();
	});

	it("F15 defers and serializes adopted, home and bound enrollment, continuing after a failure", async () => {
		const { mesh, root, log } = await fixture();
		for (const id of ["adopted", "home", "bound"]) {
			writeFileSync(join(root, `${id}.json`), "{}");
			directories.set(id, { sessionId: id, name: id, principal: `local.${id}`, homeSocket: "home" });
		}
		vi.mocked(enrollment.homeEnrollments).mockReturnValueOnce([
			enrollment.ensureEnrollmentRecord(root, "home", join(root, "home.json")),
		]);
		vi.mocked(enrollment.claimEnrollment).mockClear();
		let rejectFirst!: (error: Error) => void;
		let beginFirst!: () => void;
		const firstProvisioned = new Promise<void>((resolve) => {
			beginFirst = resolve;
		});
		vi.mocked(enrollment.provisionEnrollment)
			.mockClear()
			.mockImplementation(async (_root, _config, record) => {
				if (record.sessionId === "adopted")
					await new Promise<void>((_resolve, reject) => {
						rejectFirst = reject;
						beginFirst();
					});
			});
		const adopted = mesh.enqueueEnrollment("adopted", join(root, "adopted.json"));
		const inlineClaims = vi.mocked(enrollment.claimEnrollment).mock.calls.length;
		const refused = expect(adopted).rejects.toThrow("first refused");
		const home = mesh.start();
		const bound = mesh.enqueueEnrollment("bound", join(root, "bound.json"));
		try {
			await firstProvisioned;
			expect(inlineClaims).toBe(0);
			expect(enrollment.claimEnrollment).toHaveBeenCalledTimes(1);
			expect(enrollment.provisionEnrollment).toHaveBeenCalledTimes(1);
		} finally {
			rejectFirst(new Error("first refused"));
			await refused;
			await Promise.all([home, bound]);
		}
		expect(vi.mocked(enrollment.provisionEnrollment).mock.calls.map((call) => call[2].sessionId)).toEqual([
			"adopted",
			"home",
			"bound",
		]);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Mesh home enrollment: 1 sessions in \d+ ms$/));
	});

	it("bounds in-flight enrollment during stop and releases the late claim without opening an endpoint", async () => {
		vi.useFakeTimers();
		const { mesh, root } = await fixture();
		let finish!: () => void;
		vi.mocked(enrollment.provisionEnrollment).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		writeFileSync(join(root, "late.json"), "{}");
		const work = mesh.enroll("late", join(root, "late.json"));
		const refused = expect(work).rejects.toThrow("shutting down");
		let stoppedDone = false;
		const stopped = mesh.stop().then(() => {
			stoppedDone = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(5000);
			expect(stoppedDone).toBe(true);
			expect(releaseClaim).toHaveBeenCalledTimes(2);
		} finally {
			finish();
			await refused;
			await stopped;
		}
		expect(releaseClaim).toHaveBeenCalledTimes(3);
		expect(Endpoint.instances).toHaveLength(2);
	});

	it("publishes exactly once through the sender to the directory principal and returns broker storage proof", async () => {
		const { mesh, root, source } = await fixture();
		expect(await mesh.send({ sessionId: "a" }, "b", "hello")).toMatchObject({
			deliveryStatus: "stored",
			sequence: 42,
			cotalId: "published",
			id: "agentmsg_published",
		});
		expect(source.unicastAttributed).toHaveBeenCalledExactlyOnceWith("local.b", "hello");
		expect(mesh.directoryEntryForPrincipal("local.a")).toEqual(directories.get("a"));
		expect(mesh.directoryEntryForPrincipal("local.unknown")).toBeUndefined();
		writeFileSync(join(root, "directory", "broken.json"), "{}");
		const get = directories.get.bind(directories);
		const corrupt = vi.spyOn(directories, "get").mockImplementation((id) => {
			if (id === "broken") throw new Error("Invalid mesh directory entry");
			return get(id);
		});
		try {
			expect(mesh.directoryEntryForPrincipal("local.a")).toEqual(directories.get("a"));
		} finally {
			corrupt.mockRestore();
		}
		rmSync(join(root, "directory"), { recursive: true });
		expect(mesh.directoryEntryForPrincipal("local.a")).toBeUndefined();
	});

	it("broadcasts through the existing host expansion once per each of three family members", async () => {
		const { mesh, root, source } = await fixture();
		for (const id of ["c", "d"]) {
			writeFileSync(join(root, `${id}.json`), "{}");
			directories.set(id, { sessionId: id, name: id, principal: `local.${id}`, homeSocket: "home" });
			await mesh.enroll(id, join(root, `${id}.json`));
		}
		const host = createAgentMessageHostHandlers({
			family: async () =>
				["b", "c", "d"].map((id) => ({ relationship: "sibling", entry: { id } })) as AgentFamilyMember[],
			sendAgentMessage: ({ target, message }) => mesh.send({ sessionId: "a" }, target, message),
		});
		const result = await host["agent_message.send"]!({ target: "all", message: "hello" });
		expect(result.receipts).toHaveLength(3);
		expect(source.unicastAttributed.mock.calls).toEqual([
			["local.b", "hello"],
			["local.c", "hello"],
			["local.d", "hello"],
		]);
		for (const receipt of result.receipts as unknown[])
			expect(receipt).toMatchObject({ deliveryStatus: "stored", sequence: 42 });
	});

	it.each([
		["source", "sender fileless is not enrolled"],
		["source-record", "sender a has no enrollment record or directory entry"],
		["target", "target b is not enrolled: no enrollment record or directory entry"],
		["record", "target b is not enrolled: no enrollment record or directory entry"],
		["directory", "Error: invalid directory principal"],
	])("refuses pre-publish %s failures", async (missing, reason) => {
		const { mesh, source, root } = await fixture();
		if (missing === "target") directories.delete("b");
		if (missing === "source-record") rmSync(join(root, "a.json"));
		if (missing === "record") rmSync(join(root, "b.json"));
		if (missing === "directory")
			vi.mocked(enrollment.readDirectory)
				.mockReturnValueOnce(directories.get("a"))
				.mockImplementationOnce(() => {
					throw new Error("invalid directory principal");
				});
		await expect(mesh.send({ sessionId: missing === "source" ? "fileless" : "a" }, "b", "hello")).rejects.toThrow(
			`Message was not stored: ${reason}`,
		);
		expect(source.unicastAttributed).not.toHaveBeenCalled();
	});

	it.each(["rejection", "timeout"])("reports an unknown outcome on %s without retrying", async (failure) => {
		vi.useFakeTimers();
		const { mesh, source } = await fixture();
		if (failure === "rejection")
			source.unicastAttributed.mockRejectedValueOnce(new Error("lost publish acknowledgement"));
		else source.unicastAttributed.mockImplementationOnce(() => new Promise(() => {}));
		const send = mesh.send({ sessionId: "a" }, "b", "hello");
		const assertion = expect(send).rejects.toThrow("unknown");
		if (failure === "timeout") await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		expect(source.unicastAttributed).toHaveBeenCalledTimes(1);
	});

	it("answers acceptance without ack, holds FIFO order and renews both messages until their own persistence frames", async () => {
		vi.useFakeTimers();
		const early = delivery("early");
		Endpoint.onStart = (endpoint) => {
			if (endpoint.options.card?.id === "b") endpoint.emit("message", early.message, early.delivery, { kind: "dm" });
		};
		const { mesh, target, handoff, log } = await fixture();
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(early.ack).not.toHaveBeenCalled();
		mesh.confirmPersisted("early", recipient, attempt(mesh, "early"));
		await settled(mesh, "b");
		expect(early.ack).toHaveBeenCalledTimes(1);
		handoff.mockClear();
		const first = delivery("first");
		const second = delivery("second", 2);
		target.emit("message", first.message, first.delivery, { kind: "dm" });
		target.emit("message", second.message, second.delivery, { kind: "dm" });
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(first.ack).not.toHaveBeenCalled();
		expect(second.ack).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(first.working).toHaveBeenCalledTimes(2);
		expect(second.working).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5000);
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(log.mock.calls).toEqual([
			["Mesh session b, Cotal ID first, delivery count 1: persistence still pending; queued behind 1"],
		]);
		expect(first.working).toHaveBeenCalledTimes(7);
		expect(second.ack).not.toHaveBeenCalled();
		mesh.confirmPersisted("second", recipient, attempt(mesh, "second"));
		mesh.confirmPersisted("first", {}, attempt(mesh, "first"));
		expect(first.ack).not.toHaveBeenCalled();
		mesh.confirmPersisted("first", recipient, attempt(mesh, "first"));
		await settled(mesh, "b");
		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(handoff).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(log.mock.calls).toEqual([
			["Mesh session b, Cotal ID first, delivery count 1: persistence still pending; queued behind 1"],
			["Mesh session b, Cotal ID second, delivery count 2: persistence still pending; queued behind 0"],
		]);
		mesh.confirmPersisted("second", recipient, attempt(mesh, "second"));
		await settled(mesh, "b");
		expect(second.ack).toHaveBeenCalledTimes(1);
		mesh.confirmPersisted("second", recipient, attempt(mesh, "second"));
		expect(second.ack).toHaveBeenCalledTimes(1);
		expect(handoff.mock.calls[1]![2]).toBe(2);
	});

	it.each(["cleared", "closed", "other"] as const)(
		"settles a dropped delivery, stops its timers and hands off the next item (reason=%s)",
		async (reason) => {
			vi.useFakeTimers();
			const { mesh, target, handoff, log } = await fixture();
			const first = delivery("dropped");
			const next = delivery("next");
			target.emit("message", first.message, first.delivery, { kind: "dm" });
			target.emit("message", next.message, next.delivery, { kind: "dm" });
			mesh.confirmDropped("dropped", {}, reason, attempt(mesh, "dropped"));
			mesh.confirmDropped("next", recipient, reason, attempt(mesh, "next"));
			expect(first.ack).not.toHaveBeenCalled();
			expect(first.delivery.nak).not.toHaveBeenCalled();
			expect(handoff).toHaveBeenCalledTimes(1);
			const firstHandoff = settled(mesh, "b");
			mesh.confirmDropped("dropped", recipient, reason, attempt(mesh, "dropped"));
			await vi.advanceTimersByTimeAsync(0);
			expect(handoff).toHaveBeenCalledTimes(2);
			await firstHandoff;
			expect(first.ack).toHaveBeenCalledTimes(reason !== "other" ? 1 : 0);
			expect(first.delivery.nak).toHaveBeenCalledTimes(0);
			expect(handoff).toHaveBeenCalledTimes(2);
			mesh.confirmPersisted("next", recipient, attempt(mesh, "next"));
			await settled(mesh, "b");
			mesh.confirmDropped("dropped", recipient, "other", attempt(mesh, "dropped"));
			mesh.confirmDropped("next", recipient, "other", attempt(mesh, "next"));
			await vi.advanceTimersByTimeAsync(6000);
			expect(first.working).toHaveBeenCalledTimes(1);
			expect(next.working).toHaveBeenCalledTimes(1);
			expect(next.ack).toHaveBeenCalledTimes(1);
			expect(next.delivery.nak).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`dropped ${reason}`));
		},
	);

	it("logs and settles a cleared drop before its failed handoff response", async () => {
		const { mesh, target, handoff, log } = await fixture();
		const first = delivery("race");
		handoff.mockImplementationOnce(async (_record, _message, _count, bind) => {
			bind(recipient);
			mesh.confirmDropped("race", recipient, "cleared", attempt(mesh, "race"));
			throw new Error("Acceptance was cleared");
		});
		target.emit("message", first.message, first.delivery, { kind: "dm" });
		await settled(mesh, "b");
		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(first.delivery.nak).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("dropped cleared"));
	});

	it.each(["malformed", "unknown", "empty", "overlong", "nontext", "wrong-text"])(
		"acknowledges and logs only permanent payload validation failures (%s)",
		async (failure) => {
			vi.useFakeTimers();
			const { mesh, target, handoff, log } = await fixture();
			const item = delivery("invalid");
			const payload =
				failure === "malformed"
					? null
					: {
							...item.message,
							parts:
								failure === "unknown"
									? {}
									: failure === "nontext"
										? [{ kind: "blob", data: "unsupported" }]
										: [
												{
													kind: "text",
													text:
														failure === "empty" ? " " : failure === "overlong" ? "x".repeat(16385) : 42,
												},
											],
						};
			target.emit("message", payload, item.delivery, { kind: "dm" });
			await settled(mesh, "b");
			await vi.advanceTimersByTimeAsync(6000);
			expect(item.ack).toHaveBeenCalledTimes(1);
			expect(item.delivery.nak).not.toHaveBeenCalled();
			expect(item.working).toHaveBeenCalledTimes(1);
			expect(handoff).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("invalid payload acknowledged"));
		},
	);

	it.each(["handoff", "disconnect", "directory"])("leaves a %s failure unacknowledged", async (failure) => {
		vi.useFakeTimers();
		const { mesh, target, log, handoff } = await fixture(async (_record, _message, _count, bind) => {
			bind(recipient);
			if (failure === "handoff") throw new Error("restart old worker");
		});
		const item = delivery("failed");
		const queued = delivery("queued");
		if (failure === "directory") directories.delete("b");
		target.emit("message", item.message, item.delivery, { kind: "dm" });
		if (failure === "directory") target.emit("message", queued.message, queued.delivery, { kind: "dm" });
		if (failure === "disconnect") mesh.disconnect(recipient);
		await settled(mesh, "b");
		mesh.confirmPersisted("failed", recipient, attempt(mesh, "failed"));
		expect(item.ack).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("left unacknowledged"));
		if (failure === "directory") {
			expect(target.stop).toHaveBeenCalledTimes(1);
			expect(releaseClaim).toHaveBeenCalledTimes(1);
			expect(handoff).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(6000);
			expect(item.working).toHaveBeenCalledTimes(1);
			expect(queued.working).not.toHaveBeenCalled();
			expect(queued.ack).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(1);
		}
	});

	it("stops every pull immediately, acknowledges nothing after shutdown, drains at most five seconds and releases claims after all stops", async () => {
		vi.useFakeTimers();
		const { mesh, source, target } = await fixture();
		const item = delivery("in-flight");
		target.emit("message", item.message, item.delivery, { kind: "dm" });
		let finishStop!: () => void;
		source.stop.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishStop = resolve;
				}),
		);
		target.stop.mockRejectedValueOnce(new Error("close failed"));
		const stopped = mesh.stop();
		expect(source.stop).toHaveBeenCalledTimes(1);
		expect(target.stop).toHaveBeenCalledTimes(1);
		mesh.confirmPersisted("in-flight", recipient, attempt(mesh, "in-flight"));
		expect(item.ack).not.toHaveBeenCalled();
		expect(releaseClaim).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5000);
		expect(releaseClaim).not.toHaveBeenCalled();
		finishStop();
		await stopped;
		expect(releaseClaim).toHaveBeenCalledTimes(2);
		await expect(mesh.send({ sessionId: "a" }, "b", "hello")).rejects.toThrow("not stored");
	});
});
