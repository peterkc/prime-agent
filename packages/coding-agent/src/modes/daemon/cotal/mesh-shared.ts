import { join } from "node:path";
import { normalizeAgentSessionMessage } from "../../../core/agent-messages.js";

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

export interface EnrollmentRecord {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly identity: { readonly id: string; readonly seed: string };
	readonly lifecycleUid: string;
	readonly allowSubscribe: string[];
}

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

export function meshMessageText(message: unknown): string {
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
	try {
		return normalizeAgentSessionMessage(value.parts.map((part: { text: string }) => part.text).join("\n"));
	} catch {
		throw new InvalidMeshPayloadError("Mesh text is empty or exceeds the agent message limit");
	}
}
