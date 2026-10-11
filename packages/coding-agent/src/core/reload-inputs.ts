import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SettingsManager } from "./settings-manager.js";

export const RELOAD_AREAS = [
	"settings",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"context files",
	"system prompt",
] as const;
export type ReloadArea = (typeof RELOAD_AREAS)[number];
export const RELOAD_SETTINGS_KEYS = [
	"packages",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"enableSkillCommands",
	"enableBuiltinSkills",
	"bundledSkills",
	"codemode",
	"codemodeOpenAPI",
	"codemodeExcludeTools",
	"mcpServers",
	"mcpCatalogSources",
	"shellPath",
	"shellCommandPrefix",
] as const;
export const RELOAD_INPUT_ENTRY_LIMIT = 20_000;
const MAX_DEPTH = 12;
const EXCLUDED = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

export interface ReloadInputPath {
	readonly path: string;
	readonly areas: readonly ReloadArea[];
}
export interface ReloadInputSpec {
	readonly trees: readonly ReloadInputPath[];
	readonly candidates: readonly ReloadInputPath[];
	readonly settingsFiles: readonly string[];
}
export type ReloadPathState =
	| { readonly state: "present"; readonly size: number; readonly mtimeMs: number; readonly directory: boolean }
	| { readonly state: "absent" }
	| { readonly state: "unreadable"; readonly error: string };
export interface ReloadInputEntry extends ReloadInputPath {
	readonly value: ReloadPathState;
}
export interface ReloadInputSnapshot {
	readonly takenAt: number;
	readonly spec: ReloadInputSpec;
	readonly entries: readonly ReloadInputEntry[];
	readonly settings: readonly Readonly<Record<string, unknown>>[];
	readonly autoReloadable: boolean;
	readonly diagnostics: readonly string[];
}
export type ReloadDigests = Readonly<Record<ReloadArea, string>>;
export interface ReloadLoadRecord {
	readonly digests: ReloadDigests;
	readonly snapshot: ReloadInputSnapshot;
}

