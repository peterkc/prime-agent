import { readFile } from "node:fs/promises";
import type { AgentSession } from "../../core/agent-session.js";
import { PromptAdmissionCancelledError, waitForPromptAdmission } from "../../core/prompt-admission.js";
import {
	collectReloadInputs,
	createReloadInputScanCache,
	digestReloadInputs,
	RELOAD_AREAS,
	type ReloadArea,
	type ReloadDigests,
} from "../../core/reload-inputs.js";
import type { ActiveSessionState } from "./active-session-state.js";
import { withClientEnv } from "./daemon-client-env.js";
import { hasLiveSessionWork } from "./daemon-session-list.js";

const CHECK_INTERVAL_MS = 15_000;
const STOP_WARNING_INTERVAL_MS = 30_000;
type AutoReloadMode = "off" | "idle";
export interface AutoReloadSetting {
	readonly mode: AutoReloadMode;
	readonly error?: string;
}

export async function readAutoReloadSetting(path: string): Promise<AutoReloadSetting> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { mode: "off", error: "Global settings must be a JSON object" };
		}
		const setting = "autoReload" in value ? value.autoReload : undefined;
		if (setting === undefined || setting === "off") return { mode: "off" };
		if (setting === "idle") return { mode: "idle" };
		return { mode: "off", error: 'Invalid autoReload setting; expected "off" or "idle"' };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { mode: "off" };
		}
		return { mode: "off", error: error instanceof Error ? error.message : String(error) };
	}
}

function sameDigests(left: ReloadDigests | undefined, right: ReloadDigests): boolean {
	return left !== undefined && RELOAD_AREAS.every((area) => left[area] === right[area]);
}

export function decide(input: {
	readonly loaded: ReloadDigests;
	readonly current: ReloadDigests;
	readonly previous: ReloadDigests | undefined;
	readonly failed: ReloadDigests | undefined;
	readonly idle: boolean;
	readonly autoReloadable: boolean;
}): readonly ReloadArea[] {
	if (
		!input.idle ||
		!input.autoReloadable ||
		!sameDigests(input.previous, input.current) ||
		sameDigests(input.failed, input.current)
	)
		return [];
	return RELOAD_AREAS.filter((area) => input.loaded[area] !== input.current[area]);
}

export interface AutoReloadClock {
	readonly now: () => number;
	readonly setInterval: typeof setInterval;
	readonly clearInterval: typeof clearInterval;
}
interface AutoReloadOptions {
	readonly settingsPath: string;
	readonly sessions: () => ReadonlyMap<string, ActiveSessionState>;
	readonly isAvailable: (state: ActiveSessionState) => boolean;
	readonly log: (level: "debug" | "warn" | "error", message: string, details?: { durationMs: number }) => void;
	readonly onReloaded?: (state: ActiveSessionState) => void;
	readonly readSetting?: () => Promise<AutoReloadSetting>;
	readonly collectInputs?: typeof collectReloadInputs;
	readonly clock?: AutoReloadClock;
}
interface QueuedReload {
	readonly activeSessionId: string;
	readonly session: AgentSession;
	readonly runId: symbol;
	readonly enabledId: symbol;
	readonly digests: ReloadDigests;
	readonly changedAreas: readonly ReloadArea[];
}
interface ActiveReload {
	readonly job: QueuedReload;
	readonly done: Promise<void>;
	readonly phase: "waiting" | "running";
}

/** One queue per daemon; the session owns the input pause and reload serialization. */
export class DaemonAutoReloadScheduler {
	private readonly clock: AutoReloadClock;
	private interval?: ReturnType<typeof setInterval>;
	private runId?: symbol;
	private enabledId?: symbol;
	private checking = false;
	private readonly previous = new Map<AgentSession, ReloadDigests>();
	private readonly failed = new WeakMap<AgentSession, ReloadDigests>();
	private readonly reportedErrors = new Set<string>();
	private readonly pending = new Set<AgentSession>();
	private readonly queue: QueuedReload[] = [];
	private active?: ActiveReload;
	private draining?: Promise<void>;
	private stopping?: Promise<void>;

	constructor(private readonly options: AutoReloadOptions) {
		this.clock = options.clock ?? { now: () => performance.now(), setInterval, clearInterval };
	}

	start(): void {
		if (this.runId) return;
		this.runId = Symbol("auto-reload-run");
		this.interval = this.clock.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
		this.interval.unref();
	}

	async stop(signal?: AbortSignal): Promise<void> {
		this.runId = undefined;
		this.disable();
		if (this.interval) this.clock.clearInterval(this.interval);
		this.interval = undefined;
		const active = this.active;
		// A wait for the env lock or session fence has not started a reload body.
		if (active?.phase !== "running") return;
		this.stopping ??= this.waitForRunningReload(active);
		try {
			await waitForPromptAdmission(this.stopping, signal);
		} catch (error) {
			if (error instanceof PromptAdmissionCancelledError) {
				throw new Error(`Waiting for automatic reload of ${active.job.activeSessionId} was cancelled.`, {
					cause: error,
				});
			}
			throw error;
		}
	}

