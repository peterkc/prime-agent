import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createDecisionApiHostHandler } from "../src/core/decision-api.js";
import type { HostRequestHandler } from "../src/core/kernel/shared.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const KEY = "decision-test-key";
const HEADER = "decision-test-header";
const LABEL = "typesafe-test/decision-model";
const DEFAULT = "Choose the next action that best advances the goal given the observation.";
const UNSET =
	'decisionApi.systemOneModel is not set in settings.json. Set it to the decision model reference ("provider/model-id" or a bare id), e.g. "typesafe/jev-1.13.0".';
const IMAGE_ERROR = 'decision images must be data URL strings like "data:image/png;base64,..."';
const GOOD_REPLY = JSON.stringify({
	answers: { action: { choice: "left", confidence: 0.8, probabilities: { left: 0.8 } } },
	usage: { input_tokens: 12, output_tokens: 3 },
});
function question(action: unknown = { criteria: { left: "go left", right: "go right" } }) {
	return { state: { observation: "ball left" }, questions: { action } };
}
function unusable(ref: string) {
	return `decisionApi.systemOneModel "${ref}" could not be resolved to an available, authenticated model.\n\nFix the decisionApi.systemOneModel setting (settings.json) or authenticate the provider, then retry the decision.`;
}

describe("decision_api.decide", () => {
	let dir: string;
	let logPath: string;
	let counter: string;
	let server: Server;
	let reference: string | undefined;
	let registry: ModelRegistry;
	let handler: HostRequestHandler;
	let replies: { status: number; body: string }[];
	let requests: { path: string | undefined; headers: IncomingMessage["headers"]; body: unknown }[];

	async function serve(req: IncomingMessage, res: ServerResponse) {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
		const reply = replies.shift() ?? { status: 200, body: GOOD_REPLY };
		res.writeHead(reply.status, { "Content-Type": "application/json" });
		res.end(reply.body);
	}
	function buildRegistry(input: string[] = ["text"]) {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("loopback port missing");
		const script = `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'lookup\\n'); process.stdout.write('${KEY}')`;
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					"typesafe-test": {
						baseUrl: `http://127.0.0.1:${address.port}`,
						api: "systemone",
						apiKey: `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
						headers: { "X-Test-Secret": HEADER },
						models: [
							{ id: "decision-model", input },
							{ id: "second", input },
							{ id: "wrong-api", api: "openai-completions", input },
						],
					},
					"noauth-test": {
						apiKey: KEY,
						baseUrl: `http://127.0.0.1:${address.port}`,
						api: "systemone",
						models: [{ id: "decision-model", input }],
					},
					"broken-auth": {
						baseUrl: `http://127.0.0.1:${address.port}`,
						api: "systemone",
						apiKey: `!${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
						models: [{ id: "decision-model", input }],
					},
				},
			}),
		);
		registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json"));
		expect(registry.getError()).toBeUndefined();
		registry.markProviderAuthStale("noauth-test");
		handler = createDecisionApiHostHandler({
			getReference: () => reference,
			modelRegistry: registry,
			sessionId: "test-session",
			logPath,
		});
	}
	function logs(): Record<string, unknown>[] {
		return readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}
	function lookups() {
		return existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
	}
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "decision-api-"));
		logPath = join(dir, "logs", "decision-api.jsonl");
		counter = join(dir, "counter");
		reference = LABEL;
		requests = [];
		replies = [];
		server = createServer(serve);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		buildRegistry();
	});
	afterEach(async () => {
		try {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sends the upstream body, defaults null instructions, returns usage and one safe ok log", async () => {
		const request = question({
			type: "choice",
			instructions: null,
			criteria: { left: "go left", right: "go right" },
		});
		const answer = await handler({ request });
		expect(answer).toEqual({
			model: LABEL,
			answers: { action: { choice: "left", confidence: 0.8, probabilities: { left: 0.8 } } },
			usage: { input_tokens: 12, output_tokens: 3 },
		});
		expect(requests).toEqual([
			{
				path: "/systemone",
				headers: expect.objectContaining({ authorization: `Bearer ${KEY}`, "x-test-secret": HEADER }),
				body: {
					...request,
					model: "decision-model",
					questions: {
						action: { type: "choice", instructions: DEFAULT, criteria: { left: "go left", right: "go right" } },
					},
				},
			},
		]);
		expect(logs()).toEqual([
			expect.objectContaining({
				ts: expect.any(String),
				session_id: "test-session",
				model: LABEL,
				latency_ms: expect.any(Number),
				outcome: "ok",
				error: null,
				actions: ["left", "right"],
				choice: "left",
				confidence: 0.8,
				probabilities: { left: 0.8 },
				usage: { input_tokens: 12, output_tokens: 3 },
				request_bytes: Buffer.byteLength(JSON.stringify(request)),
				state: request.state,
				images: { count: 0, sha256: [] },
			}),
		]);
		expect(readFileSync(logPath, "utf8")).not.toContain(KEY);
		expect(readFileSync(logPath, "utf8")).not.toContain(HEADER);
	});

	it.each([
		["missing request", undefined, "decision_api.decide needs a request object"],
		["null request", null, "decision_api.decide needs a request object"],
		["array request", [], "decision_api.decide needs a request object"],
		[
			"model override",
			{ ...question(), model: "other" },
			'The decision model comes from the decisionApi.systemOneModel setting; the request carries no model (got "other").',
		],
		[
			"unknown fields",
			{ ...question(), z: true, hint: true },
			'decision_api.decide got unsupported request fields: "hint", "z". Only "state", "questions", and "images" are allowed.',
		],
		["missing state", { questions: question().questions }, 'decision_api.decide needs a "state" value'],
		["missing questions", { state: {} }, 'decision_api.decide needs a "questions" object with an "action" question'],
		[
			"array questions",
			{ state: {}, questions: [] },
			'decision_api.decide needs a "questions" object with an "action" question',
		],
		[
			"missing action",
			{ state: {}, questions: { move: {} } },
			'decision_api.decide needs a "questions" object with an "action" question',
		],
		["scalar action", question(7), 'the "action" question needs a "criteria" object of action names to descriptions'],
		[
			"wrong type",
			question({ type: "rank" }),
			'the "action" question must have type "choice", not "rank". The Decision API serves one action choice per request.',
		],
		[
			"null type",
			question({ type: null }),
			'the "action" question must have type "choice", not null. The Decision API serves one action choice per request.',
		],
		[
			"wrong instructions",
			question({ instructions: 7 }),
			'the "action" question\'s instructions must be a string, not 7.',
		],
		[
			"missing criteria",
			question({}),
			'the "action" question needs a "criteria" object of action names to descriptions',
		],
		[
			"array criteria",
			question({ criteria: [] }),
			'the "action" question needs a "criteria" object of action names to descriptions',
		],
		[
			"empty criteria",
			question({ criteria: {} }),
			'the "action" question\'s "criteria" object is empty; a decision needs actions to choose from',
		],
		[
			"non-string criterion",
			question({ criteria: { left: 7 } }),
			'the "criteria" entry "left" must be a string describing when the action applies, not 7',
		],
		["empty action name", question({ criteria: { "": "go" } }), 'the "criteria" object has an empty action name'],
		[
			"too many images",
			{ ...question(), images: Array(5).fill("data:image/png;base64,AA==") },
			"a decision carries at most 4 images, got 5",
		],
		[
			"object image",
			{ ...question(), images: [{ data: "private-image" }] },
			`${IMAGE_ERROR}, got {"data":"private-image"}`,
		],
		[
			"image string",
			{ ...question(), images: "data:image/png;base64,private-image" },
			'decision "images" must be an array of data URL strings, not "data:image/png;base64,private-image".',
		],
		[
			"base64 string",
			{ ...question(), images: "private-image" },
			'decision "images" must be an array of data URL strings, not "private-image".',
		],
		["no comma", { ...question(), images: ["data:image/png;base64"] }, IMAGE_ERROR],
		["not image mime", { ...question(), images: ["data:text/plain;base64,private-image"] }, IMAGE_ERROR],
		["not base64 marker", { ...question(), images: ["data:image/png,private-image"] }, IMAGE_ERROR],
		["empty image", { ...question(), images: ["data:image/png;base64,"] }, IMAGE_ERROR],
		["unset setting", question(), UNSET, undefined],
		["unknown model", question(), unusable("missing/model"), "missing/model"],
		["missing auth", question(), unusable("noauth-test/decision-model"), "noauth-test/decision-model"],
		["broken auth", question(), unusable("broken-auth/decision-model"), "broken-auth/decision-model"],
		[
			"wrong api",
			question(),
			'decisionApi.systemOneModel "typesafe-test/wrong-api" uses api "openai-completions"; the Decision API needs a model with api "systemone".',
			"typesafe-test/wrong-api",
		],
		[
			"text-only images",
			{ ...question(), images: ["data:image/png;base64,AA=="] },
			`${LABEL} does not accept image input, so decisions cannot carry images. Drop the images, or set decisionApi.systemOneModel to a vision-capable model.`,
			LABEL,
		],
	] as const)("rejects %s before network and logs only its category", async (...row) => {
		const [, request, message] = row;
		if (row.length === 4) reference = row[3];
		await expect(handler({ request })).rejects.toMatchObject({ message });
		expect(requests).toHaveLength(0);
		const invalid = row.length === 3;
		expect(logs()).toEqual([
			expect.objectContaining({ outcome: "rejected", error: invalid ? "invalid_request" : "not_configured" }),
		]);
		if (invalid) expect(logs()[0]).not.toHaveProperty("state");
		if (invalid) expect(logs()[0]).not.toHaveProperty("images");
		expect(readFileSync(logPath, "utf8")).not.toMatch(/private-image|data:image|AA==/);
	});

	it.each([
		["prose envelope", `before ${GOOD_REPLY} after`, 0.8, { left: 0.8 }],
		["repairable JSON", '{"answers":{"action":{"choice":"left","ignored":"raw\nline"}}}', null, null],
		["clamped confidence", '{"answers":{"action":{"choice":"left","confidence":1.7}}}', 1, null],
		["absent metadata", '{"answers":{"action":{"choice":"left"}}}', null, null],
		[
			"non-finite and unbounded probabilities",
			'{"answers":{"action":{"choice":"left","confidence":1e999,"probabilities":{"other":-2,"left":4,"infinite":1e999,"string":"1"}}}}',
			null,
			{ other: -2, left: 4 },
		],
		[
			"non-object probabilities",
			'{"answers":{"action":{"choice":"left","confidence":"1","probabilities":[]}}}',
			null,
			null,
		],
	] as const)("accepts reply %s", async (_name, body, confidence, probabilities) => {
		replies.push({ status: 200, body });
		expect((await handler({ request: question() })).answers).toEqual({
			action: { choice: "left", confidence, probabilities },
		});
		expect(logs()).toHaveLength(1);
		expect(logs()[0]).toMatchObject({ outcome: "ok", error: null });
	});
	it.each([
		[
			"unknown choice",
			'{"answers":{"action":{"choice":"up"}}}',
			'the decision model chose "up", which is not one of the requested actions: left, right',
		],
		["no answers", "{}", 'the decision model\'s reply has no "answers" object: {}'],
		["non-object answers", '{"answers":[]}', 'the decision model\'s reply has no "answers" object: {"answers":[]}'],
		["no action", '{"answers":{}}', 'the decision model\'s reply has no "action" object: {}'],
		[
			"no choice",
			'{"answers":{"action":{}}}',
			'the decision model\'s reply has no "action"."choice" string: {"action":{}}',
		],
		["empty reply", " ", "the decision model returned an empty reply"],
		["invalid JSON", "not-json", "the decision model's reply was not valid JSON"],
	] as const)("refuses reply %s", async (_name, body, message) => {
		replies.push({ status: 200, body });
		await expect(handler({ request: question() })).rejects.toThrow(message);
		expect(requests).toHaveLength(1);
		expect(logs()).toEqual([expect.objectContaining({ outcome: "error", error: "invalid_reply" })]);
	});

	it.each([
		"sequential",
		"concurrent",
		"provider error",
		"invalid reply",
		"changed setting",
		"unset setting",
	] as const)("caches auth across %s calls", async (mode) => {
		if (mode === "provider error") replies.push({ status: 500, body: "failed" });
		if (mode === "invalid reply") replies.push({ status: 200, body: "{}" });
		if (mode === "concurrent")
			await Promise.all([handler({ request: question() }), handler({ request: question() })]);
		else {
			if (mode === "provider error" || mode === "invalid reply")
				await expect(handler({ request: question() })).rejects.toThrow();
			else await handler({ request: question() });
			if (mode === "changed setting") reference = "typesafe-test/second";
			if (mode === "unset setting") reference = undefined;
			if (mode === "unset setting")
				await expect(handler({ request: question() })).rejects.toMatchObject({ message: UNSET });
			else await handler({ request: question() });
		}
		expect(lookups()).toBe(["provider error", "invalid reply", "changed setting"].includes(mode) ? 2 : 1);
		expect(requests).toHaveLength(mode === "unset setting" ? 1 : 2);
		expect(logs()).toHaveLength(2);
		if (mode === "changed setting") expect(requests[1].body).toHaveProperty("model", "second");
		if (mode === "unset setting") {
			reference = LABEL;
			await handler({ request: question() });
			expect(lookups()).toBe(2);
		}
	});

	it("redacts provider key and header echoes in thrown messages, never logs the body", async () => {
		replies.push({ status: 500, body: `${KEY} ${HEADER} body-marker` });
		await expect(handler({ request: question() })).rejects.toMatchObject({
			message: "the decision model call failed: systemone returned HTTP 500: [redacted] [redacted] body-marker",
		});
		expect(logs()).toEqual([
			expect.objectContaining({ outcome: "error", error: "provider_error", http_status: 500 }),
		]);
		expect(readFileSync(logPath, "utf8")).not.toMatch(/decision-test-key|decision-test-header|body-marker/);
	});
	it("redacts cached credentials in parse errors and state strings without corrupting JSON", async () => {
		await handler({ request: question() });
		await expect(handler({ request: question({ instructions: [KEY, HEADER] }) })).rejects.toMatchObject({
			message: 'the "action" question\'s instructions must be a string, not ["[redacted]","[redacted]"].',
		});
		await handler({ request: { ...question(), state: { secret: KEY, numeric: 12 } } });
		expect(logs()).toHaveLength(3);
		expect(logs()[2]).toMatchObject({ state: { secret: "[redacted]", numeric: 12 } });
		expect(readFileSync(logPath, "utf8")).not.toMatch(/decision-test-key|decision-test-header/);
	});
	it("logs image payload hashes without image data and accepts syntax without decoding", async () => {
		buildRegistry(["text", "image"]);
		const images = Array(4).fill("data:image/;base64,not-base64!");
		await handler({ request: { ...question(), model: null, images } });
		expect(requests[0].body).toHaveProperty("images", images);
		expect(logs()[0]).toMatchObject({
			images: { count: 4, sha256: Array(4).fill(createHash("sha256").update("not-base64!").digest("hex")) },
		});
		expect(readFileSync(logPath, "utf8")).not.toContain("not-base64!");
	});
	it.each(["success", "refusal"])("reports a log write failure on %s without repeating the decision", async (mode) => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory");
		handler = createDecisionApiHostHandler({
			getReference: () => reference,
			modelRegistry: registry,
			sessionId: "test-session",
			logPath: join(blocked, "decision-api.jsonl"),
		});
		if (mode === "refusal") {
			reference = undefined;
			await expect(handler({ request: question() })).rejects.toThrow(
				`${UNSET} (the decision log write also failed:`,
			);
		} else
			expect(await handler({ request: question() })).toMatchObject({
				answers: { action: { choice: "left" } },
				log_error: expect.any(String),
			});
		expect(requests).toHaveLength(mode === "success" ? 1 : 0);
	});
	it.each([undefined, "", "  ", "  typesafe/jev-1.13.0  ", 42, null])(
		"normalizes the setting and gates the bundled skill for %j",
		async (value) => {
			const settings = SettingsManager.inMemory(
				JSON.parse(JSON.stringify({ decisionApi: { systemOneModel: value } })),
			);
			const expected = typeof value === "string" ? value.trim() || undefined : undefined;
			expect(settings.getDecisionApiSystemOneModel()).toBe(expected);
			const bundled = join(dir, "bundled");
			mkdirSync(join(bundled, "decision-api"), { recursive: true });
			const path = join(bundled, "decision-api", "SKILL.md");
			writeFileSync(path, "---\nname: decision-api\ndescription: Decisions\n---\nDecide");
			const manager = new DefaultPackageManager({
				cwd: dir,
				agentDir: join(dir, "agent"),
				settingsManager: settings,
				bundledSkillsDir: bundled,
			});
			const resources = await manager.resolve();
			expect(resources.skills).toEqual([expect.objectContaining({ path, enabled: expected !== undefined })]);
		},
	);
});
