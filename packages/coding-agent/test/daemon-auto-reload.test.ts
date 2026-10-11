import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../src/core/kernel/index.js";
import type { ReloadInputSnapshot } from "../src/core/reload-inputs.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { DaemonAutoReloadScheduler, readAutoReloadSetting } from "../src/modes/daemon/daemon-auto-reload.js";
import { withClientEnv } from "../src/modes/daemon/daemon-client-env.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type {
	DaemonCommand,
	DaemonOutbound,
	DaemonUpdateRestartManifest,
} from "../src/modes/daemon/daemon-protocol.js";
import type { DaemonWorkerCommand } from "../src/modes/daemon/daemon-worker-protocol.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

const releases: Array<() => void> = [];
const waits: Promise<unknown>[] = [];
const roots: string[] = [],
	harnesses: Harness[] = [],
	schedulers: DaemonAutoReloadScheduler[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(waits.splice(0));
	for (const scheduler of schedulers.splice(0)) {
		await scheduler.stop();
		await scheduler.waitForReloads();
	}
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
const snapshot = (value: string): ReloadInputSnapshot => ({
	takenAt: 0,
	spec: { trees: [], candidates: [], settingsFiles: [] },
	entries: [],
	settings: [{ skills: [value] }],
	autoReloadable: true,
	diagnostics: [],
});
async function fixture(count = 1, readSetting?: () => ReturnType<typeof readAutoReloadSetting>) {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
	const root = mkdtempSync(join(tmpdir(), "daemon-reload-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	writeFileSync(settingsPath, '{"autoReload":"idle"}');
	let version = "changed";
	const sessions = new Map<string, ActiveSessionState>(),
		captured: Array<string | undefined> = [];
	const hs: Harness[] = [],
		loaders: ReturnType<typeof createTestResourceLoader>[] = [];
	for (let i = 0; i < count; i++) {
		let loaded = snapshot("loaded");
		const loader = createTestResourceLoader();
		loader.getReloadInputSnapshot = () => loaded;
		vi.spyOn(loader, "reload").mockImplementation(async () => {
			captured.push(process.env.HERDR_PANE_ID);
			loaded = snapshot(version);
		});
		const h = await createHarness({ tools: [], resourceLoader: loader });
		harnesses.push(h);
		hs.push(h);
		loaders.push(loader);
		sessions.set(String(i), {
			activeSessionId: String(i),
			runtime: { session: h.session, metadata: { kind: "top-level" } },
			clientEnv: { HERDR_PANE_ID: String(i) },
			clients: new Set(),
		} as unknown as ActiveSessionState);
	}
	const collect = vi.fn(async (_spec, _cache) => snapshot(version));
	const log = vi.fn();
	const scheduler = new DaemonAutoReloadScheduler({
		settingsPath,
		readSetting,
		sessions: () => sessions,
		isAvailable: () => true,
		collectInputs: collect,
		clock: { now: () => Date.now(), setInterval, clearInterval },
		log,
	});
	schedulers.push(scheduler);
	scheduler.start();
	async function checks() {
		await scheduler.check();
		await scheduler.check();
	}
	async function flush(count = 1) {
		for (let i = 0; i < count; i++) await scheduler.check();
		await scheduler.waitForReloads();
	}
	function set(value: unknown) {
		writeFileSync(settingsPath, JSON.stringify({ autoReload: value }));
	}
	function change(value: string) {
		version = value;
	}
	return { root, sessions, captured, loaders, hs, collect, log, scheduler, checks, flush, set, change };
}
function notices(h: Harness) {
	return h.session.messages
		.filter((m) => m.role === "custom" && m.customType === "runtime-auto-reload")
		.map(getMessageText);
}

function hold<T>(work: () => Promise<T>) {
	const entered = createDeferred<void>(),
		release = createDeferred<void>();
	releases.push(() => release.resolve());
	async function run() {
		entered.resolve();
		await release.promise;
		return work();
	}
	return { entered: entered.promise, release: () => release.resolve(), run };
}
function holdReload(f: Awaited<ReturnType<typeof fixture>>) {
	const block = hold(f.loaders[0]!.reload.bind(f.loaders[0]));
	vi.mocked(f.loaders[0]!.reload).mockImplementationOnce(block.run);
	return block;
}
function createDaemon(f: Awaited<ReturnType<typeof fixture>>) {
	return new AgentDaemon(join(f.root, "daemon.sock"), {
		defaultSessionConfig: { agentDir: f.root, cwd: f.root },
		createRuntime: async () => {
			throw new Error("unused");
		},
	}) as unknown as {
		autoReloadScheduler: DaemonAutoReloadScheduler;
		sessions: typeof f.sessions;
		log: (message: string) => void;
		closeSession: () => Promise<void>;
		shutdown: (code: number) => Promise<unknown>;
		prepareUpdateRestartCheckpoint: () => Promise<DaemonUpdateRestartManifest>;
		handleCommand: (client: DaemonSocketClient, command: DaemonCommand) => Promise<unknown>;
		handleWorkerCommand: (client: DaemonSocketClient, command: DaemonWorkerCommand) => Promise<void>;
		write: (client: DaemonSocketClient, message: unknown) => boolean;
		broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
	};
}
function daemonFor(f: Awaited<ReturnType<typeof fixture>>) {
	const daemon = createDaemon(f);
	daemon.autoReloadScheduler = f.scheduler;
	daemon.sessions = f.sessions;
	daemon.log = vi.fn();
	return daemon;
}

describe("daemon automatic reload", () => {
	it.each(["automatic", "command", "extension", "supervisor command", "private session command"] as const)(
		"TM-13 notifies capable clients after %s reload",
		async (path) => {
			const f = await fixture();
			await f.scheduler.stop();
			const d = createDaemon(f);
			d.sessions = f.sessions;
			const state = f.sessions.get("0")!;
			const clients = [true, true, false].map(
				(capable, i) =>
					({
						id: String(i),
						capabilities: new Set(capable ? ["runtime_reload_events"] : []),
						transport:
							(path === "supervisor command" || path === "private session command") && i === 1
								? "private-framed"
								: "jsonl",
						authenticationRole: path === "supervisor command" && i === 1 ? "supervisor" : "session_client",
					}) as DaemonSocketClient,
			);
			state.clients = new Set(clients);
			const deliveries: string[] = [];
			vi.spyOn(d, "write").mockImplementation((client, message) => {
				if ((message as DaemonOutbound).type === "session_runtime_reloaded") deliveries.push(client.id);
				return true;
			});
			if (path === "automatic") {
				schedulers.push(d.autoReloadScheduler);
				d.autoReloadScheduler.start();
				await d.autoReloadScheduler.check();
				await d.autoReloadScheduler.check();
				await d.autoReloadScheduler.waitForReloads();
			} else if (path === "extension") {
				Object.assign(state.runtime, {
					setRuntimeEnvScope: vi.fn(),
					setSubagentRuntimeHost: vi.fn(),
					setRebindSession: vi.fn(),
				});
				state.extensionUiRequests = new Map();
				const binding = vi.spyOn(f.hs[0]!.session, "bindExtensions");
				await bindActiveSessionState(state, { broadcast: d.broadcastToSession.bind(d), shutdown: () => {} });
				await binding.mock.calls[0]![0]!.commandContextActions!.reload();
			} else {
				await d.handleCommand(clients[1]!, { type: "reload", activeSessionId: "0" });
			}
			expect(deliveries).toEqual(path === "command" || path === "private session command" ? ["0"] : ["0", "1"]);
		},
	);

	it("TM-05 settles on the second tick, deduplicates and does not overlap checks", async () => {
		const f = await fixture(1, async () => ({ mode: "idle" }));
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.captured).toEqual([]);
		await vi.advanceTimersByTimeAsync(15_000);
		await f.scheduler.waitForReloads();
		await f.flush();
		expect(notices(f.hs[0]!)).toHaveLength(1);
		const scan = hold(async () => snapshot("changed"));
		f.collect.mockImplementationOnce(scan.run);
		const check = f.scheduler.check();
		waits.push(check);
		await scan.entered;
		const calls = f.collect.mock.calls.length;
		await f.scheduler.check();
		expect(f.collect).toHaveBeenCalledTimes(calls);
		scan.release();
		await check;
	});
	it.each([
		"isStreaming",
		"isCompacting",
		"isRetrying",
		"isBashRunning",
		"kernel background",
		"queuedActionCount",
		"next turn",
		"hasAcceptedPromptInFlight",
		"child",
	] as const)("TM-06 defers %s until the first idle check", async (busy) => {
		const f = await fixture(),
			session = f.hs[0]!.session;
		const blocker =
			busy === "child"
				? vi.spyOn(session, "hasRunningRlmChildren").mockReturnValue(true)
				: busy === "next turn"
					? vi
							.spyOn(session, "getPendingNextTurnMessageSnapshots")
							.mockReturnValue([
								{ role: "custom", customType: "fixture", content: "next", display: true, timestamp: 0 },
							])
					: busy === "kernel background"
						? vi.spyOn(session, "isSessionActive", "get").mockReturnValue(true)
						: busy === "queuedActionCount"
							? vi.spyOn(session, busy, "get").mockReturnValue(1)
							: vi.spyOn(session, busy, "get").mockReturnValue(true);
		await f.flush(2);
		expect(notices(f.hs[0]!)).toEqual([]);
		blocker.mockRestore();
		await f.flush();
		expect(notices(f.hs[0]!)).toHaveLength(1);
	});
	it.each(["busy", "replaced", "closed", "stop"] as const)(
		"TM-07 skips %s after acquiring the pause and releases input",
		async (change) => {
			const f = await fixture(),
				h = f.hs[0]!;
			const session = h.session as unknown as { _acquireSessionActionCommitFence(): Promise<{ release(): void }> };
			const block = hold(session._acquireSessionActionCommitFence.bind(session));
			vi.spyOn(session, "_acquireSessionActionCommitFence").mockImplementationOnce(block.run);
			const auto = vi.spyOn(h.session, "autoReload");
			await f.checks();
			await block.entered;
			const busy = vi.spyOn(h.session, "isStreaming", "get").mockReturnValue(change === "busy");
			if (change === "replaced") f.sessions.get("0")!.runtime = { session: {} } as ActiveSessionState["runtime"];
			if (change === "closed") f.sessions.delete("0");
			if (change === "stop") await f.scheduler.stop();
			block.release();
			await f.scheduler.waitForReloads();
			expect(await auto.mock.results[0]!.value).toBe("skipped");
			expect(f.loaders[0]!.reload).not.toHaveBeenCalled();
			busy.mockRestore();
			const api = getApiProvider(h.faux.api)!;
			registerApiProvider(api);
			h.setResponses([fauxAssistantMessage("input released")]);
			await h.session.prompt("after skip");
			expect(h.session.getLastAssistantText()).toBe("input released");
			if (change === "busy") {
				await f.flush();
				expect(notices(h)).toHaveLength(1);
			}
		},
	);
	it("TM-11 reports failure once and retries only a new settled digest", async () => {
		const f = await fixture();
		vi.mocked(f.loaders[0]!.reload).mockRejectedValueOnce(new Error("broken fixture"));
		await f.flush(2);
		await f.flush(2);
		expect(notices(f.hs[0]!)).toHaveLength(1);
		expect(notices(f.hs[0]!)[0]).toContain("broken fixture");
		expect(f.log.mock.calls.filter(([level]) => level === "error")).toHaveLength(1);
		f.change("new");
		await f.flush(2);
		expect(notices(f.hs[0]!)).toHaveLength(2);
	});
	it("TM-12 reads fresh, drops queued work, resets settling and deduplicates errors", async () => {
		const f = await fixture(2),
			block = holdReload(f);
		for (const mode of [undefined, "bad"]) {
			f.set(mode);
			await f.checks();
			expect(f.collect).not.toHaveBeenCalled();
		}
		f.set("idle");
		await f.scheduler.check();
		expect(f.captured).toEqual([]);
		await f.scheduler.check();
		await block.entered;
		f.set("off");
		await f.scheduler.check();
		block.release();
		await f.scheduler.waitForReloads();
		expect(f.captured).toEqual(["0"]);
		f.set("idle");
		await f.flush();
		expect(f.captured).toEqual(["0"]);
		await f.flush();
		expect(f.captured).toEqual(["0", "1"]);
		writeFileSync(join(f.root, "settings.json"), "{ malformed");
		await f.checks();
		expect(f.log.mock.calls.filter(([level]) => level === "error")).toHaveLength(2);
		expect(await readAutoReloadSetting(join(f.root, "settings.json"))).toMatchObject({ mode: "off" });
	});
	it("tm-stop invalidates an env-lock wait across restart", async () => {
		const f = await fixture(),
			block = hold(async () => {});
		const blocker = withClientEnv({ HERDR_PANE_ID: "manual" }, block.run);
		waits.push(blocker);
		await block.entered;
		await f.checks();
		await f.scheduler.stop();
		f.scheduler.start();
		block.release();
		await blocker;
		await f.scheduler.waitForReloads();
		expect(f.captured).toEqual([]);
		await f.flush(2);
		expect(f.captured).toEqual(["0"]);
	});
	it("tm-stop drops queued reloads without starting one", async () => {
		const f = await fixture();
		await f.scheduler.check();
		f.log.mockImplementationOnce((level) => {
			if (level === "debug") void f.scheduler.stop();
		});
		await f.flush();
		expect(f.captured).toEqual([]);
	});
	it.each(["direct", "archive"] as const)("tm-stop %s worker shutdown waits before teardown", async (path) => {
		const f = await fixture(),
			block = holdReload(f),
			d = daemonFor(f),
			h = f.hs[0]!;
		const state = f.sessions.get("0")!;
		state.clients = new Set();
		state.extensionUiRequests = new Map();
		const dispose = vi.fn(async () => h.session.dispose());
		state.runtime.dispose = dispose;
		const close = vi.spyOn(d, "closeSession"),
			archive = vi.spyOn(h.sessionManager, "appendSessionState");
		vi.spyOn(d, "write").mockReturnValue(true);
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("fixture exit");
		});
		const exited = createDeferred<void>(),
			shutdown = d.shutdown.bind(d);
		releases.push(() => exited.resolve());
		vi.spyOn(d, "shutdown").mockImplementation(async (code) => {
			try {
				await shutdown(code);
			} catch (error) {
				expect((error as Error).message).toBe("fixture exit");
			}
			exited.resolve();
		});
		await f.checks();
		await block.entered;
		const request =
			path === "direct"
				? d.shutdown(0)
				: d.handleWorkerCommand({} as DaemonSocketClient, { type: "worker_archive_and_shutdown" });
		waits.push(request);
		await vi.advanceTimersByTimeAsync(90_001);
		for (const effect of [close, archive, dispose]) expect(effect).not.toHaveBeenCalled();
		expect(f.log.mock.calls.filter(([level]) => level === "warn")).toHaveLength(3);
		block.release();
		await request;
		await exited.promise;
		for (const effect of [close, dispose, process.exit]) expect(effect).toHaveBeenCalledOnce();
		if (path === "archive") expect(archive).toHaveBeenCalledWith({ status: "archived" });
	});
	it.each([85_000, undefined])(
		"tm-stop update reports its reload blocker at budget %s and recovers",
		async (budget) => {
			const f = await fixture(),
				block = holdReload(f),
				d = daemonFor(f);
			const checkpoint = vi
				.spyOn(d, "prepareUpdateRestartCheckpoint")
				.mockResolvedValue({ formatVersion: 1, createdAt: "now", sessions: [] });
			const write = vi.spyOn(d, "write").mockReturnValue(true),
				restart = vi.spyOn(f.scheduler, "start");
			await f.checks();
			await block.entered;
			const request = d.handleWorkerCommand({} as DaemonSocketClient, {
				type: "worker_prepare_update",
				...(budget === undefined ? {} : { checkpointTimeoutMs: budget }),
			});
			waits.push(request);
			await vi.advanceTimersByTimeAsync((budget ?? 90_000) - 1);
			expect(write).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(write).toHaveBeenCalledOnce();
			await request;
			expect(write.mock.calls[0]![1]).toMatchObject({
				success: false,
				error: expect.stringContaining("automatic reload of 0"),
			});
			expect(checkpoint).not.toHaveBeenCalled();
			expect(restart).toHaveBeenCalledOnce();
			await f.checks();
			expect(f.loaders[0]!.reload).toHaveBeenCalledOnce();
			expect(f.captured).toEqual([]);
			block.release();
			await f.scheduler.waitForReloads();
			f.change("later");
			await f.flush(2);
			await f.flush();
			expect(notices(f.hs[0]!)).toHaveLength(2);
			expect(f.captured).toEqual(["0", "0"]);
			expect(restart).toHaveBeenCalledOnce();
		},
	);
	it("TM-17 overlaps automatic and manual reload under separate client envs", async () => {
		const f = await fixture(2);
		const loader = new DefaultResourceLoader({
			cwd: f.root,
			agentDir: f.root,
			bundledSkillsDir: null,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [
				() => {
					f.captured.push(process.env.HERDR_PANE_ID);
				},
			],
		});
		for (const resource of f.loaders) {
			const reload = vi.mocked(resource.reload).getMockImplementation()!;
			vi.mocked(resource.reload).mockImplementation(async () => {
				await loader.reload();
				await reload();
				f.captured.pop();
			});
		}
		const block = holdReload(f);
		const d = daemonFor(f);
		await f.checks();
		await block.entered;
		const manual = d.handleCommand({} as DaemonSocketClient, { type: "reload", activeSessionId: "1" });
		waits.push(manual);
		block.release();
		await manual;
		await f.scheduler.waitForReloads();
		expect(f.captured).toEqual(["0", "1", "1"]);
		expect(f.hs.map(notices).map((n) => n.length)).toEqual([1, 1]);
	});
	it("unsafe scans never queue", async () => {
		const f = await fixture();
		f.collect.mockResolvedValue({
			...snapshot("changed"),
			autoReloadable: false,
			diagnostics: ["unreadable fixture"],
		});
		await f.flush(2);
		expect(f.captured).toEqual([]);
		expect(f.log.mock.calls.filter(([level]) => level === "warn")).toEqual([["warn", "unreadable fixture"]]);
	});
});
