import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImageContent, registerSessionResourceCleanup, type TextContent } from "@earendil-works/pi-ai";
import {
	ENV_PREFIX,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withKernelBootPermit } from "./kernel/boot-gate.ts";
import { ReplKernelManager } from "./kernel/repl-manager.ts";
import {
	type ExecuteResult,
	errorMessage,
	isRecord,
	type KernelAttachment,
	raceStartupWithAbort,
} from "./kernel/shared.ts";
import { manifestPathIn, snapshotPathIn } from "./kernel/state-snapshot.ts";
import { spawnSyncHidden } from "./utils/child-process.ts";

const schema = Type.Object({
	code: Type.String({ description: "Python code to execute in the persistent Python REPL." }),
});
const bootstrapCode = "import asyncio\nfrom rlm import bash\nimport rlm";
const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface IpythonDetails {
	readonly status: ExecuteResult["status"];
	readonly durationMs: number;
}

/** Owns one session's lazy kernel, restore and final flush. */
class IpythonKernelProvisioner {
	private readonly cwd: string;
	private readonly sessionId: string;
	private readonly snapshotDir: string | undefined;
	private readonly startupAbort = new AbortController();
	private managerPromise?: Promise<ReplKernelManager>;
	private shutdownPromise?: Promise<void>;
	private unregisterCleanup?: () => void;
	private restoreNotice = "";
	private stopping = false;

	constructor(ctx: ExtensionContext) {
		this.cwd = ctx.cwd;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.snapshotDir = ctx.sessionManager.getSessionFile()
			? join(getAgentDir(), "session-artifacts", this.sessionId)
			: undefined;
		this.unregisterCleanup = registerSessionResourceCleanup((sessionId) => {
			if ((!sessionId || sessionId === this.sessionId) && !this.stopping) void this.shutdown({ snapshot: false });
		});
	}

	async ensure(signal: AbortSignal | undefined): Promise<ReplKernelManager> {
		if (this.stopping) throw new Error("Python kernel is shutting down");
		if (signal?.aborted) throw new Error("Python execution aborted");
		this.managerPromise ??= this.startKernel();
		const startup = this.managerPromise;
		try {
			return await raceStartupWithAbort(startup, signal);
		} catch (error) {
			if (!signal?.aborted && this.managerPromise === startup) this.managerPromise = undefined;
			throw error;
		}
	}

	private async startKernel(): Promise<ReplKernelManager> {
		const variable = `${ENV_PREFIX}_KERNEL_PYTHON`;
		const python = process.env[variable];
		const runtimeDir = fileURLToPath(new URL("../runtime/", import.meta.url));
		if (!python) throw new Error(`Set ${variable} to a Python interpreter with the runtime from ${runtimeDir}.`);
		const check = spawnSyncHidden(python, ["-c", "import rlm.repl, dill"], {
			cwd: this.cwd,
			encoding: "utf8",
			timeout: 5000,
		});
		if (check.status !== 0)
			throw new Error(`${variable} cannot import rlm.repl and dill: ${check.error?.message ?? check.stderr.trim()}`);
		const signal = this.startupAbort.signal;
		if (signal.aborted) throw new Error("Python kernel is shutting down");
		const shellPath = resolveKernelBashShell();
		const manager = new ReplKernelManager({
			python,
			cwd: this.cwd,
			sessionId: this.sessionId,
			env: {
				NO_COLOR: "1",
				...(shellPath ? { PRIME_AGENT_BASH_SHELL: shellPath } : {}),
			},
			snapshot: this.snapshotDir
				? { path: snapshotPathIn(this.snapshotDir), manifestPath: manifestPathIn(this.snapshotDir) }
				: undefined,
			bootstrapCode,
		});
		try {
			await withKernelBootPermit(() => manager.start({ signal }), signal);
			const snapshotExisted = this.snapshotDir && existsSync(snapshotPathIn(this.snapshotDir));
			if (this.snapshotDir) {
				const notSaved = readNotSavedNames(manifestPathIn(this.snapshotDir));
				const restored = await manager.restoreState();
				if (snapshotExisted) {
					const failed = restored?.failed.map((entry) => entry.name) ?? [];
					this.restoreNotice = [
						notSaved.length ? `Not saved: ${notSaved.join(", ")}` : "",
						failed.length ? `Failed to revive: ${failed.join(", ")}` : "",
					]
						.filter(Boolean)
						.join("\n");
				}
			}
			const result = await manager.execute(bootstrapCode, { signal });
			if (result.status !== "ok")
				throw new Error(`Failed to prepare the Python runtime: ${result.error?.evalue ?? result.stderr}`);
			if (snapshotExisted) manager.markRestoredNamespaceFresh();
			return manager;
		} catch (error) {
			await manager.shutdown({ snapshot: false });
			throw error;
		}
	}

