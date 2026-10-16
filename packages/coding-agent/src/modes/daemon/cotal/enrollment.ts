import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	CotalEndpoint,
	deprovisionAgent,
	isAccountNkey,
	isUserNkey,
	mintCreds,
	mintLifecycleUid,
	mkSecretDir,
	newIdentity,
	parsePrincipalKey,
	provisionAgent,
	type SpaceAuth,
	writeSecretFileCreateOnly,
} from "@cotal-ai/core";
import { lockSync } from "proper-lockfile";
import {
	acquireSessionLease,
	canonicalSessionPath,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	type SessionLease,
} from "../../../core/session-lease.js";
import { readSessionInfo } from "../../../core/session-manager.js";
import { writeFileAtomicSync } from "../../../utils/atomic-file.js";
import { type EnrollmentRecord, redactMeshError } from "./mesh-shared.js";

export { type EnrollmentRecord, redactMeshError } from "./mesh-shared.js";

export interface MeshConfiguration {
	readonly space: string;
	readonly server: string;
}

export interface MeshDirectoryEntry {
	readonly sessionId: string;
	readonly name: string;
	readonly principal: string;
	readonly homeSocket: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// JSON parser errors can contain a fragment of the secret being parsed.
		throw new Error(`Mesh file ${path}: cannot read valid JSON`);
	}
}

function assertPrivateFile(path: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		throw new Error(`Mesh secret ${path}: missing or inaccessible file`);
	}
	if (!stat.isFile()) throw new Error(`Mesh secret ${path}: not a regular file`);
	if ((stat.mode & 0o777) !== 0o600) throw new Error(`Mesh secret ${path}: mode must be 0600`);
	if (!process.getuid || stat.uid !== process.getuid()) {
		throw new Error(`Mesh secret ${path}: not owned by the current user`);
	}
}

export function loadMeshConfiguration(meshRoot: string): MeshConfiguration {
	const path = join(meshRoot, "mesh.json");
	const value = object(readJson(path));
	if (typeof value?.space !== "string" || !value.space || typeof value.server !== "string" || !value.server) {
		throw new Error(`Mesh configuration ${path}: space and server are required`);
	}
	return { space: value.space, server: value.server };
}

export function readSigner(meshRoot: string, space: string): SpaceAuth {
	const path = join(meshRoot, "signer.json");
	assertPrivateFile(path);
	const value = object(readJson(path));
	const account = object(value?.account);
	if (value?.space !== space || !isAccountNkey(account?.pub) || typeof account?.signingSeed !== "string") {
		throw new Error(`Mesh signer ${path}: invalid space or account signing material`);
	}
	return {
		space,
		operator: { seed: "", jwt: "" },
		account: { pub: account.pub, signingSeed: account.signingSeed, seed: "", jwt: "", signingPub: "" },
		sys: { pub: "", jwt: "" },
	};
}

function sessionKey(sessionId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid mesh session ID");
	return sessionId;
}

export function enrollmentPath(meshRoot: string, sessionId: string): string {
	return join(meshRoot, "enrollments", `${sessionKey(sessionId)}.json`);
}

export function directoryPath(meshRoot: string, sessionId: string): string {
	return join(meshRoot, "directory", `${sessionKey(sessionId)}.json`);
}

export function claimEnrollment(meshRoot: string, sessionId: string, sessionFile?: string): SessionLease {
	if (!sessionFile) throw new Error(`Session ${sessionId} has no session file and cannot be enrolled`);
	mkSecretDir(join(meshRoot, "enrollments"));
	const claim = acquireSessionLease(enrollmentPath(meshRoot, sessionId), meshRoot, {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: sessionId,
	});
	if (!claim) throw new Error(`Session ${sessionId}: mesh claim was not acquired`);
	return claim;
}

export function readEnrollment(meshRoot: string, sessionId: string): EnrollmentRecord {
	const path = enrollmentPath(meshRoot, sessionId);
	assertPrivateFile(path);
	const value = object(readJson(path));
	const identity = object(value?.identity);
	if (
		value?.sessionId !== sessionId ||
		typeof value.sessionFile !== "string" ||
		!isUserNkey(identity?.id) ||
		typeof identity?.seed !== "string" ||
		typeof value.lifecycleUid !== "string" ||
		!Array.isArray(value.allowSubscribe) ||
		!value.allowSubscribe.every((channel) => typeof channel === "string")
	) {
		throw new Error(`Mesh enrollment ${path}: invalid record`);
	}
	return {
		sessionId,
		sessionFile: value.sessionFile,
		identity: { id: identity.id, seed: identity.seed },
		lifecycleUid: value.lifecycleUid,
		allowSubscribe: value.allowSubscribe,
	};
}

