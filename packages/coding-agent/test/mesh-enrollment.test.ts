import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as core from "@cotal-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	claimEnrollment,
	credentialSource,
	directoryPath,
	enrollmentPath,
	ensureEnrollmentRecord,
	publishDirectory,
	readDirectory,
	readSigner,
	redactMeshError,
} from "../src/modes/daemon/cotal/enrollment.js";
import { MeshEndpoints } from "../src/modes/daemon/cotal/mesh-endpoints.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

vi.mock("@cotal-ai/core", async (original) => ({
	...(await original<typeof core>()),
	CotalEndpoint: function (options: core.EndpointOptions) {
		if (!new.target) throw new TypeError("CotalEndpoint requires new");
		return new FakeEndpoint(options);
	},
}));

class FakeEndpoint extends EventEmitter {
	static instances: FakeEndpoint[] = [];
	static failStart = false;
	static afterProvision?: () => void;
	readonly start = vi.fn(async () => {
		if (FakeEndpoint.failStart) throw new Error("start failed");
	});
	readonly stop = vi.fn(async () => undefined);
	readonly provisionDmInbox = vi.fn(async () => FakeEndpoint.afterProvision?.());
	readonly provisionDlvInbox = vi.fn(async () => undefined);
	readonly reissueAcl = vi.fn(async () => undefined);
	constructor(readonly options: core.EndpointOptions) {
		super();
		FakeEndpoint.instances.push(this);
	}
}

