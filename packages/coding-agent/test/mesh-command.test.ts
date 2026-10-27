import * as subprocessTools from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dmDurable } from "@cotal-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCommandHelp } from "../src/cli/command-registry.js";
import { runMeshCommand } from "../src/cli/mesh-command.js";
import { handlePublicCommand } from "../src/cli/public-command.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { RLM_LEDGER_DIR } from "../src/modes/daemon/rlm-ledger.js";

vi.mock("node:child_process", async (original) => {
	const tools = await original<typeof subprocessTools>();
	return { ...tools, execFile: vi.fn(tools.execFile) };
});

const seed = `S${"A".repeat(57)}`;
const fakeTool = String.raw`#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { execFileSync } = require("node:child_process");
const root = process.env.MESH_FIXTURE_ROOT;
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(join(root, "control.json"), "utf8"));
let cotalRoot = process.cwd();
while (!existsSync(join(cotalRoot, ".cotal")) && dirname(cotalRoot) !== cotalRoot) cotalRoot = dirname(cotalRoot);
appendFileSync(join(root, "events.jsonl"), JSON.stringify({ tool, args, cotalRoot, cwd: process.cwd(), home: process.env.COTAL_HOME, skipSeed: process.env.COTAL_SKIP_CONNECTOR_SEED }) + "\n");
const job = args[0] === "bootstrap" ? /<key>Label<\/key><string>(.*?)<\/string>/.exec(readFileSync(args[2], "utf8"))[1] : String(args.at(-1));
const loaded = join(root, job.endsWith(".rotate") ? "loaded-rotate" : job.endsWith(".renew") ? "loaded-renew" : "loaded");
const stalled = (control.stalledBootout === true && !job.endsWith(".rotate")) || (control.stalledBootout === "renew" && job.endsWith(".renew"));
if (tool === "launchctl") {
  if (args[0] === "print") { console.log("state = running\nlast exit code = 78" + (control.symbolicExit ? ": EX_CONFIG" : "")); if (existsSync(loaded) && (stalled || existsSync(join(root, "removing"))) && !existsSync(join(root, "Library", "LaunchAgents", "ai.prime.mesh.test.plist"))) process.exit(2); if (existsSync(join(root, "removing"))) { unlinkSync(join(root, "removing")); unlinkSync(loaded); process.exit(0); } process.exit(existsSync(loaded) ? 0 : 113); }
  if (control.fail === args[0]) { console.error(control.seed); process.exit(2); }
  if (args[0] === "bootstrap") {
    if ((control.failRenewBootstrap && job.endsWith(".renew")) || (control.failRotateBootstrap && job.endsWith(".rotate")) || (control.failRestart && existsSync(join(root, "rotated")) && !job.endsWith(".renew"))) process.exit(5);
    const plist = readFileSync(args[2], "utf8");
    if (args[2].endsWith("rotation-boot.plist")) writeFileSync(join(root, "rotation-boot-copy.plist"), plist);
    const decode = x => x.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
    const cwd = decode(/<key>WorkingDirectory<\/key><string>(.*?)<\/string>/.exec(plist)[1]);
    const home = decode(/<key>COTAL_HOME<\/key><string>(.*?)<\/string>/.exec(plist)[1]);
    const argv = [.../<key>ProgramArguments<\/key><array>(.*?)<\/array>/.exec(plist)[1].matchAll(/<string>(.*?)<\/string>/g)].map(m => decode(m[1]));
    if (!existsSync(join(cwd, "mesh.json")) || !existsSync(join(cwd, ".cotal"))) process.exit(3);
    if (!job.endsWith(".rotate")) execFileSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, COTAL_HOME: home } });
    writeFileSync(loaded, "yes");
  }
  if (args[0] === "bootout") { if (!existsSync(loaded)) process.exit(3); if (stalled) process.exit(3); if (control.deferredBootout) writeFileSync(join(root, "removing"), "yes"); else unlinkSync(loaded); if (control.bootoutNonzero) process.exit(3); }
} else {
  if (control.fail === args[0]) { console.error(control.seed); process.exit(2); }
  if (args[0] === "--version") { console.log(control.versionOutput ?? "cotal-ai 0.79.0\n  adapter test 9.9.9"); process.exit(0); }
  if (args[0] === "up") {
    if (args.includes("--rotate-sys") && control.failRotate) process.exit(6);
    if (args.includes("--rotate-sys")) writeFileSync(join(root, "rotated"), "yes");
    writeFileSync("auth", "ready");
    writeFileSync(join(cotalRoot, ".cotal", "nats.pid"), "42");
    if (!existsSync(join(cotalRoot, ".cotal", "space.7072696d65")) || (args.includes("--rotate-sys") && !control.staleRotation)) {
      const dir = join(cotalRoot, ".cotal", "space.7072696d65"); mkdirSync(dir, { recursive: true });
      const iat = Math.floor((control.credentialNow ?? 0) / 1000);
      const jwt = "e30." + Buffer.from(JSON.stringify({ iat, exp: iat + 2592000 })).toString("base64url") + ".c2ln";
      for (const file of ["membership-observer.creds", "connection-evictor.creds"]) writeFileSync(join(dir, file), "-----BEGIN NATS USER JWT-----\n" + jwt + "\n------END NATS USER JWT------\n" + control.seed);
    }
  }
  if (args[0] === "status" && control.interruptedStatus && !existsSync(join(root, "interrupted"))) {
    writeFileSync(join(root, "interrupted"), "yes");
    process.stdout.write("x".repeat(2 * 1024 * 1024)); return;
  }
  if (args[0] === "status") { const foreign = control.foreignBroker && !args.includes(control.foreignBroker === "server" ? control.expectedServer : "prime"); console.log(control.foreignBroker ? foreign ? "  broker  serving · registered elsewhere" : "  broker  registered" : control.notReady ? "  broker  registered" : "  broker  serving · registered"); console.log(control.seed); process.exit(1); }
  if (args[0] === "mint") {
    if (!existsSync("auth")) process.exit(4);
    writeFileSync(args[3], control.seed, { mode: 0o600 });
    console.log(control.seed);
  }
  if (args[0] === "deliver") { if (args[2] === control.failedSession) process.exit(1); console.log(control.invalidCounts ? "{broken" : JSON.stringify({ pending: 3, ackPending: 2 })); console.log("message-id sender message-content " + control.seed); }
  if (args[0] === "doctor") console.log(control.seed);
}
`;
interface Event {
	tool: string;
	args: string[];
	cwd: string;
	home: string;
	skipSeed: string;
	cotalRoot: string;
}
let root: string;
let mesh: string;
let plist: string;
let server: string;
let control: Record<string, unknown>;
let now = 0;
const clock = {
	platform: "darwin" as const,
	now: () => now,
	wait: async (ms: number) => {
		now += ms;
	},
};
function configure(values: Record<string, unknown> = {}): void {
	control = { seed, ...control, ...values };
	writeFileSync(join(root, "control.json"), JSON.stringify(control));
}
function events(): Event[] {
	return existsSync(join(root, "events.jsonl"))
		? readFileSync(join(root, "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}
function output(): string {
	return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join("\n");
}
async function command(name: string, ...options: string[]): Promise<void> {
	process.exitCode = undefined;
	configure({ credentialNow: now });
	await runMeshCommand([name, "--label", "ai.prime.mesh.test", "--server", server, ...options], {
		...clock,
		processAlive: () => existsSync(join(mesh, ".cotal", "nats.pid")),
		wait: async (ms) => {
			now += control.notReady
				? 30_000
				: control.stalledBootout || control.holdPid
					? 15_000
					: name === "rotate"
						? 1000
						: ms;
			if (name === "rotate" && !control.holdPid) rmSync(join(mesh, ".cotal", "nats.pid"), { force: true });
			configure({ credentialNow: now });
		},
	});
}
function credentials(ageDays: number, file = "membership-observer.creds"): void {
	const iat = now / 1000 - ageDays * 86400;
	const jwt = `e30.${Buffer.from(JSON.stringify({ iat, exp: iat + 2592000 })).toString("base64url")}.c2ln`;
	writeFileSync(
		join(mesh, ".cotal", "space.7072696d65", file),
		`-----BEGIN NATS USER JWT-----
${jwt}
------END NATS USER JWT------
${seed}`,
	);
}

async function freePort(): Promise<number> {
	const socket = createServer();
	try {
		await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
		const address = socket.address();
		if (!address || typeof address === "string") throw new Error("No test port");
		return address.port;
	} finally {
		await new Promise<void>((closed, reject) => socket.close((error) => (error ? reject(error) : closed())));
	}
}

describe("mesh command", () => {
	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "mesh-command-")));
		mesh = join(root, "agent", "mesh");
		plist = join(root, "Library", "LaunchAgents", "ai.prime.mesh.test.plist");
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, ".cotal"));
		for (const tool of ["launchctl", "cotal", "prime-agent"])
			writeFileSync(join(root, "bin", tool), fakeTool, { mode: 0o700 });
		vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
		vi.stubEnv("HOME", root);
		vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
		vi.stubEnv("PATH", join(root, "bin"));
		vi.stubEnv("MESH_FIXTURE_ROOT", root);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		control = {};
		now = 0;
		configure();
		server = `nats://127.0.0.1:${await freePort()}`;
	});
	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		["matching", "cotal-ai 0.79.0\n  adapter test 9.9.9", undefined],
		["mismatch", "cotal-ai 0.80.0\n  adapter test 0.79.0", undefined],
		["malformed", "not a version\n  adapter test 0.79.0", undefined],
		["failed", "cotal-ai 0.79.0", "--version"],
	] as const)("AC-39 checks the CLI header before effects (%s)", async (kind, versionOutput, fail) => {
		configure({ versionOutput, fail });
		expect(existsSync(mesh)).toBe(false);
		await command("install");
		const matches = kind === "matching";
		expect(process.exitCode).toBe(matches ? undefined : 1);
		expect(existsSync(mesh)).toBe(matches);
		expect(existsSync(plist)).toBe(matches);
		expect(events().find((event) => event.args[0] === "--version")?.cwd).toBe(root);
		if (!matches) {
			expect(events().map((event) => event.args[0])).toEqual(["print", "print", "print", "--version"]);
			expect(output()).toContain("required 0.79.0");
			expect(output()).toContain(kind === "mismatch" ? "0.80.0" : kind === "failed" ? "exit 2" : "unrecognized");
			mkdirSync(join(mesh, ".cotal"), { recursive: true });
			writeFileSync(join(mesh, "mesh.json"), JSON.stringify({ space: "prime", server }));
			for (const job of ["loaded", "loaded-renew", "loaded-rotate"]) writeFileSync(join(root, job), "yes");
			mkdirSync(join(mesh, ".cotal", "space.7072696d65"), { recursive: true });
			for (const file of ["membership-observer.creds", "connection-evictor.creds"]) credentials(0, file);
		}
		rmSync(join(root, "events.jsonl"));
		await command("doctor");
		expect(process.exitCode).toBe(matches ? undefined : 1);
		expect(events().some((event) => event.args[0] === "doctor")).toBe(matches);
		if (!matches) expect(events().map((event) => event.args[0])).toEqual(["--version"]);
		if (!matches) expect(output()).not.toContain("RLM ledger health");
		vi.mocked(console.log).mockClear();
		vi.mocked(console.error).mockClear();
		await command("status");
		expect(process.exitCode).toBe(kind === "failed" || kind === "malformed" ? 1 : undefined);
		expect(output()).toContain(
			kind === "failed" || kind === "malformed"
				? "Cannot read cotal CLI version"
				: `Cotal CLI: ${kind === "mismatch" ? "0.80.0" : "0.79.0"}`,
		);
		expect(output()).not.toContain(seed);
		const source = readFileSync(new URL("../src/cli/mesh-command.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["'](?:@cotal-ai|@nats-io|nats)/);
	});

	it("installs in order, accepts serving with exit 1, and preserves an existing signer", async () => {
		await command("install", "--mesh-home", mesh);
		expect(process.exitCode).toBeUndefined();
		expect(events().map((event) => `${event.tool} ${event.args[0]}`)).toEqual([
			"launchctl print",
			"launchctl print",
			"launchctl print",
			"cotal --version",
			"launchctl bootstrap",
			"cotal up",
			"cotal status",
			"cotal mint",
			"launchctl bootstrap",
			"cotal doctor",
			"launchctl bootstrap",
		]);
		const renewal = readFileSync(join(dirname(plist), "ai.prime.mesh.test.renew.plist"), "utf8");
		expect(renewal).toContain("<string>doctor</string><string>auth</string><string>--fix</string>");
		expect(renewal).toContain("<key>StartInterval</key><integer>600</integer>");
		expect(JSON.parse(readFileSync(join(mesh, "mesh.json"), "utf8"))).toEqual({ space: "prime", server });
		const job = readFileSync(plist, "utf8");
		expect(lstatSync(plist).mode & 0o777).toBe(0o600);
		for (const fragment of [
			`<key>Label</key><string>ai.prime.mesh.test</string>`,
			`<key>WorkingDirectory</key><string>${mesh}</string>`,
			`<key>COTAL_HOME</key><string>${join(mesh, "home")}</string>`,
			`<key>HOME</key><string>${root}</string>`,
			`<key>PATH</key><string>${join(root, "bin")}</string>`,
			`<key>XDG_CONFIG_HOME</key><string>${join(root, "config")}</string>`,
			`<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>`,
			`<key>RunAtLoad</key><true/>`,
			`<key>COTAL_SKIP_CONNECTOR_SEED</key><string>1</string>`,
		])
			expect(job).toContain(fragment);
		expect(events().find((event) => event.args[0] === "up")?.args).toEqual([
			"up",
			"--space",
			"prime",
			"--server",
			server,
			"--no-manager",
		]);
		expect(lstatSync(mesh).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(mesh, ".cotal")).mode & 0o777).toBe(0o700);
		expect(readFileSync(join(mesh, "signer.json"), "utf8")).toBe(seed);
		await command("uninstall");
		await command("install");
		expect(events().filter((event) => event.args[0] === "mint")).toHaveLength(1);
		for (const event of events().filter((event) => event.tool === "cotal" && event.args[0] !== "--version"))
			expect(event).toMatchObject({ cwd: mesh, cotalRoot: mesh, home: join(mesh, "home"), skipSeed: "1" });
		expect(output()).not.toContain(seed);
	});

	it.each(["bootstrap", "readiness", "mint"])("cleans a failed %s step and retains the mesh home", async (step) => {
		configure(step === "readiness" ? { notReady: true } : { fail: step });
		await command("install");
		expect(process.exitCode).toBe(1);
		expect(output()).toMatch(/failed|30 seconds/);
		if (step === "readiness") expect(output()).toContain(join(mesh, "service.log"));
		expect(
			events()
				.slice(-2)
				.map((event) => event.args[0]),
		).toEqual(["bootout", "print"]);
		expect(existsSync(plist)).toBe(false);
		expect(existsSync(join(dirname(plist), "ai.prime.mesh.test.renew.plist"))).toBe(false);
		expect(existsSync(join(root, "loaded"))).toBe(false);
		expect(existsSync(mesh)).toBe(true);
		expect(output()).not.toContain(seed);
	});

	it("removes both launchd jobs when the renewal job fails to load", async () => {
		configure({ failRenewBootstrap: true });
		await command("install");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain("launchctl bootstrap failed (exit 5)");
		expect(events().filter((event) => event.args[0] === "bootstrap")).toHaveLength(2);
		expect(readdirSync(dirname(plist))).toEqual([]);
		expect(existsSync(join(root, "loaded"))).toBe(false);
	});

	it.each(["label", "port", "wildcard", "plist"])(
		"refuses an occupied %s before creating mesh files",
		async (occupied) => {
			const socket = createServer();
			try {
				if (occupied === "label") writeFileSync(join(root, "loaded"), "yes");
				else if (occupied === "plist") {
					mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
					writeFileSync(plist, "retained");
				} else {
					await new Promise<void>((ready) =>
						socket.listen(0, occupied === "wildcard" ? "0.0.0.0" : "127.0.0.1", ready),
					);
					const address = socket.address();
					if (!address || typeof address === "string") throw new Error("No port");
					server = `nats://127.0.0.1:${address.port}`;
				}
				await command("install");
				expect(process.exitCode).toBe(1);
				expect(existsSync(mesh)).toBe(false);
				expect(events()).toHaveLength(occupied === "label" || occupied === "plist" ? 1 : 3);
				if (occupied === "plist") expect(readFileSync(plist, "utf8")).toBe("retained");
			} finally {
				if (socket.listening) await new Promise<void>((closed) => socket.close(() => closed()));
			}
		},
	);

	it.each(["overflow"])("waits through an interrupted %s status probe", async (interruptedStatus) => {
		configure({ interruptedStatus });
		await command("install");
		expect(process.exitCode).toBeUndefined();
		expect(events().filter((event) => event.args[0] === "status")).toHaveLength(2);
		expect(existsSync(join(mesh, "signer.json"))).toBe(true);
	});

	it("never starts a status probe or bootout check with a zero timeout at the deadline", async () => {
		configure({ notReady: true });
		vi.mocked(subprocessTools.execFile).mockClear();
		await runMeshCommand(["install", "--label", "ai.prime.mesh.test", "--server", server], {
			...clock,
			now: () => (now += 15_000),
		});
		const calls = vi.mocked(subprocessTools.execFile).mock.calls;
		expect(calls.filter((call) => call[1]?.[0] === "status").map((call) => call[2]?.timeout)).toEqual([15_000]);
		expect(calls.map((call) => call[2]?.timeout)).not.toContain(0);
		expect(process.exitCode).toBe(1);
	});

	it.each([
		["uninstall", true],
		["rollback", true],
		["uninstall", "renew"],
	] as const)("retains only the unconfirmed plist when %s cannot confirm bootout (%s)", async (step, stalled) => {
		if (step === "uninstall") await command("install");
		configure({ stalledBootout: stalled, fail: step === "rollback" ? "mint" : "" });
		await command(step === "rollback" ? "install" : "uninstall");
		expect(process.exitCode).toBe(1);
		expect(existsSync(plist)).toBe(stalled === true);
		expect(existsSync(join(root, "loaded"))).toBe(stalled === true);
		// Rollback after a failed mint has no renewal job to stall.
		expect(existsSync(plist.replace(".plist", ".renew.plist"))).toBe(step === "uninstall");
		expect(now).toBe(step === "uninstall" && stalled === true ? 60_000 : 30_000);
		const label = stalled === true ? "ai.prime.mesh.test" : "ai.prime.mesh.test.renew";
		expect(output()).toContain(`${label}: Mesh launchd service is still loaded after bootout`);
		if (step === "rollback") expect(output()).toContain("cotal mint --signer failed (exit 2); rollback incomplete:");
	});

	it.each(["absent-label", "absent-plist", "nonzero-bootout", "absent-main"])("uninstalls with %s", async (state) => {
		await command("install");
		if (state === "absent-label" || state === "absent-main") rmSync(join(root, "loaded"));
		if (state === "absent-plist" || state === "absent-main") rmSync(plist);
		configure({ bootoutNonzero: state === "nonzero-bootout" });
		await command("uninstall");
		expect(process.exitCode).toBeUndefined();
		expect(readdirSync(dirname(plist))).toEqual([]);
		expect(readdirSync(root)).not.toContain("loaded-renew");
		expect(existsSync(join(root, "loaded"))).toBe(false);
	});

	it("uninstalls an install from before the renewal agent", async () => {
		await command("install");
		rmSync(join(root, "loaded-renew"));
		rmSync(plist.replace(".plist", ".renew.plist"));
		await command("uninstall");
		expect(process.exitCode).toBeUndefined();
		expect(readdirSync(dirname(plist))).toEqual([]);
		expect(existsSync(join(root, "loaded"))).toBe(false);
	});

	it.each(["install", "uninstall", "start", "stop"])("refuses %s on linux without calling tools", async (name) => {
		await runMeshCommand([name, "--label", "ai.prime.mesh.test", "--server", server], {
			...clock,
			platform: "linux",
		});
		expect(process.exitCode).toBe(1);
		expect(output()).toContain("linux");
		expect(events()).toEqual([]);
		expect(existsSync(mesh)).toBe(false);
	});

	it("starts, stops, uninstalls and keeps enrollments and signer", async () => {
		await command("install");
		mkdirSync(join(mesh, "enrollments"));
		writeFileSync(join(mesh, "enrollments", "retained.json"), "retained");
		await command("start");
		await command("stop");
		configure({ deferredBootout: true });
		await command("uninstall");
		expect(process.exitCode).toBeUndefined();
		expect(
			events()
				.filter((event) => ["kickstart", "kill", "bootout"].includes(event.args[0]!))
				.map((event) => event.args),
		).toEqual([
			["kickstart", `gui/${process.getuid!()}/ai.prime.mesh.test`],
			["kill", "SIGTERM", `gui/${process.getuid!()}/ai.prime.mesh.test`],
			["bootout", `gui/${process.getuid!()}/ai.prime.mesh.test.rotate`],
			["bootout", `gui/${process.getuid!()}/ai.prime.mesh.test.renew`],
			["bootout", `gui/${process.getuid!()}/ai.prime.mesh.test`],
		]);
		expect(existsSync(plist)).toBe(false);
		expect(existsSync(join(root, "loaded"))).toBe(false);
		expect(existsSync(join(mesh, "signer.json"))).toBe(true);
		expect(readFileSync(join(mesh, "enrollments", "retained.json"), "utf8")).toBe("retained");
		expect(
			events()
				.slice(-3)
				.map((event) => event.args[0]),
		).toEqual(["bootout", "print", "print"]);
	});

	it.each([
		["status", "broker"],
		["doctor", "broker"],
		["doctor", "launchctl"],
		["status", "cotal"],
		["status", "home"],
		["status", "serving"],
		["doctor", "serving"],
	])("reports all ledger failures in %s with %s unavailable or checked", async (name, unavailable) => {
		const agent = join(root, "agent");
		const files = [
			[`${RLM_LEDGER_DIR}/bad-a.jsonl`, "broken\n"],
			[`${RLM_LEDGER_DIR}/bad-b.jsonl`, "{}\n"],
			[`${RLM_LEDGER_DIR}/torn.jsonl`, "{torn"],
			["mesh/mesh.json", JSON.stringify({ space: "prime", server })],
			["mesh/.cotal/nats/jetstream/preserved", "inbox"],
		] as const;
		const fixtures = files.filter(([file]) => unavailable !== "home" || !file.startsWith("mesh/"));
		for (const [file, bytes] of fixtures) {
			mkdirSync(dirname(join(agent, file)), { recursive: true });
			writeFileSync(join(agent, file), bytes);
		}
		writeFileSync(join(root, "loaded"), "yes");
		configure({ notReady: unavailable !== "serving" });
		if (unavailable === "cotal" || unavailable === "launchctl") rmSync(join(root, "bin", unavailable));
		const before = readdirSync(agent, { recursive: true, encoding: "utf8" }).sort();
		expect(existsSync(mesh)).toBe(unavailable !== "home");
		await command(name);
		expect(process.exitCode).toBe(1);
		for (const file of ["bad-a.jsonl", "bad-b.jsonl"]) expect(output()).toContain(join(agent, RLM_LEDGER_DIR, file));
		expect(output()).toMatch(/CHECKED.*FAILED/);
		expect(readdirSync(agent, { recursive: true }).sort()).toEqual(before);
		for (const [file, content] of fixtures) expect(readFileSync(join(agent, file), "utf8")).toBe(content);
	});

	it("reports store bytes and only unacknowledged counts, and diagnoses auth", async () => {
		vi.mocked(subprocessTools.execFile).mockClear();
		await command("install");
		const store = join(mesh, ".cotal", "nats", "jetstream", "nested");
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "a"), "a".repeat(37));
		writeFileSync(join(store, "b"), "b".repeat(5));
		for (const [stream, count] of [
			["DM_prime", 2],
			["DLV_prime", 3],
		] as const) {
			for (let i = 0; i < count; i++)
				mkdirSync(join(store, "streams", stream, "obs", `consumer-${i}`), { recursive: true });
			writeFileSync(join(store, "streams", stream, "obs", "not-a-consumer"), "");
		}
		writeFileSync(join(mesh, "service.log"), "l".repeat(17));
		mkdirSync(join(mesh, "enrollments"));
		writeFileSync(
			join(mesh, "enrollments", "session-a.json"),
			JSON.stringify({
				sessionId: "session-a",
				identity: { id: "UABC", seed },
				lifecycleUid: "0123456789abcdefghijklmnop",
			}),
		);
		await command("status");
		await command("doctor");
		expect(process.exitCode).toBeUndefined();
		expect(subprocessTools.execFile).toHaveBeenCalledWith(
			expect.stringContaining("cotal"),
			["status", "--components", "--space", "prime", "--server", server],
			expect.objectContaining({ timeout: 30_000 }),
			expect.any(Function),
		);
		expect(output()).toContain("Store: 42 bytes");
		expect(output()).toContain("Enrolled sessions: 1");
		expect(output()).toContain("DM_prime: 2 consumers / 1000");
		expect(output()).toContain("DLV_prime: 3 consumers / 1000");
		expect(output()).toContain("Service log: 17 bytes");
		expect(output()).toContain("Launchd last exit code: 78");
		expect(output()).toContain("Session session-a: 5 unacknowledged");
		expect(output()).toContain("Auth: healthy");
		for (const event of events().filter((event) => event.tool === "cotal")) expect(event.skipSeed).toBe("1");
		const pending = events().filter((event) => event.args[0] === "deliver");
		expect(pending.map((event) => event.args)).toEqual(
			Array(2).fill([
				"deliver",
				"pending",
				"session-a",
				"--space",
				"prime",
				"--server",
				server,
				"--root",
				mesh,
				"--durable",
				dmDurable("local", "UABC", "0123456789abcdefghijklmnop"),
				"--json",
			]),
		);
		expect(output()).not.toMatch(/message-id|sender|message-content|UABC|0123456789abcdefghijklmnop/);
		expect(output()).not.toContain(seed);
	});

	it("fails status for an install without the credential renewal job", async () => {
		await command("install");
		rmSync(join(root, "loaded-renew"));
		await command("status");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain("Credential renewal: absent");
		expect(output()).toContain("renewal job is absent; reinstall the mesh");
	});

	it("reports the symbolic launchctl last-exit-code form", async () => {
		configure({ symbolicExit: true });
		await command("install");
		await command("status");
		expect(output()).toContain("Launchd last exit code: 78");
	});

	it.each(["record", "counts", "broker", "auth", "pending"])(
		"reports a failed %s diagnosis without secret content",
		async (broken) => {
			await command("install");
			mkdirSync(join(mesh, "enrollments"));
			const record = {
				sessionId: "bad",
				identity: { id: "UABC", seed },
				lifecycleUid: "0123456789abcdefghijklmnop",
			};
			writeFileSync(
				join(mesh, "enrollments", "bad.json"),
				broken === "record" ? `{${seed}` : JSON.stringify(record),
			);
			if (broken === "pending") {
				writeFileSync(join(mesh, "enrollments", "good.json"), JSON.stringify({ ...record, sessionId: "good" }));
			}
			configure({
				failedSession: broken === "pending" ? "bad" : "",
				invalidCounts: broken === "counts",
				notReady: broken === "broker",
				fail: broken === "auth" ? "doctor" : "",
			});
			await command("doctor");
			expect(process.exitCode).toBe(1);
			expect(output()).not.toContain(seed);
			if (broken === "broker") expect(events().filter((event) => event.args[0] === "deliver")).toHaveLength(0);
			if (broken === "pending") {
				expect(output()).toContain("Session bad: count unavailable");
				expect(output()).toContain("Session good: 5 unacknowledged");
			}
			expect(output()).toMatch(/unreadable|invalid counts|not serving|doctor auth failed|counts are unavailable/);
		},
	);

	it.each(["uninstall", "start", "stop", "status", "doctor"])("fails %s when the service is absent", async (name) => {
		mkdirSync(join(mesh, ".cotal"), { recursive: true });
		writeFileSync(join(mesh, "mesh.json"), JSON.stringify({ space: "prime", server }));
		await command(name);
		expect(process.exitCode).toBe(1);
		expect(output()).toMatch(/lookup failed|absent/);
	});

	it.each(["launchctl", "cotal"])("reports a missing %s without creating files", async (tool) => {
		rmSync(join(root, "bin", tool));
		await command("install");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain(`${tool} is missing`);
		expect(output()).not.toContain("help mesh");
		expect(existsSync(mesh)).toBe(false);
	});

	it.each(["status", "doctor"])("refuses %s without a pinned Cotal root", async (name) => {
		mkdirSync(mesh, { recursive: true });
		await command(name);
		expect(process.exitCode).toBe(1);
		expect(events().map((event) => event.args[0])).toEqual(name === "doctor" ? ["--version"] : []);
		expect(output()).toContain("no .cotal directory");
	});

	it.each(["mode", "owner"])("preserves an existing mesh home with unsafe %s", async (unsafe) => {
		mkdirSync(mesh, { recursive: true, mode: 0o700 });
		if (unsafe === "mode") chmodSync(mesh, 0o755);
		else vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
		await command("install");
		expect(process.exitCode).toBe(1);
		expect(lstatSync(mesh).mode & 0o777).toBe(unsafe === "mode" ? 0o755 : 0o700);
		expect(readdirSync(mesh)).toEqual([]);
	});

	it("escapes plist values and pins only absolute PATH entries", async () => {
		mesh += "&";
		vi.stubEnv("PATH", `.:${join(root, "bin")}:relative::`);
		await command("install", "--mesh-home", mesh);
		expect(process.exitCode).toBeUndefined();
		const job = readFileSync(plist, "utf8");
		expect(job).toContain(`<key>WorkingDirectory</key><string>${mesh.replaceAll("&", "&amp;")}</string>`);
		expect(job).toContain(`<key>PATH</key><string>${join(root, "bin")}</string>`);
		expect(events().find((event) => event.args[0] === "up")?.cwd).toBe(mesh);
	});

	it.each(["bin", ".", ""])("ignores relative PATH entry %j", async (entry) => {
		const cwd = process.cwd();
		try {
			process.chdir(root);
			for (const tool of ["launchctl", "cotal"]) writeFileSync(join(root, tool), fakeTool, { mode: 0o700 });
			vi.stubEnv("PATH", entry);
			await command("install");
			expect(process.exitCode).toBe(1);
			expect(events()).toEqual([]);
		} finally {
			process.chdir(cwd);
		}
	});

	it.each(["uninstall", "start", "stop"])("refuses %s on a foreign label without effects", async (name) => {
		const foreign = join(root, "Library", "LaunchAgents", "homebrew.database.plist");
		mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(foreign, "retained");
		writeFileSync(join(root, "loaded"), "yes");
		await runMeshCommand([name, "--label", "homebrew.database"], clock);
		expect(process.exitCode).toBe(1);
		expect(events()).toEqual([]);
		expect(readFileSync(foreign, "utf8")).toBe("retained");
	});

	it.each(["due-observer", "due-evictor", "boundary", "fresh", "manual"])(
		"rotates with the stopped boot contract (%s)",
		async (scenario) => {
			await command("install");
			now = Date.UTC(2026, 10, 1);
			for (const file of ["membership-observer.creds", "connection-evictor.creds"]) credentials(0, file);
			if (scenario.startsWith("due") || scenario === "boundary")
				credentials(
					scenario === "boundary" ? 22.5 : 25,
					scenario === "due-evictor" ? "connection-evictor.creds" : "membership-observer.creds",
				);
			const installed = readFileSync(plist, "utf8");
			rmSync(join(root, "events.jsonl"));
			await command("rotate", ...(scenario === "manual" ? [] : ["--if-due"]));
			expect(process.exitCode).toBeUndefined();
			if (scenario === "fresh") {
				expect(events()).toEqual([]);
				expect(output()).toContain("next due:");
			} else {
				const effects = events().filter((event) =>
					["bootout", "bootstrap", "up", "down", "status"].includes(event.args[0]!),
				);
				expect(effects.map((event) => event.args[0])).toEqual([
					"bootout",
					"bootout",
					"bootstrap",
					"up",
					"status",
					"bootout",
					"bootstrap",
					"up",
					"bootstrap",
					"status",
				]);
				expect(effects.slice(0, 2).map((event) => event.args[1])).toEqual([
					`gui/${process.getuid!()}/ai.prime.mesh.test.renew`,
					`gui/${process.getuid!()}/ai.prime.mesh.test`,
				]);
				expect(effects[3]).toMatchObject({
					args: ["up", "--space", "prime", "--server", server, "--no-manager", "--rotate-sys"],
					cwd: mesh,
					home: join(mesh, "home"),
					skipSeed: "1",
				});
				expect(effects[2]!.args[2]).toBe(join(mesh, "rotation-boot.plist"));
				expect(effects[6]!.args[2]).toBe(plist);
				expect(readFileSync(join(root, "rotation-boot-copy.plist"), "utf8")).toBe(
					installed
						.replace("</array>", "<string>--rotate-sys</string></array>")
						.replace("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>", ""),
				);
				expect(existsSync(join(root, "loaded"))).toBe(true);
				expect(existsSync(join(root, "loaded-renew"))).toBe(true);
				expect(output()).toContain("Earlier full Cotal backups");
			}
			expect(existsSync(join(mesh, "rotation.lock"))).toBe(false);
			expect(existsSync(join(mesh, "rotation-boot.plist"))).toBe(false);
			expect(readFileSync(plist, "utf8")).toBe(installed);
			expect(output()).not.toContain(seed);
		},
	);

	it.each(["boot", "restart", "stale"])("restores jobs and reports a failed rotation step (%s)", async (failure) => {
		await command("install");
		now = Date.UTC(2026, 10, 1);
		configure({
			failRotate: failure === "boot",
			failRestart: failure === "restart",
			staleRotation: failure === "stale",
		});
		rmSync(join(root, "events.jsonl"));
		await command("rotate");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain(
			failure === "boot"
				? "start rotation broker"
				: failure === "restart"
					? "restart ai.prime.mesh.test"
					: "verify rotated $SYS credentials",
		);
		expect(events().filter((event) => event.args[0] === "bootstrap")).toHaveLength(3);
		expect(events().some((event) => event.args[0] === "down")).toBe(false);
		expect(existsSync(join(root, "loaded-renew"))).toBe(true);
		expect(existsSync(join(root, "loaded"))).toBe(failure !== "restart");
		expect(existsSync(join(mesh, "rotation.lock"))).toBe(false);
		expect(output()).not.toContain(seed);
	});

	it.each(["server", "space"])(
		"does not accept a different %s's serving broker during install",
		async (foreignBroker) => {
			configure({ foreignBroker, expectedServer: server, notReady: true });
			await command("install");
			expect(process.exitCode).toBe(1);
			expect(output()).toContain("did not report serving");
			expect(existsSync(join(mesh, "signer.json"))).toBe(false);
			expect(
				events()
					.filter((event) => event.args[0] === "status")
					.map((event) => event.args),
			).toEqual([["status", "--components", "--space", "prime", "--server", server]]);
		},
	);

	it("waits for root process death and refuses a second boot while a Cotal pid stays live", async () => {
		await command("install");
		configure({ holdPid: true });
		rmSync(join(root, "events.jsonl"));
		await command("rotate");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain("wait for Cotal processes to stop");
		expect(events().some((event) => event.args.includes(join(mesh, "rotation-boot.plist")))).toBe(false);
		expect(now).toBe(30_000);
	});

	it("reports and uninstalls a leftover temporary rotation job", async () => {
		await command("install");
		writeFileSync(join(mesh, "rotation-boot.plist"), "leftover");
		await command("status");
		expect(process.exitCode).toBe(1);
		expect(output()).toContain("Temporary rotation plist remains");
		await command("uninstall");
		expect(process.exitCode).toBeUndefined();
		expect(existsSync(join(mesh, "rotation-boot.plist"))).toBe(false);
	});

	it.each(["missing", "garbled", "lock", "duplicate-jwt"])(
		"refuses rotation before stopping anything (%s)",
		async (failure) => {
			await command("install");
			const cred = join(mesh, ".cotal", "space.7072696d65", "connection-evictor.creds");
			if (failure === "missing") rmSync(cred);
			if (failure === "garbled")
				writeFileSync(
					cred,
					`-----BEGIN NATS USER JWT-----
e30.eyJleHAiOiJzZWNyZXQifQ.c2ln
------END NATS USER JWT------
${seed}`,
				);
			if (failure === "lock") mkdirSync(join(mesh, "rotation.lock"));
			if (failure === "duplicate-jwt")
				writeFileSync(cred, `${readFileSync(cred, "utf8")}\n${readFileSync(cred, "utf8")}`);
			rmSync(join(root, "events.jsonl"));
			await command("rotate");
			expect(process.exitCode).toBe(1);
			expect(events()).toEqual([]);
			expect(output()).toContain(failure === "lock" ? "rotation lock" : "Cannot read $SYS credential lifetime");
			expect(output()).not.toContain(seed);
		},
	);

	it.each(["healthy", "bootstrap", "occupied", "absent-status", "older-install"])(
		"owns the third rotation job (%s)",
		async (scenario) => {
			configure({ failRotateBootstrap: scenario === "bootstrap" });
			if (scenario === "occupied") writeFileSync(join(root, "loaded-rotate"), "yes");
			await command("install");
			if (scenario === "occupied" || scenario === "bootstrap") {
				expect(process.exitCode).toBe(1);
				expect(output()).toContain(
					scenario === "occupied"
						? "ai.prime.mesh.test.rotate is already loaded"
						: "bootstrap rotation job failed",
				);
				if (scenario === "occupied") expect(existsSync(mesh)).toBe(false);
				else {
					expect(readdirSync(dirname(plist))).toEqual([]);
					expect(events().filter((event) => event.args[0] === "bootout")).toHaveLength(3);
				}
				return;
			}
			const rotation = plist.replace(".plist", ".rotate.plist");
			const job = readFileSync(rotation, "utf8");
			expect(job).toContain(
				`<string>${join(root, "bin", "prime-agent")}</string><string>mesh</string><string>rotate</string><string>--if-due</string><string>--label</string><string>ai.prime.mesh.test</string><string>--server</string><string>${server}</string><string>--mesh-home</string><string>${mesh}</string>`,
			);
			expect(job).toContain(
				"<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>",
			);
			expect(job).toContain(`<key>StandardErrorPath</key><string>${join(mesh, "rotation.log")}</string>`);
			expect(job).not.toContain("<key>RunAtLoad</key>");
			if (scenario !== "healthy") rmSync(join(root, "loaded-rotate"));
			if (scenario === "older-install") rmSync(rotation);
			await command("status");
			expect(process.exitCode).toBe(scenario === "healthy" ? undefined : 1);
			expect(output()).toContain(`Credential rotation: ${scenario === "healthy" ? "scheduled" : "absent"}`);
			expect(output()).toContain("$SYS membership-observer.creds expires:");
			if (scenario !== "healthy") expect(output()).toContain("rotation job is absent; reinstall the mesh");
			await command("uninstall");
			expect(process.exitCode).toBeUndefined();
			expect(readdirSync(dirname(plist))).toEqual([]);
			expect(existsSync(join(root, "loaded-rotate"))).toBe(false);
		},
	);

	it.each([
		{ args: ["wrong"] },
		{ args: ["install", "--unknown", "x"] },
		{ args: ["install", "--label", "../x"] },
		{ args: ["install", "--label", "ai.prime.mesh.a/b"] },
		{ args: ["install", "--label", "ai.prime.mesh.renew"] },
		{ args: ["install", "--label", "ai.prime.mesh.x.rotate"] },
		{ args: ["install", "--if-due"] },
		{ args: ["rotate", "--if-due", "--if-due"] },
		{ args: ["install", "--server", "nats://0.0.0.0:{port}"] },
		{ args: ["install", "--server", "nats://localhost:{port}"] },
		{ args: ["install", "--server", "https://127.0.0.1"] },
		{ args: ["install", "--server"] },
		{ args: ["install", "--label", "x", "--label", "x"] },
	])("rejects malformed arguments $args without effects", async ({ args }) => {
		const options = args.includes("--server") ? args : [...args, "--server", server];
		await runMeshCommand(
			options.map((value) => value.replace("{port}", new URL(server).port)),
			clock,
		);
		expect(process.exitCode).toBe(1);
		expect(output()).toContain('Run "prime-agent help mesh" for usage.');
		expect(events()).toEqual([]);
		expect(existsSync(mesh)).toBe(false);
	});

	it("routes public mesh help and status without starting an agent", async () => {
		await command("install");
		const result = await handlePublicCommand(["mesh", "status", "--label", "ai.prime.mesh.test"]);
		expect(result.handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
		expect(output()).toContain("Broker: serving");
		expect(formatCommandHelp(["mesh"])).toContain("mesh <install|uninstall|start|stop|status|doctor|rotate>");
		for (const name of ["install", "uninstall", "start", "stop", "status", "doctor", "rotate"])
			expect(formatCommandHelp(["mesh", name])).toContain(`mesh ${name}`);
		expect(readdirSync(join(root, "agent"))).toEqual(["mesh"]);
	});
});
