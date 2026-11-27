import childProcess from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { DEFAULT_MAX_OUTPUT_CHARS, type ExecuteOptions, type ExecuteResult } from "../src/kernel/shared.ts";
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

function positiveProcessId(value: string): number {
	const pid = Number(value);
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process ID: ${value}`);
	return pid;
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
	it.each([
		["quit", true],
		["reload", true],
		["quit", false],
	] as const)("W1: failed %s flush with UI=%s reports stderr only for interactive quit", async (reason, hasUI) => {
		const { runtime, cell } = await host();
		await cell("x = 41");
		const path = snapshot(runtime);
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		vi.spyOn(runtime.session.extensionRunner, "hasUI").mockReturnValue(hasUI);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const errors: string[] = [];
		runtime.session.extensionRunner.onError((error) => errors.push(error.error));
		await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/Final Python snapshot failed:/);
		if (reason === "quit" && hasUI) {
			expect(stderr).toHaveBeenCalledExactlyOnceWith(
				expect.stringMatching(/^Final Python snapshot failed: [^\n]*\n$/),
			);
		} else expect(stderr).not.toHaveBeenCalled();
	});

	it("W2: many small stream chunks copy the tail only when an update is emitted", async () => {
		const { runtime, cell } = await host(false);
		await cell("0");
		const tool = runtime.session.agent.state.tools.find((tool) => tool.name === "ipython");
		if (!tool) throw new Error("ipython was not registered");
		const entered = Promise.withResolvers<ExecuteOptions>();
		const release = Promise.withResolvers<ExecuteResult>();
		vi.spyOn(ReplKernelManager.prototype, "execute").mockImplementationOnce((_code, options) => {
			entered.resolve(options ?? {});
			return release.promise;
		});
		const updates: string[] = [];
		const pending = tool.execute("chunks", { code: "controlled stream" }, undefined, (update) => {
			for (const block of update.content) if (block.type === "text") updates.push(block.text);
		});
		const options = await entered.promise;
		vi.useFakeTimers({ now: 1000 });
		const chunk = "W2:".repeat(100);
		const expectedTail = chunk.repeat(1000).slice(-DEFAULT_MAX_OUTPUT_CHARS);
		const joins = vi.spyOn(Array.prototype, "join");
		const slices = vi.spyOn(String.prototype, "slice");
		let beforeUpdate: number[] = [];
		let afterUpdate: number[] = [];
		try {
			for (let i = 0; i < 1000; i++) options.onStream?.(chunk, "stdout");
			beforeUpdate = [updates.length, joins.mock.calls.length, slices.mock.calls.length];
			await vi.advanceTimersByTimeAsync(100);
			afterUpdate = [updates.length, joins.mock.calls.length, slices.mock.calls.length];
		} finally {
			joins.mockRestore();
			slices.mockRestore();
			release.resolve({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
			await pending;
			vi.useRealTimers();
		}
		expect(beforeUpdate).toEqual([1, 1, 1]);
		expect(afterUpdate).toEqual([2, 2, 2]);
		expect(updates).toEqual([chunk, expectedTail]);
	});

	it("W3: a live kernel recreates its removed journal directory before bash enrollment", async () => {
		const { cell } = await host(false);
		const path = text(
			await cell("import os\nprint(os.environ['PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL'])"),
		).trim();
		rmSync(join(path, ".."), { recursive: true });
		const result = await cell("completed = await bash('printf journal-restored')\ncompleted.output");
		expect(result.isError).toBe(false);
		expect(text(result)).toContain("journal-restored");
		expect(existsSync(path)).toBe(true);
	});

	it("W4a: journal removal errors do not escape synchronous cleanup", async () => {
		const { dir } = await host(false);
		const manager = new ReplKernelManager({ python, cwd: dir });
		cleanups.push(() => manager.disposeSync());
		await manager.start();
		const internal = manager as unknown as { orphanJournalDir: string; kernelStderr: string };
		const journalDir = internal.orphanJournalDir;
		cleanups.push(() => rmSync(journalDir, { recursive: true, force: true }));
		const remove = fs.rmSync;
		const stub = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
			if (path === journalDir) throw new Error("injected journal removal failure");
			return remove(path, options);
		});
		syncBuiltinESMExports();
		try {
			expect(() => manager.disposeSync()).not.toThrow();
			expect(internal.kernelStderr).toContain("injected journal removal failure");
			expect(manager.isDefunct).toBe(true);
		} finally {
			stub.mockRestore();
			syncBuiltinESMExports();
		}
	});

	it("W4b: failed journal creation during protocol repair leaves startup idle and usable", async () => {
		const { dir } = await host(false);
		const manager = new ReplKernelManager({ python, cwd: dir });
		cleanups.push(() => manager.disposeSync());
		await manager.start();
		const internal = manager as unknown as {
			child: childProcess.ChildProcess;
			protocolRepairPromise: Promise<void>;
			state: string;
		};
		const stub = vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
			throw new Error("injected journal creation failure");
		});
		syncBuiltinESMExports();
		try {
			internal.child.stdout?.emit("data", Buffer.from("invalid-protocol-frame\n"));
			await internal.protocolRepairPromise;
			expect(internal.state).toBe("idle");
			const result = await manager.execute("21 * 2");
			expect(result.status).toBe("ok");
			expect(result.result).toBe("42");
		} finally {
			stub.mockRestore();
			syncBuiltinESMExports();
		}
	});

	it.each(["timeout", "shutdown"] as const)("W5: a SIGTERM-ignoring import probe settles on %s", async (mode) => {
		const { runtime, cell, dir } = await host(false);
		const server = net.createServer();
		const accepted = once(server, "connection");
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(
			() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address");
		const hanging = join(dir, "ignores-sigterm-python");
		writeFileSync(
			hanging,
			`#!${python}\nimport signal, socket\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ns = socket.create_connection(('127.0.0.1', ${address.port}))\ns.recv(1)\n`,
			{ mode: 0o700 },
		);
		vi.stubEnv(pythonVariable, hanging);
		const spawns = vi.spyOn(childProcess, "spawn");
		syncBuiltinESMExports();
		const pending = cell("42");
		const [socket] = await accepted;
		cleanups.push(() => socket.destroy());
		const child = spawns.mock.results[0].value as childProcess.ChildProcess;
		if (mode === "shutdown") {
			const shutdown = runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			// emit starts handlers synchronously; a later timeout cannot satisfy this assertion.
			expect(child.killed).toBe(true);
			await shutdown;
		}
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(child.signalCode).toBe("SIGKILL");
		if (mode === "timeout") expect(text(result)).toMatch(/timed out/i);
		else expect(text(result)).not.toContain("cannot import");
	});

	it.each(["0", "NaN", "-1"])("W6: orphan test rejects PID text %s before a signal", (value) => {
		expect(() => positiveProcessId(value)).toThrow("Invalid process ID");
	});

	it("L1: a silent nonzero interpreter probe reports its exit code", async () => {
		const { cell, dir } = await host(false);
		const failing = join(dir, "failing-python");
		writeFileSync(failing, `#!${python}\nraise SystemExit(7)\n`, { mode: 0o700 });
		vi.stubEnv(pythonVariable, failing);
		const result = await cell("42");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(pythonVariable);
		expect(text(result)).toContain("exit code 7");
	});

	it("L6: image-only cells omit empty text while empty cells keep a result block", async () => {
		const { cell } = await host(false);
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const result = await cell(
			"from rlm.repl import emit\nemit({'application/vnd.prime-agent.attachment+json': {'mime_type': 'image/png', 'data': 'aGVsbG8='}})",
		);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([image]);
		expect((await cell("pass")).content).toEqual([{ type: "text", text: "" }]);
		const mixed = await cell(
			"print('caption')\nemit({'application/vnd.prime-agent.attachment+json': {'mime_type': 'image/png', 'data': 'aGVsbG8='}})",
		);
		expect(mixed.content).toEqual([{ type: "text", text: "caption\n" }, image]);
	});

	it("R2-1: large streamed output keeps bounded partial-result tails", async () => {
		const { runtime, cell } = await host(false);
		const updates: string[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "tool_execution_update") {
				for (const block of event.partialResult.content) {
					if (block.type === "text") updates.push(block.text);
				}
			}
		});
		const result = await cell("print('x' * 200000, end='stream-tail', flush=True)");
		expect(result.isError).toBe(false);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every((update) => update.length <= DEFAULT_MAX_OUTPUT_CHARS)).toBe(true);
		expect(updates.at(-1)).toBe(`${"x".repeat(DEFAULT_MAX_OUTPUT_CHARS - 11)}stream-tail`);
	});

	it.each(["ok", "reject"] as const)("R2-1: throttles updates and flushes on %s", async (mode) => {
		const { runtime, cell } = await host(false);
		await cell("0");
		const tool = runtime.session.agent.state.tools.find((tool) => tool.name === "ipython");
		if (!tool) throw new Error("ipython was not registered");
		const entered = Promise.withResolvers<ExecuteOptions>();
		const release = Promise.withResolvers<ExecuteResult>();
		vi.spyOn(ReplKernelManager.prototype, "execute").mockImplementationOnce((_code, options) => {
			entered.resolve(options ?? {});
			return release.promise;
		});
		const updates: string[] = [];
		const pending = tool.execute("stream", { code: "controlled stream" }, undefined, (update) => {
			for (const block of update.content) {
				if (block.type === "text") updates.push(block.text);
			}
		});
		const options = await entered.promise;
		vi.useFakeTimers({ now: 1000 });
		try {
			options.onStream?.("first", "stdout");
			options.onStream?.("-second", "stderr");
			expect(updates).toEqual(["first"]);
			await vi.advanceTimersByTimeAsync(99);
			expect(updates).toEqual(["first"]);
			await vi.advanceTimersByTimeAsync(1);
			expect(updates).toEqual(["first", "first-second"]);
			options.onStream?.("-last", "stdout");
			if (mode === "ok") {
				release.resolve({ stdout: "first-last", stderr: "-second", status: "ok", durationMs: 0 });
				await pending;
			} else {
				const rejected = expect(pending).rejects.toThrow("stream failure");
				release.reject(new Error("stream failure"));
				await rejected;
			}
			expect(updates).toEqual(["first", "first-second", "first-second-last"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve({ stdout: "", stderr: "", status: "ok", durationMs: 0 });
			await pending.catch(() => undefined);
			vi.useRealTimers();
		}
	});

	it.each(["success", "partial"] as const)("R2-4: reports the final %s restore retry outcome", async (mode) => {
		const { runtime, cell, dir, open } = await host();
		writeFileSync(join(dir, "retry_module.py"), "class Value:\n    pass\n");
		await cell(
			"import sys\nsys.path.insert(0, '.')\nimport retry_module as _retry\nx = 41\nfailed_to_revive = _retry.Value()",
		);
		const file = runtime.session.sessionFile;
		if (!file) throw new Error("Expected a saved session file");
		await runtime.dispose();
		const path = snapshot(runtime);
		const saved = readFileSync(path);
		writeFileSync(path, "broken-payload");
		if (mode === "partial") rmSync(join(dir, "retry_module.py"));
		const restore = ReplKernelManager.prototype.restoreState;
		vi.spyOn(ReplKernelManager.prototype, "restoreState").mockImplementation(async function (
			this: ReplKernelManager,
		) {
			const restored = await restore.call(this);
			expect(restored).toBeNull();
			writeFileSync(path, saved);
			return restored;
		});
		const writes = vi.spyOn(ReplKernelManager.prototype as unknown as KernelWire, "writeLine");
		const reopened = await open(SessionManager.open(file));
		const result = await cell("x", reopened);
		expect(result.isError).toBe(false);
		expect(writes.mock.calls.filter(([request]) => request.type === "restore")).toHaveLength(2);
		expect(text(result)).toContain("41");
		expect(text(result)).not.toContain("all saved names were lost");
		if (mode === "partial") expect(text(result)).toContain("Failed to revive: failed_to_revive");
		else {
			expect(text(result).trim()).toBe("41");
			expect(text(await cell("type(failed_to_revive).__name__", reopened)).trim()).toBe("'Value'");
		}
		expect(text(await cell("42", reopened)).trim()).toBe("42");
	});

	it("R2-4: failed restore without retry preserves saved bytes during disposal", async () => {
		const { dir } = await host(false);
		const path = join(dir, "kernel-state.dill");
		const saved = Buffer.from("broken-payload-that-must-not-be-overwritten");
		writeFileSync(path, saved);
		const manager = new ReplKernelManager({
			python,
			cwd: dir,
			snapshot: { path, manifestPath: join(dir, "kernel-state.json") },
		});
		cleanups.push(async () => {
			await manager.shutdown({ snapshot: false });
		});
		await manager.start();
		expect(await manager.restoreState()).toBeNull();
		await manager.shutdown({ snapshot: true });
		expect(readFileSync(path)).toEqual(saved);
	});

	it("R2-5: a hanging interpreter probe reports its timeout", async () => {
		const { cell, dir } = await host(false);
		const hanging = join(dir, "hanging-python");
		writeFileSync(hanging, `#!${python}\nimport signal\nsignal.pause()\n`, { mode: 0o700 });
		vi.stubEnv(pythonVariable, hanging);
		const spawn = childProcess.spawn;
		const spawns = vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
			expect(options?.timeout).toBe(5000);
			return spawn(command, args, { ...options, timeout: 25 });
		});
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
		expect(text(result)).toMatch(/timed out/i);
		expect(spawns.mock.calls).toHaveLength(1);
		expect(spawns.mock.calls[0][1]).toEqual(["-c", "import rlm.repl, dill"]);
		expect(network).not.toHaveBeenCalled();
		expect(tcp).not.toHaveBeenCalled();
		expect(secure).not.toHaveBeenCalled();
	});

	it("R3-1: an interpreter probe killed by a signal reports its stderr, not a timeout", async () => {
		const { cell, dir } = await host(false);
		const crashing = join(dir, "crashing-python");
		writeFileSync(
			crashing,
			`#!${python}\nimport os, signal, sys\nsys.stderr.write("native extension crashed\\n")\nsys.stderr.flush()\nos.kill(os.getpid(), signal.SIGTERM)\n`,
			{ mode: 0o700 },
		);
		vi.stubEnv(pythonVariable, crashing);
		const result = await cell("42");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(pythonVariable);
		expect(text(result)).toContain("native extension crashed");
		expect(text(result)).not.toMatch(/timed out/i);
	});

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
		const [socket] = await accepted;
		cleanups.push(() => socket.destroy());
		const pid = positiveProcessId(text(spawned).trim());
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

	it("AC-17: the entry passes the ipython factory to exported main and does pi's CLI setup", async () => {
		const title = process.title;
		const codingAgent = process.env.PI_CODING_AGENT;
		const aiAgent = process.env.AI_AGENT;
		const emitWarning = process.emitWarning;
		const warned = vi.fn();
		try {
			delete process.env.PI_CODING_AGENT;
			delete process.env.AI_AGENT;
			process.emitWarning = warned as typeof process.emitWarning;
			const main = vi.fn(async () => {
				expect(process.env.PI_CODING_AGENT).toBe("true");
				expect(process.env.AI_AGENT).toBe("pi");
				process.emitWarning("ignored");
			});
			await run(["--version"], main);
			expect(main).toHaveBeenCalledWith(["--version"], { extensionFactories: [ipython] });
			expect(process.title).toBe(APP_NAME);
			expect(warned).not.toHaveBeenCalled();
			const entry = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
			expect(entry).toContain('from "@earendil-works/pi-coding-agent"');
			expect(entry).toContain("run(process.argv.slice(2), main)");
			const bin = fileURLToPath(new URL("../../../node_modules/.bin/prime-agent", import.meta.url));
			const result = childProcess.spawnSync(bin, ["--version"], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(VERSION);
		} finally {
			process.title = title;
			process.emitWarning = emitWarning;
			if (codingAgent === undefined) delete process.env.PI_CODING_AGENT;
			else process.env.PI_CODING_AGENT = codingAgent;
			if (aiAgent === undefined) delete process.env.AI_AGENT;
			else process.env.AI_AGENT = aiAgent;
		}
	});
});
