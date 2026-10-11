import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createDecisionApiHostHandler } from "../src/core/decision-api.js";
import type { HostRequestHandler } from "../src/core/kernel/shared.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const MODEL = "typesafe-test/decision-model";
const REPLY = {
	model: MODEL,
	answers: { action: { choice: "left", confidence: 0.9, probabilities: { left: 0.9, right: 0.1 } } },
	usage: { input_tokens: 12, output_tokens: 3 },
};
const LOOP = `
import json
acted = []
records = []
actions = {"left": "Move left", "right": "Move right"}
loop = decision_api.Loop(lambda: {"ball": "left"}, acted.append, actions,
                         objective="Catch the ball", max_steps=3)
`;

describe("decision-api skill over the kernel host bridge", () => {
	let dir: string;
	let provisioner: IpythonKernelProvisioner | undefined;
	let handler: HostRequestHandler;
	let requests: Record<string, unknown>[];
	let server: Server | undefined;

	async function stub(payload: Record<string, unknown>) {
		requests.push({ request: payload.request });
		return REPLY;
	}
	async function execute(code: string) {
		const packagePath = join(getBundledSkillsDir(), "decision-api");
		provisioner = new IpythonKernelProvisioner(dir, {
			pythonSkills: [
				{
					name: "decision-api",
					importName: "decision_api",
					packagePath,
					pyprojectPath: join(packagePath, "pyproject.toml"),
				},
			],
			hostHandlers: { "decision_api.decide": handler },
		});
		const manager = await provisioner.ensure();
		const result = await manager.execute(LOOP + code, { signal: AbortSignal.timeout(2000) });
		expect(result.status, result.stderr).toBe("ok");
		return JSON.parse(result.stdout.trim());
	}
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kernel-decision-api-"));
		requests = [];
		handler = stub;
	});
	afterEach(async () => {
		try {
			await provisioner?.dispose();
			provisioner = undefined;
		} finally {
			try {
				if (server) {
					server.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						server?.close((error) => (error ? reject(error) : resolve())),
					);
					server = undefined;
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("decide returns the public result and usage through the only host handler", async () => {
		const result = await execute(`
print(json.dumps(await decision_api.decide({"ball": "left"}, actions, goal="Catch")))
`);
		expect(result).toEqual({
			action: "left",
			confidence: 0.9,
			probabilities: { left: 0.9, right: 0.1 },
			latency_ms: expect.any(Number),
			model: MODEL,
			usage: REPLY.usage,
		});
		expect(result.latency_ms).toBeGreaterThanOrEqual(0);
		expect(requests).toEqual([
			{
				request: {
					state: { observation: { ball: "left" }, goal: "Catch" },
					questions: {
						action: {
							type: "choice",
							criteria: { left: "Move left", right: "Move right" },
							instructions: "Choose the next action that best advances the goal given the observation.",
						},
					},
				},
			},
		]);
	});

	it("runs three left actions and reports the last decision model", async () => {
		const result = await execute(`
status = await loop.run()
print(json.dumps({"acted": acted, "status": status}))
`);
		expect(result.acted).toEqual(["left", "left", "left"]);
		expect(result.status).toMatchObject({ step: 3, running: false, system1_model: MODEL, errors: 0 });
		expect(requests).toHaveLength(3);
	});

	it("set_goal adds the new goal to the next custom dict state without messaging", async () => {
		const result = await execute(`
state = {"ball": "left"}
loop.state = lambda observation, goal, history: state
def update(record, observation):
    if record["step"] == 0:
        loop.set_goal("Track the ball")
loop.on_step = update
await loop.run()
print(json.dumps({"updates": loop.goal_updates, "state": state}))
`);
		expect(requests.map((payload) => payload.request)).toEqual([
			expect.objectContaining({ state: { ball: "left", goal: "Catch the ball" } }),
			expect.objectContaining({ state: { ball: "left", goal: "Track the ball" } }),
			expect.objectContaining({ state: { ball: "left", goal: "Track the ball" } }),
		]);
		expect(result).toEqual({ updates: [{ step: 1, goal: "Track the ball" }], state: { ball: "left" } });
	});

	it("carries log_error in decide, history and on_step without retrying", async () => {
		handler = async (payload) => ({ ...(await stub(payload)), log_error: "log unavailable" });
		const result = await execute(`
single = await decision_api.decide("ball left", actions)
loop.max_steps = 1
loop.on_step = lambda record, observation: records.append(record)
await loop.run()
print(json.dumps({"single": single, "history": loop.history, "records": records}))
`);
		expect(result.single.log_error).toBe("log unavailable");
		expect(result.history).toEqual([expect.objectContaining({ action: "left", log_error: "log unavailable" })]);
		expect(result.records).toEqual(result.history);
		expect(requests).toHaveLength(2);
	});

	it("records a system1 timeout and continues the next step with skip", async () => {
		let release = () => {};
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		async function slowFirst(payload: Record<string, unknown>) {
			const reply = await stub(payload);
			if (requests.length === 1) await stalled;
			else release();
			return reply;
		}
		handler = slowFirst;
		try {
			const result = await execute(`
loop.max_steps = 2
loop.decide_timeout = 0.1
loop.on_error = "skip"
await loop.run()
print(json.dumps({"acted": acted, "status": loop.status(), "errors": loop.errors}))
`);
			expect(result.acted).toEqual(["left"]);
			expect(result.status).toMatchObject({ step: 2, error: null, errors: 1 });
			expect(result.errors).toEqual([{ step: 0, where: "system1", error: "TimeoutError: " }]);
			expect(requests).toHaveLength(2);
		} finally {
			release();
		}
	});

	it("runs a Loop through the real host handler and a loopback systemone model", async () => {
		async function serve(req: IncomingMessage, res: ServerResponse) {
			let body = "";
			for await (const chunk of req) body += chunk;
			requests.push({ path: req.url, body: JSON.parse(body) });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(REPLY));
		}
		server = createServer(serve);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("loopback port missing");
		const modelsPath = join(dir, "models.json");
		const logPath = join(dir, "decision-api.jsonl");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"typesafe-test": {
						baseUrl: `http://127.0.0.1:${address.port}`,
						api: "systemone",
						apiKey: "kernel-test-key",
						models: [{ id: "decision-model", input: ["text"] }],
					},
				},
			}),
		);
		const modelRegistry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(modelRegistry.getError()).toBeUndefined();
		handler = createDecisionApiHostHandler({
			getReference: () => MODEL,
			modelRegistry,
			sessionId: "kernel-test",
			logPath,
		});
		const result = await execute(`
loop.max_steps = 1
await loop.run()
print(json.dumps({"acted": acted, "status": loop.status()}))
`);
		expect(result.acted).toEqual(["left"]);
		expect(result.status).toMatchObject({ system1_model: MODEL, errors: 0 });
		expect(requests).toEqual([
			{
				path: "/systemone",
				body: {
					state: { observation: { ball: "left" }, goal: "Catch the ball" },
					model: "decision-model",
					questions: {
						action: {
							type: "choice",
							criteria: { left: "Move left", right: "Move right" },
							instructions: "Choose the next action that best advances the goal given the observation.",
						},
					},
				},
			},
		]);
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toMatchObject({
			outcome: "ok",
			choice: "left",
			usage: REPLY.usage,
			session_id: "kernel-test",
		});
	});
});
