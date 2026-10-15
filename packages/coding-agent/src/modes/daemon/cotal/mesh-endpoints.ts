import { existsSync } from "node:fs";
import { CotalEndpoint, type CotalMessage, credsClaims, type Delivery, type MessageMeta } from "@cotal-ai/core";
import {
	AGENT_MESSAGE_ID_PREFIX,
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
} from "../../../core/agent-messages.js";
import { canonicalSessionPath, SessionAlreadyActiveError, type SessionLease } from "../../../core/session-lease.js";
import { resolveDirectoryAddress } from "./address.js";
import {
	claimEnrollment,
	credentialSource,
	deprovisionEnrollment,
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
	removeEnrollment,
	renameDirectory,
	withDirectoryLock,
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
		isOpen: () => boolean,
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
	state: "starting" | "connected" | "transport-disconnected" | "reconnecting" | "closed";
	readonly abort: AbortController;
	credentialExpiresAt?: number;
	close?: Promise<void>;
	retirement?: Promise<void>;
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
		const existing = this.enrolling.get(sessionId);
		if (existing) return existing;
		const session = this.sessions.get(sessionId);
		if (session)
			return session.state === "closed"
				? Promise.reject(new Error(`Session ${sessionId}: mesh endpoint is closed`))
				: Promise.resolve();
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
		let session: SessionEndpoint | undefined;
		let record: EnrollmentRecord | undefined;
		try {
			readSigner(this.options.meshRoot, config.space);
			record = await withDirectoryLock(this.options.meshRoot, sessionId, async () => {
				if (!existsSync(sessionFile)) throw new Error(`Session ${sessionId}: session file is missing`);
				return ensureEnrollmentRecord(this.options.meshRoot, sessionId, sessionFile);
			});
			await provisionEnrollment(this.options.meshRoot, config, record);
			if (this.closing) throw new Error(`Session ${sessionId}: mesh is shutting down`);
			const directory = await publishDirectory(this.options.meshRoot, record, this.options.homeSocket);
			const source = credentialSource(
				this.options.meshRoot,
				config.space,
				record,
				this.options.credentialLifetimeSeconds,
			);
			let nextCredentialExpiresAt: number | undefined;
			const endpoint = new CotalEndpoint({
				space: config.space,
				servers: config.server,
				card: { name: directory.name, kind: "agent", id: record.identity.id },
				lifecycleUid: record.lifecycleUid,
				channels: [],
				watchPresence: false,
				watchChannels: false,
				creds: async () => {
					const creds = await source();
					// Initial/passive binds accept this generation at their ready edge. Timer candidates need adoption.
					if (!session || session.state === "starting" || session.state === "reconnecting") {
						const exp = credsClaims(creds).exp;
						nextCredentialExpiresAt = exp === undefined ? undefined : exp * 1000;
					}
					return creds;
				},
			});
			session = { record, claim, endpoint, queue: [], state: "starting", abort: new AbortController() };
			this.sessions.set(sessionId, session);
			const startedSession = session;
			endpoint.on("connection", ({ connected }: { connected: boolean }) => {
				if (startedSession.state === "closed") return;
				startedSession.state = connected ? "connected" : "reconnecting";
				if (connected) startedSession.credentialExpiresAt = nextCredentialExpiresAt;
			});
			endpoint.on("transport", ({ connected }: { connected: boolean }) => {
				if (!connected && startedSession.state === "connected") startedSession.state = "transport-disconnected";
				else if (connected && startedSession.state === "transport-disconnected") {
					startedSession.state = "connected";
					startedSession.credentialExpiresAt = nextCredentialExpiresAt;
				}
			});
			endpoint.on("creds-adopted", ({ exp }: { exp?: number }) => {
				nextCredentialExpiresAt = exp === undefined ? undefined : exp * 1000;
			});
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
			if (session.state === "closed") throw new Error(`Session ${sessionId}: mesh endpoint is closed`);
			session.state = "connected";
			this.enrollmentFailures.delete(sessionId);
			this.drain(session);
		} catch (error) {
			if (session) {
				let directoryMissing = false;
				try {
					directoryMissing = !session.retirement && !readDirectory(this.options.meshRoot, sessionId);
				} catch (cleanupError) {
					this.options.log(
						`Mesh session ${sessionId}: directory read failed; inbox retained: ${redactMeshError(cleanupError)}`,
					);
				}
				if (session.retirement || directoryMissing) {
					await this.retireSession(session);
				} else {
					await this.closeSession(sessionId);
					this.sessions.delete(sessionId);
					claim.release();
				}
			} else {
				// An unpublished first enrollment is not a delete. Only missing persisted state authorizes removal.
				if (record && !existsSync(enrollmentPath(this.options.meshRoot, sessionId))) {
					await this.removeInbox(record);
				}
				claim.release();
			}
			throw error;
		}
	}

	closeSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.resolve();
		if (session.close) return session.close;
		session.state = "closed";
		session.abort.abort();
		for (const item of [...session.queue, ...(session.current ? [session.current] : [])]) {
			if (item.workingTimer) clearInterval(item.workingTimer);
			if (item.stallTimer) clearTimeout(item.stallTimer);
		}
		session.queue.length = 0;
		for (const [id, pending] of this.pending) {
			if (pending.sessionId !== sessionId) continue;
			this.pending.delete(id);
			pending.reject(new Error("Mesh endpoint closed before persistence"));
		}
		session.close = session.endpoint.stop().catch((error: unknown) => {
			this.options.log(`Mesh session ${sessionId}: endpoint stop failed; claim retained: ${redactMeshError(error)}`);
			throw error;
		});
		return session.close;
	}

	async unenroll(sessionId: string, sessionFile: string): Promise<void> {
		const record = await removeEnrollment(this.options.meshRoot, sessionId, canonicalSessionPath(sessionFile));
		if (!record) {
			this.options.log(`Mesh session ${sessionId}: deleted file is not the enrolled file; inbox unchanged`);
			return;
		}
		const session = this.sessions.get(sessionId);
		if (session) {
			await this.retireSession(session);
			return;
		}
		let claim: SessionLease;
		try {
			claim = claimEnrollment(this.options.meshRoot, sessionId, sessionFile);
		} catch (error) {
			if (!(error instanceof SessionAlreadyActiveError)) throw error;
			this.options.log(`Mesh session ${sessionId}: inbox removal skipped; claimed by another daemon`);
			return;
		}
		try {
			await this.removeInbox(record);
		} finally {
			claim.release();
		}
	}

	private retireSession(session: SessionEndpoint): Promise<void> {
		if (session.retirement) return session.retirement;
		session.retirement = this.closeSession(session.record.sessionId).then(async () => {
			await this.removeInbox(session.record);
			session.claim.release();
			this.sessions.delete(session.record.sessionId);
		});
		return session.retirement;
	}

	private async removeInbox(record: EnrollmentRecord): Promise<void> {
		if (!this.config) throw new Error("Mesh configuration is unavailable");
		try {
			await deprovisionEnrollment(this.options.meshRoot, this.config, record);
		} catch (error) {
			this.options.log(`Mesh session ${record.sessionId}: inbox removal failed: ${redactMeshError(error)}`);
		}
	}

	async resolveAddress(selector: string): Promise<string> {
		if (!this.config || this.refusal) throw new Error(`Message was not stored: mesh unavailable: ${this.refusal}`);
		let result: Awaited<ReturnType<typeof resolveDirectoryAddress>>;
		try {
			result = await resolveDirectoryAddress(this.options.meshRoot, this.config.space, selector, (file) => {
				if (this.invalidDirectoryEntries.has(file)) return;
				this.invalidDirectoryEntries.add(file);
				this.options.log(`Mesh directory entry ${JSON.stringify(file)}: unreadable or invalid; ignored`);
			});
		} catch (error) {
			throw new Error(`Message was not stored: directory lookup failed: ${redactMeshError(error)}`);
		}
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
		const deadline = Date.now() + 30_000;
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
		try {
			await this.waitForConnection(source, deadline);
			if (this.closing || source.state === "closed") throw new Error("mesh endpoint closed");
			if (Date.now() >= deadline) throw new Error("mesh send deadline elapsed before publish");
			if (
				!existsSync(enrollmentPath(this.options.meshRoot, senderSessionId)) ||
				!readDirectory(this.options.meshRoot, senderSessionId)
			)
				throw new Error("sender enrollment disappeared while reconnecting");
			target = readDirectory(this.options.meshRoot, targetSessionId);
			if (!target || !existsSync(enrollmentPath(this.options.meshRoot, targetSessionId)))
				throw new Error("target enrollment disappeared while reconnecting");
		} catch (error) {
			throw new Error(`Message was not stored: sender ${senderSessionId}: ${redactMeshError(error)}`);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// From this call onward any error is ambiguous. Never retry a publish or use native delivery.
			const publish = source.endpoint.unicastAttributed(target.principal, message);
			const { msg, ack } = await Promise.race([
				publish,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Mesh publish deadline elapsed")),
						Math.max(0, deadline - Date.now()),
					);
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

	private waitForConnection(session: SessionEndpoint, deadline: number): Promise<void> {
		if (
			session.state === "connected" &&
			session.credentialExpiresAt !== undefined &&
			Date.now() >= session.credentialExpiresAt
		) {
			session.state = "reconnecting";
			void session.endpoint.reconnect().catch((error: unknown) => {
				this.options.log(`Mesh session ${session.record.sessionId}: reconnect failed: ${redactMeshError(error)}`);
			});
		}
		if (session.state === "connected") return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			function finish(error?: Error): void {
				clearTimeout(timer);
				session.endpoint.off("connection", connected);
				session.endpoint.off("transport", connected);
				session.abort.signal.removeEventListener("abort", closed);
				if (error) reject(error);
				else resolve();
			}
			function connected(): void {
				if (session.state === "connected") finish();
			}
			function closed(): void {
				finish(new Error("mesh endpoint closed"));
			}
			const timer = setTimeout(
				() => finish(new Error("endpoint did not reconnect within 30 seconds")),
				Math.max(0, deadline - Date.now()),
			);
			session.endpoint.on("connection", connected);
			session.endpoint.on("transport", connected);
			session.abort.signal.addEventListener("abort", closed, { once: true });
			if (session.state === "closed") closed();
			else connected();
		});
	}

	private enqueue(session: SessionEndpoint, message: CotalMessage, delivery: Delivery): void {
		if (this.closing || session.state === "closed") return;
		const redelivery = delivery.redelivery;
		const deliveryCount = redelivery?.deliveryCount ?? 1;
		const working = () => {
			if (this.closing || session.state === "closed") return;
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
		if (
			this.closing ||
			session.state === "closed" ||
			session.state === "starting" ||
			session.handoff ||
			this.sessions.get(session.record.sessionId) !== session
		)
			return;
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
				this.logDelivery(session, message.id, deliveryCount, "directory entry disappeared; left unacknowledged");
				await this.retireSession(session);
				return;
			}
			if (this.pending.has(message.id)) throw new Error("A copy is already in flight");
			const persisted = new Promise<void>((resolve, reject) => {
				pending = { sessionId: session.record.sessionId, deliveryCount, delivery, resolve, reject };
				this.pending.set(message.id, pending);
			});
			// A disconnect may reject this while wake/acceptance is still pending.
			void persisted.catch(() => undefined);
			await this.options.handoff(
				session.record,
				message,
				deliveryCount,
				(recipient) => {
					if (pending) pending.recipient = recipient;
				},
				() => {
					if (this.closing || session.state === "closed") return false;
					if (readDirectory(this.options.meshRoot, session.record.sessionId)) return true;
					void this.retireSession(session).catch(() => undefined); // close logs a failed stop and keeps custody.
					return false;
				},
			);
			await persisted;
		} catch (error) {
			if (session.state === "closed" || (pending && this.pending.get(message.id) !== pending)) return;
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
