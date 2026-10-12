import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

export interface QuestionOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly recommended?: boolean;
}

export interface Question {
	readonly id: string;
	readonly label: string;
	readonly prompt: string;
	readonly options: QuestionOption[];
	readonly allowOther: boolean;
}

export interface Answer {
	readonly id: string;
	readonly value: string;
	readonly label: string;
	readonly wasCustom: boolean;
	readonly index?: number;
}

export interface QuestionnaireResult {
	readonly questions: readonly Question[];
	readonly answers: readonly Answer[];
	readonly cancelled: boolean;
	readonly deferred?: boolean;
	// Retained for rendering earlier timeout results in session history.
	readonly cancelReason?: "timeout";
	readonly retry?: {
		available: boolean;
		savedAnswers: number;
	};
}

export interface QuestionnaireRetryState {
	readonly version: 1;
	readonly formKey: string;
	readonly status: "active" | "cleared";
	readonly answers?: readonly Answer[];
}

interface RestoredRetryState {
	active: boolean;
	answers: Answer[];
}

export interface QuestionnaireAnswerValue {
	readonly value: string;
	readonly wasCustom: boolean;
}

export interface QuestionnaireForm {
	readonly questions: readonly Question[];
	readonly answers: Record<string, QuestionnaireAnswerValue>;
}

export interface QuestionnaireOutcome {
	readonly status: "submitted" | "deferred" | "cancelled";
	readonly answers: Record<string, QuestionnaireAnswerValue>;
	readonly error?: string;
}

