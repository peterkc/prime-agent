import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import type { CotalEndpoint, CotalMessage, Delivery } from "@cotal-ai/core";
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import type { SessionLease } from "../../src/core/session-lease.js";
import { main } from "../../src/main.js";
import {
	claimEnrollment,
	type EnrollmentRecord,
	ensureEnrollmentRecord,
	publishDirectory,
	readDirectory,
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
faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("observed")));

interface StubSession {
	record: EnrollmentRecord;
	claim: SessionLease;
	endpoint: Pick<CotalEndpoint, "stop" | "unicastAttributed">;
	queue: unknown[];
}
interface StubMesh {
	sessions: Map<string, StubSession>;
	enqueue(session: StubSession, message: CotalMessage, delivery: Delivery): void;
	startSession(id: string, file: string): Promise<void>;
}
// Only the broker boundary is fake. The production handoff, frame routing, queue and ack logic run.
(MeshEndpoints.prototype as unknown as StubMesh).startSession = async function (id, file) {
	const meshRoot = join(agentDir, "mesh");
	const claim = claimEnrollment(meshRoot, id, file);
	try {
		const record = ensureEnrollmentRecord(meshRoot, id, file);
		const directory = await publishDirectory(meshRoot, record, socketPath);
		mkdirSync(mailbox, { recursive: true });
		const seen = new Set<string>();
		const pull = () => {
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
						if (existsSync(join(agentDir, "kill-before-ack"))) {
							signal("before-ack", stored.message.id);
							process.kill(process.pid, "SIGKILL");
							return;
						}
						appendFileSync(join(agentDir, "acks.jsonl"), `${JSON.stringify({ id: stored.message.id })}\n`);
						unlinkSync(join(mailbox, name));
						signal("ack", stored.message.id);
					},
				});
			}
		};
		const watcher = watch(mailbox, () => {
			void deliveryReady.then(pull);
		});
		const session: StubSession = {
			record,
			claim,
			queue: [],
			endpoint: {
				stop: async () => {
					watcher.close();
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
					writeFileAtomicSync(
						join(mailbox, `${message.id}.json`),
						JSON.stringify({ target: target.sessionId, message }),
					);
					return { msg: message, ack: { seq: 1, duplicate: false } };
				},
			},
		};
		this.sessions.set(id, session);
		void deliveryReady.then(pull);
		signal("endpoint", id);
	} catch (error) {
		claim.release();
		throw error;
	}
};

if (isDaemonWorkerProcess()) await main([...process.argv.slice(2), "--offline"]);
else {
	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: {
			agentDir,
			cwd: process.argv[3],
			sessionDir: join(agentDir, "sessions"),
			provider: "faux",
			model: "mesh-faux",
			noTools: true,
			noExtensions: true,
			telemetryDisabled: true,
		},
	});
	await supervisor.start();
	releaseDelivery();
	signal("ready");
}
