import { existsSync } from "node:fs";
import { CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "@cotal-ai/core";
import {
	AGENT_MESSAGE_ID_PREFIX,
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
} from "../../../core/agent-messages.js";
import { SessionAlreadyActiveError, type SessionLease } from "../../../core/session-lease.js";
import { resolveDirectoryAddress } from "./address.js";
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
	renameDirectory,
} from "./enrollment.js";
import { InvalidMeshPayloadError, meshMessageText, redactMeshError } from "./mesh-shared.js";

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
	stallTimer?: ReturnType<typeof setTimeout>;
}

interface SessionEndpoint {
	readonly record: EnrollmentRecord;
	readonly claim: SessionLease;
	readonly endpoint: CotalEndpoint;
	readonly queue: QueuedDelivery[];
	handoff?: Promise<void>;
	current?: QueuedDelivery;
	failed?: boolean;
}

interface PendingPersistence {
	readonly deliveryCount: number;
	readonly sessionId: string;
	readonly delivery: Delivery;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	recipient?: object;
}

export class MeshEndpoints {
	private readonly config?: MeshConfiguration;
	private readonly refusal?: string;
	private readonly enrollmentFailures = new Map<string, string>();
	private readonly invalidDirectoryEntries = new Set<string>();
	private readonly sessions = new Map<string, SessionEndpoint>();
	private readonly enrolling = new Map<string, Promise<void>>();
	private enrollmentQueue = Promise.resolve();
	private readonly pending = new Map<string, PendingPersistence>();
	private closing = false;
	private stopping?: Promise<void>;

	constructor(private readonly options: MeshEndpointOptions) {
		try {
			this.config = loadMeshConfiguration(options.meshRoot);
			// Refuse mesh sends under a bad signer without preventing daemon readiness.
			readSigner(options.meshRoot, this.config.space);
		} catch (error) {
			this.refusal = redactMeshError(error);
			options.log(`Mesh unavailable: ${this.refusal}`);
		}
	}

	async start(): Promise<void> {
		if (this.closing || this.refusal) return;
		const started = Date.now();
		let count = 0;
		const failed = (sessionId: string, error: unknown) => {
			count++;
			this.options.log(`Mesh session ${sessionId}: ${this.recordEnrollmentFailure(sessionId, error)}`);
		};
		try {
			for (const record of homeEnrollments(this.options.meshRoot, this.options.homeSocket, failed)) {
				if (this.closing) break;
				count++;
				try {
					await this.enqueueEnrollment(record.sessionId, record.sessionFile);
				} catch (error) {
					this.options.log(`Mesh session ${record.sessionId}: ${redactMeshError(error)}`);
				}
			}
		} finally {
			this.options.log(`Mesh home enrollment: ${count} sessions in ${Date.now() - started} ms`);
		}
	}

	private recordEnrollmentFailure(sessionId: string, error: unknown): string {
		const reason = `enrollment failed: ${redactMeshError(error)}`;
		this.enrollmentFailures.set(sessionId, reason);
		return reason;
	}

	enqueueEnrollment(sessionId: string, sessionFile?: string): Promise<void> {
		const work = this.enrollmentQueue.then(() => {
			if (!this.closing) return this.enroll(sessionId, sessionFile);
		});
		this.enrollmentQueue = work.catch(() => undefined);
		return work;
	}

	enroll(sessionId: string, sessionFile?: string): Promise<void> {
		if (this.closing) return Promise.reject(new Error(`Session ${sessionId}: mesh is shutting down`));
		if (this.refusal) return Promise.reject(new Error(this.refusal));
		if (!sessionFile) {
			const error = new Error(`Session ${sessionId} has no session file and cannot be enrolled`);
			this.recordEnrollmentFailure(sessionId, error);
			return Promise.reject(error);
		}
		if (this.sessions.has(sessionId)) return Promise.resolve();
		const existing = this.enrolling.get(sessionId);
		if (existing) return existing;
		const work = this.startSession(sessionId, sessionFile).catch((error: unknown) => {
			throw new Error(this.recordEnrollmentFailure(sessionId, error));
		});
		this.enrolling.set(sessionId, work);
		void work.then(
			() => this.enrolling.delete(sessionId),
			() => this.enrolling.delete(sessionId),
		);
		return work;
	}

