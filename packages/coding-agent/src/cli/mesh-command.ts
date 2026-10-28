import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.js";
import { readRlmLedgerHealth } from "../modes/daemon/rlm-ledger.js";

type MeshCommand = "install" | "uninstall" | "start" | "stop" | "status" | "doctor" | "rotate";
interface MeshOptions {
	readonly command: MeshCommand;
	readonly ifDue: boolean;
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
	readonly processAlive?: (pid: number) => boolean;
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
		command !== "doctor" &&
		command !== "rotate"
	)
		throw new Error(`Use ${APP_NAME} mesh <install|uninstall|start|stop|status|doctor|rotate>`);
	let label = "ai.prime.mesh";
	let meshHome = join(getAgentDir(), "mesh");
	let server = "nats://127.0.0.1:4222";
	let ifDue = false;
	const seen = new Set<string>();
	for (let index = 1; index < args.length; index += 2) {
		const flag = args[index]!;
		if (flag === "--if-due" && command === "rotate" && !seen.has(flag)) {
			seen.add(flag);
			ifDue = true;
			index--;
			continue;
		}
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
	if (!/^ai\.prime\.mesh(?:\.[A-Za-z0-9.-]+)?$/.test(label) || label.endsWith(".renew") || label.endsWith(".rotate"))
		throw new Error("Invalid mesh launchd label");
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
		ifDue,
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

// Cotal renews its 24-hour daemon creds only from its manager, which `--no-manager` omits. A second
// job runs Cotal's documented repair every 10 minutes. It re-signs only creds past their renewal
// point (75% of their lifetime), so a short interval keeps `cotal doctor auth` healthy.
function renewalOf(options: MeshOptions): MeshOptions {
	const label = `${options.label}.renew`;
	return { ...options, label, plist: join(dirname(options.plist), `${label}.plist`) };
}

function rotationOf(options: MeshOptions): MeshOptions {
	const label = `${options.label}.rotate`;
	return { ...options, label, plist: join(dirname(options.plist), `${label}.plist`) };
}

function targetOf(options: MeshOptions): string {
	return `gui/${process.getuid?.()}/${options.label}`;
}

function agentPlist(
	options: MeshOptions,
	program: string,
	kind: "service" | "renewal" | "rotation" = "service",
): string {
	const job = kind === "renewal" ? renewalOf(options) : kind === "rotation" ? rotationOf(options) : options;
	const args =
		kind === "renewal"
			? [program, "doctor", "auth", "--fix"]
			: kind === "rotation"
				? [
						program,
						"mesh",
						"rotate",
						"--if-due",
						"--label",
						options.label,
						"--server",
						options.server,
						"--mesh-home",
						options.meshHome,
					]
				: [program, "up", "--space", "prime", "--server", options.server, "--no-manager"];
	const log = xml(
		join(options.meshHome, kind === "renewal" ? "renewal.log" : kind === "rotation" ? "rotation.log" : "service.log"),
	);
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
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.meshHome)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
		.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
		.join("")}</dict>
${
	kind === "rotation"
		? "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>"
		: `<key>RunAtLoad</key><true/>
${kind === "renewal" ? "<key>StartInterval</key><integer>600</integer>" : "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"}`
}
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
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

