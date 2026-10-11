import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Api, completeSimple, type Model, parseJsonWithRepair } from "@earendil-works/pi-ai";
import { getDecisionApiLogPath } from "../config.js";
import type { HostRequestHandler } from "./kernel/shared.js";
import type { ModelRegistry } from "./model-registry.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";

const DEFAULT_INSTRUCTIONS = "Choose the next action that best advances the goal given the observation.";
const UNCONFIGURED =
	'decisionApi.systemOneModel is not set in settings.json. Set it to the decision model reference ("provider/model-id" or a bare id), e.g. "typesafe/jev-1.13.0".';
const INVALID_IMAGE = 'decision images must be data URL strings like "data:image/png;base64,..."';

type ErrorCategory = "invalid_request" | "not_configured" | "provider_error" | "aborted" | "invalid_reply";

class DecisionApiError extends Error {
	constructor(
		message: string,
		readonly category: ErrorCategory,
		readonly outcome: "rejected" | "error",
		readonly httpStatus?: number,
	) {
		super(message);
	}
}

interface DecisionRequest {
	readonly state: unknown;
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string>>;
	readonly images: readonly string[];
}

interface ResolvedDecisionModel {
	readonly model: Model<Api>;
	readonly apiKey: string | undefined;
	readonly headers: Record<string, string> | undefined;
}

interface DecisionApiDependencies {
	readonly getReference: () => string | undefined;
	readonly modelRegistry: ModelRegistry;
	readonly sessionId: string;
	readonly logPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): never {
	throw new DecisionApiError(message, "invalid_request", "rejected");
}

function parseDecisionRequest(request: unknown): DecisionRequest {
	if (!isObject(request)) invalidRequest("decision_api.decide needs a request object");
	if (request.model !== undefined && request.model !== null) {
		invalidRequest(
			`The decision model comes from the decisionApi.systemOneModel setting; the request carries no model (got ${JSON.stringify(request.model)}).`,
		);
	}
	const unknown = Object.keys(request)
		.filter((key) => !["model", "state", "questions", "images"].includes(key))
		.sort();
	if (unknown.length) {
		invalidRequest(
			`decision_api.decide got unsupported request fields: ${unknown.map((key) => JSON.stringify(key)).join(", ")}. Only "state", "questions", and "images" are allowed.`,
		);
	}
	if (!Object.hasOwn(request, "state")) invalidRequest('decision_api.decide needs a "state" value');
	if (!isObject(request.questions) || !Object.hasOwn(request.questions, "action")) {
		invalidRequest('decision_api.decide needs a "questions" object with an "action" question');
	}
	const question = isObject(request.questions.action) ? request.questions.action : {};
	if (question.type !== undefined && question.type !== "choice") {
		invalidRequest(
			`the "action" question must have type "choice", not ${JSON.stringify(question.type)}. The Decision API serves one action choice per request.`,
		);
	}
	const instructions = question.instructions ?? DEFAULT_INSTRUCTIONS;
	if (typeof instructions !== "string") {
		invalidRequest(`the "action" question's instructions must be a string, not ${JSON.stringify(instructions)}.`);
	}
	if (!isObject(question.criteria)) {
		invalidRequest('the "action" question needs a "criteria" object of action names to descriptions');
	}
	if (!Object.keys(question.criteria).length) {
		invalidRequest('the "action" question\'s "criteria" object is empty; a decision needs actions to choose from');
	}
	const entries: [string, string][] = [];
	for (const [name, applies] of Object.entries(question.criteria)) {
		if (typeof applies !== "string") {
			invalidRequest(
				`the "criteria" entry ${JSON.stringify(name)} must be a string describing when the action applies, not ${JSON.stringify(applies)}`,
			);
		}
		if (!name.length) invalidRequest('the "criteria" object has an empty action name');
		entries.push([name, applies]);
	}
	const images: string[] = [];
	if (request.images !== undefined && request.images !== null) {
		if (!Array.isArray(request.images)) {
			invalidRequest(
				`decision "images" must be an array of data URL strings, not ${JSON.stringify(request.images)}.`,
			);
		}
		if (request.images.length > 4)
			invalidRequest(`a decision carries at most 4 images, got ${request.images.length}`);
		for (const url of request.images) {
			if (typeof url !== "string") invalidRequest(`${INVALID_IMAGE}, got ${JSON.stringify(url)}`);
			const comma = url.indexOf(",");
			const header = url.slice(0, comma);
			if (comma < 0 || !header.startsWith("data:image/") || !header.endsWith(";base64") || !url.slice(comma + 1)) {
				invalidRequest(INVALID_IMAGE);
			}
			images.push(url);
		}
	}
	return { state: request.state, instructions, criteria: Object.fromEntries(entries), images };
}

