import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	enrollmentPath: (root: string, id: string) => join(root, `${id}.json`),
	readDirectory: vi.fn((_: string, id: string) => directories.get(id)),
}));

class Endpoint extends EventEmitter {
	static instances: Endpoint[] = [];
	static onStart?: (endpoint: Endpoint) => void;
	readonly start = vi.fn(async () => Endpoint.onStart?.(this));
	readonly stop = vi.fn(async (): Promise<void> => undefined);
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
	vi.clearAllMocks();
});

async function fixture(
	handoff: MeshEndpointOptions["handoff"] = async (_record, _message, _count, bind) => {
		bind(recipient);
	},
) {
	const root = mkdtempSync(join(tmpdir(), "prime-mesh-endpoints-"));
	roots.push(root);
	for (const id of ["a", "b"]) {
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

async function settled(mesh: MeshEndpoints, id: string) {
	await (mesh as unknown as { sessions: Map<string, { handoff?: Promise<void> }> }).sessions.get(id)?.handoff;
}

describe("mesh endpoints", () => {
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
		for (const id of ["home", "bound"])
			directories.set(id, { sessionId: id, name: id, principal: `local.${id}`, homeSocket: "home" });
		vi.mocked(enrollment.homeEnrollments).mockReturnValueOnce([
			enrollment.ensureEnrollmentRecord(root, "home", join(root, "home.json")),
		]);
		vi.mocked(enrollment.claimEnrollment).mockClear();
		let rejectFirst!: (error: Error) => void;
		vi.mocked(enrollment.provisionEnrollment)
			.mockClear()
			.mockImplementation(async (_root, _config, record) => {
				if (record.sessionId === "adopted")
					await new Promise<void>((_resolve, reject) => {
						rejectFirst = reject;
					});
			});
		const adopted = mesh.enqueueEnrollment("adopted", join(root, "adopted.json"));
		const inlineClaims = vi.mocked(enrollment.claimEnrollment).mock.calls.length;
		const refused = expect(adopted).rejects.toThrow("first refused");
		const home = mesh.start();
		const bound = mesh.enqueueEnrollment("bound", join(root, "bound.json"));
		try {
			await Promise.resolve();
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
		const { mesh, source } = await fixture();
		expect(await mesh.send({ sessionId: "a" }, "b", "hello")).toMatchObject({
			deliveryStatus: "stored",
			sequence: 42,
			cotalId: "published",
			id: "agentmsg_published",
		});
		expect(source.unicastAttributed).toHaveBeenCalledExactlyOnceWith("local.b", "hello");
		expect(mesh.sessionIdForPrincipal("local.a", ["b", "a"])).toBe("a");
		expect(mesh.sessionIdForPrincipal("local.unknown", ["a", "b"])).toBeUndefined();
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
		mesh.confirmPersisted("early", recipient);
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
		mesh.confirmPersisted("second", recipient);
		mesh.confirmPersisted("first", {});
		expect(first.ack).not.toHaveBeenCalled();
		mesh.confirmPersisted("first", recipient);
		await settled(mesh, "b");
		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(handoff).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(log.mock.calls).toEqual([
			["Mesh session b, Cotal ID first, delivery count 1: persistence still pending; queued behind 1"],
			["Mesh session b, Cotal ID second, delivery count 2: persistence still pending; queued behind 0"],
		]);
		mesh.confirmPersisted("second", recipient);
		await settled(mesh, "b");
		expect(second.ack).toHaveBeenCalledTimes(1);
		mesh.confirmPersisted("second", recipient);
		expect(second.ack).toHaveBeenCalledTimes(1);
		expect(handoff.mock.calls[1]![2]).toBe(2);
	});

	it.each([true, false])(
		"settles a dropped delivery, stops its timers and hands off the next item (cleared=%s)",
		async (cleared) => {
			vi.useFakeTimers();
			const { mesh, target, handoff, log } = await fixture();
			const first = delivery("dropped");
			const next = delivery("next");
			target.emit("message", first.message, first.delivery, { kind: "dm" });
			target.emit("message", next.message, next.delivery, { kind: "dm" });
			mesh.confirmDropped("dropped", {}, cleared);
			mesh.confirmDropped("next", recipient, cleared);
			expect(first.ack).not.toHaveBeenCalled();
			expect(first.delivery.nak).not.toHaveBeenCalled();
			expect(handoff).toHaveBeenCalledTimes(1);
			const firstHandoff = settled(mesh, "b");
			mesh.confirmDropped("dropped", recipient, cleared);
			await vi.advanceTimersByTimeAsync(0);
			expect(handoff).toHaveBeenCalledTimes(2);
			await firstHandoff;
			expect(first.ack).toHaveBeenCalledTimes(cleared ? 1 : 0);
			expect(first.delivery.nak).toHaveBeenCalledTimes(cleared ? 0 : 1);
			expect(handoff).toHaveBeenCalledTimes(2);
			mesh.confirmPersisted("next", recipient);
			await settled(mesh, "b");
			mesh.confirmDropped("dropped", recipient, !cleared);
			mesh.confirmDropped("next", recipient, false);
			await vi.advanceTimersByTimeAsync(6000);
			expect(first.working).toHaveBeenCalledTimes(1);
			expect(next.working).toHaveBeenCalledTimes(1);
			expect(next.ack).toHaveBeenCalledTimes(1);
			expect(next.delivery.nak).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
		},
	);

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
		mesh.confirmPersisted("failed", recipient);
		expect(item.ack).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("left unacknowledged"));
		if (failure === "directory") {
			expect(target.stop).toHaveBeenCalledTimes(1);
			expect(releaseClaim).toHaveBeenCalledTimes(1);
			expect(handoff).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(6000);
			expect(item.working).toHaveBeenCalledTimes(1);
			expect(queued.working).toHaveBeenCalledTimes(1);
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
		mesh.confirmPersisted("in-flight", recipient);
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
