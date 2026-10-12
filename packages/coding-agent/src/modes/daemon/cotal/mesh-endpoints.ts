import { existsSync } from "node:fs";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import {
	AGENT_MESSAGE_ID_PREFIX,
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
} from "../../../core/agent-messages.js";
import { SessionAlreadyActiveError, type SessionLease } from "../../../core/session-lease.js";
import {
	claimEnrollment,
	credentialSource,
	type EnrollmentRecord,
	enrollmentPath,
	ensureEnrollmentRecord,
	homeEnrollments,
	loadMeshConfiguration,
	type MeshConfiguration,
	provisionEnrollment,
	publishDirectory,
	readDirectory,
	readSigner,
} from "./enrollment.js";

export interface MeshEndpointOptions {
	readonly meshRoot: string;
	readonly homeSocket: string;
	readonly credentialLifetimeSeconds?: number;
	readonly log: (message: string) => void;
	readonly handoff: (
		record: EnrollmentRecord,
		message: CotalMessage,
		deliveryCount: number,
		bindRecipient: (recipient: object) => void,
	) => Promise<void>;
}

interface QueuedDelivery {
	readonly message: CotalMessage;
	readonly delivery: Delivery;
	readonly deliveryCount: number;
	readonly workingTimer?: ReturnType<typeof setInterval>;
}

interface SessionEndpoint {
	readonly record: EnrollmentRecord;
	readonly claim: SessionLease;
	readonly endpoint: CotalEndpoint;
	readonly queue: QueuedDelivery[];
	handoff?: Promise<void>;
	current?: QueuedDelivery;
}

interface PendingPersistence {
	readonly sessionId: string;
	readonly delivery: Delivery;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	recipient?: object;
}

export class MeshEndpoints {
	private readonly config: MeshConfiguration;
	private readonly sessions = new Map<string, SessionEndpoint>();
	private readonly enrolling = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, PendingPersistence>();
	private closing = false;
	private stopping?: Promise<void>;

	constructor(private readonly options: MeshEndpointOptions) {
		this.config = loadMeshConfiguration(options.meshRoot);
	}

	async start(): Promise<void> {
		// Validate even when there are no saved sessions. Never create identities under a bad signer.
		readSigner(this.options.meshRoot, this.config.space);
		for (const record of homeEnrollments(this.options.meshRoot, this.options.homeSocket)) {
			await this.enroll(record.sessionId, record.sessionFile);
		}
	}

	enroll(sessionId: string, sessionFile?: string): Promise<void> {
		if (this.closing) return Promise.reject(new Error(`Session ${sessionId}: mesh is shutting down`));
		if (!sessionFile)
			return Promise.reject(new Error(`Session ${sessionId} has no session file and cannot be enrolled`));
		if (this.sessions.has(sessionId)) return Promise.resolve();
		const existing = this.enrolling.get(sessionId);
		if (existing) return existing;
		const work = this.startSession(sessionId, sessionFile);
		this.enrolling.set(sessionId, work);
		void work.then(
			() => this.enrolling.delete(sessionId),
			() => this.enrolling.delete(sessionId),
		);
		return work;
	}