function unusableMessage(reference: string): string {
	return `decisionApi.systemOneModel "${reference}" could not be resolved to an available, authenticated model.

Fix the decisionApi.systemOneModel setting (settings.json) or authenticate the provider, then retry the decision.`;
}

async function resolveDecisionModel(reference: string, registry: ModelRegistry): Promise<ResolvedDecisionModel> {
	const model = findExactModelReferenceMatch(reference, registry.getAvailable());
	if (!model) throw new DecisionApiError(unusableMessage(reference), "not_configured", "rejected");
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new DecisionApiError(unusableMessage(reference), "not_configured", "rejected");
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function invalidReply(message: string): never {
	throw new DecisionApiError(message, "invalid_reply", "error");
}

function parseDecisionAnswer(reply: string, actions: readonly string[]) {
	const raw = reply.trim();
	if (!raw) invalidReply("the decision model returned an empty reply");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
	let parsed: unknown;
	try {
		parsed = parseJsonWithRepair<unknown>(candidate);
	} catch (error) {
		invalidReply(
			`the decision model's reply was not valid JSON (${error instanceof Error ? error.message : String(error)}): ${raw}`,
		);
	}
	if (!isObject(parsed) || !isObject(parsed.answers)) {
		invalidReply(`the decision model's reply has no "answers" object: ${raw}`);
	}
	const answers = JSON.stringify(parsed.answers);
	if (!isObject(parsed.answers.action)) invalidReply(`the decision model's reply has no "action" object: ${answers}`);
	const answer = parsed.answers.action;
	if (typeof answer.choice !== "string")
		invalidReply(`the decision model's reply has no "action"."choice" string: ${answers}`);
	if (!actions.includes(answer.choice)) {
		invalidReply(
			`the decision model chose ${JSON.stringify(answer.choice)}, which is not one of the requested actions: ${actions.join(", ")}`,
		);
	}
	const confidence =
		typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
			? Math.max(0, Math.min(1, answer.confidence))
			: null;
	const probabilities = isObject(answer.probabilities)
		? Object.fromEntries(
				Object.entries(answer.probabilities).filter(
					([, value]) => typeof value === "number" && Number.isFinite(value),
				),
			)
		: null;
	return { choice: answer.choice, confidence, probabilities };
}

function redact(message: string, secrets: readonly string[]): string {
	let redacted = message;
	for (const secret of secrets) {
		redacted = redacted.split(secret).join("[redacted]");
	}
	return redacted;
}

export function createDecisionApiHostHandler(deps: DecisionApiDependencies): HostRequestHandler {
	const logPath = deps.logPath ?? getDecisionApiLogPath();
	let cache:
		| { readonly reference: string; readonly pending: Promise<ResolvedDecisionModel>; secrets: string[] }
		| undefined;

	return async function decide(payload) {
		const started = Date.now();
		const reference = deps.getReference();
		if (!reference || cache?.reference !== reference) cache = undefined;
		let resolution: typeof cache;
		let request: DecisionRequest | undefined;
		let secrets: string[] = cache?.secrets ?? [];
		let result: Record<string, unknown> | undefined;
		let failure: DecisionApiError | undefined;
		const record: Record<string, unknown> = {
			ts: new Date(started).toISOString(),
			session_id: deps.sessionId,
			model: reference ?? null,
			actions: [],
			choice: null,
			confidence: null,
			probabilities: null,
			usage: null,
			request_bytes: Buffer.byteLength(JSON.stringify(payload.request) ?? "", "utf8"),
		};
		try {
			request = parseDecisionRequest(payload.request);
			const actions = Object.keys(request.criteria);
			record.state = request.state;
			record.actions = actions;
			record.images = {
				count: request.images.length,
				sha256: request.images.map((url) =>
					createHash("sha256")
						.update(url.slice(url.indexOf(",") + 1))
						.digest("hex"),
				),
			};
			if (!reference) throw new DecisionApiError(UNCONFIGURED, "not_configured", "rejected");
			cache ??= { reference, pending: resolveDecisionModel(reference, deps.modelRegistry), secrets: [] };
			resolution = cache;
			const resolved = await resolution.pending;
			secrets = [resolved.apiKey, ...Object.values(resolved.headers ?? {})]
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.sort((a, b) => b.length - a.length);
			resolution.secrets = secrets;
			const { model } = resolved;
			const label = `${model.provider}/${model.id}`;
			record.model = label;
			if (model.api !== "systemone") {
				throw new DecisionApiError(
					`decisionApi.systemOneModel "${reference}" uses api "${model.api}"; the Decision API needs a model with api "systemone".`,
					"not_configured",
					"rejected",
				);
			}
			if (request.images.length && !model.input.includes("image")) {
				throw new DecisionApiError(
					`${label} does not accept image input, so decisions cannot carry images. Drop the images, or set decisionApi.systemOneModel to a vision-capable model.`,
					"not_configured",
					"rejected",
				);
			}
			const body = {
				state: request.state,
				questions: { action: { type: "choice", instructions: request.instructions, criteria: request.criteria } },
				model: model.id,
				...(request.images.length ? { images: request.images } : {}),
			};
			const response = await completeSimple(
				model,
				{ messages: [{ role: "user", content: JSON.stringify(body), timestamp: 0 }] },
				{ apiKey: resolved.apiKey, headers: resolved.headers, timeoutMs: 30000 },
			);
			const usage = { input_tokens: response.usage.input, output_tokens: response.usage.output };
			record.usage = usage;
			if (response.stopReason === "aborted")
				throw new DecisionApiError("the decision model call was aborted", "aborted", "error");
			if (response.stopReason === "error") {
				const message = response.errorMessage ?? "unknown provider error";
				const status = /^systemone returned HTTP (\d{3}):/.exec(message);
				throw new DecisionApiError(
					`the decision model call failed: ${message}`,
					"provider_error",
					"error",
					status ? Number(status[1]) : undefined,
				);
			}
			const reply = response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const answer = parseDecisionAnswer(reply, actions);
			result = { model: label, answers: { action: answer }, usage };
			Object.assign(record, answer, { usage });
		} catch (error) {
			failure =
				error instanceof DecisionApiError
					? error
					: new DecisionApiError(
							`the decision model request failed: ${error instanceof Error ? error.message : String(error)}`,
							"provider_error",
							"error",
						);
			if (request && cache === resolution) cache = undefined;
		}
		Object.assign(record, {
			latency_ms: Date.now() - started,
			outcome: failure?.outcome ?? "ok",
			error: failure?.category ?? null,
			...(failure?.httpStatus === undefined ? {} : { http_status: failure.httpStatus }),
		});
		let logError: string | undefined;
		try {
			await mkdir(dirname(logPath), { recursive: true });
			const line = JSON.stringify(record, (_key, value: unknown) =>
				typeof value === "string" ? redact(value, secrets) : value,
			);
			await appendFile(logPath, `${line}\n`, "utf8");
		} catch (error) {
			logError = redact(error instanceof Error ? error.message : String(error), secrets);
		}
		if (failure) {
			const suffix = logError ? ` (the decision log write also failed: ${logError})` : "";
			throw new Error(`${redact(failure.message, secrets)}${suffix}`);
		}
		return { ...result, ...(logError ? { log_error: logError } : {}) };
	};
}
