import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CotalEndpoint, type CotalMessage, credsClaims, type Delivery, type MessageMeta } from "@cotal-ai/core";
import {
	AGENT_MESSAGE_ID_PREFIX,
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
} from "../../../core/agent-messages.js";
import { canonicalSessionPath, SessionAlreadyActiveError, type SessionLease } from "../../../core/session-lease.js";
import { readDeletedRlmChildPaths } from "../rlm-ledger.js";
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
	type MeshDirectoryEntry,
	provisionEnrollment,
	publishDirectory,
	readDirectory,
	readEnrollment,
	readSigner,
	removeEnrollment,
	renameDirectory,
	updateEnrollmentPath,
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
		attemptToken: string,
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
	readonly attemptToken: string;
	readonly deliveryCount: number;
	readonly sessionId: string;
	readonly delivery: Delivery;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	recipient?: object;
}

type ReplacementOutcome = "completed" | "cancelled" | "failed";

interface ReplacementBegin {
	readonly token: string;
	readonly requester: object;
	readonly ready: Promise<void>;
	state: "active" | "cancelled" | "failed";
}

interface SessionReplacement {
	readonly token: string;
	readonly record: EnrollmentRecord;
	readonly claim: SessionLease;
	readonly requester: object;
	state: "active" | "failed";
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
	private readonly replacements = new Map<string, SessionReplacement>();
	private readonly replacementBegins = new Map<string, ReplacementBegin>();
	private closing = false;
	private stopping?: Promise<void>;
	private reconciling?: Promise<void>;
	private reconcileAgain = false;

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
		if (this.replacements.has(sessionId) || this.replacementBegins.has(sessionId)) return Promise.resolve();
		const session = this.sessions.get(sessionId);
		if (session?.state === "closed")
			return Promise.reject(new Error(`Session ${sessionId}: mesh endpoint is closed`));
		if (session && canonicalSessionPath(sessionFile) !== canonicalSessionPath(session.record.sessionFile)) {
			return this.rebindSession(session, sessionFile);
		}
		if (session) return Promise.resolve();
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

	async openSession(sessionId: string, sessionFile?: string): Promise<void> {
		await this.replacementBegins.get(sessionId)?.ready;
		const replacement = this.replacements.get(sessionId);
		if (replacement?.state !== "failed" || !sessionFile) return this.enroll(sessionId, sessionFile);
		const existing = this.enrolling.get(sessionId);
		if (existing) return existing;
		const opening = this.finishReplacementOnce(sessionId, replacement, "completed", sessionFile).then(
			() => undefined,
		);
		this.enrolling.set(sessionId, opening);
		try {
			await opening;
		} finally {
			this.enrolling.delete(sessionId);
		}
	}

