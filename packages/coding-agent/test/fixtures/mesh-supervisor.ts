import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { CotalEndpoint, type CotalMessage, credsClaims, type Delivery, mintCreds, newIdentity } from "@cotal-ai/core";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	getApiProvider,
	registerFauxProvider,
} from "../../../ai/src/index.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { canonicalSessionPath, getProcessStartId, type SessionLease } from "../../src/core/session-lease.js";
import { main } from "../../src/main.js";
import {
	type EnrollmentRecord,
	enrollmentPath,
	readDirectory,
	readSigner,
} from "../../src/modes/daemon/cotal/enrollment.js";
import { MeshEndpoints } from "../../src/modes/daemon/cotal/mesh-endpoints.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import { DaemonSupervisor } from "../../src/modes/daemon/daemon-supervisor.js";
import { isDaemonWorkerProcess } from "../../src/modes/daemon/daemon-worker-protocol.js";
import { writeFileAtomicSync } from "../../src/utils/atomic-file.js";

const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR!;
const socketPath = process.argv.includes("--daemon-socket")
	? process.argv[process.argv.indexOf("--daemon-socket") + 1]!
	: process.argv[2]!;
// The test owns the replacement supervisor, so an orphan worker must not launch a competing fixture.
(AgentDaemon.prototype as unknown as { launchReplacementSupervisor(): Promise<void> }).launchReplacementSupervisor =
	async () => undefined;
const authPrototype = DaemonSupervisor.prototype as unknown as {
	supervisorAuthenticationClaim(): { capabilities: readonly string[] };
};
const productionAuth = authPrototype.supervisorAuthenticationClaim;
authPrototype.supervisorAuthenticationClaim = function () {
	const claim = productionAuth.call(this);
	return existsSync(join(agentDir, "no-barrier")) ? { ...claim, capabilities: [] } : claim;
};
const workerPrototype = AgentDaemon.prototype as unknown as {
	write(client: unknown, message: { command?: string; data?: { capabilities?: string[] } }): boolean;
};
const workerWrite = workerPrototype.write;
workerPrototype.write = function (client, message) {
	if (message.command === "worker_auth" && existsSync(join(agentDir, "legacy-worker")) && message.data?.capabilities) {
		message = {
			...message,
			data: {
				...message.data,
				capabilities: message.data.capabilities.filter((capability) => capability !== "mesh_replacement"),
			},
		};
	}
	return workerWrite.call(this, client, message);
};
const supervisorPrototype = DaemonSupervisor.prototype as unknown as {
	persistWorker(worker: { descriptor: { pid: number; lifecycle: string }; recovery?: Promise<void> }): void;
};
const persistWorker = supervisorPrototype.persistWorker;
supervisorPrototype.persistWorker = function (worker) {
	appendFileSync(join(agentDir, "worker-pids.jsonl"), `${JSON.stringify({ pid: worker.descriptor.pid })}\n`);
	persistWorker.call(this, worker);
	if (worker.descriptor.lifecycle === "failed" && worker.recovery) {
		const pid = worker.descriptor.pid;
		void worker.recovery.then(
			() => signal("worker-failed", String(pid)),
			() => undefined,
		);
	}
};
// Expose the existing runtime-host legacy delete boundary without a new worker command.
const daemonStartPrototype = AgentDaemon.prototype as unknown as {
	start(): Promise<void>;
	sessions: Map<string, { runtime: { session: { sessionId: string } } }>;
	createSubagentRuntimeHost(parent: unknown): { deleteRlmSubagentRuntime(id: string): Promise<void> };
};
const daemonStart = daemonStartPrototype.start;
daemonStartPrototype.start = async function () {
	process.on("SIGUSR1", () => {
		const input = JSON.parse(readFileSync(join(agentDir, "legacy-delete.json"), "utf8")) as {
			parent: string;
			child: string;
		};
		const parent = [...this.sessions.values()].find((state) => state.runtime.session.sessionId === input.parent);
		if (!parent) throw new Error("Legacy delete parent missing");
		void this.createSubagentRuntimeHost(parent)
			.deleteRlmSubagentRuntime(input.child)
			.then(() => signal("legacy-deleted"));
	});
	await daemonStart.call(this);
};

