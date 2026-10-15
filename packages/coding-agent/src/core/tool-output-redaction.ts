import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface SecretValue {
	readonly label: string;
	readonly value: string;
}

export interface SecretMatcher {
	readonly exact: readonly SecretValue[];
	readonly windows: ReadonlyMap<string, string>;
}

interface MatchRange {
	readonly start: number;
	end: number;
	readonly label: string;
}

/** Parse the whole call before any value reaches the session registry. */
export function parseSecretValues(entries: unknown): SecretValue[] {
	if (!Array.isArray(entries)) throw new Error("Invalid secret registration at entry 0");
	const parsed: SecretValue[] = [];
	for (let index = 0; index < entries.length; index++) {
		try {
			const entry: unknown = entries[index];
			if (!entry || typeof entry !== "object" || !("label" in entry) || !("value" in entry)) throw new Error();
			const { label, value } = entry;
			if (typeof label !== "string" || !label.length || typeof value !== "string" || value.length < 8) {
				throw new Error();
			}
			parsed.push({ label, value });
		} catch {
			throw new Error(`Invalid secret registration at entry ${index}`);
		}
	}
	return parsed;
}

export function createSecretMatcher(entries: readonly SecretValue[]): SecretMatcher {
	const windows = new Map<string, string>();
	for (const { label, value } of entries) {
		if (value.length < 16) continue;
		for (let start = 0; start <= value.length - 12; start++) {
			const window = value.slice(start, start + 12);
			if (!windows.has(window)) windows.set(window, label);
		}
	}
	return { exact: entries, windows };
}

export function redactText(text: string, matcher: SecretMatcher): string {
	return maskSlice(text, 0, matchRanges(text, matcher));
}

function matchRanges(text: string, matcher: SecretMatcher): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const { label, value } of matcher.exact) {
		let start = text.indexOf(value);
		while (start !== -1) {
			ranges.push({ start, end: start + value.length, label });
			start = text.indexOf(value, start + 1);
		}
	}
	for (let start = 0; matcher.windows.size > 0 && start <= text.length - 12; start++) {
		const label = matcher.windows.get(text.slice(start, start + 12));
		if (label !== undefined) ranges.push({ start, end: start + 12, label });
	}
	ranges.sort((a, b) => a.start - b.start);
	const merged: MatchRange[] = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

/** Mask the part of a joined text that starts at `from`; a range's label goes where the range starts. */
function maskSlice(text: string, from: number, ranges: readonly MatchRange[]): string {
	let output = "";
	let cursor = from;
	for (const range of ranges) {
		if (range.end <= cursor || range.start >= from + text.length) continue;
		output += text.slice(cursor - from, Math.max(range.start, cursor) - from);
		if (range.start >= from) output += `[${range.label}]`;
		cursor = Math.min(range.end, from + text.length);
	}
	return output + text.slice(cursor - from);
}

function redactDetails(value: unknown, matcher: SecretMatcher, copies: WeakMap<object, object>): unknown {
	if (typeof value === "string") return redactText(value, matcher);
	if (!value || typeof value !== "object") return value;
	const previous = copies.get(value);
	if (previous) return previous;
	const copy = Array.isArray(value) ? new Array(value.length) : {};
	copies.set(value, copy);
	for (const [key, child] of Object.entries(value)) {
		Object.defineProperty(copy, key, {
			value: redactDetails(child, matcher, copies),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

export function redactToolOutput(output: AgentToolResult<unknown>, matcher: SecretMatcher): AgentToolResult<unknown> {
	// Serializers join all text parts and drop images, so match across every text part.
	const joined = output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	const ranges = matchRanges(joined, matcher);
	let content = output.content;
	if (ranges.length > 0) {
		// Each part keeps its place; a part emptied by a range that started earlier is dropped.
		let offset = 0;
		content = output.content.flatMap<(typeof output.content)[number]>((part) => {
			if (part.type !== "text") return [part];
			const text = maskSlice(part.text, offset, ranges);
			offset += part.text.length;
			return text || !part.text ? [{ ...part, text }] : [];
		});
	}
	return {
		content,
		details: redactDetails(output.details, matcher, new WeakMap()),
		...(output.terminate !== undefined ? { terminate: output.terminate } : {}),
		...(output.isError !== undefined ? { isError: output.isError } : {}),
	};
}
