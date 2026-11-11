import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CotalEndpoint, type CotalMessage, type Delivery } from "@cotal-ai/core";
import type { SessionLease } from "../../src/core/session-lease.js";
import type { EnrollmentRecord } from "../../src/modes/daemon/cotal/enrollment.js";
import { MeshEndpoints } from "../../src/modes/daemon/cotal/mesh-endpoints.js";

const endpointMethods = {
	start: CotalEndpoint.prototype.start,
	stop: CotalEndpoint.prototype.stop,
	provisionDmInbox: CotalEndpoint.prototype.provisionDmInbox,
	provisionDlvInbox: CotalEndpoint.prototype.provisionDlvInbox,
	reissueAcl: CotalEndpoint.prototype.reissueAcl,
	unicastAttributed: CotalEndpoint.prototype.unicastAttributed,
};
const meshPrototype = MeshEndpoints.prototype as unknown as {
	removeInbox(record: EnrollmentRecord): Promise<void>;
	startSession(id: string, file: string, claim?: SessionLease): Promise<void>;
	enqueue(session: unknown, message: CotalMessage, delivery: Delivery): void;
	confirmPersisted(id: string, recipient: object, token: string): void;
	pending: Map<string, { recipient?: object; attemptToken: string; sessionId: string; deliveryCount: number }>;
	sessions: Map<string, { record: { sessionFile: string } }>;
};
const startSession = meshPrototype.startSession;
const removeInbox = meshPrototype.removeInbox;

// Keep the common faux model, process lifecycle and IPC fixture; replace only its fake broker.
export function useRealBroker(agentDir: string, signal: (type: string, id?: string) => void): void {
	Object.assign(CotalEndpoint.prototype, endpointMethods);
	meshPrototype.removeInbox = removeInbox;
	meshPrototype.startSession = async function (id, file, claim) {
		signal("endpoint-starting", id);
		await startSession.call(this, id, file, claim);
		signal("endpoint", id);
	};
	const enqueue = meshPrototype.enqueue;
	meshPrototype.enqueue = function (session, message, delivery) {
		let renewals = 0;
		const redelivery = delivery.redelivery;
		const observed = redelivery
			? {
					...delivery,
					redelivery: {
						...redelivery,
						working: () => {
							redelivery.working();
							if (++renewals > 1) signal("renewed", message.id);
						},
					},
				}
			: delivery;
		appendFileSync(
			join(agentDir, "arrivals.jsonl"),
			`${JSON.stringify({ id: message.id, pid: process.pid })}
	`,
		);
		enqueue.call(this, session, message, observed);
		signal("received", message.id);
	};
	const confirm = meshPrototype.confirmPersisted;
	meshPrototype.confirmPersisted = function (id, recipient, token) {
		const pending = this.pending.get(id);
		if (pending?.recipient === recipient && pending.attemptToken === token) {
			const file = this.sessions.get(pending.sessionId)!.record.sessionFile;
			const entries = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const count = entries.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent_message" &&
					entry.details?.id === `agentmsg_${id}`,
			).length;
			appendFileSync(
				join(agentDir, "ack-disk.jsonl"),
				`${JSON.stringify({ id, count, deliveryCount: pending.deliveryCount })}\n`,
			);
			if (count !== 1) throw new Error("Acknowledgement without its own unique persisted entry");
			signal("persisted", id);
		}
		confirm.call(this, id, recipient, token);
	};
}