	private async startSession(sessionId: string, sessionFile: string): Promise<void> {
		let claim: SessionLease;
		try {
			claim = claimEnrollment(this.options.meshRoot, sessionId, sessionFile);
		} catch (error) {
			if (error instanceof SessionAlreadyActiveError) {
				this.options.log(`Mesh session ${sessionId}: another live process holds the claim`);
				return;
			}
			throw error;
		}
		let endpoint: CotalEndpoint | undefined;
		try {
			readSigner(this.options.meshRoot, this.config.space);
			const record = ensureEnrollmentRecord(this.options.meshRoot, sessionId, sessionFile);
			await provisionEnrollment(this.options.meshRoot, this.config, record);
			if (this.closing) throw new Error(`Session ${sessionId}: mesh is shutting down`);
			const directory = await publishDirectory(this.options.meshRoot, record, this.options.homeSocket);
			endpoint = new CotalEndpoint({
				space: this.config.space,
				servers: this.config.server,
				card: { name: directory.name, kind: "agent", id: record.identity.id },
				lifecycleUid: record.lifecycleUid,
				channels: [],
				creds: credentialSource(
					this.options.meshRoot,
					this.config.space,
					record,
					this.options.credentialLifetimeSeconds,
				),
			});
			const session: SessionEndpoint = { record, claim, endpoint, queue: [] };
			endpoint.on("error", () => this.options.log(`Mesh session ${sessionId}: endpoint error`));
			endpoint.on("warning", () => this.options.log(`Mesh session ${sessionId}: endpoint warning`));
			endpoint.on("message", (message: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
				if (meta.kind === "dm" && delivery.durable) this.enqueue(session, message, delivery);
			});
			try {
				await endpoint.start();
			} catch {
				throw new Error(`Session ${sessionId}: Cotal endpoint start failed`);
			}
			if (this.closing || !readDirectory(this.options.meshRoot, sessionId)) {
				throw new Error(`Session ${sessionId}: mesh closed or directory entry disappeared`);
			}
			this.sessions.set(sessionId, session);
		} catch (error) {
			try {
				await endpoint?.stop();
			} catch {
				this.options.log(`Mesh session ${sessionId}: endpoint cleanup stop rejected`);
			} finally {
				claim.release();
			}
			throw error;
		}
	}

