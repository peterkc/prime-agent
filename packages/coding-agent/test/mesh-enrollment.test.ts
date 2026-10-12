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
	readSigner,
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
		expect(existsSync(enrollmentPath(meshRoot, "memory"))).toBe(false);
		const record = ensureEnrollmentRecord(meshRoot, sessionId, sessionFile);
		FakeEndpoint.failStart = true;
		await expect(mesh.enroll(sessionId, sessionFile)).rejects.toThrow();
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
		const { meshRoot, sessionId, sessionFile } = await fixture();
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
		} finally {
			child.kill("SIGTERM");
			await closed;
		}
		const claim = claimEnrollment(meshRoot, sessionId, sessionFile);
		claim.release();
	});
});