export function ensureEnrollmentRecord(meshRoot: string, sessionId: string, sessionFile: string): EnrollmentRecord {
	const path = enrollmentPath(meshRoot, sessionId);
	if (existsSync(path)) return readEnrollment(meshRoot, sessionId);
	mkSecretDir(join(meshRoot, "enrollments"));
	let record: EnrollmentRecord;
	try {
		record = {
			sessionId,
			sessionFile: canonicalSessionPath(sessionFile),
			identity: newIdentity(),
			lifecycleUid: mintLifecycleUid(),
			allowSubscribe: [],
		};
	} catch (error) {
		throw new Error(`Mesh session ${sessionId}: identity creation failed: ${redactMeshError(error, false)}`);
	}
	try {
		writeSecretFileCreateOnly(path, `${JSON.stringify(record)}\n`);
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return readEnrollment(meshRoot, sessionId);
	}
}

export async function updateEnrollmentPath(
	meshRoot: string,
	sessionId: string,
	sessionFile: string,
): Promise<EnrollmentRecord> {
	return withDirectoryLock(meshRoot, sessionId, async () => {
		if (!existsSync(enrollmentPath(meshRoot, sessionId)) || !readDirectory(meshRoot, sessionId))
			throw new Error(`Session ${sessionId}: enrollment was removed during replacement`);
		const info = await readSessionInfo(sessionFile);
		if (!info || info.id !== sessionId) throw new Error(`Session ${sessionId}: invalid replacement file`);
		const record = { ...readEnrollment(meshRoot, sessionId), sessionFile: canonicalSessionPath(sessionFile) };
		writeFileAtomicSync(enrollmentPath(meshRoot, sessionId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		return record;
	});
}

export function credentialSource(
	meshRoot: string,
	space: string,
	record: EnrollmentRecord,
	expiresInSeconds = 3600,
): () => Promise<string> {
	return async () => {
		const auth = readSigner(meshRoot, space);
		try {
			return await mintCreds(auth, record.identity, "agent", {
				lifecycleUid: record.lifecycleUid,
				allowSubscribe: record.allowSubscribe,
				expiresInSeconds,
			});
		} catch (error) {
			throw new Error(
				`Mesh signer ${join(meshRoot, "signer.json")}: credential mint failed: ${redactMeshError(error, false)}`,
			);
		}
	};
}

export async function provisionEnrollment(
	meshRoot: string,
	config: MeshConfiguration,
	record: EnrollmentRecord,
): Promise<void> {
	const auth = readSigner(meshRoot, config.space);
	let creds: string;
	try {
		creds = await mintCreds(auth, newIdentity(), "provisioner");
	} catch (error) {
		throw new Error(
			`Mesh signer ${join(meshRoot, "signer.json")}: provisioner mint failed: ${redactMeshError(error, false)}`,
		);
	}
	const provisioner = new CotalEndpoint({
		space: config.space,
		servers: config.server,
		creds,
		channels: [],
		consume: false,
		registerPresence: false,
		watchPresence: false,
		watchChannels: false,
		card: { name: "prime-mesh-provisioner", role: "provisioner", kind: "endpoint" },
	});
	let failure: Error | undefined;
	provisioner.on("error", (error: unknown) => {
		failure ??= new Error(`Mesh session ${record.sessionId}: provisioner error: ${redactMeshError(error)}`);
	});
	try {
		await provisioner.start();
		await provisionAgent(provisioner, auth, record.identity, {
			lifecycleUid: record.lifecycleUid,
			allowSubscribe: record.allowSubscribe,
			subscribe: record.allowSubscribe,
		});
	} catch (error) {
		failure = new Error(`Mesh session ${record.sessionId}: provisioning failed: ${redactMeshError(error)}`);
	}
	try {
		await provisioner.stop();
	} catch (error) {
		failure ??= new Error(`Mesh session ${record.sessionId}: provisioner stop failed: ${redactMeshError(error)}`);
	}
	if (failure) throw failure;
}

export async function removeEnrollment(
	meshRoot: string,
	sessionId: string,
	deletedPath: string,
): Promise<"absent" | "mismatch" | EnrollmentRecord> {
	return withDirectoryLock(meshRoot, sessionId, async () => {
		const path = enrollmentPath(meshRoot, sessionId);
		const record = existsSync(path) ? readEnrollment(meshRoot, sessionId) : undefined;
		if (!record) return "absent";
		if (
			canonicalSessionPath(record.sessionFile) !== deletedPath ||
			lstatSync(record.sessionFile, { throwIfNoEntry: false }) !== undefined
		)
			return "mismatch";
		await rm(directoryPath(meshRoot, sessionId), { force: true });
		await rm(path, { force: true });
		return record;
	});
}

export async function deprovisionEnrollment(
	meshRoot: string,
	config: MeshConfiguration,
	record: EnrollmentRecord,
): Promise<void> {
	const signer = readSigner(meshRoot, config.space);
	let creds: string;
	try {
		creds = await mintCreds(signer, newIdentity(), "deprovisioner", {
			deprovisionTarget: { principal: record.identity.id, lifecycleUid: record.lifecycleUid },
		});
	} catch (error) {
		throw new Error(`Deprovisioner mint failed: ${redactMeshError(error, false)}`);
	}
	await deprovisionAgent({
		servers: config.server,
		space: config.space,
		targetId: record.identity.id,
		lifecycleUid: record.lifecycleUid,
		creds,
	});
}

/** Same lock shape as the session-lease guard, but retry waits yield the event loop. */
export async function withDirectoryLock<T>(meshRoot: string, sessionId: string, action: () => Promise<T>): Promise<T> {
	mkSecretDir(join(meshRoot, "directory"));
	const path = directoryPath(meshRoot, sessionId);
	let compromised = false;
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(path, {
				realpath: false,
				lockfilePath: `${path}.lock`,
				stale: 5000,
				onCompromised: () => {
					compromised = true;
				},
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			if (attempt === 99) throw new Error(`Could not coordinate mesh directory ${path}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
	}
	if (!release) throw new Error(`Could not coordinate mesh directory ${path}`);
	try {
		if (compromised) throw new Error(`Mesh directory lock compromised: ${path}`);
		const result = await action();
		if (compromised) throw new Error(`Mesh directory lock compromised: ${path}`);
		return result;
	} finally {
		if (!compromised) release();
		else {
			try {
				release();
			} catch {
				/* A compromised lock no longer belongs to us. */
			}
		}
	}
}

export async function publishDirectory(
	meshRoot: string,
	record: EnrollmentRecord,
	homeSocket: string,
): Promise<MeshDirectoryEntry> {
	return withDirectoryLock(meshRoot, record.sessionId, async () => {
		const path = enrollmentPath(meshRoot, record.sessionId);
		if (!existsSync(record.sessionFile) || !existsSync(path)) {
			throw new Error(`Session ${record.sessionId}: session file or enrollment record is missing`);
		}
		const session = await readSessionInfo(record.sessionFile);
		if (!session || session.id !== record.sessionId)
			throw new Error(`Session ${record.sessionId}: invalid session file`);
		const entry: MeshDirectoryEntry = {
			sessionId: record.sessionId,
			name: session.name ?? record.sessionId,
			principal: `local.${record.identity.id}`,
			homeSocket,
		};
		// A delete during the asynchronous session read must not recreate its directory entry.
		if (!existsSync(record.sessionFile) || !existsSync(path)) {
			throw new Error(`Session ${record.sessionId}: session file or enrollment record is missing`);
		}
		writeFileAtomicSync(directoryPath(meshRoot, record.sessionId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		return entry;
	});
}

export async function renameDirectory(meshRoot: string, sessionId: string, sessionFile: string): Promise<void> {
	await withDirectoryLock(meshRoot, sessionId, async () => {
		const entry = readDirectory(meshRoot, sessionId);
		if (!entry) return;
		const info = await readSessionInfo(sessionFile);
		if (!info || info.id !== sessionId) throw new Error(`Session ${sessionId}: invalid session file after rename`);
		writeFileAtomicSync(
			directoryPath(meshRoot, sessionId),
			`${JSON.stringify({ ...entry, name: info.name ?? sessionId })}\n`,
			{
				mode: 0o600,
			},
		);
	});
}

export function readDirectory(meshRoot: string, sessionId: string): MeshDirectoryEntry | undefined {
	const path = directoryPath(meshRoot, sessionId);
	if (!existsSync(path)) return undefined;
	return parseDirectoryEntry(path, sessionId, readJson(path));
}

export async function readDirectoryAsync(meshRoot: string, sessionId: string): Promise<MeshDirectoryEntry | undefined> {
	const path = directoryPath(meshRoot, sessionId);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Mesh directory ${path}: cannot read valid JSON`);
	}
	return parseDirectoryEntry(path, sessionId, value);
}

function parseDirectoryEntry(path: string, sessionId: string, input: unknown): MeshDirectoryEntry {
	const value = object(input);
	if (
		value?.sessionId !== sessionId ||
		typeof value.name !== "string" ||
		typeof value.principal !== "string" ||
		!parsePrincipalKey(value.principal) ||
		typeof value.homeSocket !== "string"
	)
		throw new Error(`Mesh directory ${path}: invalid entry`);
	return { sessionId, name: value.name, principal: value.principal, homeSocket: value.homeSocket };
}

export function homeEnrollments(
	meshRoot: string,
	homeSocket: string,
	onFailure: (sessionId: string, error: unknown) => void,
): EnrollmentRecord[] {
	const directory = join(meshRoot, "directory");
	if (!existsSync(directory)) return [];
	const result: EnrollmentRecord[] = [];
	for (const file of readdirSync(directory)) {
		if (!file.endsWith(".json")) continue;
		const sessionId = file.slice(0, -5);
		try {
			if (readDirectory(meshRoot, sessionId)?.homeSocket === homeSocket) {
				result.push(readEnrollment(meshRoot, sessionId));
			}
		} catch (error) {
			onFailure(sessionId, error);
		}
	}
	return result;
}
