/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 Peter KC
 * SPDX-License-Identifier: MIT
 */
/** Archives large text tool results and projects stable, readable placeholders without editing history. */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEntry } from "../../session-manager.js";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "../types.js";

const THRESHOLD_BYTES = 10240;
const EXCERPT_BYTES = 512;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

interface Observation {
	id: string;
	contentHash: string;
	filePath: string;
	toolName: string;
	text: string;
	bytes: number;
	lines: number;
}

interface CycleDecision {
	readonly compactionId: string;
	readonly noteIds: readonly string[];
}

interface State {
	pi: ExtensionAPI;
	warnedSessions: Set<string>;
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

function completeLineExcerpt(text: string, fromEnd: boolean): string {
	const lines = text.split(/(?<=\n)/);
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = fromEnd ? lines.length - 1 : 0;
	while (index >= 0 && index < lines.length) {
		const line = lines[index];
		const bytes = Buffer.byteLength(line, "utf8");
		if (selectedBytes + bytes > EXCERPT_BYTES) break;
		if (fromEnd) selected.unshift(line);
		else selected.push(line);
		selectedBytes += bytes;
		index += fromEnd ? -1 : 1;
	}
	return selected.join("");
}

function placeholderFor(observation: Observation): string {
	return [
		"[large tool result shrunk when a new context cycle began]",
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`archive: ${observation.filePath}`,
		`read in ipython: print(open(${JSON.stringify(observation.filePath)}, encoding="utf-8", newline="").read()[0:16000])`,
		`[first complete lines, up to ${EXCERPT_BYTES} bytes]`,
		completeLineExcerpt(observation.text, false),
		`[middle omitted; last complete lines, up to ${EXCERPT_BYTES} bytes]`,
		completeLineExcerpt(observation.text, true),
		"[full text in archive]",
	].join("\n");
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function requireDirectory(path: string): void {
	const stats = lstatSync(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Observation archive directory is not a regular directory: ${path}`);
	}
}

function ensureDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}
	requireDirectory(path);
}

function reuseStored(observation: Observation): boolean {
	let stats: Stats;
	try {
		stats = lstatSync(observation.filePath);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false;
		throw error;
	}
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Observation archive is not a regular file for ${observation.id}`);
	}
	const fd = openSync(observation.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Observation archive is not a regular file for ${observation.id}`);
		if (hash(readFileSync(fd)) !== observation.contentHash) {
			throw new Error(`Observation archive hash mismatch for ${observation.id}`);
		}
	} finally {
		closeSync(fd);
	}
	return true;
}

function ensureStored(observation: Observation, sessionDir: string, sessionId: string): void {
	// Check each archive directory before touching its children; recursive mkdir would follow a symlink.
	const archiveRoot = join(sessionDir, "observation-pack");
	ensureDirectory(archiveRoot);
	const directory = join(archiveRoot, sessionId);
	ensureDirectory(directory);
	if (reuseStored(observation)) return;

	const tempPath = join(directory, `.${observation.id}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	const fd = openSync(tempPath, CREATE_FLAGS, 0o600);
	let tempExists = true;
	try {
		try {
			writeFileSync(fd, observation.text, { encoding: "utf8" });
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, observation.filePath);
		tempExists = false;
	} finally {
		if (tempExists) unlinkSync(tempPath);
	}
}

function warnFailure(state: State, ctx: ExtensionContext, sessionKey: string): void {
	try {
		if (!ctx.hasUI || state.warnedSessions.has(sessionKey)) return;
		state.warnedSessions.add(sessionKey);
		ctx.ui.notify(
			"observation-pack could not store or verify an archive decision. The cycle's selected representation is unchanged; see the session error entry if available.",
			"warning",
		);
	} catch {
		// A UI failure must not change the context projection.
	}
}

function reportFailure(
	state: State,
	ctx: ExtensionContext,
	id: string,
	error: unknown,
	sessionKey: string,
	compactionId: string,
): void {
	try {
		const message = error instanceof Error ? error.message : String(error);
		const reported = ctx.sessionManager.getEntries().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== "observation-pack-error") return false;
			const data = entry.data as { id: string; compactionId?: string } | undefined;
			return data?.compactionId === compactionId && data.id === id;
		});
		if (reported) return;
		state.pi.appendEntry("observation-pack-error", { id, message, compactionId });
	} catch {
		// Diagnostic lookup or persistence failures must not change the context projection.
	}
	warnFailure(state, ctx, sessionKey);
}