	private async startSession(sessionId: string, sessionFile: string): Promise<void> {
		const config = this.config;
		if (!config) throw new Error(this.refusal ?? "Mesh configuration is unavailable");
		let claim: SessionLease;
		try {
			claim = claimEnrollment(this.options.meshRoot, sessionId, sessionFile);
		} catch (error) {
			if (error instanceof SessionAlreadyActiveError) {
				this.enrollmentFailures.set(sessionId, "claimed by another daemon");
				this.options.log(`Mesh session ${sessionId}: claimed by another daemon`);
				return;
			}
			throw error;
		}
		let endpoint: CotalEndpoint | undefined;
		let session: SessionEndpoint | undefined;
		try {
			readSigner(this.options.meshRoot, config.space);
			const record = ensureEnrollmentRecord(this.options.meshRoot, sessionId, sessionFile);
			await provisionEnrollment(this.options.meshRoot, config, record);
			if (this.closing) throw new Error(`Session ${sessionId}: mesh is shutting down`);
			const directory = await publishDirectory(this.options.meshRoot, record, this.options.homeSocket);
			endpoint = new CotalEndpoint({
				space: config.space,
				servers: config.server,
				card: { name: directory.name, kind: "agent", id: record.identity.id },
				lifecycleUid: record.lifecycleUid,
				channels: [],
				creds: credentialSource(
					this.options.meshRoot,
					config.space,
					record,
					this.options.credentialLifetimeSeconds,
				),
			});
			session = { record, claim, endpoint, queue: [] };
			const startedSession = session;
			endpoint.on("error", (error: unknown) =>
				this.options.log(`Mesh session ${sessionId}: endpoint error: ${redactMeshError(error)}`),
			);
			endpoint.on("warning", (error: unknown) =>
				this.options.log(`Mesh session ${sessionId}: endpoint warning: ${redactMeshError(error)}`),
			);
			endpoint.on("message", (message: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
				if (meta.kind === "dm" && delivery.durable) this.enqueue(startedSession, message, delivery);
			});
			try {
				await endpoint.start();
			} catch (error) {
				throw new Error(`Session ${sessionId}: Cotal endpoint start failed: ${redactMeshError(error)}`);
			}
			if (this.closing || !readDirectory(this.options.meshRoot, sessionId)) {
				throw new Error(`Session ${sessionId}: mesh closed or directory entry disappeared`);
			}
			this.sessions.set(sessionId, session);
			this.enrollmentFailures.delete(sessionId);
			this.drain(session);
		} catch (error) {
			if (session) {
				session.failed = true;
				for (const item of session.queue) {
					if (item.workingTimer) clearInterval(item.workingTimer);
					if (item.stallTimer) clearTimeout(item.stallTimer);
				}
				session.queue.length = 0;
			}
			try {
				await endpoint?.stop();
			} catch (error) {
				this.options.log(`Mesh session ${sessionId}: endpoint cleanup stop rejected: ${redactMeshError(error)}`);
			} finally {
				claim.release();
			}
			throw error;
		}
	}

	async resolveAddress(selector: string): Promise<string> {
		if (!this.config || this.refusal) throw new Error(`Message was not stored: mesh unavailable: ${this.refusal}`);
		const result = await resolveDirectoryAddress(this.options.meshRoot, this.config.space, selector, (file) => {
			if (this.invalidDirectoryEntries.has(file)) return;
			this.invalidDirectoryEntries.add(file);
			this.options.log(`Mesh directory entry ${JSON.stringify(file)}: unreadable or invalid; ignored`);
		});
		if (!result.ok) {
			const reason = result.reason === "unknown" ? this.enrollmentFailures.get(selector) : undefined;
			throw new Error(`Message was not stored: ${reason ?? result.error}`);
		}
		return result.entry.sessionId;
	}

	async rename(sessionId: string, sessionFile: string): Promise<void> {
		await renameDirectory(this.options.meshRoot, sessionId, sessionFile);
	}

	sessionIdForPrincipal(principal: string, knownSessionIds: readonly string[]): string | undefined {
		return knownSessionIds.find((sessionId) => {
			try {
				return readDirectory(this.options.meshRoot, sessionId)?.principal === principal;
			} catch {
				return false;
			}
		});
	}

