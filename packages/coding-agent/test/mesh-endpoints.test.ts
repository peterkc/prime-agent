import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentFamilyMember, createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import type * as enrollment from "../src/modes/daemon/cotal/enrollment.js";
import { type MeshEndpointOptions, MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";

vi.mock("@cotal-ai/core", async (original) => ({
	...(await original<typeof core>()),
	CotalEndpoint: function (options: core.EndpointOptions) {
		if (!new.target) throw new TypeError("CotalEndpoint requires new");
		return new Endpoint(options);
	},
}));
vi.mock("../src/modes/daemon/cotal/enrollment.js", () => ({
	loadMeshConfiguration: () => ({ space: "prime", server: "nats://127.0.0.1:1" }),
	readSigner: vi.fn(),
	homeEnrollments: () => [],
	claimEnrollment: () => ({ release: releaseClaim }),
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
	readDirectory: (_: string, id: string) => directories.get(id),
}));

class Endpoint extends EventEmitter {
	static instances: Endpoint[] = [];
	readonly start = vi.fn(async () => undefined);
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
	directories.clear();
	releaseClaim.mockClear();
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
	it("publishes exactly once through the sender to the directory principal and returns broker storage proof", async () => {
		const { mesh, source } = await fixture();
		expect(await mesh.send({ sessionId: "a" }, "b", "hello")).toMatchObject({
			deliveryStatus: "stored",
			sequence: 42,
			cotalId: "published",
			id: "agentmsg_published",
		});
		expect(source.unicastAttributed).toHaveBeenCalledExactlyOnceWith("local.b", "hello");
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

	it.each(["source", "target", "record"])("refuses a missing %s before any publish", async (missing) => {
		const { mesh, source, root } = await fixture();
		if (missing === "target") directories.delete("b");
		if (missing === "record") rmSync(join(root, "b.json"));
		await expect(mesh.send({ sessionId: missing === "source" ? "fileless" : "a" }, "b", "hello")).rejects.toThrow(
			"not stored",
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
		const { mesh, target, handoff } = await fixture();
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
		mesh.confirmPersisted("second", recipient);
		mesh.confirmPersisted("first", {});
		expect(first.ack).not.toHaveBeenCalled();
		mesh.confirmPersisted("first", recipient);
		await settled(mesh, "b");
		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(handoff).toHaveBeenCalledTimes(2);
		mesh.confirmPersisted("second", recipient);
		await settled(mesh, "b");
		expect(second.ack).toHaveBeenCalledTimes(1);
		mesh.confirmPersisted("second", recipient);
		expect(second.ack).toHaveBeenCalledTimes(1);
		expect(handoff.mock.calls[1]![2]).toBe(2);
	});

	it.each(["handoff", "disconnect"])("leaves a %s failure unacknowledged", async (failure) => {
		const { mesh, target, log } = await fixture(async (_record, _message, _count, bind) => {
			bind(recipient);
			if (failure === "handoff") throw new Error("restart old worker");
		});
		const item = delivery("failed");
		target.emit("message", item.message, item.delivery, { kind: "dm" });
		if (failure === "disconnect") mesh.disconnect(recipient);
		await settled(mesh, "b");
		mesh.confirmPersisted("failed", recipient);
		expect(item.ack).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("left unacknowledged"));
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