	takeRestoreNotice(): string {
		const notice = this.restoreNotice;
		this.restoreNotice = "";
		return notice;
	}

	shutdown(options = { snapshot: true }): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopping = true;
		this.startupAbort.abort();
		this.shutdownPromise = this.disposeKernel(options);
		return this.shutdownPromise;
	}

	private async disposeKernel(options: { snapshot: boolean }): Promise<void> {
		try {
			let manager: ReplKernelManager;
			try {
				const pending = this.managerPromise;
				if (!pending) return;
				manager = await pending;
			} catch {
				return; // Failed startup already stopped its kernel.
			}
			await manager.shutdown({ snapshot: options.snapshot, drainHostRequests: true });
		} finally {
			this.unregisterCleanup?.();
		}
	}
}

function readNotSavedNames(path: string): string[] {
	if (!existsSync(path)) return [];
	const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(manifest) || !Array.isArray(manifest.skipped))
		throw new Error(`Invalid kernel snapshot manifest: ${path}`);
	return manifest.skipped.map((entry) => {
		if (!isRecord(entry) || typeof entry.name !== "string")
			throw new Error(`Invalid kernel snapshot manifest: ${path}`);
		return entry.name;
	});
}

function resolveKernelBashShell(): string | undefined {
	if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	return ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((path) =>
		existsSync(path),
	);
}

function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	return (attachments ?? [])
		.filter((attachment) => imageMimeTypes.has(attachment.mimeType))
		.map((attachment) => ({ type: "image", data: attachment.data, mimeType: attachment.mimeType }));
}

function createIpythonToolDefinition(
	getProvisioner: (ctx: ExtensionContext) => IpythonKernelProvisioner,
): ToolDefinition<typeof schema, IpythonDetails> {
	return {
		name: "ipython",
		label: "ipython",
		executionMode: "sequential",
		parameters: schema,
		description:
			"Execute Python in a persistent REPL with top-level await and streamed output. Variables survive calls and are restored best-effort from saved sessions; the first result reports lost names. bash() runs shell commands. Host services such as subagents, messaging, goals and MCP are unavailable. Project imports, tests and CLIs must use the project's own environment.",
		execute: async (_id, params, signal, onUpdate, ctx) => {
			const provisioner = getProvisioner(ctx);
			const manager = await provisioner.ensure(signal);
			const result = await manager.execute(params.code, {
				signal,
				onStream: (chunk) =>
					onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "ok", durationMs: 0 } }),
			});
			const output = [
				provisioner.takeRestoreNotice(),
				result.stdout,
				result.stderr,
				result.result,
				result.error?.traceback.join("\n"),
				result.backgroundOutput ? `[background output (unattributed)]\n${result.backgroundOutput}` : "",
			]
				.filter(Boolean)
				.join("\n");
			const content: (TextContent | ImageContent)[] = [
				{ type: "text", text: output },
				...imageBlocksFromAttachments(result.attachments),
			];
			return {
				content,
				details: { status: result.status, durationMs: result.durationMs },
				isError: result.status !== "ok",
			};
		},
	};
}

export default function ipython(pi: ExtensionAPI): void {
	let provisioner: IpythonKernelProvisioner | undefined;
	let stopped = false;
	function getProvisioner(ctx: ExtensionContext): IpythonKernelProvisioner {
		if (stopped) throw new Error("Python kernel is shutting down");
		provisioner ??= new IpythonKernelProvisioner(ctx);
		return provisioner;
	}
	pi.registerTool(createIpythonToolDefinition(getProvisioner));
	pi.on("session_shutdown", async () => {
		stopped = true;
		try {
			await provisioner?.shutdown();
		} catch (error) {
			throw new Error(`Final Python snapshot failed: ${errorMessage(error)}`, { cause: error });
		}
	});
}