const roots: string[] = [];
const meshes: MeshEndpoints[] = [];
afterEach(async () => {
	for (const mesh of meshes.splice(0)) await mesh.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	FakeEndpoint.instances = [];
	FakeEndpoint.failStart = false;
	vi.restoreAllMocks();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-mesh-enrollment-"));
	roots.push(root);
	const meshRoot = join(root, "mesh");
	mkdirSync(meshRoot);
	const auth = core.stripSpaceAuth(await core.createSpaceAuth("prime"));
	writeFileSync(join(meshRoot, "signer.json"), JSON.stringify(auth), { mode: 0o600 });
	writeFileSync(join(meshRoot, "mesh.json"), JSON.stringify({ space: "prime", server: "nats://127.0.0.1:1" }));
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendSessionInfo("root-a");
	const sessionId = session.getSessionId();
	const sessionFile = session.getSessionFile()!;
	const mesh = new MeshEndpoints({ meshRoot, homeSocket: join(root, "daemon.sock"), log: vi.fn(), handoff: vi.fn() });
	meshes.push(mesh);
	return { root, meshRoot, auth, session, sessionId, sessionFile, mesh };
}

describe("mesh enrollment", () => {
	it.each(["mesh.json", "signer.json", "invalid mesh.json", "signer mode"])(
		"keeps the supervisor ready with refusing Cotal mode for %s",
		async (missing) => {
			const { root, meshRoot } = await fixture();
			writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
			const file =
				missing === "invalid mesh.json" ? "mesh.json" : missing === "signer mode" ? "signer.json" : missing;
			if (missing === "invalid mesh.json") writeFileSync(join(meshRoot, file), "{");
			else if (missing === "signer mode") chmodSync(join(meshRoot, file), 0o644);
			else rmSync(join(meshRoot, file));
			const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
				defaultSessionConfig: { cwd: root, agentDir: root },
			});
			const internals = supervisor as unknown as {
				startupComplete: boolean;
				mesh: MeshEndpoints;
				cleanupSupervisorResources(): Promise<void>;
			};
			try {
				await supervisor.start();
				expect(internals.startupComplete).toBe(true);
				await expect(internals.mesh.send({ sessionId: "absent" }, "target", "hello")).rejects.toThrow(
					"not stored: mesh unavailable: Error: Mesh",
				);
				await expect(internals.mesh.send({ sessionId: "absent" }, "target", "hello")).rejects.toThrow(
					join(meshRoot, file),
				);
				expect(FakeEndpoint.instances).toHaveLength(0);
			} finally {
				await internals.cleanupSupervisorResources();
			}
		},
	);

	it.each(["record", "provisioning"])(
		"starts home enrollment after readiness and continues past a failed home %s",
		async (failure) => {
			const { root, meshRoot, sessionId, sessionFile } = await fixture();
			const socket = join(root, "daemon.sock");
			writeFileSync(join(root, "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
			const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			await publishDirectory(meshRoot, record, socket);
			writeFileSync(
				directoryPath(meshRoot, "0"),
				JSON.stringify({ sessionId: "0", name: "bad", principal: "local.bad", homeSocket: socket }),
			);
			const badRecord = { ...record, sessionId: "0" };
			writeFileSync(enrollmentPath(meshRoot, "0"), failure === "record" ? "{" : JSON.stringify(badRecord), {
				mode: 0o600,
			});
			const enroll = MeshEndpoints.prototype.enroll;
			vi.spyOn(MeshEndpoints.prototype, "enroll").mockImplementation(async function (this: MeshEndpoints, id, file) {
				expect(ready).toHaveBeenCalledTimes(1);
				if (failure === "provisioning" && id === "0") FakeEndpoint.failStart = true;
				try {
					return await enroll.call(this, id, file);
				} finally {
					FakeEndpoint.failStart = false;
				}
			});
			const start = vi.spyOn(MeshEndpoints.prototype, "start");
			const supervisor = new DaemonSupervisor(socket, { defaultSessionConfig: { cwd: root, agentDir: root } });
			const internals = supervisor as unknown as {
				startupComplete: boolean;
				mesh: MeshEndpoints;
				log(message: string): void;
				markReady(): void;
				cleanupSupervisorResources(): Promise<void>;
			};
			const log = vi.spyOn(internals, "log");
			const ready = vi.spyOn(internals, "markReady");
			try {
				await supervisor.start();
				expect(internals.startupComplete).toBe(true);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await start.mock.results[0]!.value;
				expect(FakeEndpoint.instances).toHaveLength(failure === "record" ? 2 : 3);
				await expect(internals.mesh.send({ sessionId: "0" }, sessionId, "hello")).rejects.toThrow(
					"enrollment failed",
				);
				expect(log).toHaveBeenCalledWith(expect.stringContaining("Mesh session 0:"));
				const claim = claimEnrollment(meshRoot, "0", sessionFile);
				claim.release();
				expect(log).toHaveBeenCalledWith(expect.stringMatching(/Mesh home enrollment: 2 sessions in \d+ ms/));
			} finally {
				await internals.cleanupSupervisorResources();
			}
		},
	);

	it("uses the same fresh enrollment claim through a symlink alias and its real path", async () => {
		const { root, meshRoot, sessionId, sessionFile } = await fixture();
		const alias = join(root, "alias");
		symlinkSync(meshRoot, alias);
		const claim = claimEnrollment(alias, sessionId, sessionFile);
		try {
			ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			expect(() => claimEnrollment(meshRoot, sessionId, sessionFile)).toThrow("already active");
		} finally {
			claim.release();
		}
	});

	it.each(["owner", "local.*", "local.a.b", "local.a-b", ".a", "local."])(
		"rejects malformed directory principal %s",
		async (principal) => {
			const { meshRoot, sessionId, sessionFile } = await fixture();
			const entry = await publishDirectory(
				meshRoot,
				ensureEnrollmentRecord(meshRoot, sessionId, sessionFile),
				"home",
			);
			expect(readDirectory(meshRoot, sessionId)).toEqual(entry);
			writeFileSync(directoryPath(meshRoot, sessionId), JSON.stringify({ ...entry, principal }));
			expect(() => readDirectory(meshRoot, sessionId)).toThrow("invalid entry");
		},
	);

	it.each(["mint", "identity"])(
		"retains safe %s error fields and bounds redacted diagnostic messages",
		async (boundary) => {
			const { auth, meshRoot, sessionId, sessionFile } = await fixture();
			const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
			const error = Object.assign(
				new Error(`nkeys failed ${auth.account.signingSeed} ${record.identity.seed} opaque-private-fragment`),
				{ name: "MintError", code: "EKEY" },
			);
			if (boundary === "mint") {
				vi.spyOn(core, "mintCreds").mockRejectedValueOnce(error);
				await expect(credentialSource(meshRoot, "prime", record)()).rejects.toMatchObject({
					message: `Mesh signer ${join(meshRoot, "signer.json")}: credential mint failed: MintError (EKEY)`,
				});
			} else {
				vi.spyOn(core, "newIdentity").mockImplementationOnce(() => {
					throw error;
				});
				expect(() => ensureEnrollmentRecord(meshRoot, "fresh", sessionFile)).toThrow(
					/^Mesh session fresh: identity creation failed: MintError \(EKEY\)$/,
				);
			}
			expect(redactMeshError(error, false)).toBe("MintError (EKEY)");
			expect(redactMeshError(new Error("x".repeat(1000)))).toHaveLength(519);
			expect(redactMeshError(error)).not.toContain(record.identity.seed);
		},
	);

	it("reuses one private identity across concurrent enrollment and restart, and provisions before publication", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		await Promise.all([mesh.enroll(sessionId, sessionFile), mesh.enroll(sessionId, sessionFile)]);
		const path = enrollmentPath(meshRoot, sessionId);
		const before = readFileSync(path, "utf8");
		expect(FakeEndpoint.instances).toHaveLength(2);
		expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledTimes(1);
		expect(FakeEndpoint.instances[0]!.stop).toHaveBeenCalledTimes(1);
		const record = JSON.parse(before);
		expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledWith(
			"local",
			record.identity.id,
			record.lifecycleUid,
		);
		expect(FakeEndpoint.instances[1]!.options.lifecycleUid).toBe(record.lifecycleUid);
		expect(readFileSync(directoryPath(meshRoot, sessionId), "utf8")).not.toContain(record.identity.seed);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		await mesh.stop();
		const restarted = new MeshEndpoints({
			meshRoot,
			homeSocket: join(meshRoot, "../daemon.sock"),
			log: vi.fn(),
			handoff: vi.fn(),
		});
		meshes.push(restarted);
		await restarted.start();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(FakeEndpoint.instances).toHaveLength(4);
		expect(FakeEndpoint.instances[3]!.options.card?.id).toBe(record.identity.id);
	});

	it("recovers after a stop at the record or at provisioning, and refuses fileless sessions", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		await expect(mesh.enroll("memory")).rejects.toThrow("no session file");
		await expect(mesh.send({ sessionId: "never" }, sessionId, "hello")).rejects.toThrow("is not enrolled");
		await expect(mesh.send({ sessionId: "memory" }, sessionId, "hello")).rejects.toThrow(
			"enrollment failed: Error: Session memory has no session file",
		);
		expect(existsSync(enrollmentPath(meshRoot, "memory"))).toBe(false);
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		FakeEndpoint.failStart = true;
		await expect(mesh.enroll(sessionId, sessionFile)).rejects.toThrow();
		await expect(mesh.send({ sessionId }, "memory", "hello")).rejects.toThrow(
			"enrollment failed: Error: Mesh session",
		);
		expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
		FakeEndpoint.failStart = false;
		const publish = vi.spyOn(FakeEndpoint.prototype, "emit");
		await mesh.enroll(sessionId, sessionFile);
		expect(JSON.parse(readFileSync(enrollmentPath(meshRoot, sessionId), "utf8")).identity).toEqual(record.identity);
		expect(publish).not.toHaveBeenCalledWith("message", expect.anything());
		expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(record.identity.id);
	});

	it("keeps its record and identity when publication fails after successful provisioning", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		const bytes = readFileSync(sessionFile);
		FakeEndpoint.afterProvision = () => rmSync(sessionFile);
		try {
			await expect(mesh.enroll(sessionId, sessionFile)).rejects.toThrow("missing");
			const before = readFileSync(enrollmentPath(meshRoot, sessionId), "utf8");
			expect(FakeEndpoint.instances[0]!.provisionDmInbox).toHaveBeenCalledTimes(1);
			expect(FakeEndpoint.instances[0]!.stop).toHaveBeenCalledTimes(1);
			expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
			writeFileSync(sessionFile, bytes);
			FakeEndpoint.afterProvision = undefined;
			await mesh.enroll(sessionId, sessionFile);
			expect(readFileSync(enrollmentPath(meshRoot, sessionId), "utf8")).toBe(before);
			expect(FakeEndpoint.instances.at(-1)!.options.card?.id).toBe(JSON.parse(before).identity.id);
		} finally {
			FakeEndpoint.afterProvision = undefined;
		}
	});

	it("does not restore a directory entry when the session file or enrollment record disappeared", async () => {
		const { meshRoot, sessionId, sessionFile, session } = await fixture();
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		session.appendSessionInfo("latest-name");
		expect((await publishDirectory(meshRoot, record, "home")).name).toBe("latest-name");
		rmSync(directoryPath(meshRoot, sessionId));
		rmSync(enrollmentPath(meshRoot, sessionId));
		await expect(publishDirectory(meshRoot, record, "home")).rejects.toThrow("missing");
		expect(existsSync(directoryPath(meshRoot, sessionId))).toBe(false);
	});

	it.each(["missing", "directory", "symlink", "mode", "owner", "json"])(
		"rejects signer %s without exposing contents or creating an enrollment",
		async (reason) => {
			const { meshRoot, mesh, sessionId, sessionFile, auth } = await fixture();
			const path = join(meshRoot, "signer.json");
			if (reason === "missing") rmSync(path);
			if (reason === "directory") {
				rmSync(path);
				mkdirSync(path);
			}
			if (reason === "symlink") {
				const target = join(meshRoot, "seed.json");
				writeFileSync(target, JSON.stringify(auth));
				rmSync(path);
				symlinkSync(target, path);
			}
			if (reason === "mode") chmodSync(path, 0o644);
			if (reason === "owner") vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
			if (reason === "json") writeFileSync(path, `invalid-${auth.account.signingSeed}`);
			let error: unknown;
			try {
				await mesh.enroll(sessionId, sessionFile);
			} catch (failure) {
				error = failure;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(path);
			expect((error as Error).message).not.toContain(auth.account.signingSeed);
			expect(existsSync(enrollmentPath(meshRoot, sessionId))).toBe(false);
			expect(() => readSigner(meshRoot, "prime")).toThrow();
		},
	);

	it("mints two one-hour credentials with the same identity, lifecycle and read set", async () => {
		const { meshRoot, sessionId, sessionFile } = await fixture();
		const record = { ...ensureEnrollmentRecord(meshRoot, sessionId, sessionFile), allowSubscribe: ["work"] };
		const source = credentialSource(meshRoot, "prime", record);
		for (const credential of [await source(), await source()]) {
			const claims = core.credsClaims(credential);
			expect(claims.sub).toBe(record.identity.id);
			expect(claims.exp! - claims.iat!).toBe(3600);
			expect(JSON.stringify(claims.nats)).toContain(record.lifecycleUid);
			expect(JSON.stringify(claims.nats)).toContain("work");
		}
	});

	it.each(["native", "project", "invalid"])("selects native for %s and creates no mesh files", async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "prime-mesh-off-"));
		roots.push(root);
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".prime"), { recursive: true });
		writeFileSync(join(root, "settings.json"), mode === "invalid" ? "{" : "{}");
		if (mode === "project")
			writeFileSync(join(cwd, ".prime", "settings.json"), JSON.stringify({ agentMessageTransport: "cotal" }));
		expect(SettingsManager.create(cwd, root).getAgentMessageTransport()).toBe("native");
		const script = `
			import { registerHooks } from "node:module";
			registerHooks({ resolve(specifier, context, next) {
				if (specifier === "@cotal-ai/core" || specifier === "nats" || specifier.startsWith("@nats-io/"))
					throw new Error("Mode off loaded " + specifier);
				return next(specifier, context);
			} });
			const { DaemonSupervisor } = await import(${JSON.stringify(resolve("src/modes/daemon/daemon-supervisor.ts"))});
			await import(${JSON.stringify(resolve("src/modes/daemon/daemon-mode.ts"))});
			const supervisor = new DaemonSupervisor(${JSON.stringify(join(root, "probe.sock"))}, {
				defaultSessionConfig: { cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(root)} }
			});
			try { await supervisor.start(); console.log("mode off imports clean"); }
			finally { await supervisor.cleanupSupervisorResources(); }
		`;
		const child = spawn(
			process.execPath,
			["--import", resolve("../../node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script],
			{
				cwd,
				env: {
					...process.env,
					PRIME_AGENT_CODING_AGENT_DIR: root,
					TSX_TSCONFIG_PATH: resolve("../../tsconfig.json"),
				},
			},
		);
		let output = "";
		child.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			output += data.toString();
		});
		const code = await new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", resolveExit);
		});
		expect({ code, output }).toEqual({ code: 0, output: expect.stringContaining("mode off imports clean") });
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			defaultSessionConfig: { cwd, agentDir: root },
		});
		try {
			await supervisor.start();
			expect(FakeEndpoint.instances).toHaveLength(0);
			expect(existsSync(join(root, "mesh"))).toBe(false);
		} finally {
			await (supervisor as unknown as { cleanupSupervisorResources(): Promise<void> }).cleanupSupervisorResources();
		}
	});

	it("leaves a live claim in another process alone and reclaims it after that process exits", async () => {
		const { mesh, meshRoot, sessionId, sessionFile } = await fixture();
		const script = `import { claimEnrollment } from ${JSON.stringify(resolve("src/modes/daemon/cotal/enrollment.ts"))}; claimEnrollment(...JSON.parse(process.argv[1])); console.log("claimed"); process.stdin.resume();`;
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([meshRoot, sessionId, sessionFile])],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve());
				child.once("error", reject);
				child.once("exit", () => reject(new Error("claim child exited before receipt")));
			});
			expect(() => claimEnrollment(meshRoot, sessionId, sessionFile)).toThrow("already active");
			await mesh.enroll(sessionId, sessionFile);
			await expect(mesh.send({ sessionId }, "target", "hello")).rejects.toThrow("claimed by another daemon");
		} finally {
			child.kill("SIGTERM");
			await closed;
		}
		const claim = claimEnrollment(meshRoot, sessionId, sessionFile);
		claim.release();
	});
});
