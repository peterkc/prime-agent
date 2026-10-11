import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionBusyError } from "../../src/core/agent-session.js";
import { AgentCronJobStore } from "../../src/core/cron-jobs.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import { createDeferred, type HostRequestHandlers } from "../../src/core/kernel/index.js";
import { collectReloadInputs, digestReloadInputs, type ReloadLoadRecord } from "../../src/core/reload-inputs.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.js";

const harnesses: Harness[] = [],
	roots: string[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
async function currentDigests(record: ReloadLoadRecord) {
	return digestReloadInputs(await collectReloadInputs(record.snapshot.spec));
}
function makeLoader(root: string, factory: ExtensionFactory): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		bundledSkillsDir: null,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [factory],
	});
}
async function fixture(shutdownSend = false) {
	const root = mkdtempSync(join(tmpdir(), "session-reload-"));
	roots.push(root);
	writeFileSync(join(root, "AGENTS.md"), "old instructions");
	const lifecycle: string[] = [];
	const compactEntered = createDeferred<void>(),
		compactRelease = createDeferred<void>();
	const loader = makeLoader(root, (pi) => {
		pi.on("session_start", (event) => void lifecycle.push(`start:${event.reason}`));
		pi.on("session_shutdown", (event) => {
			lifecycle.push(`shutdown:${event.reason}`);
			if (shutdownSend) pi.sendUserMessage("shutdown");
		});
		pi.on("session_before_compact", async (event) => {
			compactEntered.resolve();
			await compactRelease.promise;
			return {
				compaction: {
					summary: "compacted",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	});
	await loader.reload();
	const h = await createHarness({
		tools: [],
		resourceLoader: loader,
		settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 25 } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ shutdownHandler: () => {} });
	const entered = createDeferred<void>(),
		release = createDeferred<void>();
	const originalReload = loader.reload.bind(loader);
	const api = getApiProvider(h.faux.api)!;
	const original = async () => {
		await originalReload();
		registerApiProvider(api);
	};
	let calls = 0;
	vi.spyOn(loader, "reload").mockImplementation(async () => {
		calls++;
		if (calls === 1) {
			registerApiProvider(api);
			entered.resolve();
			await release.promise;
		}
		await original();
	});
	return { h, root, loader, lifecycle, entered, release, original, compactEntered, compactRelease };
}
function responses(h: Harness): string[] {
	const systems: string[] = [];
	h.setResponses(
		Array.from({ length: 8 }, () => (context) => {
			systems.push(context.systemPrompt ?? "");
			return fauxAssistantMessage("done");
		}),
	);
	return systems;
}
interface KernelSession {
	_ipythonKernelProvisioner: IpythonKernelProvisioner;
	_createKernelHostHandlers(): HostRequestHandlers;
}
describe("AgentSession guarded reload", () => {
	it.each([false, true])("TM-01 serializes callers and releases input after first failure=%s", async (fail) => {
		const f = await fixture();
		if (fail)
			vi.mocked(f.loader.reload).mockImplementationOnce(async () => {
				f.entered.resolve();
				await f.release.promise;
				throw new Error("first load failed");
			});
		const first = f.h.session.reload().then(
			() => "ok",
			(error: Error) => error.message,
		);
		let second: Promise<void> | undefined;
		try {
			await f.entered.promise;
			second = f.h.session.reload();
			expect(f.lifecycle).toEqual(["start:startup", "shutdown:reload"]);
			f.release.resolve();
			expect(await first).toBe(fail ? "first load failed" : "ok");
			await second;
			expect(f.lifecycle).toEqual(
				fail
					? ["start:startup", "shutdown:reload", "shutdown:reload", "start:reload"]
					: ["start:startup", "shutdown:reload", "start:reload", "shutdown:reload", "start:reload"],
			);
			f.h.setResponses([fauxAssistantMessage("after reload")]);
			await f.h.session.prompt("after");
			await f.h.session.waitForIdle();
			expect(f.h.session.hasPendingAdmissionWaiters).toBe(false);
		} finally {
			f.release.resolve();
			await first;
			await second;
		}
	});
	it("TM-02 holds direct, follow-up, agent-message and shutdown input on the new runtime", async () => {
		const f = await fixture(true),
			systems = responses(f.h),
			reload = f.h.session.reload();
		try {
			await f.entered.promise;
			writeFileSync(join(f.root, "AGENTS.md"), "new instructions");
			const prompt = f.h.session.prompt("direct");
			await f.h.session.followUp("follow");
			const message = f.h.session.acceptAgentMessagePrompt("agent", {
				streamingBehavior: "steer",
				queueIfBusy: true,
			});
			expect(systems).toEqual([]);
			f.release.resolve();
			await reload;
			await Promise.all([prompt, message]);
			await f.h.session.waitForIdle();
			expect(getUserTexts(f.h).sort()).toEqual(["agent", "direct", "follow", "shutdown"]);
			expect(systems.length).toBeGreaterThan(0);
			expect(systems.every((system) => system.includes("new instructions"))).toBe(true);
		} finally {
			f.release.resolve();
			await reload;
		}
	});
	it("TM-03 holds heartbeat and bash completion, preserving delivery priority and FIFO", async () => {
		const f = await fixture(),
			systems = responses(f.h),
			reload = f.h.session.reload();
		try {
			await f.entered.promise;
			writeFileSync(join(f.root, "AGENTS.md"), "new background instructions");
			const heartbeat = await new AgentCronJobStore(join(f.root, "cron.json")).create({
				source: "heartbeat",
				activeSessionId: "a",
				sessionId: "s",
				sessionFile: join(f.root, "session.jsonl"),
				cwd: f.root,
				prompt: "heartbeat payload",
				scheduleText: "every 5m",
			});
			const hb = f.h.session.promptHeartbeat(heartbeat, { streamingBehavior: "followUp" });
			const handlers = (f.h.session as unknown as KernelSession)._createKernelHostHandlers();
			const bash = handlers["bash.completed"]!({ pid: 42, command: "printf done", exitCode: 0 });
			await f.h.session.followUp("background follow", undefined, { priority: "background" });
			await f.h.session.followUp("human follow", undefined, { priority: "user" });
			await f.h.session.steer("steer first");
			await f.h.session.steer("steer second");
			expect(systems).toEqual([]);
			f.release.resolve();
			await reload;
			await Promise.all([hb, bash]);
			await f.h.session.waitForIdle();
			expect(systems.length).toBeGreaterThan(0);
			expect(systems.every((system) => system.includes("new background instructions"))).toBe(true);
			const texts = f.h.session.messages
				.filter(
					(m) =>
						m.role === "user" ||
						(m.role === "custom" && ["heartbeat_prompt", "async_bash_completion"].includes(m.customType)),
				)
				.map(getMessageText);
			expect(getUserTexts(f.h)).toEqual(["steer first", "steer second", "human follow", "background follow"]);
			expect(texts.filter((text) => text.includes("heartbeat payload"))).toHaveLength(1);
			expect(texts.filter((text) => text.includes("printf done"))).toHaveLength(1);
		} finally {
			f.release.resolve();
			await reload;
		}
	});
	it.each(["streaming", "compacting", "retrying"] as const)(
		"tm-busy-manual refuses %s without lifecycle effects",
		async (state) => {
			const f = await fixture();
			f.release.resolve();
			const entered = createDeferred<void>(),
				release = createDeferred<void>();
			let work: Promise<unknown>;
			if (state === "compacting") {
				f.h.setResponses([fauxAssistantMessage("prior context")]);
				await f.h.session.prompt("old context ".repeat(80));
				work = f.h.session.compact();
				await f.compactEntered.promise;
			} else if (state === "streaming") {
				f.h.setResponses([
					async () => {
						entered.resolve();
						await release.promise;
						return fauxAssistantMessage("still usable");
					},
				]);
				work = f.h.session.prompt("busy");
				await entered.promise;
			} else {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				f.h.session.subscribe((event) => {
					if (event.type === "auto_retry_start") entered.resolve();
				});
				f.h.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
					fauxAssistantMessage("recovered"),
				]);
				work = f.h.session.prompt("retry");
				await entered.promise;
				await f.h.session.agent.waitForIdle();
				expect(f.h.session.isStreaming).toBe(false);
			}
			try {
				const property =
					state === "streaming" ? "isStreaming" : state === "compacting" ? "isCompacting" : "isRetrying";
				expect(f.h.session[property]).toBe(true);
				await expect(f.h.session.reload()).rejects.toBeInstanceOf(SessionBusyError);
				expect(f.lifecycle).toEqual(["start:startup"]);
			} finally {
				release.resolve();
				f.compactRelease.resolve();
				if (state === "retrying")
					await vi.advanceTimersByTimeAsync(f.h.eventsOfType("auto_retry_start")[0].delayMs + 1);
				await work;
			}
			if (state === "retrying") {
				expect(f.h.faux.state.callCount).toBe(2);
				expect(f.h.eventsOfType("auto_retry_end")[0].success).toBe(true);
				expect(f.h.session.getLastAssistantText()).toBe("recovered");
			} else if (state === "compacting") expect(f.h.eventsOfType("compaction_end")[0].aborted).toBe(false);
			else expect(f.h.session.getLastAssistantText()).toBe("still usable");
		},
	);
	it("TM-16 retains the before-content snapshot, detects startup changes, and keeps records after throw or skip", async () => {
		const root = mkdtempSync(join(tmpdir(), "reload-record-"));
		roots.push(root);
		const path = join(root, "AGENTS.md");
		writeFileSync(path, "before load");
		const gate = createDeferred<void>(),
			entered = createDeferred<void>();
		let gateNext = false;
		const extra = join(root, "extra.md");
		writeFileSync(extra, "extra prompt");
		const loader = makeLoader(root, async (pi) => {
			pi.on("resources_discover", () => ({ promptPaths: [extra] }));
			if (gateNext) {
				entered.resolve();
				await gate.promise;
			}
		});
		await loader.reload();
		const h = await createHarness({ tools: [], resourceLoader: loader });
		harnesses.push(h);
		const startup = h.session.loadRecord!;
		writeFileSync(path, "after startup");
		await h.session.bindExtensions({ shutdownHandler: () => {} });
		expect(h.session.loadRecord!.digests["context files"]).toBe(startup.digests["context files"]);
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("extra");
		writeFileSync(extra, "changed discovered prompt");
		expect((await currentDigests(h.session.loadRecord!)).prompts).not.toBe(h.session.loadRecord!.digests.prompts);
		expect((await currentDigests(startup))["context files"]).not.toBe(startup.digests["context files"]);
		gateNext = true;
		const reload = h.session.reload();
		try {
			await entered.promise;
			writeFileSync(path, "edited during load");
			gate.resolve();
			await reload;
			const loaded = h.session.loadRecord!;
			expect(h.session.systemPrompt).toContain("edited during load");
			expect((await currentDigests(loaded))["context files"]).not.toBe(loaded.digests["context files"]);
			gateNext = false;
			expect(await h.session.autoReload({ changedAreas: ["context files"], isIdle: () => true })).toBe("reloaded");
			const settled = h.session.loadRecord!;
			expect(settled).not.toBe(loaded);
			expect(await currentDigests(settled)).toEqual(settled.digests);
			const original = loader.reload.bind(loader);
			vi.spyOn(loader, "reload").mockImplementation(async () => {
				await original();
				throw new Error("load failed");
			});
			await expect(h.session.autoReload({ changedAreas: ["skills"], isIdle: () => true })).rejects.toThrow(
				"load failed",
			);
			expect(h.session.loadRecord).toBe(settled);
			expect(await h.session.autoReload({ changedAreas: ["skills"], isIdle: () => false })).toBe("skipped");
			expect(h.session.loadRecord).toBe(settled);
			const notices = h.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "runtime-auto-reload",
			);
			expect(notices).toHaveLength(2);
			expect(getMessageText(notices[1])).toContain("partly rebuilt");
			const session = h.session as unknown as { _acquireSessionActionCommitFence(): Promise<{ release(): void }> };
			vi.spyOn(session, "_acquireSessionActionCommitFence").mockRejectedValueOnce(new Error("fence cancelled"));
			await expect(h.session.autoReload({ changedAreas: ["skills"], isIdle: () => true })).rejects.toThrow(
				"fence cancelled",
			);
			expect(
				h.session.messages.filter((m) => m.role === "custom" && m.customType === "runtime-auto-reload"),
			).toHaveLength(2);
		} finally {
			gate.resolve();
			await reload;
		}
	});
	it("TM-04 reports automatic reload, extension errors, and an unsaveable kernel value", async () => {
		const python = resolve(__dirname, "../../../../prime-agent-runtime/.venv/bin/python");
		vi.stubEnv(
			"PRIME_AGENT_KERNEL_PYTHON",
			existsSync(python) ? python : join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
		);
		vi.stubEnv("PYTHONPATH", resolve(__dirname, "../../../../prime-agent-runtime/src"));
		const root = mkdtempSync(join(tmpdir(), "reload-notice-"));
		roots.push(root);
		const loader = makeLoader(root, () => {
			throw new Error("bad extension fixture");
		});
		await loader.reload();
		const h = await createHarness({ resourceLoader: loader, persistSession: true });
		harnesses.push(h);
		const internals = h.session as unknown as KernelSession;
		try {
			const kernel = await internals._ipythonKernelProvisioner.ensure();
			expect((await kernel.execute("kept = 42\ngen = (n for n in range(3))")).status).toBe("ok");
			const snapshot = await kernel.snapshotState();
			expect(snapshot!.skipped.map((value) => value.name)).toContain("gen");
			expect(await h.session.autoReload({ changedAreas: ["skills", "context files"], isIdle: () => true })).toBe(
				"reloaded",
			);
			await internals._ipythonKernelProvisioner.ensure();
			const notices = h.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "runtime-auto-reload",
			);
			expect(notices).toHaveLength(1);
			expect(getMessageText(notices[0])).toContain("skills, context files");
			expect(getMessageText(notices[0])).toContain("Python kernel restarted");
			expect(getMessageText(notices[0])).toContain("bad extension fixture");
			const pending = h.session.getPendingNextTurnMessageSnapshots();
			expect(pending.map(getMessageText).join("\n")).toContain("gen");
		} finally {
			await internals._ipythonKernelProvisioner.dispose();
		}
	});
});