	private async waitForRunningReload(active: ActiveReload): Promise<void> {
		const warning = this.clock.setInterval(
			() => this.options.log("warn", `Waiting for automatic reload of ${active.job.activeSessionId} to finish`),
			STOP_WARNING_INTERVAL_MS,
		);
		warning.unref();
		try {
			await active.done;
		} finally {
			this.clock.clearInterval(warning);
			this.stopping = undefined;
		}
	}

	/** Completion signal for the current queue, without making checks wait for it. */
	waitForReloads(): Promise<void> {
		return this.draining ?? Promise.resolve();
	}

	private disable(): void {
		this.enabledId = undefined;
		this.previous.clear();
		for (const job of this.queue) this.pending.delete(job.session);
		this.queue.length = 0;
	}

	private isIdle(job: QueuedReload): boolean {
		const state = this.options.sessions().get(job.activeSessionId);
		return (
			this.runId === job.runId &&
			this.enabledId === job.enabledId &&
			state !== undefined &&
			state.runtime.session === job.session &&
			this.options.isAvailable(state) &&
			!hasLiveSessionWork(state) &&
			job.session.queuedActionCount === 0 &&
			job.session.getPendingNextTurnMessageSnapshots().length === 0 &&
			!job.session.hasAcceptedPromptInFlight &&
			!job.session.isRetrying
		);
	}

	async check(): Promise<void> {
		const runId = this.runId;
		if (!runId || this.checking) return;
		this.checking = true;
		const began = this.clock.now();
		try {
			const setting = await (this.options.readSetting?.() ?? readAutoReloadSetting(this.options.settingsPath));
			if (this.runId !== runId) return;
			if (setting.error && !this.reportedErrors.has(setting.error)) {
				this.reportedErrors.add(setting.error);
				this.options.log("error", `Automatic reload settings: ${setting.error}`);
			}
			if (setting.mode === "off") {
				this.disable();
				return;
			}
			this.enabledId ??= Symbol("auto-reload-enabled");
			const enabledId = this.enabledId;
			const cache = createReloadInputScanCache();
			const sessions = [...this.options.sessions().values()];
			const live = new Set(sessions.map((state) => state.runtime.session));
			for (const session of this.previous.keys()) if (!live.has(session)) this.previous.delete(session);
			for (const state of sessions) {
				const session = state.runtime.session;
				const record = session.loadRecord;
				if (this.pending.has(session) || !this.options.isAvailable(state) || !record) continue;
				const snapshot = await (this.options.collectInputs ?? collectReloadInputs)(record.snapshot.spec, cache);
				if (this.runId !== runId || this.enabledId !== enabledId) return;
				const digests = digestReloadInputs(snapshot);
				const job: QueuedReload = {
					activeSessionId: state.activeSessionId,
					session,
					runId,
					enabledId,
					digests,
					changedAreas: [],
				};
				const changedAreas = decide({
					loaded: session.loadRecord?.digests ?? record.digests,
					current: digests,
					previous: this.previous.get(session),
					failed: this.failed.get(session),
					idle: this.isIdle(job),
					autoReloadable: record.snapshot.autoReloadable && snapshot.autoReloadable,
				});
				if (snapshot.autoReloadable) this.previous.set(session, digests);
				else {
					this.previous.delete(session);
					for (const diagnostic of snapshot.diagnostics) {
						if (this.reportedErrors.has(diagnostic)) continue;
						this.reportedErrors.add(diagnostic);
						this.options.log("warn", diagnostic);
					}
				}
				if (changedAreas.length === 0) continue;
				this.queue.push({ ...job, changedAreas });
				this.pending.add(session);
			}
		} catch (error) {
			this.options.log(
				"error",
				`Automatic reload check failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.checking = false;
			this.options.log("debug", "Automatic reload check", { durationMs: this.clock.now() - began });
			if (this.runId && this.queue.length > 0 && !this.draining) this.draining = this.drainQueue();
		}
	}

	private async drainQueue(): Promise<void> {
		await Promise.resolve();
		try {
			while (this.runId && this.queue.length > 0) {
				const job = this.queue.shift()!;
				let complete = () => {};
				const done = new Promise<void>((resolve) => {
					complete = resolve;
				});
				this.active = { job, done, phase: "waiting" };
				try {
					const state = this.options.sessions().get(job.activeSessionId);
					if (!state || state.runtime.session !== job.session || !this.isIdle(job)) continue;
					const result = await withClientEnv(state.clientEnv, () =>
						job.session.autoReload({
							changedAreas: job.changedAreas,
							isIdle: () => {
								if (!this.isIdle(job)) return false;
								this.active = { job, done, phase: "running" };
								return true;
							},
						}),
					);
					if (result === "reloaded") this.options.onReloaded?.(state);
				} catch (error) {
					this.failed.set(job.session, job.digests);
					this.options.log(
						"error",
						`Automatic reload of ${job.activeSessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					this.pending.delete(job.session);
					this.active = undefined;
					complete();
				}
			}
		} finally {
			this.draining = undefined;
		}
	}
}