const mailbox = join(agentDir, "mailbox");
let releaseDelivery!: () => void;
const deliveryReady = new Promise<void>((resolveReady) => {
	releaseDelivery = resolveReady;
});
function signal(type: string, id?: string): void {
	process.stdout.write(`${JSON.stringify({ type, id })}\n`);
}
const faux = registerFauxProvider({ api: "faux", models: [{ id: "mesh-faux" }] });
const api = getApiProvider(faux.api)!;
for (const factory of ["create", "inMemory"] as const) {
	const original = ModelRegistry[factory];
	ModelRegistry[factory] = ((...args: Parameters<typeof original>) => {
		const registry = original(args[0], args[1]);
		registry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.models[0]!.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			streamSimple: api.streamSimple,
			models: faux.models,
		});
		return registry;
	}) as typeof original;
}
const response: FauxResponseFactory = async (_context, options) => {
	const path = join(agentDir, "hold-turn");
	if (existsSync(path)) {
		writeFileAtomicSync(join(agentDir, "turn-held"), "held");
		await new Promise<void>((resolve) => {
			let watcher: ReturnType<typeof watch> | undefined;
			const finish = () => {
				watcher?.close();
				options?.signal?.removeEventListener("abort", finish);
				resolve();
			};
			try {
				// macOS can deliver directory FSEvents late; a file watch reports its deletion.
				watcher = watch(path, () => {
					if (!existsSync(path)) finish();
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existsSync(path)) throw error;
				resolve();
				return;
			}
			options?.signal?.addEventListener("abort", finish, { once: true });
			if (options?.signal?.aborted || !existsSync(path)) finish();
		});
	}
	return fauxAssistantMessage("observed");
};
faux.setResponses(Array.from({ length: 40 }, () => response));

interface StubSession {
	record: EnrollmentRecord;
	claim: SessionLease;
	endpoint: Pick<CotalEndpoint, "stop" | "unicastAttributed">;
	queue: unknown[];
	state: "connected";
	abort: AbortController;
	pull?: () => void;
}
interface StubMesh {
	sessions: Map<string, StubSession>;
	enqueue(session: StubSession, message: CotalMessage, delivery: Delivery): void;
	startSession(id: string, file: string, claim?: SessionLease): Promise<void>;
	removeInbox(record: EnrollmentRecord): Promise<void>;
}

(MeshEndpoints.prototype as unknown as StubMesh).removeInbox = async (record) => {
	const credential = await mintCreds(readSigner(join(agentDir, "mesh"), "prime"), newIdentity(), "deprovisioner", {
		deprovisionTarget: { principal: record.identity.id, lifecycleUid: record.lifecycleUid },
	});
	const permissions = JSON.stringify(credsClaims(credential).nats);
	if (!permissions.includes(record.identity.id) || !permissions.includes(record.lifecycleUid))
		throw new Error("Wrong lifecycle credential");
	appendFileSync(
		join(agentDir, "cleanup-order.jsonl"),
		`${JSON.stringify({ type: "remove", id: record.sessionId })}\n`,
	);
	const events = join(agentDir, "removals.jsonl");
	appendFileSync(
		events,
		`${JSON.stringify({ sessionId: record.sessionId, identity: record.identity.id, uid: record.lifecycleUid })}\n`,
	);
	for (const stream of ["dm", "dlv"]) {
		if (stream === "dlv" && existsSync(join(agentDir, "partial-removal"))) {
			process.stderr.write(
				`Mesh session ${record.sessionId}: inbox removal failed: DeprovisionError: partial removal\n`,
			);
			break;
		}
		unlinkSync(join(agentDir, `${stream}-${record.sessionId}`));
	}
	signal("removed", record.sessionId);
};

// Production start owns enrollment, claims and path updates. These methods fake only the broker.
CotalEndpoint.prototype.start = async () => undefined;
CotalEndpoint.prototype.stop = async () => undefined;
CotalEndpoint.prototype.provisionDmInbox = async () => undefined;
CotalEndpoint.prototype.provisionDlvInbox = async () => undefined;
CotalEndpoint.prototype.reissueAcl = async () => undefined;
function targetSupervisorPid(meshRoot: string, sessionId: string): number | undefined {
	const path = canonicalSessionPath(enrollmentPath(meshRoot, sessionId));
	const key = createHash("sha256").update(path).digest("hex");
	let contents: string;
	try {
		contents = readFileSync(join(meshRoot, "session-leases", `${key}.lock`, "owner.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const owner = JSON.parse(contents) as {
		pid: number;
		processStartId?: string;
		sessionPath: string;
		activeSessionId?: string;
	};
	if (
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 1 ||
		owner.sessionPath !== path ||
		owner.activeSessionId !== sessionId
	)
		throw new Error("Invalid fixture mesh claim owner");
	return owner.processStartId && getProcessStartId(owner.pid) === owner.processStartId ? owner.pid : undefined;
}

const starts = new Map<string, number>();
const productionStart = (MeshEndpoints.prototype as unknown as StubMesh).startSession;
(MeshEndpoints.prototype as unknown as StubMesh).startSession = async function (id, file, claim) {
	const meshRoot = join(agentDir, "mesh");
	try {
		if (existsSync(join(agentDir, `pause-publication-${id}`))) {
			signal("publication-paused", id);
			await new Promise<void>((resolve) => {
				const resumed = watch(agentDir, () => {
					if (!existsSync(join(agentDir, `pause-publication-${id}`))) {
						resumed.close();
						resolve();
					}
				});
			});
		}
		await productionStart.call(this, id, file, claim);
		const session = this.sessions.get(id);
		if (!session) throw new Error("Production endpoint did not start");
		const record = session.record;
		const directory = readDirectory(meshRoot, id);
		if (!directory) throw new Error("Production directory was not published");
		for (const stream of ["dm", "dlv"]) writeFileAtomicSync(join(agentDir, `${stream}-${id}`), "inbox");
		let stopped = false;
		mkdirSync(mailbox, { recursive: true });
		const seen = new Set<string>();
		const pull = () => {
			if (stopped || existsSync(join(agentDir, `hold-pulls-${id}`))) return;
			for (const name of readdirSync(mailbox)) {
				if (!name.endsWith(".json") || seen.has(name)) continue;
				const stored = JSON.parse(readFileSync(join(mailbox, name), "utf8")) as {
					target: string;
					message: CotalMessage;
				};
				if (stored.target !== id) continue;
				seen.add(name);
				this.enqueue(session, stored.message, {
					durable: true,
					nak: () => undefined,
					redelivery: { deliveryCount: 2, ackWaitMs: 3000, working: () => undefined },
					ack: () => {
						if (existsSync(join(agentDir, "hold-acks"))) {
							signal("before-ack", stored.message.id);
							return;
						}
						if (existsSync(join(agentDir, "kill-before-ack"))) {
							signal("before-ack", stored.message.id);
							process.kill(process.pid, "SIGKILL");
							return;
						}
						const covered = readFileSync(record.sessionFile, "utf8")
							.split("\n")
							.some((line) => line.includes(`agentmsg_${stored.message.id}`));
						appendFileSync(
							join(agentDir, "ack-disk.jsonl"),
							`${JSON.stringify({ id: stored.message.id, covered })}\n`,
						);
						appendFileSync(join(agentDir, "acks.jsonl"), `${JSON.stringify({ id: stored.message.id })}\n`);
						unlinkSync(join(mailbox, name));
						signal("ack", stored.message.id);
					},
				});
				signal("pulled", stored.message.id);
			}
		};
		const watcher = watch(mailbox, () => {
			void deliveryReady.then(pull);
		});
		session.pull = pull;
		const broker: Pick<StubSession, "endpoint"> = {
			endpoint: {
				stop: async () => {
					stopped = true;
					watcher.close();
					appendFileSync(join(agentDir, "cleanup-order.jsonl"), `${JSON.stringify({ type: "stop", id })}\n`);
					signal("endpoint-stopped", id);
				},
				unicastAttributed: async (principal, text) => {
					const target = readdirSync(join(meshRoot, "directory"))
						.filter((name) => name.endsWith(".json"))
						.map((name) => readDirectory(meshRoot, name.slice(0, -5)))
						.find((entry) => entry?.principal === principal);
					if (!target) throw new Error("Stub target missing");
					const message = {
						id: randomUUID(),
						ts: Date.now(),
						space: "prime",
						from: { id: directory.principal, name: directory.name },
						to: principal,
						parts: [{ kind: "text", text }],
					} as CotalMessage;
					const targetPid = this.sessions.has(target.sessionId)
						? undefined
						: targetSupervisorPid(meshRoot, target.sessionId);
					writeFileAtomicSync(
						join(mailbox, `${message.id}.json`),
						JSON.stringify({ target: target.sessionId, message }),
					);
					if (targetPid !== undefined) {
						try {
							process.kill(targetPid, "SIGUSR2");
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
						}
					}
					void deliveryReady.then(() => this.sessions.get(target.sessionId)?.pull?.());
					return { msg: message, ack: { seq: 1, duplicate: false } };
				},
			},
		};
		Object.assign(session.endpoint, broker.endpoint);
		void deliveryReady.then(pull);
		const count = (starts.get(id) ?? 0) + 1;
		starts.set(id, count);
		signal(count === 1 ? "endpoint" : "rebound", id);
	} catch (error) {
		if (!claim) this.sessions.get(id)?.claim.release();
		throw error;
	}
};

const supervisorMesh = DaemonSupervisor.prototype as unknown as {
	handoffMeshMessage(...args: unknown[]): Promise<void>;
};
const productionHandoff = supervisorMesh.handoffMeshMessage;
supervisorMesh.handoffMeshMessage = async function (...args) {
	try {
		await productionHandoff.apply(this, args);
	} catch (error) {
		signal("handoff-refused", (args[1] as CotalMessage).id);
		throw error;
	}
	signal("accepted", (args[1] as CotalMessage).id);
};

if (isDaemonWorkerProcess()) await main([...process.argv.slice(2), "--offline"]);
else {
	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: {
			agentDir,
			cwd: process.argv[3],
			sessionDir: process.env.PRIME_MESH_TEST_SESSION_DIR ?? join(agentDir, "sessions"),
			provider: "faux",
			model: "mesh-faux",
			noTools: true,
			noExtensions: !existsSync(join(agentDir, "extensions", "rebind.ts")),
			telemetryDisabled: true,
		},
	});
	process.on("SIGUSR2", () => {
		void deliveryReady.then(() => {
			const mesh = (supervisor as unknown as { mesh?: StubMesh }).mesh;
			for (const session of mesh?.sessions.values() ?? []) session.pull?.();
		});
	});
	await supervisor.start();
	releaseDelivery();
	signal("ready");
}