	private async startSession(sessionId: string, sessionFile: string, retainedClaim?: SessionLease): Promise<void> {
		const config = this.config;
		if (!config) throw new Error(this.refusal ?? "Mesh configuration is unavailable");
		let claim: SessionLease;
		try {
			claim = retainedClaim ?? claimEnrollment(this.options.meshRoot, sessionId, sessionFile);
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
				if (readDeletedRlmChildPaths(dirname(this.options.meshRoot)).has(canonicalSessionPath(sessionFile)))
					throw new Error(`Session ${sessionId}: RLM child was deliberately deleted`);
				return ensureEnrollmentRecord(this.options.meshRoot, sessionId, sessionFile);
			});
			if (canonicalSessionPath(sessionFile) !== canonicalSessionPath(record.sessionFile))
				record = await updateEnrollmentPath(this.options.meshRoot, sessionId, sessionFile);
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
					if (!retainedClaim) claim.release();
				}
			} else {
				// An unpublished first enrollment is not a delete. Only missing persisted state authorizes removal.
				if (record && !existsSync(enrollmentPath(this.options.meshRoot, sessionId))) {
					await this.removeInbox(record);
				}
				if (!retainedClaim) claim.release();
			}
			throw error;
		}
	}

	async beginReplacement(sessionId: string, requester: object, token: string): Promise<string | undefined> {
		if (this.closing || this.refusal) throw new Error(this.refusal ?? "Mesh is shutting down");
		if (typeof token !== "string" || !token) throw new Error("Mesh replacement refused: invalid replacement token");
		if (this.replacements.get(sessionId)?.token === token || this.replacementBegins.get(sessionId)?.token === token)
			throw new Error(`Session ${sessionId}: stale replacement token`);
		if (this.replacementBegins.has(sessionId))
			throw new Error(`Session ${sessionId}: replacement is already pending`);
		let complete!: () => void;
		const ready = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const beginning: ReplacementBegin = { token, requester, ready, state: "active" };
		this.replacementBegins.set(sessionId, beginning);
		let replacement: SessionReplacement | undefined;
		try {
			await this.enrolling.get(sessionId);
			if (beginning.state === "failed") throw new Error(`Session ${sessionId}: replacement begin failed`);
			if (beginning.state === "cancelled") return undefined;
			if (!existsSync(enrollmentPath(this.options.meshRoot, sessionId))) return undefined;
			const record = readEnrollment(this.options.meshRoot, sessionId);
			const previous = this.replacements.get(sessionId);
			if (previous?.state === "active") throw new Error(`Session ${sessionId}: replacement is already pending`);
			const session = this.sessions.get(sessionId);
			const claim =
				previous?.claim ?? session?.claim ?? claimEnrollment(this.options.meshRoot, sessionId, record.sessionFile);
			replacement = { token, record, claim, requester, state: "active" };
			this.replacements.set(sessionId, replacement);
			await this.closeSession(sessionId);
			return token;
		} catch (error) {
			beginning.state = "failed";
			if (replacement && this.replacements.get(sessionId) === replacement) this.replacements.delete(sessionId);
			if (error instanceof SessionAlreadyActiveError)
				throw new Error(`Session ${sessionId}: claimed by another daemon`, { cause: error });
			throw error;
		} finally {
			this.replacementBegins.delete(sessionId);
			complete();
		}
	}

	async finishReplacement(
		sessionId: string,
		token: string,
		outcome: ReplacementOutcome,
		sessionFile: string,
	): Promise<ReplacementOutcome> {
		const beginning = this.replacementBegins.get(sessionId);
		const current = this.replacements.get(sessionId);
		if ((!beginning || beginning.token !== token) && (!current || current.token !== token))
			throw new Error(`Session ${sessionId}: stale replacement token`);
		if (outcome !== "completed") {
			if (beginning && beginning.token === token) beginning.state = outcome;
			if (current && current.token === token) current.state = "failed";
		}
		if (beginning && beginning.token === token) await beginning.ready;
		await this.enrolling.get(sessionId);
		const replacement = this.replacements.get(sessionId);
		if (!replacement && beginning && beginning.token === token && outcome !== "completed")
			return beginning.state === "failed" ? "failed" : outcome;
		if (!replacement || replacement.token !== token) throw new Error(`Session ${sessionId}: stale replacement token`);
		const work = this.finishReplacementOnce(sessionId, replacement, outcome, sessionFile).then(() => undefined);
		this.enrolling.set(sessionId, work);
		try {
			await work;
			return outcome;
		} finally {
			this.enrolling.delete(sessionId);
		}
	}

	private async finishReplacementOnce(
		sessionId: string,
		replacement: SessionReplacement,
		outcome: ReplacementOutcome,
		sessionFile: string,
	): Promise<ReplacementOutcome> {
		if (outcome === "failed") {
			replacement.state = "failed";
			return outcome;
		}
		try {
			if (outcome === "completed") await updateEnrollmentPath(this.options.meshRoot, sessionId, sessionFile);
			this.sessions.delete(sessionId);
			await this.startSession(
				sessionId,
				outcome === "cancelled" ? replacement.record.sessionFile : sessionFile,
				replacement.claim,
			);
			this.replacements.delete(sessionId);
			return outcome;
		} catch (error) {
			replacement.state = "failed";
			if (
				!existsSync(enrollmentPath(this.options.meshRoot, sessionId)) &&
				this.replacements.get(sessionId) === replacement
			) {
				await this.removeInbox(replacement.record);
				replacement.claim.release();
				this.sessions.delete(sessionId);
				this.replacements.delete(sessionId);
			}
			throw error;
		}
	}

	private async rebindSession(session: SessionEndpoint, sessionFile: string): Promise<void> {
		const token = await this.beginReplacement(session.record.sessionId, this, randomUUID());
		if (token) await this.finishReplacement(session.record.sessionId, token, "completed", sessionFile);
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

	reconcileDeletedChildren(): Promise<void> {
		if (this.closing || this.refusal) return Promise.resolve();
		if (this.reconciling) {
			this.reconcileAgain = true;
			return this.reconciling;
		}
		this.reconciling = (async () => {
			do {
				this.reconcileAgain = false;
				await this.reconcileDeletedChildrenOnce();
			} while (this.reconcileAgain && !this.closing);
		})().finally(() => {
			this.reconciling = undefined;
		});
		return this.reconciling;
	}

	private async reconcileDeletedChildrenOnce(): Promise<void> {
		let deleted: ReadonlySet<string>;
		let files: string[];
		try {
			deleted = readDeletedRlmChildPaths(dirname(this.options.meshRoot));
			const directory = join(this.options.meshRoot, "enrollments");
			files = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")) : [];
		} catch (error) {
			this.options.log(`Mesh RLM deletion reconciliation failed: ${redactMeshError(error)}`);
			return;
		}
		for (const file of files) {
			if (this.closing) break;
			const sessionId = file.slice(0, -5);
			try {
				if (!existsSync(enrollmentPath(this.options.meshRoot, sessionId))) continue;
				const record = readEnrollment(this.options.meshRoot, sessionId);
				if (deleted.has(canonicalSessionPath(record.sessionFile)))
					await this.unenroll(sessionId, record.sessionFile, deleted);
			} catch (error) {
				this.options.log(`Mesh session ${sessionId}: unenrollment failed: ${redactMeshError(error)}`);
			}
		}
	}

	async unenroll(sessionId: string, sessionFile: string, deletedChildren?: ReadonlySet<string>): Promise<void> {
		const record = await removeEnrollment(
			this.options.meshRoot,
			sessionId,
			canonicalSessionPath(sessionFile),
			deletedChildren,
		);
		if (record === "absent") return;
		if (record === "mismatch") {
			this.options.log(`Mesh session ${sessionId}: deleted file is not the enrolled file; inbox unchanged`);
			return;
		}
		const replacement = this.replacements.get(sessionId);
		if (replacement) {
			await this.closeSession(sessionId);
			await this.removeInbox(record);
			replacement.claim.release();
			this.replacements.delete(sessionId);
			this.sessions.delete(sessionId);
			return;
		}
		const session = this.sessions.get(sessionId);
		if (session) {
			await this.retireSession(session);
			return;
		}
		await this.enrolling.get(sessionId)?.catch(() => undefined);
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

	directoryEntryForPrincipal(principal: string): MeshDirectoryEntry | undefined {
		const directory = join(this.options.meshRoot, "directory");
		let files: string[];
		try {
			files = readdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const entry = readDirectory(this.options.meshRoot, file.slice(0, -5));
				if (entry?.principal === principal) return entry;
			} catch {
				// An unrelated invalid directory entry is not a sender match.
			}
		}
		return undefined;
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
				pending = {
					sessionId: session.record.sessionId,
					attemptToken: randomUUID(),
					deliveryCount,
					delivery,
					resolve,
					reject,
				};
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
				pending!.attemptToken,
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

	confirmPersisted(cotalId: string, recipient: object, attemptToken: string): void {
		if (this.closing) return;
		const pending = this.pending.get(cotalId);
		if (!pending || pending.recipient !== recipient || pending.attemptToken !== attemptToken) return;
		this.pending.delete(cotalId);
		try {
			pending.delivery.ack();
			pending.resolve();
		} catch {
			pending.reject(new Error("Mesh acknowledgement failed"));
		}
	}

	confirmDropped(
		cotalId: string,
		recipient: object,
		reason: "cleared" | "closed" | "other",
		attemptToken: string,
	): void {
		if (this.closing) return;
		const pending = this.pending.get(cotalId);
		if (!pending || pending.recipient !== recipient || pending.attemptToken !== attemptToken) return;
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
		for (const beginning of this.replacementBegins.values()) {
			if (beginning.requester === recipient) beginning.state = "failed";
		}
		for (const replacement of this.replacements.values()) {
			if (replacement.requester === recipient && replacement.state === "active") replacement.state = "failed";
		}
		for (const pending of this.pending.values()) {
			if (pending.recipient === recipient)
				pending.reject(new Error("Mesh recipient disconnected before persistence"));
		}
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closing = true;
		for (const beginning of this.replacementBegins.values()) beginning.state = "failed";
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
				Promise.allSettled([
					...handoffs,
					this.reconciling,
					...this.enrolling.values(),
					...[...this.replacementBegins.values()].map((beginning) => beginning.ready),
				]),
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
			for (const replacement of this.replacements.values()) replacement.claim.release();
			this.replacements.clear();
			this.replacementBegins.clear();
			this.sessions.clear();
		}
	}

	private logDelivery(session: SessionEndpoint, cotalId: string, deliveryCount: number, reason: string): void {
		this.options.log(
			`Mesh session ${session.record.sessionId}, Cotal ID ${cotalId}, delivery count ${deliveryCount}: ${reason}`,
		);
	}
}
