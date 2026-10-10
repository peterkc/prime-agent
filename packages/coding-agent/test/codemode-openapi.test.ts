import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as yaml } from "yaml";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { CodemodeOpenAPIEntry } from "../src/core/tools/codemode-openapi.js";
import { createCodemodeOpenAPI } from "../src/core/tools/codemode-openapi.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

function text(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const example: { paths: Record<string, unknown>; [key: string]: unknown } = JSON.parse(
	readFileSync(new URL("./fixtures/codemode/openapi.json", import.meta.url), "utf8"),
);
const authCases: {
	type: string;
	mapping: unknown;
	scheme: unknown;
	sensitive: string[];
	expected: Record<string, string>;
	expectedCount?: string;
	token?: string;
}[] = readFileSync(new URL("./fixtures/codemode/openapi-auth.jsonl", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map((row) => JSON.parse(row));
function spec(path = "/things/{id}") {
	return { ...example, paths: { [path]: example.paths["/things/{id}"] } };
}
const environment = process.env;
const input = '{id:"one",q:2,value:"body"}';
const call = `await tools.openapi.dummy.things.write(${input})`;

describe("codemode OpenAPI", () => {
	let dir: string;
	const sessions: AgentSession[] = [],
		servers: Server[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-openapi-test-"));
	});
	afterEach(async () => {
		try {
			for (const session of sessions.splice(0)) await session.dispose();
		} finally {
			for (const server of servers.splice(0)) {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
			process.env = environment;
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	async function api(handler: (req: IncomingMessage, res: ServerResponse) => void) {
		const server = createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing dummy server port");
		return `http://127.0.0.1:${address.port}`;
	}
	function entry(baseUrl: string, document: unknown = spec(), suffix = "json"): CodemodeOpenAPIEntry {
		const specFile = join(dir, `spec.${suffix}`);
		writeFileSync(specFile, suffix === "json" ? JSON.stringify(document) : yaml(document));
		return { name: "dummy", specFile, baseUrl };
	}
	async function session(entries: unknown, factory?: ExtensionFactory, excluded: string[] = []) {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ codemodeOpenAPI: entries, codemodeExcludeTools: excluded }),
		);
		const extensionsResult = await createTestExtensionsResult(factory ? [factory] : [], dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model: getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5"),
			authStorage: AuthStorage.create(join(dir, "auth.json")),
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.create(dir, dir),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session.agent.state.messages = [assistantMsg("script")];
		sessions.push(session);
		const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
		if (!tool) throw new Error("Missing production codemode");
		return { session, tool };
	}
	it.each(["json", "yaml"])("TM-09 native response and exactly-once checked JSON hooks from %s", async (suffix) => {
		const received: unknown[] = [],
			hooks: string[] = [];
		const base = await api((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				received.push({
					url: req.url,
					method: req.method,
					body: JSON.parse(body),
					header: req.headers["x-default"],
				});
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ value: "native", credential: req.headers["x-default"] }));
			});
		});
		const config = entry(base, spec(), suffix);
		vi.stubEnv("PRIME_OPENAPI_TEST_DEFAULT", "dummy-header-secret");
		const { session: s, tool } = await session(
			[{ ...config, specFile: `spec.${suffix}`, headersFromEnv: { "X-Default": "PRIME_OPENAPI_TEST_DEFAULT" } }],
			(pi) => {
				pi.on("tool_call", (event) => {
					hooks.push(`before:${event.toolCallId}`);
				});
				pi.on("tool_result", (event) => {
					expect(event.content).toEqual([{ type: "text", text: '{"value":"native","credential":"[REDACTED]"}' }]);
					hooks.push(`after:${event.toolCallId}`);
					return { content: [{ type: "text", text: '{"value":"hook","secret":"dummy-header-secret"}' }] };
				});
			},
		);
		const result = await tool.execute("p", {
			code: `text(await search({query:"Dummy API namespace"})); const r=${call}; text(r.value); r;`,
		});
		expect(result.isError).toBe(false);
		expect(text(result)).toContain('"value":"hook"');
		expect(text(result)).toContain('"secret":"[REDACTED]"');
		expect(received).toEqual([
			{ url: "/things/one?q=2", method: "POST", body: { value: "body" }, header: "dummy-header-secret" },
		]);
		expect(hooks).toEqual(["before:p/1", "after:p/1"]);
		expect(result.details.calls).toMatchObject([{ name: "openapi.dummy.things.write", id: "p/1", status: "ok" }]);
		expect(s.agent.state.tools.map((tool) => tool.name)).not.toContain("openapi.dummy.things.write");
		expect(JSON.stringify(result)).not.toContain("dummy-header-secret");
	});
	it.each(["validation", "hook", "missing", "excluded", "project"])("TM-10 D19 %s refusal", async (reason) => {
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.end("{}");
		});
		const entries = [{ ...entry(base), headersFromEnv: { "X-Default": "PRIME_OPENAPI_TEST_MISSING" } }];
		const readEnv = vi.fn(Reflect.get);
		if (reason === "project") {
			vi.stubEnv("PRIME_OPENAPI_TEST_MISSING", "dummy-project-secret");
			process.env = new Proxy<typeof environment>(environment, { get: readEnv });
			mkdirSync(join(dir, ".prime", "agent"), { recursive: true });
			writeFileSync(join(dir, ".prime", "agent", "settings.json"), JSON.stringify({ codemodeOpenAPI: entries }));
		}
		const { tool } = await session(
			reason === "project" ? [] : entries,
			(pi) => {
				pi.on("tool_call", () => (reason === "hook" ? { block: true, reason: "denied" } : undefined));
			},
			reason === "excluded" ? ["openapi.dummy.things.write"] : [],
		);
		const result = await tool.execute("p", {
			code:
				reason === "validation"
					? "await tools.openapi.dummy.things.write({id:{bad:true},value:{bad:true}})"
					: `text(ALL_TOOLS); ${call}`,
		});
		expect(result.isError).toBe(true);
		expect(requests).toBe(0);
		if (reason === "validation") expect(text(result)).toContain("Validation failed");
		if (reason === "hook") expect(text(result)).toContain("denied");
		if (reason === "missing") expect(text(result)).toContain("Missing OpenAPI environment variable");
		if (reason === "excluded" || reason === "project") {
			expect(text(result).split("Script error:")[0]).not.toContain("openapi.");
			expect(text(result)).toContain("Unknown tool");
			expect(readEnv.mock.calls.some(([, name]) => name === "PRIME_OPENAPI_TEST_MISSING")).toBe(false);
		}
	});
	it("TM-09 non-JSON hook changes fail visibly after a single write", async () => {
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"value":"ok"}');
		});
		const { tool } = await session([entry(base)], (pi) => {
			pi.on("tool_result", () => ({ content: [{ type: "text", text: "not JSON" }] }));
		});
		const result = await tool.execute("p", { code: call });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("tool_result hook must return valid JSON");
		expect(requests).toBe(1);
	});
	it.each(authCases)("TM-10 call-time $type auth/header override and reflected-value redaction", async (row) => {
		const values = {
			PRIME_OPENAPI_TEST_TOKEN: row.token ?? "dummy auth+secret*",
			PRIME_OPENAPI_TEST_USER: "dummy-user-secret",
			PRIME_OPENAPI_TEST_PASSWORD: "dummy-password-secret",
			PRIME_OPENAPI_TEST_DEFAULT: "dummy-default-secret",
		};
		for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
		const count = Number(row.token ?? 1);
		const seen: unknown[] = [];
		const base = await api((req, res) => {
			seen.push(req.headers);
			res.writeHead(seen.length === 1 ? 503 : 200, { "content-type": "application/json" });
			res.end(JSON.stringify({ count, stable: 12, echo: row.sensitive, padding: "E".repeat(2000) }));
		});
		const document = {
			...spec(),
			security: [{ access: [] }],
			components: { securitySchemes: { access: row.scheme } },
		};
		const { tool } = await session([
			{
				...entry(base, document),
				headersFromEnv: { "X-Default": "PRIME_OPENAPI_TEST_DEFAULT", Authorization: "PRIME_OPENAPI_TEST_DEFAULT" },
				authFromEnv: { access: row.mapping },
			},
		]);
		const code =
			'text(ALL_TOOLS); text(await search({})); text(await describeTool("openapi.dummy.things.write")); await tools.openapi.dummy.things.write({id:"one",value:"body","X-Default":"override"});';
		const failure = await tool.execute("p", { code });
		expect(failure.isError).toBe(true);
		expect(seen).toHaveLength(1);
		expect(text(failure)).toContain("HTTP 503");
		expect(text(failure)).not.toContain("E".repeat(1100));
		const success = await tool.execute("q", { code });
		expect(success.isError).toBe(false);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject(row.expected);
		expect(text(success)).toContain(`"count":${JSON.stringify(row.expectedCount ?? 1)}`);
		expect(text(success)).toContain('"stable":12');
		for (const result of [failure, success])
			expect(text(result)).toContain(`"echo":${JSON.stringify(row.sensitive.map(() => "[REDACTED]"))}`);
		if (row.expectedCount === undefined)
			for (const value of row.sensitive) expect(JSON.stringify([failure, success])).not.toContain(value);
	});
	it.each(["same-origin", "cross-origin"])("TM-10 %s redirects never follow the response", async (kind) => {
		let followed = 0,
			initial = 0;
		const other = await api((_req, res) => {
			followed++;
			res.end("{}");
		});
		let base = "";
		base = await api((req, res) => {
			if (req.url === "/target") followed++;
			else initial++;
			res.writeHead(302, { location: `${kind === "same-origin" ? base : other}/target` });
			res.end();
		});
		const { tool } = await session([entry(base)]);
		const result = await tool.execute("p", { code: call });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("redirect refused");
		expect([initial, followed]).toEqual([1, 0]);
	});
	it("TM-10 exact final origin denies a spec path authority escape before I/O; alternate servers cannot retarget", async () => {
		let allowed = 0,
			denied = 0;
		const other = await api((_req, res) => {
			denied++;
			res.end("{}");
		});
		const base = await api((_req, res) => {
			allowed++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"value":"ok"}');
		});
		const document = { ...spec(), servers: [{ url: other }] };
		const { tool } = await session([entry(base, document)]);
		expect((await tool.execute("p", { code: call })).isError).toBe(false);
		expect([allowed, denied]).toEqual([1, 0]);
		entry(base, spec(`@${other.slice("http://".length)}/things/{id}`));
		const rejected = await tool.execute("p", { code: call });
		expect(rejected.isError).toBe(true);
		expect(text(rejected)).toContain("destination refused");
		expect([allowed, denied]).toEqual([1, 0]);
	});
	it.each(["malformed", "oversize"])(
		"TM-11 %s HTTP response remains failed, with one admitted write",
		async (kind) => {
			let requests = 0;
			const base = await api((_req, res) => {
				requests++;
				res.writeHead(200, {
					"content-type": "application/json",
					...(kind === "oversize" ? { "content-length": String(51 * 1024 * 1024) } : {}),
				});
				res.end(kind === "malformed" ? "{broken" : JSON.stringify({ error: "E".repeat(2000) }));
			});
			const { tool } = await session([entry(base)]);
			const result = await tool.execute("p", { code: call });
			expect(result.isError).toBe(true);
			expect(requests).toBe(1);
			expect(text(result)).toContain(kind === "malformed" ? "malformed JSON" : "50 MiB");
		},
	);
	it("TM-11 unsupported operation is reported without executing it; empty settings have no HTTP tools", async () => {
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.end("{}");
		});
		const document: unknown = JSON.parse(
			readFileSync(new URL("./fixtures/codemode/openapi-binary.json", import.meta.url), "utf8"),
		);
		const { tool } = await session([entry(base, document)]);
		const result = await tool.execute("p", { code: "text(ALL_TOOLS); 1;" });
		expect(result.isError).toBe(false);
		expect(result.details.openapiSkipped).toHaveLength(1);
		expect(text(result)).toContain("skipped operations");
		expect(requests).toBe(0);
		expect(createCodemodeOpenAPI({ entries: undefined })).toEqual({ tools: [], skipped: [] });
	});

	it.each([
		["non-array", "bad"],
		["malformed entry", [null]],
		["missing baseUrl", [{ baseUrl: null }]],
		["name", [{ name: "bad.name" }]],
		["literal secret", [{ headers: { authorization: "dummy-literal-secret" } }]],
		["auth literal", [{ authFromEnv: { a: { type: "bearer", token: "dummy-literal-secret" } } }]],
		["authority header", [{ headersFromEnv: { Host: "A" } }]],
		["url file", [{ specFile: "https://example.invalid/spec.json" }]],
		["unsupported file", [{ specFile: "spec.txt" }]],
		["env literal", [{ headersFromEnv: { "X-Key": "dummy-literal-secret" } }]],
		["unsafe base", [{ baseUrl: "http://example.invalid" }]],
		["url credentials", [{ baseUrl: "https://dummy-literal-secret@example.invalid" }]],
		["wildcard", [{ baseUrl: "https://*.example.invalid" }]],
		["duplicate", [{}, {}]],
	])("TM-10 %s configuration rejects atomically without HTTP or secret reflection", async (_label, overrides) => {
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.end("{}");
		});
		const config = entry(base);
		const entries = Array.isArray(overrides)
			? overrides.map((v) => (v === null ? v : { ...config, ...v }))
			: overrides;
		const { tool } = await session(entries);
		const result = await tool.execute("p", { code: call });
		expect(result.isError).toBe(true);
		expect(requests).toBe(0);
		expect(result.details.calls).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("dummy-literal-secret");
	});
	it.each(["broken", "version", "remote-ref", "missing-file", "undeclared-auth", "partial-catalog"])(
		"TM-10 %s spec rejects without a partial catalog or I/O",
		async (kind) => {
			let requests = 0;
			const base = await api((_req, res) => {
				requests++;
				res.end("{}");
			});
			const config = entry(base);
			if (kind === "broken") writeFileSync(config.specFile, "{broken");
			if (kind === "version") writeFileSync(config.specFile, JSON.stringify({ ...spec(), openapi: "2.0" }));
			if (kind === "remote-ref")
				writeFileSync(
					config.specFile,
					JSON.stringify({ ...spec(), components: { schemas: { X: { $ref: "https://example.invalid/x" } } } }),
				);
			if (kind === "missing-file") rmSync(config.specFile);
			const entries =
				kind === "partial-catalog"
					? [config, { ...config, name: "other", specFile: join(dir, "missing.json") }]
					: [
							{
								...config,
								...(kind === "undeclared-auth"
									? { authFromEnv: { unknown: { type: "bearer", tokenEnv: "PRIME_OPENAPI_TEST_TOKEN" } } }
									: {}),
							},
						];
			const { tool } = await session(entries);
			const result = await tool.execute("p", { code: call });
			expect(result.isError).toBe(true);
			expect(result.details.calls).toEqual([]);
			expect(requests).toBe(0);
		},
	);
	it("TM-09 local spec snapshot stays fixed for one run and refreshes only on the next run", async () => {
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"value":"ok"}');
		});
		const config = entry(base);
		const { tool } = await session([config], (pi) => {
			pi.on("tool_call", () => {
				writeFileSync(config.specFile, "broken");
			});
		});
		expect((await tool.execute("p", { code: call })).isError).toBe(false);
		expect((await tool.execute("q", { code: call })).isError).toBe(true);
		expect(requests).toBe(1);
	});

	it("TM-11 abort reaches HTTP and never replays a pending write", async () => {
		const entered = deferred(),
			closed = deferred();
		let requests = 0;
		const base = await api((_req, res) => {
			requests++;
			res.on("close", closed.resolve);
			entered.resolve();
		});
		const { tool } = await session([entry(base)]);
		const abort = new AbortController();
		const pending = tool.execute("p", { code: `store("x",1); ${call}` }, abort.signal);
		await entered.promise;
		abort.abort();
		const result = await pending;
		await closed.promise;
		expect(result.isError).toBe(true);
		expect(requests).toBe(1);
		expect(result.details.calls[0].status).toBe("cancelled");
		expect(text(result)).toContain("Script aborted");
	});
});