function hasAssistantInCycle(entries: readonly SessionEntry[], compactionId: string): boolean {
	const descendants = new Set([compactionId]);
	for (const entry of entries) {
		if (!entry.parentId || !descendants.has(entry.parentId) || entry.type === "compaction") continue;
		if (entry.type === "message" && entry.message.role === "assistant") return true;
		descendants.add(entry.id);
	}
	return false;
}

function onContext(state: State, event: ContextEvent, ctx: ExtensionContext) {
	const projected = [...event.messages];
	const sessionDir = ctx.sessionManager.getSessionDir();
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionDir || !sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return { messages: projected };
	const sessionKey = `${sessionDir}\0${sessionId}`;
	const branch = ctx.sessionManager.getBranch();
	let cycleIndex = branch.length - 1;
	while (cycleIndex >= 0 && branch[cycleIndex].type !== "compaction") cycleIndex -= 1;
	if (cycleIndex < 0) return { messages: projected };
	const compactionId = branch[cycleIndex].id;
	const entries = ctx.sessionManager.getEntries();
	const decisionEntry = entries.find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "observation-pack-cycle" &&
			(entry.data as CycleDecision | undefined)?.compactionId === compactionId,
	);
	const decision = decisionEntry?.type === "custom" ? (decisionEntry.data as CycleDecision) : undefined;
	if (!decision && hasAssistantInCycle(entries, compactionId)) return { messages: projected };
	const keptCallIds = new Set(
		branch
			.slice(0, cycleIndex)
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
			),
	);
	let canRead = false;
	try {
		canRead = state.pi.getActiveTools().includes("ipython");
	} catch {
		// A host tool lookup failure means read-back is not available.
	}
	const noteIds: string[] = [];
	let hasEligibleKeptResult = false;
	for (let index = 0; index < event.messages.length; index += 1) {
		const message = event.messages[index];
		if (message.role !== "toolResult" || message.isError || !message.content.every((block) => block.type === "text"))
			continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes <= THRESHOLD_BYTES) continue;
		const contentHash = hash(text);
		const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
		if (decision ? !decision.noteIds.includes(id) : !keptCallIds.has(message.toolCallId)) continue;
		hasEligibleKeptResult = true;
		const observation: Observation = {
			id,
			contentHash,
			filePath: resolve(sessionDir, "observation-pack", sessionId, `${id}.txt`),
			toolName: message.toolName,
			text,
			bytes,
			lines: countLines(text),
		};
		if (decision) {
			// A recorded note stays a note even if its archive or read-back tool is lost.
			projected[index] = { ...message, content: [{ type: "text", text: placeholderFor(observation) }] };
			try {
				if (!canRead) throw new Error("ipython is inactive for a recorded observation note");
				if (!reuseStored(observation)) throw new Error(`Observation archive is missing for ${id}`);
			} catch (error) {
				reportFailure(state, ctx, id, error, sessionKey, compactionId);
			}
			continue;
		}
		if (!canRead) continue;
		try {
			ensureStored(observation, sessionDir, sessionId);
			noteIds.push(id);
			projected[index] = { ...message, content: [{ type: "text", text: placeholderFor(observation) }] };
		} catch (error) {
			reportFailure(state, ctx, id, error, sessionKey, compactionId);
		}
	}
	if (!decision && hasEligibleKeptResult) {
		// Keep this projection if appendEntry records the decision and then throws.
		try {
			state.pi.appendEntry("observation-pack-cycle", { compactionId, noteIds });
		} catch {
			warnFailure(state, ctx, sessionKey);
		}
	}
	return { messages: projected };
}

/** Registers the context projection, with diagnostics scoped to this loaded extension. */
export default function initialize(pi: ExtensionAPI): void {
	const state: State = { pi, warnedSessions: new Set() };
	pi.on("context", (event, ctx) => {
		try {
			return onContext(state, event, ctx);
		} catch {
			// Unexpected failures discard partial work; decision append failures are caught inside onContext.
			return { messages: event.messages };
		}
	});
}
