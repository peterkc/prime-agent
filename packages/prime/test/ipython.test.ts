import childProcess from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	APP_NAME,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ENV_PREFIX,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.ts";
import ipython from "../src/ipython.ts";
import { ReplKernelManager } from "../src/kernel/repl-manager.ts";

const python = fileURLToPath(new URL("../runtime/.venv/bin/python", import.meta.url));
const pythonVariable = `${ENV_PREFIX}_KERNEL_PYTHON`;
const cleanups: Array<() => Promise<void> | void> = [];

if (!existsSync(python))
	throw new Error("Missing kernel test interpreter. Run uv sync --frozen in packages/prime/runtime.");
const check = childProcess.spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
if (check.status !== 0) throw new Error(`Kernel test interpreter cannot import rlm.repl and dill: ${check.stderr}`);

afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()!();
	} finally {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});

async function host(persisted = true) {
	vi.stubEnv(pythonVariable, python);
	const dir = mkdtempSync(join(tmpdir(), "prime-ipython-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: getAgentDir(),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }),
			resourceLoaderOptions: {
				extensionFactories: [ipython],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
				tools: ["ipython"],
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtimes: AgentSessionRuntime[] = [];
	cleanups.push(async () => {
		for (const runtime of runtimes.reverse()) await runtime.dispose();
	});
	async function open(sessionManager: SessionManager) {
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: dir,
			agentDir: getAgentDir(),
			sessionManager,
		});
		runtimes.push(runtime);
		await runtime.session.bindExtensions({});
		return runtime;
	}
	const runtime = await open(
		persisted ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir),
	);
	async function cell(code: string, current = runtime): Promise<ToolResultMessage> {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await current.session.prompt("Run the scripted Python cell.");
		const result = current.session.messages.findLast(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("The faux model produced no ipython result");
		return result;
	}
	return { runtime, cell, dir, open, faux };
}

function text(result: ToolResultMessage): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function snapshot(runtime: AgentSessionRuntime): string {
	return join(getAgentDir(), "session-artifacts", runtime.session.sessionId, "kernel-state.dill");
}

interface KernelWire {
	writeLine(request: Record<string, unknown>): Promise<void>;
}

// The gate intercepts the real wire write, not serialization or the filesystem operation.
function holdFinalSnapshot(path: string) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = ReplKernelManager.prototype as unknown as KernelWire;
	const write = original.writeLine;
	const observations: string[] = [];
	vi.spyOn(original, "writeLine").mockImplementation(async function (this: KernelWire, request) {
		if (request.type === "snapshot") {
			entered.resolve();
			await release.promise;
			observations.push("snapshot");
		}
		if (request.type === "shutdown") {
			expect(existsSync(path)).toBe(true);
			observations.push("shutdown");
		}
		return write.call(this, request);
	});
	cleanups.push(() => release.resolve());
	return { entered: entered.promise, release: release.resolve, observations };
}