async function waitForBroker(cotal: string, options: MeshOptions, runtime: MeshRuntime, space: string): Promise<void> {
	const deadline = runtime.now() + 30_000;
	for (;;) {
		// Read the clock once: a zero timeout would let execFile wait forever.
		const timeout = deadline - runtime.now();
		if (timeout <= 0) break;
		try {
			// `cotal status --components` takes about 5 s without a manager, and longer under load.
			const status = await runTool(
				cotal,
				["status", "--components", "--space", space, "--server", options.server],
				options,
				timeout,
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
	for (;;) {
		const timeout = deadline - runtime.now();
		if (timeout <= 0) break;
		const job = await runTool(launchctl, ["print", target], options, Math.min(5000, timeout));
		if (job.code === 113) return;
		requireSuccess(job, "launchctl print after bootout");
		const remaining = deadline - runtime.now();
		if (remaining > 0) await runtime.wait(Math.min(250, remaining));
	}
	throw new Error("Mesh launchd service is still loaded after bootout");
}

function rotationBootPath(options: MeshOptions): string {
	return join(options.meshHome, "rotation-boot.plist");
}

function rotationBootPlist(service: string): string {
	const keepAlive = "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>";
	if (
		!service.includes(keepAlive) ||
		!service.includes("</array>") ||
		service.includes("<string>--rotate-sys</string>")
	)
		throw new Error("Unrecognized mesh service plist; reinstall the mesh before rotating");
	return service.replace("</array>", "<string>--rotate-sys</string></array>").replace(keepAlive, "");
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

async function rootProcessesStopped(options: MeshOptions, runtime: MeshRuntime): Promise<boolean> {
	const directory = join(options.meshHome, ".cotal");
	for (const file of (await readdir(directory)).filter((name) => name.endsWith(".pid"))) {
		let raw: string;
		try {
			raw = (await readFile(join(directory, file), "utf8")).trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Cannot read Cotal pid record ${file}`, { cause: error });
		}
		const pid = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff)
			throw new Error(`Invalid Cotal pid record ${file}; refusing to boot another broker`);
		if ((runtime.processAlive ?? processAlive)(pid)) return false;
	}
	return true;
}

async function waitForStopped(options: MeshOptions, runtime: MeshRuntime): Promise<void> {
	const deadline = runtime.now() + 30_000;
	for (;;) {
		const stopped = await rootProcessesStopped(options, runtime);
		try {
			await assertFreePort(options.port);
			if (stopped) return;
		} catch {
			// A closed port AND dead recorded processes are required, not elapsed time.
		}
		const remaining = deadline - runtime.now();
		if (remaining <= 0) break;
		await runtime.wait(Math.min(250, remaining));
	}
	throw new Error("Mesh broker or recorded Cotal processes did not stop within 30 seconds");
}

async function bootout(launchctl: string, options: MeshOptions, runtime: MeshRuntime): Promise<void> {
	await runTool(launchctl, ["bootout", targetOf(options)], options);
	await waitForBootout(launchctl, targetOf(options), options, runtime);
}

async function removeJob(launchctl: string, options: MeshOptions, runtime: MeshRuntime): Promise<void> {
	// bootout can return nonzero for an absent job; confirm removal with print.
	await bootout(launchctl, options, runtime);
	await rm(options.plist, { force: true });
}

async function removeJobs(launchctl: string, options: MeshOptions, runtime: MeshRuntime): Promise<void> {
	// Attempt every removal so a stuck scheduled job cannot leave the service loaded.
	const failures: string[] = [];
	for (const job of [rotationOf(options), renewalOf(options), options]) {
		try {
			await removeJob(launchctl, { ...job, meshHome: homedir() }, runtime);
			if (job.label === options.label) await rm(rotationBootPath(options), { force: true });
		} catch (error) {
			failures.push(`${job.label}: ${error instanceof Error ? error.message : "removal failed"}`);
		}
	}
	if (failures.length > 0) throw new Error(failures.join("; "));
}

async function install(options: MeshOptions, launchctl: string, target: string, runtime: MeshRuntime): Promise<void> {
	const renewal = renewalOf(options);
	const rotation = rotationOf(options);
	for (const job of [options, renewal, rotation]) {
		// print must work before the mesh home exists; launchctl does not use Cotal's working directory.
		const loaded = await runTool(launchctl, ["print", targetOf(job)], { ...job, meshHome: homedir() });
		if (loaded.code === 0) throw new Error(`Mesh launchd label ${job.label} is already loaded`);
		if (existsSync(job.plist)) throw new Error("Mesh launchd plist already exists; uninstall it first");
		if (loaded.code !== 113) requireSuccess(loaded, "launchctl print");
	}
	await assertFreePort(options.port);
	const cotal = await executable("cotal");
	await requireCotalVersion(cotal, options);
	const primeAgent = await executable(APP_NAME);
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
		await waitForBroker(cotal, options, runtime, "prime");
		if (!existsSync(join(options.meshHome, "signer.json"))) {
			requireSuccess(
				await runTool(cotal, ["mint", "--signer", "--out", "signer.json"], options),
				"cotal mint --signer",
			);
			if (!existsSync(join(options.meshHome, "signer.json")))
				throw new Error("cotal mint did not create signer.json");
		}
		await writeFile(renewal.plist, agentPlist(options, cotal, "renewal"), { flag: "wx", mode: 0o600 });
		requireSuccess(
			await runTool(launchctl, ["bootstrap", target.slice(0, target.lastIndexOf("/")), renewal.plist], options),
			"launchctl bootstrap",
		);
		await writeFile(rotation.plist, agentPlist(options, primeAgent, "rotation"), { flag: "wx", mode: 0o600 });
		requireSuccess(
			await runTool(launchctl, ["bootstrap", target.slice(0, target.lastIndexOf("/")), rotation.plist], options),
			"launchctl bootstrap rotation job",
		);
	} catch (error) {
		try {
			await removeJobs(launchctl, options, runtime);
		} catch (rollbackError) {
			const original = error instanceof Error ? error.message : "Mesh install failed";
			const reason = rollbackError instanceof Error ? rollbackError.message : "cleanup failed";
			throw new Error(`${original}; rollback incomplete: ${reason}`);
		}
		throw error;
	}
	console.log(`Mesh installed: ${options.label}`);
}

interface SystemCredential {
	readonly file: string;
	readonly iat: number;
	readonly exp: number;
}

async function meshConfig(options: MeshOptions): Promise<{ readonly space: string; readonly server: string }> {
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
	return { space: config.space, server: config.server };
}

const SYSTEM_CREDENTIAL_FILES = ["membership-observer.creds", "connection-evictor.creds"] as const;

async function systemCredential(options: MeshOptions, space: string, file: string): Promise<SystemCredential> {
	// Cotal 0.79.0 spaceSegment: lowercase hex of the space's UTF-8 bytes, under .cotal (not auth).
	const directory = join(options.meshHome, ".cotal", `space.${Buffer.from(space, "utf8").toString("hex")}`);
	try {
		const text = await readFile(join(directory, file), "utf8");
		const sections = [
			...text.matchAll(
				/^-----BEGIN NATS USER JWT-----\r?\n([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\r?\n------END NATS USER JWT------$/gm,
			),
		];
		if (sections.length !== 1) throw new Error("expected one JWT section");
		const jwt = sections[0]![1]!;
		const claims: unknown = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
		if (
			!claims ||
			typeof claims !== "object" ||
			!("iat" in claims) ||
			!("exp" in claims) ||
			typeof claims.iat !== "number" ||
			typeof claims.exp !== "number" ||
			!Number.isSafeInteger(claims.iat) ||
			!Number.isSafeInteger(claims.exp) ||
			claims.iat < 0 ||
			claims.exp <= claims.iat ||
			claims.exp > 8_640_000_000_000
		)
			throw new Error("invalid lifetime");
		return { file, iat: claims.iat, exp: claims.exp };
	} catch {
		// Never include parser errors: they may quote a credential's JWT or secret seed.
		throw new Error(`Cannot read $SYS credential lifetime: ${file}`);
	}
}

async function systemCredentials(options: MeshOptions, space: string): Promise<readonly SystemCredential[]> {
	return Promise.all(SYSTEM_CREDENTIAL_FILES.map((file) => systemCredential(options, space, file)));
}

async function acquireRotationLock(lock: string): Promise<string> {
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`Cannot acquire mesh rotation lock ${lock}; install the mesh first`);
		if (code !== "EEXIST") throw new Error(`Cannot acquire mesh rotation lock ${lock}: ${code}`, { cause: error });
		let owner: string;
		try {
			const entries = await readdir(lock);
			owner = entries[0] ?? "";
			if (
				entries.length !== 1 ||
				!/^[1-9]\d*$/.test(owner) ||
				Number(owner) > 0x7fffffff ||
				(await readFile(join(lock, owner), "utf8")).trim() !== owner
			)
				throw new Error("invalid owner");
		} catch {
			throw new Error(
				`Mesh rotation lock ${lock} has unreadable owner content; confirm no rotation is running before removing it`,
			);
		}
		if (processAlive(Number(owner)))
			throw new Error(`Mesh rotation lock ${lock}: another rotation may be running (pid ${owner})`);
		// Remove only the dead owner's record, never a new owner's record after a competing takeover.
		await rm(join(lock, owner));
		await rmdir(lock);
		await mkdir(lock, { mode: 0o700 });
		console.log(`Taking over stale mesh rotation lock ${lock} from dead pid ${owner}`);
	}
	const owner = join(lock, String(process.pid));
	await writeFile(owner, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
	return owner;
}

async function rotateCredentials(options: MeshOptions, launchctl: string, runtime: MeshRuntime): Promise<void> {
	const failures: string[] = [];
	let interrupted: NodeJS.Signals | undefined;
	function deferSignal(signal: NodeJS.Signals): void {
		interrupted ??= signal;
	}
	try {
		const config = await meshConfig(options);
		const before = await systemCredentials(options, config.space);
		const due = Math.min(...before.map((cred) => cred.iat + 0.75 * (cred.exp - cred.iat)));
		if (options.ifDue && runtime.now() < due * 1000) {
			console.log(`Credential rotation not due; next due: ${new Date(due * 1000).toString()}`);
			return;
		}
		if (config.server !== options.server)
			throw new Error("Mesh server differs from mesh.json; use the installed --server URL");
		const cotal = await executable("cotal");
		await requireCotalVersion(cotal, options);
		const temporary = rotationBootPath(options);
		if (existsSync(temporary))
			throw new Error("Temporary rotation plist remains; uninstall and reinstall the mesh before rotating");
		const bootPlist = rotationBootPlist(await readFile(options.plist, "utf8"));
		const jobs = [options, renewalOf(options)];
		for (const job of jobs) {
			await access(job.plist, constants.R_OK);
			requireSuccess(await runTool(launchctl, ["print", targetOf(job)], options), `Mesh job lookup ${job.label}`);
		}
		const domain = targetOf(options).slice(0, targetOf(options).lastIndexOf("/"));
		process.on("SIGINT", deferSignal);
		process.on("SIGTERM", deferSignal);
		let step: string | undefined;
		try {
			for (const job of [...jobs].reverse()) {
				step = `stop ${job.label}`;
				await bootout(launchctl, job, runtime);
			}
			if (interrupted) throw new Error(`interrupted by ${interrupted}`);
			step = "wait for Cotal processes to stop";
			await waitForStopped(options, runtime);
			if (interrupted) throw new Error(`interrupted by ${interrupted}`);
			// Reuse the service label: only one broker job can be loaded, including during recovery.
			// The installed plist is never changed; the temporary boot cannot be relaunched by KeepAlive.
			step = "start rotation broker";
			await writeFile(temporary, bootPlist, { flag: "wx", mode: 0o600 });
			const started = Math.floor(runtime.now() / 1000);
			requireSuccess(
				await runTool(launchctl, ["bootstrap", domain, temporary], options),
				"launchctl bootstrap rotation boot",
			);
			await waitForBroker(cotal, options, runtime, config.space);
			step = "verify rotated $SYS credentials";
			const after = await systemCredentials(options, config.space);
			for (const [index, cred] of after.entries()) {
				const remaining = cred.exp - runtime.now() / 1000;
				if (
					cred.iat < started ||
					cred.iat <= before[index]!.iat ||
					cred.iat > runtime.now() / 1000 ||
					Math.abs(remaining - 30 * 24 * 60 * 60) > 60
				)
					throw new Error(`${cred.file} does not have an advanced iat and fresh 30-day lifetime`);
			}
		} catch (error) {
			failures.push(`${step}: ${error instanceof Error ? error.message : "failed"}`);
		}
		if (existsSync(temporary)) {
			try {
				await bootout(launchctl, options, runtime);
				await waitForStopped(options, runtime);
				await rm(temporary);
			} catch (error) {
				failures.push(`stop rotation broker: ${error instanceof Error ? error.message : "failed"}`);
			}
		}
		for (const job of jobs) {
			try {
				const loaded = await runTool(launchctl, ["print", targetOf(job)], options);
				if (loaded.code !== 0 || existsSync(temporary)) {
					if (loaded.code !== 0 && loaded.code !== 113) requireSuccess(loaded, "launchctl print before restart");
					requireSuccess(
						await runTool(launchctl, ["bootstrap", domain, job.plist], options),
						"launchctl bootstrap",
					);
				}
			} catch (error) {
				failures.push(`restart ${job.label}: ${error instanceof Error ? error.message : "failed"}`);
			}
		}
		try {
			await waitForBroker(cotal, options, runtime, config.space);
		} catch (error) {
			failures.push(`wait for restarted broker: ${error instanceof Error ? error.message : "failed"}`);
		}
		if (interrupted) failures.push(`Rotation interrupted by ${interrupted}; recovery attempted`);
		if (failures.length) throw new Error(failures.join("; "));
		console.log(
			`Mesh credentials rotated: ${options.label}. Earlier full Cotal backups are no longer restorable; take a fresh backup.`,
		);
	} finally {
		process.off("SIGINT", deferSignal);
		process.off("SIGTERM", deferSignal);
	}
}

async function rotate(options: MeshOptions, launchctl: string, runtime: MeshRuntime): Promise<void> {
	const lock = join(options.meshHome, "rotation.lock");
	const owner = await acquireRotationLock(lock);
	const failures: string[] = [];
	try {
		await rotateCredentials(options, launchctl, runtime);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : "Mesh rotation failed");
	} finally {
		try {
			await rm(owner);
			await rmdir(lock);
		} catch (error) {
			failures.push(`Release mesh rotation lock ${lock}: ${error instanceof Error ? error.message : "failed"}`);
		}
	}
	if (failures.length) throw new Error(failures.join("; "));
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
	console.log("This check does not repair, truncate, move or restore ledgers.");
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

async function status(
	options: MeshOptions,
	launchctl: string | undefined,
	target: string,
	runtime: MeshRuntime,
): Promise<void> {
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
	const config = await meshConfig(options);
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
	const renewal = launchctl ? await runTool(launchctl, ["print", targetOf(renewalOf(options))], options) : undefined;
	if (renewal) console.log(`Credential renewal: ${renewal.code === 0 ? "scheduled" : "absent"}`);
	const rotation = launchctl ? await runTool(launchctl, ["print", targetOf(rotationOf(options))], options) : undefined;
	if (rotation) console.log(`Credential rotation: ${rotation.code === 0 ? "scheduled" : "absent"}`);
	const rotationExit =
		rotation?.code === 0 ? /^\s*last exit code = (-?\d+)(?:: [^\r\n]+)?\s*$/m.exec(rotation.stdout)?.[1] : undefined;
	if (rotationExit !== undefined) console.log(`Credential rotation last exit code: ${rotationExit}`);
	let credentialsUnavailable = false;
	let rotationOverdue = false;
	for (const file of SYSTEM_CREDENTIAL_FILES) {
		try {
			const cred = await systemCredential(options, config.space, file);
			console.log(`$SYS ${file} last rotation: ${new Date(cred.iat * 1000).toString()}`);
			console.log(`$SYS ${file} expires: ${new Date(cred.exp * 1000).toString()}`);
			const due = cred.iat + 0.75 * (cred.exp - cred.iat);
			if (runtime.now() / 1000 > due + 26 * 60 * 60) rotationOverdue = true;
		} catch {
			console.log(`$SYS ${file}: unreadable`);
			credentialsUnavailable = true;
		}
	}
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
	const renewalLog = join(options.meshHome, "renewal.log");
	console.log(`Renewal log: ${existsSync(renewalLog) ? (await lstat(renewalLog)).size : 0} bytes`);
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
	if (renewal && renewal.code !== 0) throw new Error("Mesh credential renewal job is absent; reinstall the mesh");
	if (rotation && rotation.code !== 0) throw new Error("Mesh credential rotation job is absent; reinstall the mesh");
	if (existsSync(rotationBootPath(options)))
		throw new Error(
			"Temporary rotation plist remains; a rotation is in progress or needs recovery. Uninstall and reinstall the mesh only after confirming no rotation is running.",
		);
	if (rotationOverdue)
		throw new Error(
			`Mesh $SYS credential rotation is over 26 hours overdue; inspect ${join(options.meshHome, "rotation.log")} and ${join(options.meshHome, "rotation.lock")}`,
		);
	if (credentialsUnavailable) throw new Error("Mesh $SYS credential lifetimes are unavailable");
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
		if (command === "doctor") {
			await requireCotalVersion(await executable("cotal"), options);
			ledgerUnhealthy = reportLedgerHealth();
		}
		const launchctl = runtime.platform === "darwin" ? await executable("launchctl") : undefined;
		const target = targetOf(options);
		if (command === "status" || command === "doctor") {
			await status(options, launchctl, target, runtime);
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
		if (command === "rotate") {
			await rotate(options, launchctl, runtime);
			return;
		}
		const toolOptions = { ...options, meshHome: homedir() };
		const job = await runTool(launchctl, ["print", target], toolOptions);
		const plists = [options.plist, renewalOf(options).plist, rotationOf(options).plist];
		if (!(command === "uninstall" && job.code === 113 && plists.some((plist) => existsSync(plist)))) {
			requireSuccess(job, "Mesh launchd service lookup");
		}
		switch (command) {
			case "uninstall":
				await removeJobs(launchctl, options, runtime);
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
