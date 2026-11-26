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
	ENV_AGENT_DIR,
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
import { processGroupHasLiveMember } from "../src/utils/child-process.ts";

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
	// ExtensionContext exposes no agentDir; getAgentDir reads this exported override.
	vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
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
	readonly flushingSnapshotForDispose: boolean;
	writeLine(request: Record<string, unknown>): Promise<void>;
}

// Gate the final capture, not an earlier or concurrent debounced snapshot.
function holdFinalSnapshot(path: string) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const snapshotter = ReplKernelManager.prototype as unknown as {
		captureSnapshot(options?: { final?: boolean }): ReturnType<ReplKernelManager["snapshotState"]>;
	};
	const capture = snapshotter.captureSnapshot;
	const observations: string[] = [];
	vi.spyOn(snapshotter, "captureSnapshot").mockImplementation(async function (this: typeof snapshotter, options) {
		if (options?.final) {
			entered.resolve();
			await release.promise;
			observations.push("snapshot");
		}
		return capture.call(this, options);
	});
	const wire = ReplKernelManager.prototype as unknown as KernelWire;
	const write = wire.writeLine;
	vi.spyOn(wire, "writeLine").mockImplementation(function (this: KernelWire, request) {
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
	it("F5: test services and snapshots use only the test agent directory", async () => {
		const { runtime, cell, dir } = await host();
		expect(getAgentDir()).toBe(join(dir, "agent"));
		await cell("42");
		await runtime.dispose();
		expect(existsSync(join(dir, "agent", "session-artifacts", runtime.session.sessionId, "kernel-state.dill"))).toBe(
			true,
		);
	});

	it.each(["snapshot", "queue"] as const)("F2: reports kernel exit during final %s wait", async (mode) => {
		const { runtime, cell } = await host();
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		await cell("x = 41");
		const child = spawns.mock.results[spawns.mock.calls.findIndex(([, args]) => args?.includes("rlm.repl"))].value;
		const errors: string[] = [];
		runtime.session.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(() => release.resolve());
		if (mode === "snapshot") {
			const wire = ReplKernelManager.prototype as unknown as KernelWire;
			const write = wire.writeLine;
			vi.spyOn(wire, "writeLine").mockImplementation(async function (this: KernelWire, request) {
				if (request.type === "snapshot" && this.flushingSnapshotForDispose) {
					entered.resolve();
					await release.promise;
				}
				return write.call(this, request);
			});
		} else {
			const prototype = ReplKernelManager.prototype as unknown as {
				executionQueue: Promise<unknown>;
				runSnapshotFlushForDispose(): Promise<void>;
			};
			const flush = prototype.runSnapshotFlushForDispose;
			vi.spyOn(prototype, "runSnapshotFlushForDispose").mockImplementation(function (this: typeof prototype) {
				this.executionQueue = release.promise;
				const pending = flush.call(this);
				entered.resolve();
				return pending;
			});
		}
		const disposal = runtime.dispose();
		await entered.promise;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		release.resolve();
		await disposal;
		expect(errors.join("\n")).toMatch(/session_shutdown: .*snapshot/i);
	});

	it("F7: hard kernel kill reaps its bash process group", async () => {
		const { cell } = await host(false);
		const server = net.createServer();
		const accepted = once(server, "connection");
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(
			() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address");
		const code = `import socket; s=socket.create_connection(('127.0.0.1', ${address.port})); s.recv(1)`;
		const command = `exec ${JSON.stringify(python)} -c ${JSON.stringify(code)}`;
		const spawned = await cell(`h = bash(${JSON.stringify(command)})\nh.pid`);
		const pid = Number(text(spawned).trim());
		cleanups.push(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		});
		const [socket] = await accepted;
		cleanups.push(() => socket.destroy());
		const closed = once(socket, "close");
		expect((await cell("import os\nos._exit(9)")).isError).toBe(true);
		await closed;
		expect(processGroupHasLiveMember(pid)).toBe(false);
	});

	it("F1: replaces a crashed kernel before the next cell", async () => {
		const { cell } = await host(false);
		expect((await cell("import os\nos._exit(7)")).isError).toBe(true);
		const next = await cell("21 * 2");
		expect(next.isError).toBe(false);
		expect(text(next).trim()).toBe("42");
	});

	it.each(["corrupt", "legacy-code"] as const)("F3: reports a whole %s restore failure once", async (mode) => {
		const { runtime, cell, open } = await host();
		await cell("x = 41");
		const file = runtime.session.sessionFile;
		if (!file) throw new Error("Expected a saved session file");
		await runtime.dispose();
		const path = snapshot(runtime);
		if (mode === "corrupt") writeFileSync(path, "broken-payload");
		else {
			const legacy = childProcess.spawnSync(
				python,
				["-c", "import dill, sys; open(sys.argv[1], 'wb').write(dill.dumps({'x': lambda: 41}))", path],
				{ encoding: "utf8" },
			);
			expect(legacy.status, legacy.stderr).toBe(0);
		}
		const reopened = await open(SessionManager.open(file));
		const result = await cell("'x' in globals()", reopened);
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("could not be restored; all saved names were lost");
		expect(text(result)).toContain("False");
		expect(text(await cell("42", reopened)).trim()).toBe("42");
	});

	it.each(["json", "shape", "no-payload"] as const)(
		"F8: malformed manifest %s is a first-result warning",
		async (mode) => {
			const { runtime, cell, open } = await host();
			await cell("x = 41");
			const file = runtime.session.sessionFile;
			if (!file) throw new Error("Expected a saved session file");
			await runtime.dispose();
			writeFileSync(snapshot(runtime).replace(/\.dill$/, ".json"), mode === "shape" ? '{"skipped":[{}]}' : "{");
			if (mode === "no-payload") rmSync(snapshot(runtime));
			const reopened = await open(SessionManager.open(file));
			const result = await cell("42", reopened);
			expect(result.isError).toBe(false);
			expect(text(result)).toContain("snapshot manifest could not be read");
			expect(text(result)).toContain("42");
			expect(text(await cell("42", reopened)).trim()).toBe("42");
		},
	);

	it.each(["..", "../outside", "nested/id", "nested\\id", ""])(
		"F13: session ID %j gets no snapshot target",
		async (id) => {
			const { runtime, cell } = await host();
			vi.spyOn(SessionManager.prototype, "getSessionId").mockReturnValue(id);
			const restores = vi.spyOn(ReplKernelManager.prototype, "restoreState");
			const writes = vi.spyOn(ReplKernelManager.prototype as unknown as KernelWire, "writeLine");
			expect(text(await cell("42")).trim()).toBe("42");
			await runtime.dispose();
			expect(restores).not.toHaveBeenCalled();
			expect(
				writes.mock.calls.filter(([request]) => request.type === "snapshot" || request.type === "restore"),
			).toEqual([]);
		},
	);

	it("F15: shutdown aborts startup while restore is held", async () => {
		const { runtime, cell } = await host();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const restore = ReplKernelManager.prototype.restoreState;
		vi.spyOn(ReplKernelManager.prototype, "restoreState").mockImplementation(async function (
			this: ReplKernelManager,
		) {
			entered.resolve();
			await release.promise;
			return restore.call(this);
		});
		cleanups.push(() => release.resolve());
		const pending = cell("42");
		await entered.promise;
		try {
			await runtime.dispose();
			expect((await pending).isError).toBe(true);
		} finally {
			release.resolve();
		}
	});

	it("F6: pi owns signals and exit-time kernel cleanup stays synchronous", () => {
		const shared = readFileSync(new URL("../src/kernel/shared.ts", import.meta.url), "utf8");
		expect(shared).not.toMatch(/process\.on\("(?:SIGINT|SIGTERM|beforeExit)"/);
		expect(shared).not.toContain("process.exit(");
		expect(shared).toContain('process.on("exit",');
		expect(shared).toContain("k.disposeSync()");
	});

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
		expect(updates.at(-1)).toContain("stream-out");
		expect(updates.at(-1)).toContain("stream-err");
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
		const child = spawns.mock.results[spawns.mock.calls.findIndex(([, args]) => args?.includes("rlm.repl"))].value;
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
		const child = spawns.mock.results[spawns.mock.calls.findIndex(([, args]) => args?.includes("rlm.repl"))].value;
		const exited = once(child, "exit");
		const writes = vi.spyOn(ReplKernelManager.prototype as unknown as KernelWire, "writeLine");
		runtime.session.dispose();
		await exited;
		expect(child.exitCode).toBe(0);
		expect(writes.mock.calls.filter(([request]) => request.type === "snapshot")).toEqual([]);
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
			const syncImports = vi.spyOn(childProcess, "spawnSync");
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
				expect(syncImports).not.toHaveBeenCalled();
				expect(spawns.mock.calls).toHaveLength(1);
				expect(spawns.mock.calls[0][1]).toEqual(["-c", "import rlm.repl, dill"]);
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
