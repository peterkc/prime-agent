import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.js";
import { readRlmLedgerHealth } from "../modes/daemon/rlm-ledger.js";

type MeshCommand = "install" | "uninstall" | "start" | "stop" | "status" | "doctor";
interface MeshOptions {
	readonly command: MeshCommand;
	readonly label: string;
	readonly meshHome: string;
	readonly server: string;
	readonly port: number;
	readonly plist: string;
}
interface MeshRuntime {
	readonly platform: NodeJS.Platform;
	readonly now: () => number;
	readonly wait: (ms: number) => Promise<unknown>;
}
interface ToolResult {
	readonly code: number;
	readonly stdout: string;
}
const defaultRuntime: MeshRuntime = { platform: process.platform, now: Date.now, wait: setTimeout };

function parseOptions(args: readonly string[]): MeshOptions {
	const command = args[0];
	if (
		command !== "install" &&
		command !== "uninstall" &&
		command !== "start" &&
		command !== "stop" &&
		command !== "status" &&
		command !== "doctor"
	)
		throw new Error(`Use ${APP_NAME} mesh <install|uninstall|start|stop|status|doctor>`);
	let label = "ai.prime.mesh";
	let meshHome = join(getAgentDir(), "mesh");
	let server = "nats://127.0.0.1:4222";
	const seen = new Set<string>();
	for (let index = 1; index < args.length; index += 2) {
		const flag = args[index]!;
		const value = args[index + 1];
		if (!value || value.startsWith("--") || seen.has(flag)) throw new Error("Mesh options need one value each");
		seen.add(flag);
		switch (flag) {
			case "--label":
				label = value;
				break;
			case "--mesh-home":
				meshHome = resolve(value);
				break;
			case "--server":
				server = value;
				break;
			default:
				throw new Error("Unknown mesh option");
		}
	}
	if (!/^ai\.prime\.mesh(?:\.[A-Za-z0-9.-]+)?$/.test(label)) throw new Error("Invalid mesh launchd label");
	let url: URL;
	try {
		url = new URL(server);
	} catch {
		throw new Error("Invalid mesh server URL");
	}
	const port = Number(url.port || 4222);
	if (
		url.protocol !== "nats:" ||
		url.hostname !== "127.0.0.1" ||
		url.username ||
		url.password ||
		url.pathname ||
		url.search ||
		url.hash ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("Mesh server must be a nats://127.0.0.1 URL with a valid port and no credentials");
	return {
		command,
		label,
		meshHome,
		server,
		port,
		plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
	};
}

function absolutePathEntries(): string[] {
	return (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
}

async function executable(name: string): Promise<string> {
	for (const directory of absolutePathEntries()) {
		const path = resolve(directory, name);
		try {
			await access(path, constants.X_OK);
			if ((await lstat(path)).isDirectory()) continue;
			return path;
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw new Error(`${name} is missing from PATH`);
}

function runTool(path: string, args: readonly string[], options: MeshOptions, timeout = 5000): Promise<ToolResult> {
	return new Promise((resolveResult, reject) => {
		execFile(
			path,
			[...args],
			{
				cwd: options.meshHome,
				env: { ...process.env, COTAL_HOME: join(options.meshHome, "home"), COTAL_SKIP_CONNECTOR_SEED: "1" },
				timeout,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout) => {
				if (!error) resolveResult({ code: 0, stdout });
				else if (typeof error.code === "number" && !error.killed) resolveResult({ code: error.code, stdout });
				else reject(new Error(`${path.endsWith("/cotal") ? "cotal" : "launchctl"} ${args[0]} could not complete`));
			},
		);
	});
}

function requireSuccess(result: ToolResult, step: string): void {
	if (result.code !== 0) throw new Error(`${step} failed (exit ${result.code})`);
}

const REQUIRED_COTAL_VERSION = "0.79.0";

async function readCotalVersion(cotal: string, options: MeshOptions): Promise<string> {
	try {
		const result = await runTool(cotal, ["--version"], { ...options, meshHome: homedir() });
		requireSuccess(result, "cotal --version");
		const version = /^cotal-ai (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/.exec(
			result.stdout.split(/\r?\n/, 1)[0] ?? "",
		)?.[1];
		if (!version) throw new Error("unrecognized cotal-ai version header");
		return version;
	} catch (error) {
		throw new Error(
			`Cannot read cotal CLI version: ${error instanceof Error ? error.message : String(error)}; required ${REQUIRED_COTAL_VERSION}`,
			{ cause: error },
		);
	}
}

async function requireCotalVersion(cotal: string, options: MeshOptions): Promise<void> {
	const version = await readCotalVersion(cotal, options);
	if (version !== REQUIRED_COTAL_VERSION)
		throw new Error(`cotal CLI version ${version}; required ${REQUIRED_COTAL_VERSION}`);
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function agentPlist(options: MeshOptions, cotal: string): string {
	const args = [cotal, "up", "--space", "prime", "--server", options.server, "--no-manager"];
	const env = {
		COTAL_HOME: join(options.meshHome, "home"),
		PATH: absolutePathEntries().join(delimiter),
		HOME: homedir(),
		...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
		COTAL_SKIP_CONNECTOR_SEED: "1",
	};
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(options.label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.meshHome)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
		.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
		.join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(join(options.meshHome, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.meshHome, "service.log"))}</string>
</dict></plist>
`;
}

async function assertFreePort(port: number): Promise<void> {
	const socket = createServer();
	try {
		const connection = createConnection({ host: "127.0.0.1", port });
		try {
			const connected = await new Promise<boolean>((ready, reject) => {
				connection.once("connect", () => ready(true));
				connection.once("error", (error: NodeJS.ErrnoException) =>
					error.code === "ECONNREFUSED" ? ready(false) : reject(error),
				);
				connection.setTimeout(1000, () => reject(new Error("Port probe timed out")));
			});
			if (connected) throw new Error("Port accepts connections");
		} finally {
			connection.destroy();
		}
		await new Promise<void>((ready, reject) => {
			socket.once("error", reject);
			socket.listen(port, "127.0.0.1", ready);
		});
	} catch {
		throw new Error(`Mesh broker port ${port} is in use or cannot be bound`);
	} finally {
		if (socket.listening)
			await new Promise<void>((closed, reject) => socket.close((error) => (error ? reject(error) : closed())));
	}
}

function brokerServing(stdout: string): boolean {
	return /^\s*broker\s+serving(?:\s|$)/m.test(stdout);
}

async function waitForBroker(cotal: string, options: MeshOptions, runtime: MeshRuntime): Promise<void> {
	const deadline = runtime.now() + 30_000;
	while (runtime.now() < deadline) {
		try {
			const status = await runTool(
				cotal,
				["status", "--components"],
				options,
				Math.min(5000, deadline - runtime.now()),
			);
			if (brokerServing(status.stdout)) return;
		} catch {
			// A failed probe is not readiness; keep checking within the same deadline.
		}
		const remaining = deadline - runtime.now();
		if (remaining > 0) await runtime.wait(Math.min(250, remaining));
	}
	throw new Error(
		`Mesh broker did not report serving within 30 seconds; see ${join(options.meshHome, "service.log")}`,
	);
}

async function waitForBootout(
	launchctl: string,
	target: string,
	options: MeshOptions,
	runtime: MeshRuntime,
): Promise<void> {
	const deadline = runtime.now() + 30_000;
	while (runtime.now() < deadline) {
		const job = await runTool(launchctl, ["print", target], options, Math.min(5000, deadline - runtime.now()));
		if (job.code === 113) return;
		requireSuccess(job, "launchctl print after bootout");
		const remaining = deadline - runtime.now();
		if (remaining > 0) await runtime.wait(Math.min(250, remaining));
	}
	throw new Error("Mesh launchd service is still loaded after bootout");
}

async function install(options: MeshOptions, launchctl: string, target: string, runtime: MeshRuntime): Promise<void> {
	// print must work before the mesh home exists; launchctl does not use Cotal's working directory.
	const probeOptions = { ...options, meshHome: homedir() };
	const loaded = await runTool(launchctl, ["print", target], probeOptions);
	if (loaded.code === 0) throw new Error("Mesh launchd label is already loaded");
	if (existsSync(options.plist)) throw new Error("Mesh launchd plist already exists; uninstall it first");
	if (loaded.code !== 113) requireSuccess(loaded, "launchctl print");
	await assertFreePort(options.port);
	const cotal = await executable("cotal");
	await requireCotalVersion(cotal, options);
	const created = await mkdir(options.meshHome, { recursive: true, mode: 0o700 });
	if (created) await chmod(options.meshHome, 0o700);
	else {
		const home = await lstat(options.meshHome);
		if (!home.isDirectory() || (home.mode & 0o777) !== 0o700 || home.uid !== process.getuid?.()) {
			throw new Error("Existing mesh home must be a directory owned by the current user with mode 0700");
		}
	}
	await mkdir(join(options.meshHome, ".cotal"), { recursive: true, mode: 0o700 });
	await writeFile(
		join(options.meshHome, "mesh.json"),
		`${JSON.stringify({ space: "prime", server: options.server })}\n`,
		{ mode: 0o600 },
	);
	await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
	await writeFile(options.plist, agentPlist(options, cotal), { flag: "wx", mode: 0o600 });
	try {
		requireSuccess(
			await runTool(launchctl, ["bootstrap", target.slice(0, target.lastIndexOf("/")), options.plist], options),
			"launchctl bootstrap",
		);
		await waitForBroker(cotal, options, runtime);
		if (!existsSync(join(options.meshHome, "signer.json"))) {
			requireSuccess(
				await runTool(cotal, ["mint", "--signer", "--out", "signer.json"], options),
				"cotal mint --signer",
			);
			if (!existsSync(join(options.meshHome, "signer.json")))
				throw new Error("cotal mint did not create signer.json");
		}
	} catch (error) {
		try {
			// bootout can return nonzero for an absent job; confirm removal with print.
			await runTool(launchctl, ["bootout", target], options);
			await waitForBootout(launchctl, target, options, runtime);
			await rm(options.plist, { force: true });
		} catch (rollbackError) {
			const original = error instanceof Error ? error.message : "Mesh install failed";
			const reason = rollbackError instanceof Error ? rollbackError.message : "cleanup failed";
			throw new Error(`${original}; rollback incomplete: ${reason}`);
		}
		throw error;
	}
	console.log(`Mesh installed: ${options.label}`);
}

async function storeBytes(path: string): Promise<number> {
	if (!existsSync(path)) return 0;
	let bytes = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) bytes += await storeBytes(child);
		else if (entry.isFile()) bytes += (await lstat(child)).size;
	}
	return bytes;
}

function pendingCount(stdout: string): number {
	let value: unknown;
	try {
		value = JSON.parse(stdout.split(/\r?\n/, 1)[0]!);
	} catch {
		throw new Error("cotal deliver pending returned invalid counts");
	}
	if (
		!value ||
		typeof value !== "object" ||
		!("pending" in value) ||
		!("ackPending" in value) ||
		typeof value.pending !== "number" ||
		typeof value.ackPending !== "number" ||
		!Number.isSafeInteger(value.pending) ||
		!Number.isSafeInteger(value.ackPending) ||
		value.pending < 0 ||
		value.ackPending < 0 ||
		!Number.isSafeInteger(value.pending + value.ackPending)
	)
		throw new Error("cotal deliver pending returned invalid counts");
	return value.pending + value.ackPending;
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error(`Mesh file ${path}: unreadable JSON`);
	}
}

async function inboxConsumerCounts(meshHome: string, space: string): Promise<readonly number[]> {
	const store = join(meshHome, ".cotal", "nats", "jetstream");
	if (!existsSync(store)) return [0, 0];
	for (const account of await readdir(store, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;
		const streams = join(store, account.name, "streams");
		if (!existsSync(join(streams, `DM_${space}`))) continue;
		const counts: number[] = [];
		for (const stream of [`DM_${space}`, `DLV_${space}`]) {
			const consumers = join(streams, stream, "obs");
			counts.push(
				existsSync(consumers)
					? (await readdir(consumers, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length
					: 0,
			);
		}
		return counts;
	}
	return [0, 0];
}

function reportLedgerHealth(): boolean {
	const failures = readRlmLedgerHealth(getAgentDir());
	console.log(`RLM ledger health: CHECKED (${failures.length === 0 ? "healthy" : "FAILED"})`);
	for (const failure of failures) {
		const line = failure.line === undefined ? "" : ` (line ${failure.line})`;
		console.log(`  ${failure.path}${line}: ${failure.cause}`);
	}
	if (failures.length === 0) return false;
	console.log(
		"Every listed failure blocks new mesh enrollment, directory publication and deletion reconciliation agent-wide.",
	);
	console.log("Recovery (offline): stop ALL writers, including workers that can outlive a supervisor restart.");
	console.log("Back up each listed path before changing it. Do not hand-edit committed records.");
	console.log("Prime never repairs ledgers automatically.");
	console.log("For an uncommitted unterminated tail, remove only that tail.");
	console.log("Warning: an older backup can lose deletion proof. Deleted children can re-enroll.");
	console.log("For a bad committed record or a byte or record limit failure, restore a usable trusted backup.");
	console.log("Warning: moving a ledger loses topology and deletion proof. Deleted children can re-enroll.");
	console.log(
		"If no usable backup exists, move the file outside the ledger directory only after accepting that loss.",
	);
	console.log("Correct file access if needed, then restart writers after recovery.");
	return true;
}

async function status(options: MeshOptions, launchctl: string | undefined, target: string): Promise<void> {
	if (!existsSync(join(options.meshHome, ".cotal")))
		throw new Error("Mesh home has no .cotal directory; install it first");
	const cotal = await executable("cotal");
	let versionUnavailable = false;
	try {
		console.log(`Cotal CLI: ${await readCotalVersion(cotal, options)}`);
	} catch (error) {
		console.log(error instanceof Error ? error.message : "Cannot read cotal CLI version");
		versionUnavailable = true;
	}
	const config = await readJson(join(options.meshHome, "mesh.json"));
	if (
		!config ||
		typeof config !== "object" ||
		!("space" in config) ||
		!("server" in config) ||
		typeof config.space !== "string" ||
		!config.space ||
		typeof config.server !== "string" ||
		!config.server
	) {
		throw new Error("Mesh configuration needs space and server strings");
	}
	const job = launchctl ? await runTool(launchctl, ["print", target], options) : undefined;
	const state =
		job?.code === 0
			? (/^\s*state = (running|waiting|not running|exited)$/m.exec(job.stdout)?.[1] ?? "loaded")
			: job
				? "absent"
				: "unavailable on this platform";
	console.log(`Launchd: ${state}`);
	const lastExitCode =
		job?.code === 0 ? /^\s*last exit code = (-?\d+)(?:: [^\r\n]+)?\s*$/m.exec(job.stdout)?.[1] : undefined;
	if (lastExitCode !== undefined) console.log(`Launchd last exit code: ${lastExitCode}`);
	const broker = await runTool(
		cotal,
		["status", "--components", "--space", config.space, "--server", config.server],
		options,
		30_000,
	);
	const serving = brokerServing(broker.stdout);
	console.log(`Broker: ${serving ? "serving" : "not serving"}`);
	console.log(`Store: ${await storeBytes(join(options.meshHome, ".cotal", "nats", "jetstream"))} bytes`);
	const log = join(options.meshHome, "service.log");
	console.log(`Service log: ${existsSync(log) ? (await lstat(log)).size : 0} bytes`);
	if (!serving) throw new Error("Mesh broker is not serving");
	let countUnavailable = false;
	const enrollments = join(options.meshHome, "enrollments");
	const records = (existsSync(enrollments) ? await readdir(enrollments) : []).filter((file) => file.endsWith(".json"));
	console.log(`Enrolled sessions: ${records.length}`);
	const consumers = await inboxConsumerCounts(options.meshHome, config.space);
	for (const [index, stream] of [`DM_${config.space}`, `DLV_${config.space}`].entries())
		console.log(`${stream}: ${consumers[index]} consumers / 1000`);
	for (const file of records) {
		const sessionId = file.slice(0, -5);
		const record = await readJson(join(enrollments, file));
		if (
			!/^[A-Za-z0-9_-]+$/.test(sessionId) ||
			!record ||
			typeof record !== "object" ||
			!("sessionId" in record) ||
			record.sessionId !== sessionId ||
			!("identity" in record) ||
			!record.identity ||
			typeof record.identity !== "object" ||
			!("id" in record.identity) ||
			typeof record.identity.id !== "string" ||
			!/^[A-Za-z0-9_]+$/.test(record.identity.id) ||
			!("lifecycleUid" in record) ||
			typeof record.lifecycleUid !== "string" ||
			!/^[a-z0-9]{26,32}$/.test(record.lifecycleUid)
		) {
			throw new Error(`Mesh enrollment ${file}: unreadable record`);
		}
		// Cotal 0.79.0 dmDurable("local", id, uid).
		const durable = `dm_local-${record.identity.id}-${record.lifecycleUid}`;
		const pending = await runTool(
			cotal,
			[
				"deliver",
				"pending",
				sessionId,
				"--space",
				config.space,
				"--server",
				config.server,
				"--root",
				options.meshHome,
				"--durable",
				durable,
				"--json",
			],
			options,
		);
		if (pending.code !== 0) {
			console.log(`Session ${sessionId}: count unavailable`);
			countUnavailable = true;
			continue;
		}
		console.log(`Session ${sessionId}: ${pendingCount(pending.stdout)} unacknowledged`);
	}
	if (job && job.code !== 0) throw new Error("Mesh launchd service is absent or inaccessible");
	if (countUnavailable) throw new Error("Mesh session counts are unavailable");
	if (versionUnavailable) throw new Error("Mesh CLI version is unavailable");
}

export async function runMeshCommand(args: readonly string[], runtime: MeshRuntime = defaultRuntime): Promise<void> {
	let options: MeshOptions | undefined;
	try {
		options = parseOptions(args);
		const { command } = options;
		if (runtime.platform !== "darwin" && command !== "status" && command !== "doctor") {
			throw new Error(`mesh ${command} is not supported on ${runtime.platform}`);
		}
		let ledgerUnhealthy = false;
		if (command === "status") ledgerUnhealthy = reportLedgerHealth();
		const launchctl = runtime.platform === "darwin" ? await executable("launchctl") : undefined;
		const target = `gui/${process.getuid?.()}/${options.label}`;
		if (command === "status" || command === "doctor") {
			if (command === "doctor") {
				await requireCotalVersion(await executable("cotal"), options);
				ledgerUnhealthy = reportLedgerHealth();
			}
			await status(options, launchctl, target);
			if (command === "doctor") {
				const auth = await runTool(await executable("cotal"), ["doctor", "auth"], options);
				requireSuccess(auth, "cotal doctor auth");
				console.log("Auth: healthy");
			}
			if (ledgerUnhealthy) throw new Error("RLM ledger check failed; new mesh enrollment is blocked");
			return;
		}
		if (!launchctl) throw new Error(`mesh ${command} is not supported on ${runtime.platform}`);
		if (command === "install") {
			await install(options, launchctl, target, runtime);
			return;
		}
		const toolOptions = { ...options, meshHome: homedir() };
		const job = await runTool(launchctl, ["print", target], toolOptions);
		if (!(command === "uninstall" && job.code === 113 && existsSync(options.plist))) {
			requireSuccess(job, "Mesh launchd service lookup");
		}
		switch (command) {
			case "uninstall":
				await runTool(launchctl, ["bootout", target], toolOptions);
				await waitForBootout(launchctl, target, toolOptions, runtime);
				await rm(options.plist, { force: true });
				break;
			case "start":
				requireSuccess(await runTool(launchctl, ["kickstart", target], toolOptions), "launchctl kickstart");
				break;
			case "stop":
				requireSuccess(await runTool(launchctl, ["kill", "SIGTERM", target], toolOptions), "launchctl kill");
				break;
			default: {
				const unhandled: never = command;
				return unhandled;
			}
		}
		console.log(`Mesh ${command}: ${options.label}`);
	} catch (error) {
		console.error(
			chalk.red(`Error: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Mesh command failed"}`),
		);
		if (options === undefined) console.error(chalk.dim(`Run "${APP_NAME} help mesh" for usage.`));
		process.exitCode = 1;
	}
}
