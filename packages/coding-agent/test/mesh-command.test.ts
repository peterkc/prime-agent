import {
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
import { join } from "node:path";
import { dmDurable } from "@cotal-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCommandHelp } from "../src/cli/command-registry.js";
import { runMeshCommand } from "../src/cli/mesh-command.js";
import { handlePublicCommand } from "../src/cli/public-command.js";
import { ENV_AGENT_DIR } from "../src/config.js";

const seed = `S${"A".repeat(57)}`;
const fakeTool = String.raw`#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { basename, join } = require("node:path");
const { execFileSync } = require("node:child_process");
const root = process.env.MESH_FIXTURE_ROOT;
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(join(root, "control.json"), "utf8"));
appendFileSync(join(root, "events.jsonl"), JSON.stringify({ tool, args, cwd: process.cwd(), home: process.env.COTAL_HOME }) + "\n");
const loaded = join(root, "loaded");
if (tool === "launchctl") {
  if (args[0] === "print") { console.log("state = running"); if (existsSync(join(root, "removing"))) { unlinkSync(join(root, "removing")); unlinkSync(loaded); process.exit(0); } process.exit(existsSync(loaded) ? 0 : 113); }
  if (control.fail === args[0]) { console.error(control.seed); process.exit(2); }
  if (args[0] === "bootstrap") {
    const plist = readFileSync(args[2], "utf8");
    const decode = x => x.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
    const cwd = decode(/<key>WorkingDirectory<\/key><string>(.*?)<\/string>/.exec(plist)[1]);
    const home = decode(/<key>COTAL_HOME<\/key><string>(.*?)<\/string>/.exec(plist)[1]);
    const argv = [.../<key>ProgramArguments<\/key><array>(.*?)<\/array>/.exec(plist)[1].matchAll(/<string>(.*?)<\/string>/g)].map(m => decode(m[1]));
    if (!existsSync(join(cwd, "mesh.json"))) process.exit(3);
    execFileSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, COTAL_HOME: home } });
    writeFileSync(loaded, "yes");
  }
  if (args[0] === "bootout") { if (!existsSync(loaded)) process.exit(3); if (control.deferredBootout) writeFileSync(join(root, "removing"), "yes"); else unlinkSync(loaded); }
} else {
  if (control.fail === args[0]) { console.error(control.seed); process.exit(2); }
  if (args[0] === "up") writeFileSync("auth", "ready");
  if (args[0] === "status") { console.log(control.notReady ? "  broker  registered" : "  broker  serving · registered"); console.log(control.seed); process.exit(1); }
  if (args[0] === "mint") {
    if (!existsSync("auth")) process.exit(4);
    writeFileSync(args[3], control.seed, { mode: 0o600 });
    console.log(control.seed);
  }
  if (args[0] === "deliver") { console.log(control.invalidCounts ? "{broken" : JSON.stringify({ pending: 3, ackPending: 2 })); console.log("message-id sender message-content " + control.seed); }
  if (args[0] === "doctor") console.log(control.seed);
}
`;
interface Event {
	tool: string;
	args: string[];
	cwd: string;
	home: string;
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
	await runMeshCommand([name, "--label", "ai.prime.mesh.test", "--server", server, ...options], {
		...clock,
		wait: async (ms) => {
			now += control.notReady ? 30_000 : ms;
		},
	});
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
		for (const tool of ["launchctl", "cotal"]) writeFileSync(join(root, "bin", tool), fakeTool, { mode: 0o700 });
		vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
		vi.stubEnv("HOME", root);
		vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
		vi.stubEnv("COTAL_SKIP_CONNECTOR_SEED", "1");
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

	it("installs in order, accepts serving with exit 1, and preserves an existing signer", async () => {
		await command("install", "--mesh-home", mesh);
		expect(process.exitCode).toBeUndefined();
		expect(events().map((event) => `${event.tool} ${event.args[0]}`)).toEqual([
			"launchctl print",
			"launchctl bootstrap",
			"cotal up",
			"cotal status",
			"cotal mint",
		]);
		expect(JSON.parse(readFileSync(join(mesh, "mesh.json"), "utf8"))).toEqual({ space: "prime", server });
		const job = readFileSync(plist, "utf8");
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
		expect(readFileSync(join(mesh, "signer.json"), "utf8")).toBe(seed);
		await command("uninstall");
		await command("install");
		expect(events().filter((event) => event.args[0] === "mint")).toHaveLength(1);
		for (const event of events().filter((event) => event.tool === "cotal"))
			expect(event).toMatchObject({ cwd: mesh, home: join(mesh, "home") });
		expect(output()).not.toContain(seed);
	});

	it.each(["bootstrap", "readiness", "mint"])("cleans a failed %s step and retains the mesh home", async (step) => {
		configure(step === "readiness" ? { notReady: true } : { fail: step });
		await command("install");
		expect(process.exitCode).toBe(1);
		expect(output()).toMatch(/failed|30 seconds/);
		expect(
			events()
				.slice(-2)
				.map((event) => event.args[0]),
		).toEqual(["bootout", "print"]);
		expect(existsSync(plist)).toBe(false);
		expect(existsSync(join(root, "loaded"))).toBe(false);
		expect(existsSync(mesh)).toBe(true);
		expect(output()).not.toContain(seed);
	});

	it.each(["label", "port"])("refuses an occupied %s before creating mesh files", async (occupied) => {
		const socket = createServer();
		try {
			if (occupied === "label") writeFileSync(join(root, "loaded"), "yes");
			else {
				await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
				const address = socket.address();
				if (!address || typeof address === "string") throw new Error("No port");
				server = `nats://127.0.0.1:${address.port}`;
			}
			await command("install");
			expect(process.exitCode).toBe(1);
			expect(existsSync(mesh)).toBe(false);
			expect(events()).toHaveLength(1);
		} finally {
			if (socket.listening) await new Promise<void>((closed) => socket.close(() => closed()));
		}
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

	it("reports store bytes and only unacknowledged counts, and diagnoses auth", async () => {
		await command("install");
		const store = join(mesh, ".cotal", "nats", "jetstream", "nested");
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "a"), "a".repeat(37));
		writeFileSync(join(store, "b"), "b".repeat(5));
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
		expect(output()).toContain("Store: 42 bytes");
		expect(output()).toContain("Session session-a: 5 unacknowledged");
		expect(output()).toContain("Auth: healthy");
		const pending = events().filter((event) => event.args[0] === "deliver");
		expect(pending.map((event) => event.args)).toEqual(
			Array(2).fill([
				"deliver",
				"pending",
				"session-a",
				"--durable",
				dmDurable("local", "UABC", "0123456789abcdefghijklmnop"),
				"--json",
			]),
		);
		expect(output()).not.toMatch(/message-id|sender|message-content|UABC|0123456789abcdefghijklmnop/);
		expect(output()).not.toContain(seed);
	});

	it.each(["record", "counts", "broker", "auth"])(
		"reports a failed %s diagnosis without secret content",
		async (broken) => {
			await command("install");
			mkdirSync(join(mesh, "enrollments"));
			writeFileSync(
				join(mesh, "enrollments", "bad.json"),
				broken === "record"
					? `{${seed}`
					: JSON.stringify({
							sessionId: "bad",
							identity: { id: "UABC", seed },
							lifecycleUid: "0123456789abcdefghijklmnop",
						}),
			);
			configure({
				invalidCounts: broken === "counts",
				notReady: broken === "broker",
				fail: broken === "auth" ? "doctor" : "",
			});
			await command("doctor");
			expect(process.exitCode).toBe(1);
			expect(output()).not.toContain(seed);
			expect(output()).toMatch(/unreadable|invalid counts|not serving|doctor auth failed/);
		},
	);

	it.each(["uninstall", "start", "stop", "status", "doctor"])("fails %s when the service is absent", async (name) => {
		mkdirSync(mesh, { recursive: true });
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
		expect(existsSync(mesh)).toBe(false);
	});

	it.each([
		{ args: ["wrong"] },
		{ args: ["install", "--unknown", "x"] },
		{ args: ["install", "--label", "../x"] },
		{ args: ["install", "--server", "https://127.0.0.1"] },
		{ args: ["install", "--server"] },
		{ args: ["install", "--label", "x", "--label", "x"] },
	])("rejects malformed arguments $args without effects", async ({ args }) => {
		await runMeshCommand(args, clock);
		expect(process.exitCode).toBe(1);
		expect(events()).toEqual([]);
		expect(existsSync(mesh)).toBe(false);
	});

	it("routes public mesh help and status without starting an agent", async () => {
		await command("install");
		const result = await handlePublicCommand(["mesh", "status", "--label", "ai.prime.mesh.test"]);
		expect(result.handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
		expect(output()).toContain("Broker: serving");
		expect(formatCommandHelp(["mesh"])).toContain("mesh <install|uninstall|start|stop|status|doctor>");
		for (const name of ["install", "uninstall", "start", "stop", "status", "doctor"])
			expect(formatCommandHelp(["mesh", name])).toContain(`mesh ${name}`);
		expect(readdirSync(join(root, "agent"))).toEqual(["mesh"]);
	});
});
