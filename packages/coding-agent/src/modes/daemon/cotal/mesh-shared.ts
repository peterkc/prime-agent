import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AGENT_MESSAGE_CAN_WAIT_HEADER,
	normalizeAgentSessionMessage,
	parseAgentMessageScheduling,
} from "../../../core/agent-messages.js";

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

export function parseMeshPrincipalKey(key: string): { owner: string; actor: string } | null {
	const dot = key.indexOf(".");
	if (dot <= 0 || dot >= key.length - 1) return null;
	const owner = key.slice(0, dot);
	const actor = key.slice(dot + 1);
	if (!/^[A-Za-z0-9_]+$/.test(owner) || !/^[A-Za-z0-9_]+$/.test(actor)) return null;
	return { owner, actor };
}

export function parseDirectoryEntry(path: string, sessionId: string, input: unknown): MeshDirectoryEntry {
	const value = object(input);
	if (
		value?.sessionId !== sessionId ||
		typeof value.name !== "string" ||
		typeof value.principal !== "string" ||
		!parseMeshPrincipalKey(value.principal) ||
		typeof value.homeSocket !== "string"
	)
		throw new Error(`Mesh directory ${path}: invalid entry`);
	return { sessionId, name: value.name, principal: value.principal, homeSocket: value.homeSocket };
}

export interface MeshIdentityRecord {
	readonly identity: { readonly id: string; readonly seed: string };
	readonly lifecycleUid: string;
	readonly allowSubscribe: string[];
}

export interface EnrollmentRecord extends MeshIdentityRecord {
	readonly sessionId: string;
	readonly sessionFile: string;
}

export interface GateWatcherRecord extends MeshIdentityRecord {
	readonly name: "gate-watcher";
}

export class MeshNotStoredError extends Error {}
export class MeshStorageUnknownError extends Error {}

/** Preserve diagnostic fields, never a request-bearing cause or credential material. */
export function redactMeshError(error: unknown, includeMessage = true): string {
	const fields =
		error !== null && typeof error === "object" && !Array.isArray(error)
			? (error as Record<string, unknown>)
			: undefined;
	const redact = (value: string) =>
		value
			.replace(/-----BEGIN NATS USER JWT-----[\s\S]*?-----END USER NKEY SEED-----/g, "[redacted credentials]")
			.replace(/S[A-Z2-7]{57}/g, "[redacted seed]")
			.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]")
			.replace(/[\r\n]+/g, " ")
			.slice(0, 512);
	const name = redact(typeof fields?.name === "string" ? fields.name : "Error");
	const code = typeof fields?.code === "string" ? ` (${redact(fields.code)})` : "";
	const message = typeof error === "string" ? error : fields?.message;
	return `${name}${code}${includeMessage && typeof message === "string" ? `: ${redact(message)}` : ""}`;
}

export class MeshTransferRecordError extends Error {
	constructor(
		readonly step: "enrollment" | "directory",
		cause: unknown,
	) {
		super(`Mesh ${step} transfer failed: ${redactMeshError(cause)}`, { cause });
	}
}

/** Only payload-validation failures are permanent; residency and I/O failures may recover. */
export class InvalidMeshPayloadError extends Error {}

export function meshMessagePayload(message: unknown): { text: string; canWait: boolean; replyTo?: string } {
	if (!message || typeof message !== "object") throw new InvalidMeshPayloadError("Malformed mesh payload");
	const value = message as Record<string, unknown>;
	const from = value.from as Record<string, unknown> | undefined;
	if (
		typeof value.id !== "string" ||
		!value.id ||
		!from ||
		typeof from !== "object" ||
		typeof from.id !== "string" ||
		typeof from.name !== "string" ||
		!Array.isArray(value.parts) ||
		value.parts.some(
			(part: unknown) =>
				!part ||
				typeof part !== "object" ||
				!("kind" in part) ||
				part.kind !== "text" ||
				!("text" in part) ||
				typeof part.text !== "string",
		)
	)
		throw new InvalidMeshPayloadError("Unsupported mesh payload shape");
	const parts = value.parts as { kind: "text"; text: string }[];
	let text: string;
	try {
		text = normalizeAgentSessionMessage(parts.map((part) => part.text).join("\n"));
	} catch {
		throw new InvalidMeshPayloadError("Mesh text is empty or exceeds the agent message limit");
	}
	let replyTo: string | undefined;
	try {
		replyTo = parseAgentMessageScheduling({ replyTo: value.replyTo }).replyTo;
	} catch {
		return { text, canWait: false };
	}
	const marked = parts.length >= 2 && parts[0]?.text === AGENT_MESSAGE_CAN_WAIT_HEADER;
	let body = text;
	if (marked) {
		try {
			body = normalizeAgentSessionMessage(
				parts
					.slice(1)
					.map((part) => part.text)
					.join("\n"),
			);
		} catch {
			throw new InvalidMeshPayloadError("Mesh text is empty or exceeds the agent message limit");
		}
	}
	return {
		text: body,
		canWait: marked,
		...(replyTo !== undefined ? { replyTo } : {}),
	};
}

export function meshMessageText(message: unknown): string {
	return meshMessagePayload(message).text;
}