	async send(
		sender: AgentSessionMessageSender & { sessionId: string },
		targetSessionId: string,
		message: string,
	): Promise<AgentSessionMessageReceipt> {
		const senderSessionId = sender.sessionId;
		if (this.closing) throw new Error("Message was not stored: mesh is shutting down");
		if (this.refusal) throw new Error(`Message was not stored: mesh unavailable: ${this.refusal}`);
		const source = this.sessions.get(senderSessionId);
		if (!source)
			throw new Error(
				`Message was not stored: sender ${senderSessionId} ${this.enrollmentFailures.get(senderSessionId) ?? "is not enrolled"}`,
			);
		let senderEnrolled: boolean;
		try {
			senderEnrolled =
				existsSync(enrollmentPath(this.options.meshRoot, senderSessionId)) &&
				!!readDirectory(this.options.meshRoot, senderSessionId);
		} catch (error) {
			throw new Error(`Message was not stored: ${redactMeshError(error)}`);
		}
		if (!senderEnrolled)
			throw new Error(
				`Message was not stored: sender ${senderSessionId} has no enrollment record or directory entry`,
			);
		let target: ReturnType<typeof readDirectory>;
		try {
			target = readDirectory(this.options.meshRoot, targetSessionId);
		} catch (error) {
			throw new Error(`Message was not stored: ${redactMeshError(error)}`);
		}
		if (!target || !existsSync(enrollmentPath(this.options.meshRoot, targetSessionId))) {
			throw new Error(
				`Message was not stored: target ${targetSessionId} ${this.enrollmentFailures.get(targetSessionId) ?? "is not enrolled: no enrollment record or directory entry"}`,
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
		} catch (error) {
			throw new Error(
				`Message storage outcome is unknown: ${redactMeshError(error)}; a resend can show the message twice`,
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private enqueue(session: SessionEndpoint, message: CotalMessage, delivery: Delivery): void {
		if (this.closing || session.failed) return;
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
		const item: QueuedDelivery = { message, delivery, deliveryCount, workingTimer };
		session.queue.push(item);
		this.drain(session);
	}

	private drain(session: SessionEndpoint): void {
		if (this.closing || session.handoff || this.sessions.get(session.record.sessionId) !== session) return;
		const item = session.queue.shift();
		if (!item) return;
		session.current = item;
		const redelivery = item.delivery.redelivery;
		if (redelivery) {
			item.stallTimer = setTimeout(() => {
				this.logDelivery(
					session,
					item.message.id,
					item.deliveryCount,
					`persistence still pending; queued behind ${session.queue.length}`,
				);
			}, redelivery.ackWaitMs);
			item.stallTimer.unref();
		}
		const handoff = this.deliver(session, item);
		session.handoff = handoff;
		void handoff.finally(() => {
			if (item.workingTimer) clearInterval(item.workingTimer);
			if (item.stallTimer) clearTimeout(item.stallTimer);
			session.handoff = undefined;
			session.current = undefined;
			this.drain(session);
		});
	}

	private async deliver(session: SessionEndpoint, item: QueuedDelivery): Promise<void> {
		const { message, delivery, deliveryCount } = item;
		let pending: PendingPersistence | undefined;
		try {
			meshMessageText(message);
			if (!readDirectory(this.options.meshRoot, session.record.sessionId)) {
				await session.endpoint.stop();
				session.claim.release();
				this.sessions.delete(session.record.sessionId);
				for (const queued of session.queue) {
					if (queued.workingTimer) clearInterval(queued.workingTimer);
					if (queued.stallTimer) clearTimeout(queued.stallTimer);
				}
				session.queue.length = 0;
				throw new Error("Mesh directory entry disappeared");
			}
			if (this.pending.has(message.id)) throw new Error("A copy is already in flight");
			const persisted = new Promise<void>((resolve, reject) => {
				pending = { sessionId: session.record.sessionId, deliveryCount, delivery, resolve, reject };
				this.pending.set(message.id, pending);
			});
			// A disconnect may reject this while wake/acceptance is still pending.
			void persisted.catch(() => undefined);
			await this.options.handoff(session.record, message, deliveryCount, (recipient) => {
				if (pending) pending.recipient = recipient;
			});
			await persisted;
		} catch (error) {
			if (pending && this.pending.get(message.id) !== pending) return;
			if (error instanceof InvalidMeshPayloadError) {
				let outcome = "invalid payload acknowledged";
				try {
					delivery.ack();
				} catch {
					outcome = "invalid payload acknowledgement failed; left unacknowledged";
				}
				this.logDelivery(session, message?.id, deliveryCount, `${outcome}: ${redactMeshError(error)}`);
			} else {
				this.logDelivery(
					session,
					message.id,
					deliveryCount,
					`handoff failed; left unacknowledged: ${redactMeshError(error)}`,
				);
			}
		} finally {
			if (pending && this.pending.get(message.id) === pending) this.pending.delete(message.id);
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

	confirmDropped(cotalId: string, recipient: object, reason: "cleared" | "closed" | "other"): void {
		if (this.closing) return;
		const pending = this.pending.get(cotalId);
		if (!pending || pending.recipient !== recipient) return;
		this.pending.delete(cotalId);
		let outcome = reason === "other" ? "left unacknowledged" : "acknowledged";
		try {
			if (reason !== "other") pending.delivery.ack();
			pending.resolve();
		} catch {
			outcome = "acknowledgement failed; left unacknowledged";
			pending.reject(new Error("Mesh terminal acknowledgement failed"));
		}
		this.options.log(
			`Mesh session ${pending.sessionId}, Cotal ID ${cotalId}, delivery count ${pending.deliveryCount}: dropped ${reason}; ${outcome}`,
		);
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
				Promise.allSettled([...handoffs, ...this.enrolling.values()]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		for (const pending of this.pending.values()) pending.reject(new Error("Mesh is shutting down"));
		this.pending.clear();
		const outcomes = await stops;
		try {
			for (const [index, outcome] of outcomes.entries()) {
				if (outcome.status === "rejected")
					this.options.log(
						`Mesh endpoint stop ${index} rejected; continuing shutdown: ${redactMeshError(outcome.reason)}`,
					);
			}
		} finally {
			for (const session of this.sessions.values()) {
				for (const item of [...session.queue, ...(session.current ? [session.current] : [])]) {
					if (item.workingTimer) clearInterval(item.workingTimer);
					if (item.stallTimer) clearTimeout(item.stallTimer);
				}
				session.queue.length = 0;
				session.claim.release();
			}
			this.sessions.clear();
		}
	}

	private logDelivery(session: SessionEndpoint, cotalId: string, deliveryCount: number, reason: string): void {
		this.options.log(
			`Mesh session ${session.record.sessionId}, Cotal ID ${cotalId}, delivery count ${deliveryCount}: ${reason}`,
		);
	}
}
