import { createHash } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { readFirstLineSync } from "../utils/file-lines.js";
import type { FileEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "./session-manager.js";
import { isRotatableSessionId } from "./session-storage-paths.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";

export type RotationAssistantEntry = SessionMessageEntry & { message: AssistantMessage };
export interface SessionArchiveRef {
	readonly segment: number;
	readonly bytes: number;
	readonly sha256: string;
}
export interface SessionRotation {
	readonly version: 1;
	readonly segment: number;
	readonly archives: readonly SessionArchiveRef[];
	readonly restart: { readonly version: 1; readonly count: number; readonly sha256: string };
	readonly compactionId?: string;
	readonly parent?: { readonly sessionId: string; readonly leafId: string; readonly segment: number };
	readonly accounting: { readonly messageCount: number; readonly lastActivityTime?: number; readonly usage?: Usage };
}
export type RotationAccountingRow =
	| { readonly kind: "assistant"; readonly entry: RotationAssistantEntry; readonly accountingParentId: string | null }
	| { readonly kind: "bridge"; readonly id: string; readonly accountingParentId: string | null };
export interface RotationRestart {
	readonly originalParents: Readonly<Record<string, string | null>>;
	readonly accounting: readonly RotationAccountingRow[];
	readonly firstMessage: string;
}
interface StoredRestart extends RotationRestart {
	readonly lines: readonly string[];
}
const restarts = new WeakMap<SessionRotation, StoredRestart>();
const checked = new WeakSet<SessionRotation>();
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const HEADER_BOUND = 64 * 1024;
const RECORD_BOUND = 1024 * 1024;

export function rotationOf(header: SessionHeader | null | undefined): SessionRotation | undefined {
	const r = header?.rotation;
	if (r === undefined) return undefined;
	if (checked.has(r)) return r;
	if (!header || !isRotatableSessionId(header.id)) throw new Error("Unsafe rotated session identity");
	if (
		!r ||
		r.version !== 1 ||
		!Number.isSafeInteger(r.segment) ||
		r.segment < 0 ||
		!Array.isArray(r.archives) ||
		!r.accounting ||
		!Number.isSafeInteger(r.accounting.messageCount) ||
		r.accounting.messageCount < 0 ||
		!r.restart ||
		r.restart.version !== 1 ||
		!Number.isSafeInteger(r.restart.count) ||
		r.restart.count < 0 ||
		typeof r.restart.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(r.restart.sha256) ||
		(r.restart.count === 0 && r.restart.sha256 !== EMPTY_SHA256) ||
		Object.hasOwn(r, "originalParents") ||
		Object.hasOwn(r.accounting, "assistants") ||
		Object.hasOwn(r.accounting, "firstMessage")
	)
		throw new Error("Invalid or unsupported session rotation header");
	if (
		r.parent !== undefined &&
		(!r.parent ||
			!isRotatableSessionId(r.parent.sessionId) ||
			typeof r.parent.leafId !== "string" ||
			!r.parent.leafId ||
			!Number.isSafeInteger(r.parent.segment) ||
			r.parent.segment < 0 ||
			!header.parentSession)
	)
		throw new Error("Invalid inherited session archive boundary");
	let previous = r.parent?.segment ?? -1;
	for (const ref of r.archives) {
		if (
			!ref ||
			!Number.isSafeInteger(ref.segment) ||
			ref.segment < 0 ||
			ref.segment >= r.segment ||
			ref.segment !== previous + 1 ||
			!Number.isSafeInteger(ref.bytes) ||
			ref.bytes <= 0 ||
			typeof ref.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(ref.sha256)
		)
			throw new Error("Invalid committed session archive lineage");
		previous = ref.segment;
	}
	if (previous !== r.segment - 1) throw new Error("Incomplete committed session archive lineage");
	if (!r.accounting.usage) throw new Error("Missing aggregate rotation accounting usage");
	validateUsage(r.accounting.usage);
	checked.add(r);
	return r;
}

/** Header-only probes check witness shape, never demand payload or archives. */
export function readSessionHeaderLineSync(path: string): string | undefined {
	const line = readFirstLineSync(path);
	let header: SessionHeader | undefined;
	try {
		header = JSON.parse(line ?? "null") as SessionHeader | undefined;
	} catch {
		return line;
	}
	if (header?.type === "session") rotationOf(header);
	return line;
}

export function assertSessionHeaderBound(header: SessionHeader): void {
	if (header.rotation && Buffer.byteLength(`${JSON.stringify(header)}\n`) >= HEADER_BOUND)
		throw new Error("Segmented session header exceeds the 64 KiB first-line bound");
}
export function restartOf(header: SessionHeader | null | undefined): StoredRestart | undefined {
	const r = rotationOf(header);
	if (!r) return undefined;
	const state = restarts.get(r);
	if (!state) throw new Error("Session rotation restart prefix has not been validated");
	return state;
}
export function rotationAssistants(header: SessionHeader | null | undefined): readonly RotationAssistantEntry[] {
	return (restartOf(header)?.accounting ?? []).flatMap((row) => (row.kind === "assistant" ? [row.entry] : []));
}
export function originalParent(entry: SessionEntry, restart: RotationRestart | undefined): string | null {
	return restart && Object.hasOwn(restart.originalParents, entry.id)
		? restart.originalParents[entry.id]
		: entry.parentId;
}

function validateUsage(usage: Usage): void {
	const u = usage;
	if (
		[
			u.input,
			u.output,
			u.cacheRead,
			u.cacheWrite,
			u.totalTokens,
			u.cost?.input,
			u.cost?.output,
			u.cost?.cacheRead,
			u.cost?.cacheWrite,
			u.cost?.total,
		].some((v) => typeof v !== "number" || !Number.isFinite(v))
	)
		throw new Error("Invalid rotation accounting usage");
}

function validateAssistant(entry: RotationAssistantEntry): void {
	if (
		!entry ||
		entry.type !== "message" ||
		typeof entry.id !== "string" ||
		!entry.id ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		entry.message?.role !== "assistant" ||
		!Array.isArray(entry.message.content) ||
		entry.message.content.length ||
		typeof entry.message.provider !== "string" ||
		typeof entry.message.model !== "string" ||
		!entry.message.usage
	)
		throw new Error("Invalid rotation accounting assistant");
	validateUsage(entry.message.usage);
}

export class RotationRestartReader {
	private readonly hash = createHash("sha256");
	private readonly lines: string[] = [];
	private readonly originalParents: Record<string, string | null> = Object.create(null);
	private readonly accounting: RotationAccountingRow[] = [];
	private readonly rowIds = new Set<string>();
	private firstMessage: string | undefined;
	private complete = false;
	private readonly rotation: SessionRotation | undefined;
	constructor(header: SessionHeader) {
		this.rotation = rotationOf(header);
	}
	read(line: Buffer, terminated = true): boolean {
		const r = this.rotation;
		if (!r || this.lines.length >= r.restart.count) return false;
		if (!terminated || line.length + 1 >= RECORD_BOUND)
			throw new Error("Invalid rotation restart line bound or termination");
		const text = line.toString("utf8");
		if (!Buffer.from(text).equals(line)) throw new Error("Rotation restart is not valid UTF-8");
		const value: unknown = JSON.parse(text);
		if (
			!value ||
			typeof value !== "object" ||
			!("type" in value) ||
			value.type !== "rotation_state" ||
			!("version" in value) ||
			value.version !== 1 ||
			!("segment" in value) ||
			value.segment !== r.segment ||
			!("index" in value) ||
			value.index !== this.lines.length ||
			!("kind" in value) ||
			!("data" in value) ||
			"id" in value ||
			"parentId" in value
		)
			throw new Error("Invalid rotation restart envelope");
		switch (value.kind) {
			case "cut_edges":
				if (!Array.isArray(value.data)) throw new Error("Invalid rotation cut edges");
				for (const edge of value.data) {
					if (
						!Array.isArray(edge) ||
						edge.length !== 2 ||
						typeof edge[0] !== "string" ||
						!edge[0] ||
						(edge[1] !== null && typeof edge[1] !== "string") ||
						Object.hasOwn(this.originalParents, edge[0])
					)
						throw new Error("Invalid or duplicate original session ancestry");
					this.originalParents[edge[0]] = edge[1];
				}
				break;
			case "accounting":
				if (!Array.isArray(value.data)) throw new Error("Invalid rotation accounting");
				for (const raw of value.data) {
					if (
						!raw ||
						typeof raw !== "object" ||
						(raw.kind !== "assistant" && raw.kind !== "bridge") ||
						(raw.accountingParentId !== null && typeof raw.accountingParentId !== "string")
					)
						throw new Error("Invalid rotation accounting ancestry");
					const row = raw as RotationAccountingRow;
					if (row.kind === "assistant") validateAssistant(row.entry);
					const id = row.kind === "assistant" ? row.entry.id : row.id;
					if (typeof id !== "string" || !id || this.rowIds.has(id))
						throw new Error("Duplicate or invalid rotation accounting row");
					this.rowIds.add(id);
					this.accounting.push(row);
				}
				break;
			case "preview":
				if (typeof value.data !== "string" || this.firstMessage !== undefined)
					throw new Error("Invalid or duplicate rotation preview");
				this.firstMessage = value.data;
				break;
			default:
				throw new Error("Unsupported rotation restart kind");
		}
		this.hash.update(line).update("\n");
		this.lines.push(text);
		if (this.lines.length === r.restart.count) this.finish();
		return true;
	}
	finish(): void {
		const r = this.rotation;
		if (!r || this.complete) return;
		if (this.lines.length !== r.restart.count || this.hash.digest("hex") !== r.restart.sha256)
			throw new Error("Incomplete or conflicting rotation restart prefix");
		const assistants = new Set(this.accounting.flatMap((row) => (row.kind === "assistant" ? [row.entry.id] : [])));
		const targets = new Set(Object.values(this.originalParents).filter((id) => id !== null && !assistants.has(id)));
		for (const row of this.accounting)
			if (row.kind === "bridge" && !targets.delete(row.id)) throw new Error("Unexpected rotation accounting bridge");
		if (targets.size) throw new Error("Missing rotation accounting bridge");
		restarts.set(r, {
			originalParents: this.originalParents,
			accounting: this.accounting,
			firstMessage: this.firstMessage ?? "",
			lines: this.lines,
		});
		this.complete = true;
	}
}

export function validateRotationEntries(header: SessionHeader, entries: readonly SessionEntry[]): void {
	const state = restartOf(header);
	if (!state) return;
	const index = new Map(entries.map((e) => [e.id, e]));
	const assistants = new Set(state.accounting.flatMap((r) => (r.kind === "assistant" ? [r.entry.id] : [])));
	const projected = new Map(
		state.accounting.map((r) => [r.kind === "assistant" ? r.entry.id : r.id, r.accountingParentId]),
	);
	const targets = new Set(Object.values(state.originalParents).filter((id) => id !== null && !assistants.has(id)));
	for (const [id, parent] of Object.entries(state.originalParents)) {
		if (!index.has(id) || index.get(id)!.parentId === parent)
			throw new Error("Invalid or unchanged rotation cut edge");
	}
	for (const row of state.accounting) {
		if (row.kind === "bridge" && !targets.delete(row.id)) throw new Error("Unexpected rotation accounting bridge");
		if (row.kind === "assistant" && index.has(row.entry.id))
			throw new Error("Conflicting retained rotation accounting assistant");
		const parent = row.accountingParentId;
		if (
			parent !== null &&
			!assistants.has(parent) &&
			!(
				index.get(parent)?.type === "message" &&
				(index.get(parent) as SessionMessageEntry).message.role === "assistant"
			)
		)
			throw new Error("Missing rotation accounting parent");
	}
	if (targets.size) throw new Error("Missing rotation accounting bridge");
	const complete = new Set<string>();
	for (const id of projected.keys()) {
		const path = new Set<string>();
		let next: string | null = id;
		while (next !== null && projected.has(next) && !complete.has(next)) {
			if (path.has(next)) throw new Error("Cyclic rotation accounting ancestry");
			path.add(next);
			next = projected.get(next)!;
		}
		for (const visited of path) complete.add(visited);
	}
}

export function withRotationRestart(header: SessionHeader, state: RotationRestart): SessionHeader {
	if (!header.rotation) throw new Error("Missing rotation header");
	const lines: string[] = [];
	function emit(kind: "cut_edges" | "accounting" | "preview", data: unknown): void {
		const line = JSON.stringify({
			type: "rotation_state",
			version: 1,
			segment: header.rotation!.segment,
			index: lines.length,
			kind,
			data,
		});
		if (Buffer.byteLength(line) + 1 >= RECORD_BOUND)
			throw new Error("Rotation restart record exceeds the 1 MiB line bound");
		lines.push(line);
	}
	function chunks(kind: "cut_edges" | "accounting", rows: readonly unknown[]): void {
		let chunk: unknown[] = [];
		let bytes = 256;
		for (const row of rows) {
			const size = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (bytes + size >= RECORD_BOUND && chunk.length) {
				emit(kind, chunk);
				chunk = [];
				bytes = 256;
			}
			chunk.push(row);
			bytes += size;
		}
		if (chunk.length) emit(kind, chunk);
	}
	chunks("cut_edges", Object.entries(state.originalParents));
	chunks("accounting", state.accounting);
	if (state.firstMessage) emit("preview", state.firstMessage);
	const hash = createHash("sha256");
	for (const line of lines) hash.update(`${line}\n`);
	const usage = emptyUsage();
	for (const row of state.accounting) if (row.kind === "assistant") addAssistantUsage(usage, row.entry.message.usage);
	const rotation: SessionRotation = {
		...header.rotation,
		accounting: { ...header.rotation.accounting, usage },
		restart: { version: 1, count: lines.length, sha256: hash.digest("hex") },
	};
	restarts.set(rotation, { ...state, lines });
	const result = { ...header, rotation };
	rotationOf(result);
	assertSessionHeaderBound(result);
	return result;
}

export function serializeSessionEntries(entries: readonly FileEntry[]): string {
	const header = entries[0];
	if (header?.type !== "session") throw new Error("Missing session header");
	assertSessionHeaderBound(header);
	validateRotationEntries(header, entries.slice(1) as SessionEntry[]);
	return `${[JSON.stringify(header), ...(restartOf(header)?.lines ?? []), ...entries.slice(1).map((e) => JSON.stringify(e))].join("\n")}\n`;
}

export function rotationUsageEntries(
	header: SessionHeader | null | undefined,
	branch: readonly SessionEntry[],
	allEntries: readonly SessionEntry[],
): readonly RotationAssistantEntry[] {
	const state = restartOf(header);
	if (!state) return [];
	const rows = new Map(state.accounting.map((r) => [r.kind === "assistant" ? r.entry.id : r.id, r]));
	if (branch === allEntries) return rotationAssistants(header);
	const index = new Map(allEntries.map((e) => [e.id, e]));
	const ids = new Set<string>();
	let id = branch.at(-1)?.id ?? null;
	while (id !== null) {
		if (ids.has(id)) throw new Error("Cyclic rotation accounting branch");
		ids.add(id);
		const row = rows.get(id);
		id = row ? row.accountingParentId : index.has(id) ? originalParent(index.get(id)!, state) : null;
	}
	return state.accounting.flatMap((r) => (r.kind === "assistant" && ids.has(r.entry.id) ? [r.entry] : []));
}

export function projectAccounting(
	header: SessionHeader,
	activeEntries: readonly SessionEntry[],
	assistants: ReadonlyMap<string, RotationAssistantEntry>,
	cutEdges: Readonly<Record<string, string | null>>,
	logicalParents?: ReadonlyMap<string, string | null>,
): RotationAccountingRow[] {
	const byId = new Map(activeEntries.map((entry) => [entry.id, entry]));
	const previous = restartOf(header);
	const projected = new Map(
		(previous?.accounting ?? []).map((row) => [
			row.kind === "assistant" ? row.entry.id : row.id,
			row.accountingParentId,
		]),
	);
	const previousAssistants = new Set(rotationAssistants(header).map((entry) => entry.id));
	const memo = new Map<string, string | null>();
	const nearest = (start: string | null): string | null => {
		let id = start;
		const visited = new Set<string>();
		while (id !== null) {
			const entry = byId.get(id);
			if (
				assistants.has(id) ||
				previousAssistants.has(id) ||
				(entry?.type === "message" && entry.message.role === "assistant")
			)
				break;
			if (memo.has(id)) {
				id = memo.get(id)!;
				break;
			}
			if (visited.has(id)) throw new Error("Cyclic projected accounting ancestry");
			visited.add(id);
			if (logicalParents?.has(id)) id = logicalParents.get(id)!;
			else if (projected.has(id)) id = projected.get(id)!;
			else if (entry) id = originalParent(entry, previous);
			else throw new Error(`Accounting ancestry is missing: ${id}`);
		}
		for (const node of visited) memo.set(node, id);
		return id;
	};
	const rows: RotationAccountingRow[] = [];
	for (const entry of assistants.values()) {
		const parent = logicalParents?.has(entry.id)
			? logicalParents.get(entry.id)!
			: projected.has(entry.id)
				? projected.get(entry.id)!
				: originalParent(entry, previous);
		rows.push({ kind: "assistant", entry, accountingParentId: nearest(parent) });
	}
	for (const id of new Set(Object.values(cutEdges)))
		if (id !== null && !assistants.has(id)) rows.push({ kind: "bridge", id, accountingParentId: nearest(id) });
	return rows;
}