export interface QuestionnaireHost {
	entries(): readonly unknown[];
	appendEntry(state: QuestionnaireRetryState): void;
	needsInput(ctx: ExtensionContext): void;
}

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The stable value returned when selected" }),
	label: Type.String({
		description: "Concise outcome-first display label. Do not include a recommendation marker.",
	}),
	description: Type.Optional(
		Type.String({ description: "Optional concise trade-off that distinguishes this option" }),
	),
	recommended: Type.Optional(
		Type.Boolean({
			description: "Render `— Recommended` after this option. At most one option per question may be recommended.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

export const questionnaireSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

const RECOMMENDED_SUFFIX = " — Recommended";
// Prime's daemon selector removes empty title lines. A zero-width line survives
// that normalization and renders as the section spacing the string-only API lacks.
const DIALOG_SPACER = "\u200B";
const DEFER_LABEL = "Defer / answer in chat";
const RETRY_STATE_CUSTOM_TYPE = "questionnaire_retry_state";

function displayOptionLabel(option: QuestionOption): string {
	return option.recommended ? `${option.label}${RECOMMENDED_SUFFIX}` : option.label;
}

function displayAnswerLabel(questions: readonly Question[], answer: Answer): string {
	if (answer.wasCustom) return answer.label;
	const question = questions.find((item) => item.id === answer.id);
	const byIndex = answer.index ? question?.options[answer.index - 1] : undefined;
	const option = byIndex ?? question?.options.find((item) => item.value === answer.value);
	return option ? displayOptionLabel(option) : answer.label;
}

function fallbackQuestionTitle(questions: readonly Question[], questionIndex: number, currentAnswer?: Answer): string {
	const question = questions[questionIndex];
	const lines = [`[${questionIndex + 1}/${questions.length}] ${question.label}`, DIALOG_SPACER, question.prompt];
	if (currentAnswer) {
		lines.push(
			DIALOG_SPACER,
			`Current answer: ${displayAnswerLabel(questions, currentAnswer)}`,
			"Press Esc to return to review.",
		);
	}
	const tradeoffs = question.options
		.map((option) => (option.description ? `• ${option.description}` : undefined))
		.filter((line): line is string => line !== undefined);
	if (tradeoffs.length > 0) {
		lines.push(DIALOG_SPACER, "Trade-offs:", ...tradeoffs);
	}
	return lines.join("\n");
}

function fallbackReviewTitle(questions: readonly Question[], answers: Map<string, Answer>): string {
	const summary = questions.map((question) => {
		const answer = answers.get(question.id);
		const label = answer ? displayAnswerLabel(questions, answer) : "Unanswered";
		return `${question.label}: ${label}`;
	});
	return [
		"Review answers",
		DIALOG_SPACER,
		...summary,
		DIALOG_SPACER,
		"Choose Submit, an answer to edit, or Defer / answer in chat.",
	].join("\n");
}

function deferredQuestionText(questions: readonly Question[], savedAnswers: number): string {
	const savedMessage =
		savedAnswers > 0
			? `${savedAnswers} partial answer${savedAnswers === 1 ? " was" : "s were"} saved for this session.`
			: "No partial answers were saved.";
	const lines = [
		"Questionnaire deferred without submission.",
		savedMessage,
		"",
		"Review the questions below. Reply in normal chat with your answers, or ask to reopen the form.",
		"",
	];

	for (const [questionIndex, question] of questions.entries()) {
		lines.push(`${questionIndex + 1}. ${question.label}: ${question.prompt}`);
		for (const [optionIndex, option] of question.options.entries()) {
			const description = option.description ? ` — ${option.description}` : "";
			lines.push(`   ${optionIndex + 1}. ${displayOptionLabel(option)}${description}`);
		}
		if (question.allowOther) {
			lines.push(`   ${question.options.length + 1}. Type something.`);
		}
		lines.push("");
	}

	lines.push("The questionnaire will not reopen automatically. Wait for the user's next instruction.");
	return lines.join("\n");
}

function questionnaireFormKey(questions: readonly Question[]): string {
	const canonical = questions.map((question) => ({
		id: question.id,
		label: question.label,
		prompt: question.prompt,
		allowOther: question.allowOther,
		options: question.options.map((option) => ({
			value: option.value,
			label: option.label,
			description: option.description ?? null,
			recommended: option.recommended === true,
		})),
	}));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeRetryAnswers(questions: readonly Question[], value: unknown): Answer[] {
	if (!Array.isArray(value)) return [];
	const rawAnswers = value.map(asRecord).filter((answer): answer is Record<string, unknown> => answer !== undefined);
	const answers: Answer[] = [];

	for (const question of questions) {
		const raw = rawAnswers.find((answer) => answer.id === question.id);
		if (!raw || typeof raw.value !== "string") continue;
		if (raw.wasCustom === true) {
			if (!question.allowOther) continue;
			answers.push({
				id: question.id,
				value: raw.value,
				label: raw.value,
				wasCustom: true,
			});
			continue;
		}
		if (raw.wasCustom !== false) continue;

		const rawIndex =
			typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index > 0 ? raw.index : undefined;
		const indexedOption = rawIndex ? question.options[rawIndex - 1] : undefined;
		const option =
			indexedOption?.value === raw.value
				? indexedOption
				: question.options.find((candidate) => candidate.value === raw.value);
		if (!option) continue;
		answers.push({
			id: question.id,
			value: option.value,
			label: option.label,
			wasCustom: false,
			index: question.options.indexOf(option) + 1,
		});
	}
	return answers;
}

function readRetryState(
	questions: readonly Question[],
	formKey: string,
	entries: readonly unknown[],
): RestoredRetryState {
	for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
		const entry = asRecord(entries[entryIndex]);
		if (entry?.type !== "custom" || entry.customType !== RETRY_STATE_CUSTOM_TYPE) continue;
		const data = asRecord(entry.data);
		if (data?.version !== 1 || data.formKey !== formKey) continue;
		if (data.status === "cleared") return { active: false, answers: [] };
		if (data.status === "active") {
			const answers = normalizeRetryAnswers(questions, data.answers);
			if (answers.length > 0) return { active: true, answers };
		}
	}
	return { active: false, answers: [] };
}

function errorResult(message: string, questions: readonly Question[] = []): AgentToolResult<QuestionnaireResult> {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
		isError: true,
	};
}

export function parseQuestionnaireQuestions(value: unknown): { questions: readonly Question[] } | { error: string } {
	if (!Array.isArray(value) || value.length === 0) return { error: "Error: No questions provided" };
	const questions: Question[] = [];
	const ids = new Set<string>();
	for (const [index, raw] of value.entries()) {
		const question = asRecord(raw);
		const name = typeof question?.id === "string" && question.id.trim() ? question.id : `#${index + 1}`;
		const error = (reason: string) => ({ error: `Error: Question ${name} ${reason}` });
		if (!question || typeof question.id !== "string" || !question.id.trim()) return error("has an empty ID");
		if (ids.has(question.id)) return error("has a duplicate ID");
		if (typeof question.prompt !== "string" || !question.prompt.trim()) return error("has an empty prompt");
		if (!Array.isArray(question.options)) return error("has invalid options");
		if (question.allowOther !== undefined && typeof question.allowOther !== "boolean")
			return error("has invalid allowOther");
		if (question.label !== undefined && typeof question.label !== "string") return error("has an invalid label");
		const options: QuestionOption[] = [];
		const values = new Set<string>();
		for (const rawOption of question.options) {
			const option = asRecord(rawOption);
			if (
				!option ||
				typeof option.value !== "string" ||
				typeof option.label !== "string" ||
				(option.description !== undefined && typeof option.description !== "string") ||
				(option.recommended !== undefined && typeof option.recommended !== "boolean")
			)
				return error("has an invalid option");
			if (values.has(option.value)) return error("has a duplicate option value");
			values.add(option.value);
			options.push({
				value: option.value,
				label: option.label,
				...(typeof option.description === "string" ? { description: option.description } : {}),
				...(typeof option.recommended === "boolean" ? { recommended: option.recommended } : {}),
			});
		}
		if (!options.length && question.allowOther === false) return error("has no answer path");
		if (options.filter((option) => option.recommended === true).length > 1)
			return error("has more than one recommended option; at most one is allowed");
		ids.add(question.id);
		questions.push({
			id: question.id,
			label: question.label || `Q${index + 1}`,
			prompt: question.prompt,
			options,
			allowOther: question.allowOther !== false,
		});
	}
	return { questions };
}

export function parseQuestionnaireOutcome(questions: readonly Question[], value: unknown): QuestionnaireOutcome {
	const invalid = (reason: string): QuestionnaireOutcome => ({
		status: "cancelled",
		answers: {},
		error: `Invalid questionnaire reply: ${reason}`,
	});
	const raw = asRecord(value);
	if (!raw || (raw.status !== "submitted" && raw.status !== "deferred" && raw.status !== "cancelled"))
		return invalid("unknown status");
	const rawAnswers = asRecord(raw.answers);
	if (!rawAnswers) return invalid("answers must be keyed by question ID");
	const answers: Record<string, QuestionnaireAnswerValue> = {};
	for (const [id, rawAnswer] of Object.entries(rawAnswers)) {
		const question = questions.find((question) => question.id === id);
		if (!question) return invalid(`unknown question ${id}`);
		const answer = asRecord(rawAnswer);
		if (!answer || typeof answer.value !== "string" || typeof answer.wasCustom !== "boolean")
			return invalid(`invalid answer for ${id}`);
		if (answer.wasCustom ? !question.allowOther : !question.options.some((option) => option.value === answer.value))
			return invalid(`answer not offered for ${id}`);
		Object.defineProperty(answers, id, {
			value: { value: answer.value, wasCustom: answer.wasCustom },
			enumerable: true,
		});
	}
	if (raw.status === "submitted" && questions.some((question) => !Object.hasOwn(answers, question.id)))
		return invalid("Submit requires every question to be answered");
	return { status: raw.status, answers };
}

function resultFromOutcome(questions: readonly Question[], outcome: QuestionnaireOutcome): QuestionnaireResult {
	const answers = normalizeRetryAnswers(
		questions,
		Object.entries(outcome.answers).map(([id, answer]) => ({ id, ...answer })),
	);
	return {
		questions,
		answers,
		cancelled: outcome.status === "cancelled",
		...(outcome.status === "deferred" ? { deferred: true } : {}),
	};
}

function deferResult(questions: readonly Question[], answers: Answer[]): QuestionnaireResult {
	return { questions, answers, cancelled: false, deferred: true };
}

async function runDialogFallback(
	questions: readonly Question[],
	initialAnswers: readonly Answer[],
	ui: ExtensionContext["ui"],
	signal?: AbortSignal,
): Promise<QuestionnaireResult> {
	const answers = new Map(initialAnswers.map((answer) => [answer.id, answer]));

	function orderedAnswers(): Answer[] {
		return questions.flatMap((question) => {
			const answer = answers.get(question.id);
			return answer ? [answer] : [];
		});
	}

	async function askQuestion(
		questionIndex: number,
		editing: boolean,
	): Promise<"answered" | "back" | "cancelled" | "deferred"> {
		const question = questions[questionIndex];
		const currentAnswer = answers.get(question.id);
		const displayOptions = question.options.map(
			(option, optionIndex) => `${optionIndex + 1}. ${displayOptionLabel(option)}`,
		);
		if (question.allowOther) {
			displayOptions.push(`${question.options.length + 1}. Type something.`);
		}

		const deferOption = `${displayOptions.length + 1}. ${DEFER_LABEL}`;
		displayOptions.push(deferOption);
		const title = fallbackQuestionTitle(questions, questionIndex, currentAnswer);
		const selected = await ui.select(title, displayOptions, { signal });
		if (signal?.aborted) return "cancelled";
		if (selected === deferOption) return "deferred";
		if (selected === undefined) {
			return editing ? "back" : "cancelled";
		}

		const selectedIndex = displayOptions.indexOf(selected);
		if (selectedIndex < 0) {
			return editing ? "back" : "cancelled";
		}

		if (question.allowOther && selectedIndex === question.options.length) {
			const placeholder = currentAnswer?.wasCustom ? currentAnswer.value : "Type your answer";
			const value = await ui.input(title, placeholder, { signal });
			if (signal?.aborted) return "cancelled";
			if (value === undefined) {
				return editing ? "back" : "cancelled";
			}
			const trimmed = value.trim() || "(no response)";
			answers.set(question.id, {
				id: question.id,
				value: trimmed,
				label: trimmed,
				wasCustom: true,
			});
			return "answered";
		}

		const option = question.options[selectedIndex];
		if (!option) {
			return editing ? "back" : "cancelled";
		}
		answers.set(question.id, {
			id: question.id,
			value: option.value,
			label: option.label,
			wasCustom: false,
			index: selectedIndex + 1,
		});
		return "answered";
	}

	for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
		if (answers.has(questions[questionIndex].id)) continue;
		const outcome = await askQuestion(questionIndex, false);
		if (outcome === "deferred") return deferResult(questions, orderedAnswers());
		if (outcome !== "answered") {
			return { questions, answers: orderedAnswers(), cancelled: true };
		}
	}

	const submitOption = "1. Submit answers";
	const editOptions = questions.map(
		(question, questionIndex) => `${questionIndex + 2}. Edit ${question.label} answer`,
	);
	const deferOption = `${questions.length + 2}. ${DEFER_LABEL}`;
	const cancelOption = `${questions.length + 3}. Cancel questionnaire`;
	const reviewOptions = [submitOption, ...editOptions, deferOption, cancelOption];

	while (true) {
		const selected = await ui.select(fallbackReviewTitle(questions, answers), reviewOptions, { signal });
		if (signal?.aborted || selected === undefined || selected === cancelOption) {
			return { questions, answers: orderedAnswers(), cancelled: true };
		}
		if (selected === deferOption) return deferResult(questions, orderedAnswers());
		if (selected === submitOption) {
			return { questions, answers: orderedAnswers(), cancelled: false };
		}

		const editIndex = editOptions.indexOf(selected);
		if (editIndex < 0) {
			return { questions, answers: orderedAnswers(), cancelled: true };
		}
		const editOutcome = await askQuestion(editIndex, true);
		if (editOutcome === "deferred") return deferResult(questions, orderedAnswers());
		if (editOutcome === "cancelled") {
			return { questions, answers: orderedAnswers(), cancelled: true };
		}
	}
}

async function executeQuestionnaire(
	rawQuestions: unknown,
	ctx: ExtensionContext,
	host?: QuestionnaireHost,
	signal?: AbortSignal,
): Promise<AgentToolResult<QuestionnaireResult>> {
	const parsed = parseQuestionnaireQuestions(rawQuestions);
	if ("error" in parsed) return errorResult(parsed.error);
	const { questions } = parsed;
	if (!ctx.hasUI) return errorResult("Error: UI not available (running in non-interactive mode)", questions);
	const formKey = questionnaireFormKey(questions);
	const restoredRetryState = readRetryState(questions, formKey, host?.entries() ?? ctx.sessionManager.getBranch());
	let retryStateActive = restoredRetryState.active;
	let persistedAnswerCount = restoredRetryState.answers.length;

	function persistRetryState(answers: readonly Answer[]): { available: boolean; savedAnswers: number } {
		if (answers.length === 0) {
			return { available: persistedAnswerCount > 0, savedAnswers: persistedAnswerCount };
		}
		const state: QuestionnaireRetryState = {
			version: 1,
			formKey,
			status: "active",
			answers,
		};
		try {
			if (!host) throw new Error("questionnaire needs an agent session to save progress");
			host.appendEntry(state);
			retryStateActive = true;
			persistedAnswerCount = answers.length;
		} catch {
			ctx.ui.notify("Questionnaire deferred, but its latest partial answers could not be saved.", "warning");
		}
		return { available: persistedAnswerCount > 0, savedAnswers: persistedAnswerCount };
	}

	function clearRetryState(): void {
		if (!retryStateActive) return;
		const state: QuestionnaireRetryState = {
			version: 1,
			formKey,
			status: "cleared",
		};
		try {
			if (!host) throw new Error("questionnaire needs an agent session to save progress");
			host.appendEntry(state);
			retryStateActive = false;
			persistedAnswerCount = 0;
		} catch {
			ctx.ui.notify("Questionnaire finished, but its saved retry state could not be cleared.", "warning");
		}
	}

	if (!signal?.aborted) host?.needsInput(ctx);
	const savedAnswers = Object.fromEntries(
		restoredRetryState.answers.map((answer) => [answer.id, { value: answer.value, wasCustom: answer.wasCustom }]),
	);
	const native: QuestionnaireOutcome | undefined = signal?.aborted
		? { status: "cancelled", answers: {} }
		: await ctx.ui.questionnaire({ questions, answers: savedAnswers }, { signal });
	const outcome =
		native === undefined ? undefined : native.error ? native : parseQuestionnaireOutcome(questions, native);
	if (outcome?.error) {
		clearRetryState();
		return errorResult(outcome.error, questions);
	}
	let result =
		outcome === undefined
			? await runDialogFallback(questions, restoredRetryState.answers, ctx.ui, signal)
			: resultFromOutcome(questions, outcome);
	if (signal?.aborted) result = { questions, answers: result.answers, cancelled: true };
	if (result.deferred) {
		const retry = persistRetryState(result.answers);
		return {
			content: [{ type: "text", text: deferredQuestionText(questions, retry.savedAnswers) }],
			details: { ...result, retry },
			terminate: true,
		};
	}
	if (result.cancelled) {
		clearRetryState();
		return {
			content: [{ type: "text", text: "User cancelled the questionnaire" }],
			details: result,
		};
	}

	clearRetryState();
	const answerLines = result.answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) {
			return `${qLabel}: user wrote: ${a.label}`;
		}
		return `${qLabel}: user selected: ${a.index}. ${displayAnswerLabel(questions, a)}`;
	});

	return {
		content: [{ type: "text", text: answerLines.join("\n") }],
		details: result,
	};
}

export function createQuestionnaireToolDefinition(
	_cwd: string,
	host?: QuestionnaireHost,
): ToolDefinition<typeof questionnaireSchema, QuestionnaireResult> {
	return {
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Before a material choice, present verified data, concrete trade-offs, a supported recommendation, and visible uncertainty in assistant text. Use concise outcome-first option labels; set recommended=true on at most one supported option so the UI appends `— Recommended`; keep Ask and Defer after substantive choices. Shows tabs where custom UI is supported and sequential review/edit/submit dialogs otherwise. No response deadline. Defer saves completed answers and shows questions in chat without submitting.",
		parameters: questionnaireSchema,
		executionMode: "sequential",
		promptGuidelines: [
			"Call questionnaire as the only tool in its assistant turn so Defer can end that turn cleanly.",
			"After the user defers the questionnaire, wait for their next instruction. Reopen only when explicitly asked.",
		],

		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeQuestionnaire(params.questions, ctx, host, signal);
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.deferred || details.cancelReason === "timeout") {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const label = displayAnswerLabel(details.questions, a);
				const display = a.index ? `${a.index}. ${label}` : label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}