describe("ipython extension boundary", () => {
	it("AC-12: runs sequentially, streams output, supports await and keeps one lazy kernel", async () => {
		const { runtime, cell } = await host(false);
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		expect(spawns).not.toHaveBeenCalled();
		const updates: string[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_update") updates.push(JSON.stringify(event.partialResult));
		});
		expect(runtime.session.getToolDefinition("ipython")?.executionMode).toBe("sequential");
		const first = await cell(
			"import os, sys\nx = 41\nprint('stream-out')\nprint('stream-err', file=sys.stderr)\nos.getpid()",
		);
		const second = await cell("await asyncio.sleep(0)\nprint(os.getpid())\nx + 1");
		expect(first.isError).toBe(false);
		expect(text(first)).toContain("stream-err");
		expect(text(second)).toContain("42");
		const pid = text(first).trim().split("\n").at(-1);
		expect(text(second).trim().split("\n")[0]).toBe(pid);
		expect(updates.join("\n")).toContain("stream-out");
		expect(updates.join("\n")).toContain("stream-err");
		expect(spawns.mock.calls.filter(([, args]) => args?.includes("rlm.repl"))).toHaveLength(1);
		expect(existsSync(snapshot(runtime))).toBe(false);
		const bad = await cell("raise ValueError('cell-error')");
		expect(bad.isError).toBe(true);
		expect(text(bad)).toContain("ValueError: cell-error");
	});

	it.each(["reload", "reopen"] as const)(
		"AC-13: restores x and reports both lost-name sets after %s",
		async (mode) => {
			const { runtime, cell, dir, open } = await host();
			writeFileSync(join(dir, "lost_module.py"), "class Value:\n    pass\n");
			const first = await cell(
				"import sys\nsys.path.insert(0, '.')\nimport lost_module as _lost\nx = 41\nunsavable = (n for n in range(3))\nfailed_to_revive = _lost.Value()",
			);
			expect(first.isError).toBe(false);
			rmSync(join(dir, "lost_module.py"));
			let current = runtime;
			if (mode === "reload") await runtime.session.reload();
			else {
				const file = runtime.session.sessionFile;
				if (!file) throw new Error("Expected a saved session file");
				await runtime.dispose();
				current = await open(SessionManager.open(file));
			}
			const restored = await cell("x", current);
			expect(restored.isError).toBe(false);
			expect(text(restored)).toContain("41");
			expect(text(restored)).toContain("Not saved: unsavable");
			expect(text(restored)).toContain("Failed to revive: failed_to_revive");
			const next = await cell("x", current);
			expect(text(next).trim()).toBe("41");
		},
	);

	it("AC-14: rejects new calls during flush, writes before exit, and reload restores after flush", async () => {
		const { runtime, cell } = await host();
		expect((await cell("x = 41")).isError).toBe(false);
		const tool = runtime.session.agent.state.tools.find((tool) => tool.name === "ipython");
		if (!tool) throw new Error("ipython was not registered");
		const gate = holdFinalSnapshot(snapshot(runtime));
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		const reload = runtime.session.reload();
		await gate.entered;
		try {
			await expect(tool.execute("late", { code: "x = 0" })).rejects.toThrow("shutting down");
			expect(spawns).not.toHaveBeenCalled();
			expect(gate.observations).toEqual([]);
		} finally {
			gate.release();
		}
		await reload;
		expect(existsSync(snapshot(runtime))).toBe(true);
		expect(readFileSync(snapshot(runtime)).subarray(0, 33).toString()).toBe("PRIME-AGENT-KERNEL-SNAPSHOT-V3 py");
		expect(gate.observations).toEqual(["snapshot", "shutdown"]);
		expect(text(await cell("x"))).toContain("41");
	});

	it("AC-14: reports a failed final snapshot and still exits; repeated shutdown does not write again", async () => {
		const { runtime, cell } = await host();
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		expect((await cell("x = 41")).isError).toBe(false);
		const child = spawns.mock.results[0].value;
		const errors: string[] = [];
		runtime.session.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
		const path = snapshot(runtime);
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		await runtime.dispose();
		expect(errors.join("\n")).toMatch(/session_shutdown: .*snapshot/i);
		expect(child.exitCode).toBe(0);
		const writes = vi.spyOn(ReplKernelManager.prototype as unknown as KernelWire, "writeLine");
		await runtime.dispose();
		expect(writes).not.toHaveBeenCalled();
	});

	it("AC-14: direct session disposal stops a kernel without starting a final snapshot", async () => {
		const { runtime, cell } = await host();
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		expect((await cell("x = 41")).isError).toBe(false);
		const child = spawns.mock.results[0].value;
		const exited = once(child, "exit");
		runtime.session.dispose();
		await exited;
		expect(child.exitCode).toBe(0);
		expect(existsSync(snapshot(runtime))).toBe(false);
	});

	it("AC-15: unsupported host requests fail without hanging", async () => {
		const { cell } = await host(false);
		const result = await cell("import rlm\nawait rlm.host_request('rlm.run', {'prompt': 'not supported'})");
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/rlm.run.*not available/);
	});

	it("AC-15: abort settles a hanging real cell", async () => {
		const { runtime, faux } = await host(false);
		const entered = Promise.withResolvers<void>();
		runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("cell-started"))
				entered.resolve();
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", { code: "print('cell-started', flush=True)\nawait asyncio.Event().wait()" }),
				{ stopReason: "toolUse" },
			),
		]);
		const prompt = runtime.session.prompt("Run the hanging cell");
		await entered.promise;
		await runtime.session.abort();
		await prompt;
		const results = runtime.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
	});

	it.each(["unset", "missing", "without-runtime"] as const)(
		"AC-16: %s interpreter fails at import check without kernel or network",
		async (mode) => {
			const { cell, dir } = await host(false);
			if (mode === "unset") vi.stubEnv(pythonVariable, undefined);
			else if (mode === "missing") vi.stubEnv(pythonVariable, join(dir, "missing-python"));
			else {
				const bare = join(dir, "bare");
				const created = childProcess.spawnSync(python, ["-m", "venv", "--without-pip", bare], { encoding: "utf8" });
				expect(created.status, created.stderr).toBe(0);
				vi.stubEnv(pythonVariable, join(bare, "bin", "python"));
			}
			const spawns = vi.spyOn(childProcess, "spawn");
			syncBuiltinESMExports();
			const imports = vi.spyOn(childProcess, "spawnSync");
			syncBuiltinESMExports();
			const network = vi.fn(() => {
				throw new Error("No network is allowed");
			});
			vi.stubGlobal("fetch", network);
			const tcp = vi.spyOn(net, "connect");
			const secure = vi.spyOn(tls, "connect");
			syncBuiltinESMExports();
			const result = await cell("42");
			expect(result.isError).toBe(true);
			expect(text(result)).toContain(pythonVariable);
			expect(spawns.mock.calls.filter(([, args]) => args?.includes("rlm.repl"))).toEqual([]);
			expect(network).not.toHaveBeenCalled();
			expect(tcp).not.toHaveBeenCalled();
			expect(secure).not.toHaveBeenCalled();
			if (mode === "without-runtime") {
				expect(imports.mock.calls).toHaveLength(1);
				expect(imports.mock.calls[0][1]).toEqual(["-c", "import rlm.repl, dill"]);
				expect(text(result)).toContain("import");
			}
			vi.stubEnv(pythonVariable, python);
			expect(text(await cell("42")).trim()).toBe("42");
		},
	);

	it("AC-17: the entry passes the ipython factory to exported main and sets APP_NAME", async () => {
		const title = process.title;
		try {
			const main = vi.fn(async () => {});
			await run(["--version"], main);
			expect(main).toHaveBeenCalledWith(["--version"], { extensionFactories: [ipython] });
			expect(process.title).toBe(APP_NAME);
			const entry = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
			expect(entry).toContain('from "@earendil-works/pi-coding-agent"');
			expect(entry).toContain("run(process.argv.slice(2), main)");
			const bin = fileURLToPath(new URL("../../../node_modules/.bin/prime-agent", import.meta.url));
			const result = childProcess.spawnSync(bin, ["--version"], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(VERSION);
		} finally {
			process.title = title;
		}
	});
});