	async send(
		sender: AgentSessionMessageSender & { sessionId: string },
		targetSessionId: string,
		message: string,
	): Promise<AgentSessionMessageReceipt> {
		const senderSessionId = sender.sessionId;
		if (this.closing) throw new Error("Message was not stored: mesh is shutting down");
		const source = this.sessions.get(senderSessionId);
		if (!source) throw new Error(`Message was not stored: sender ${senderSessionId} has no endpoint or session file`);
		if (
			!existsSync(enrollmentPath(this.options.meshRoot, senderSessionId)) ||
			!readDirectory(this.options.meshRoot, senderSessionId)
		) {
			throw new Error(
				`Message was not stored: sender ${senderSessionId} has no enrollment record or directory entry`,
			);
		}
		const target = readDirectory(this.options.meshRoot, targetSessionId);
		if (!target || !existsSync(enrollmentPath(this.options.meshRoot, targetSessionId))) {
			throw new Error(
				`Message was not stored: target ${targetSessionId} has no enrollment record or directory entry; a session without a session file is not enrolled`,
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// From this call onward any error is ambiguous. Never retry a publish or use native delivery.
			const publish = source.endpoint.unicastAttributed(target.principal, message);
			const { msg, ack } = await Promise.race([
				publish,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Mesh publish deadline elapsed")), 30_000);
				}),
			]);
			return {
				id: `${AGENT_MESSAGE_ID_PREFIX}${msg.id}`,
				source: AGENT_MESSAGE_SOURCE,
				from: sender,
				target: { sessionId: targetSessionId, activeSessionId: targetSessionId, sessionName: target.name },
				message,
				deliveryStatus: "stored",
				sequence: ack.seq,
				cotalId: msg.id,
			};
		} catch {
			throw new Error(
				"Message storage outcome is unknown: publish failed or timed out; a resend can show the message twice",
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private enqueue(session: SessionEndpoint, message: CotalMessage, delivery: Delivery): void {
		if (this.closing) return;
		const redelivery = delivery.redelivery;
		const deliveryCount = redelivery?.deliveryCount ?? 1;
		const working = () => {
			if (this.closing) return;
			try {
				redelivery?.working();
			} catch {
				this.logDelivery(session, message.id, deliveryCount, "working failed");
			}
		};
		working();
		const workingTimer = redelivery
			? setInterval(working, Math.max(1, Math.floor(redelivery.ackWaitMs / 3)))
			: undefined;
		workingTimer?.unref();
		session.queue.push({ message, delivery, deliveryCount, workingTimer });
		this.drain(session);
	}

	private drain(session: SessionEndpoint): void {
		if (this.closing || session.handoff) return;
		const item = session.queue.shift();
		if (!item) return;
		session.current = item;
		const handoff = this.deliver(session, item);
		session.handoff = handoff;
		void handoff.finally(() => {
			if (item.workingTimer) clearInterval(item.workingTimer);
			session.handoff = undefined;
			session.current = undefined;
			this.drain(session);
		});
	}

	private async deliver(session: SessionEndpoint, item: QueuedDelivery): Promise<void> {
		const { message, delivery, deliveryCount } = item;
		let pending: PendingPersistence | undefined;
		try {
			if (!readDirectory(this.options.meshRoot, session.record.sessionId)) {
				await session.endpoint.stop();
				session.claim.release();
				this.sessions.delete(session.record.sessionId);
				throw new Error("Mesh directory entry disappeared");
			}
			if (this.pending.has(message.id)) throw new Error("A copy is already in flight");
			const persisted = new Promise<void>((resolve, reject) => {
				pending = { sessionId: session.record.sessionId, delivery, resolve, reject };
				this.pending.set(message.id, pending);
			});
			// A disconnect may reject this while wake/acceptance is still pending.
			void persisted.catch(() => undefined);
			await this.options.handoff(session.record, message, deliveryCount, (recipient) => {
				if (pending) pending.recipient = recipient;
			});
			await persisted;
		} catch {
			this.logDelivery(session, message.id, deliveryCount, "handoff failed; left unacknowledged");
		} finally {
			if (this.pending.get(message.id) === pending) this.pending.delete(message.id);
		}
	}

	confirmPersisted(cotalId: string, recipient: object): void {
		if (this.closing) return;
		const pending = this.pending.get(cotalId);
		if (!pending || pending.recipient !== recipient) return;
		this.pending.delete(cotalId);
		try {
			pending.delivery.ack();
			pending.resolve();
		} catch {
			pending.reject(new Error("Mesh acknowledgement failed"));
		}
	}

	disconnect(recipient: object): void {
		for (const pending of this.pending.values()) {
			if (pending.recipient === recipient)
				pending.reject(new Error("Mesh recipient disconnected before persistence"));
		}
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closing = true;
		// stop() is the public pull-stop operation. It also closes the connection; no ack is permitted now.
		const stops = Promise.allSettled([...this.sessions.values()].map((session) => session.endpoint.stop()));
		this.stopping = this.finishStop(stops);
		return this.stopping;
	}

	private async finishStop(stops: Promise<PromiseSettledResult<void>[]>): Promise<void> {
		const handoffs = [...this.sessions.values()].flatMap((session) => (session.handoff ? [session.handoff] : []));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(handoffs),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		for (const pending of this.pending.values()) pending.reject(new Error("Mesh is shutting down"));
		this.pending.clear();
		await Promise.allSettled(this.enrolling.values());
		const outcomes = await stops;
		for (const [index, outcome] of outcomes.entries()) {
			if (outcome.status === "rejected")
				this.options.log(`Mesh endpoint stop ${index} rejected; continuing shutdown`);
		}
		for (const session of this.sessions.values()) {
			if (session.current?.workingTimer) clearInterval(session.current.workingTimer);
			for (const item of session.queue) if (item.workingTimer) clearInterval(item.workingTimer);
			session.queue.length = 0;
			session.claim.release();
		}
		this.sessions.clear();
	}

	private logDelivery(session: SessionEndpoint, cotalId: string, deliveryCount: number, reason: string): void {
		this.options.log(
			`Mesh session ${session.record.sessionId}, Cotal ID ${cotalId}, delivery count ${deliveryCount}: ${reason}`,
		);
	}
}