/** One scan can share filesystem results across sessions, but never across checks. */
export interface ReloadInputScanCache {
	readonly states: Map<string, Promise<ReloadPathState>>;
	readonly directories: Map<string, Promise<readonly string[]>>;
	readonly settings: Map<string, Promise<Readonly<Record<string, unknown>>>>;
}
export function createReloadInputScanCache(): ReloadInputScanCache {
	return { states: new Map(), directories: new Map(), settings: new Map() };
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
async function readPathState(path: string): Promise<ReloadPathState> {
	try {
		const info = await stat(path);
		await access(path, constants.R_OK);
		return { state: "present", size: info.size, mtimeMs: info.mtimeMs, directory: info.isDirectory() };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return { state: "absent" };
		}
		return { state: "unreadable", error: errorMessage(error) };
	}
}
function pathState(path: string, cache: ReloadInputScanCache): Promise<ReloadPathState> {
	let pending = cache.states.get(path);
	if (!pending) {
		pending = readPathState(path);
		cache.states.set(path, pending);
	}
	return pending;
}
function directoryEntries(path: string, cache: ReloadInputScanCache): Promise<readonly string[]> {
	let pending = cache.directories.get(path);
	if (!pending) {
		pending = readdir(path);
		cache.directories.set(path, pending);
	}
	return pending;
}
function reloadSettings(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return Object.fromEntries(RELOAD_SETTINGS_KEYS.map((key) => [key, settings[key]]));
}
async function readSettings(path: string): Promise<Readonly<Record<string, unknown>>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid settings: ${path}`);
		return reloadSettings({ ...SettingsManager.migrateSettings({ ...value }) });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

export async function collectReloadInputs(
	spec: ReloadInputSpec,
	cache: ReloadInputScanCache = createReloadInputScanCache(),
	loadedSettings?: readonly Readonly<Record<string, unknown>>[],
	baseline?: ReloadInputSnapshot,
): Promise<ReloadInputSnapshot> {
	const takenAt = Date.now();
	const entries = new Map<string, ReloadInputEntry>(baseline?.entries.map((entry) => [entry.path, entry]));
	const diagnostics = new Set<string>(baseline?.diagnostics);
	let limitReached = false;
	async function visit(input: ReloadInputPath, depth: number, tree: boolean): Promise<void> {
		const path = resolve(input.path);
		const previous = entries.get(path);
		if (!previous && entries.size >= RELOAD_INPUT_ENTRY_LIMIT) {
			limitReached = true;
			diagnostics.add(`Reload inventory exceeds ${RELOAD_INPUT_ENTRY_LIMIT} entries; automatic reload is disabled.`);
			return;
		}
		const value = previous?.value ?? (await pathState(path, cache));
		const areas = [...new Set([...(previous?.areas ?? []), ...input.areas])].sort();
		entries.set(path, { path, areas, value });
		if (value.state === "unreadable") diagnostics.add(`Unreadable reload input ${path}: ${value.error}`);
		if (!tree || value.state !== "present" || !value.directory) return;
		try {
			const names = (await directoryEntries(path, cache))
				.filter((name) => !name.startsWith(".") && !EXCLUDED.has(name))
				.sort();
			if (depth === MAX_DEPTH) {
				if (names.length > 0)
					diagnostics.add(`Reload inventory exceeds depth ${MAX_DEPTH} at ${path}; automatic reload is disabled.`);
				return;
			}
			for (const name of names) {
				await visit({ path: join(path, name), areas: input.areas }, depth + 1, true);
				if (limitReached) break;
			}
		} catch (error) {
			entries.set(path, { path, areas, value: { state: "unreadable", error: errorMessage(error) } });
			diagnostics.add(`Unreadable reload input ${path}: ${errorMessage(error)}`);
		}
	}
	for (const input of spec.trees) {
		await visit(input, 0, true);
		if (limitReached) break;
	}
	for (const input of spec.candidates) await visit(input, 0, false);
	for (const path of spec.settingsFiles) await visit({ path, areas: [] }, 0, false);
	const settings: Readonly<Record<string, unknown>>[] = [];
	if (loadedSettings) {
		settings.push(...loadedSettings.map(reloadSettings));
	} else {
		for (const path of spec.settingsFiles) {
			try {
				let pending = cache.settings.get(path);
				if (!pending) {
					pending = readSettings(path);
					cache.settings.set(path, pending);
				}
				settings.push(await pending);
			} catch (error) {
				diagnostics.add(`Unreadable reload settings ${path}: ${errorMessage(error)}`);
			}
		}
	}
	return {
		takenAt: baseline?.takenAt ?? takenAt,
		spec: baseline ? { ...baseline.spec, trees: [...baseline.spec.trees, ...spec.trees] } : spec,
		entries: [...entries.values()],
		settings: baseline?.settings ?? settings,
		autoReloadable: diagnostics.size === 0,
		diagnostics: [...diagnostics],
	};
}

/** Add discovered inputs without re-reading the pre-load baseline. */
export async function addReloadInputs(
	snapshot: ReloadInputSnapshot,
	trees: readonly ReloadInputPath[],
): Promise<ReloadInputSnapshot> {
	return collectReloadInputs({ trees, candidates: [], settingsFiles: [] }, undefined, [], snapshot);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
export function digestReloadInputs(snapshot: ReloadInputSnapshot): ReloadDigests {
	const digests = {} as Record<ReloadArea, string>;
	for (const area of RELOAD_AREAS) {
		const values =
			area === "settings"
				? snapshot.settings
				: snapshot.entries
						.filter((entry) => entry.areas.includes(area))
						.map((entry) => ({ path: entry.path, value: entry.value }))
						.sort((a, b) => a.path.localeCompare(b.path));
		digests[area] = createHash("sha256").update(stableJson(values)).digest("hex");
	}
	return digests;
}
