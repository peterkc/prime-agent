import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { OpenAPI, Tool, ToolError } from "@opencode/codemode";
import { Effect, Schema, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import type { TSchema } from "typebox";
import { parse as parseYaml } from "yaml";
import { resolveUserPath } from "../../utils/paths.js";
import type { CodemodeGeneratedTool } from "./codemode.js";

export type CodemodeOpenAPIAuth =
	| { readonly type: "bearer"; readonly tokenEnv: string }
	| { readonly type: "apiKey"; readonly valueEnv: string }
	| { readonly type: "basic"; readonly usernameEnv: string; readonly passwordEnv: string }
	| { readonly type: "header"; readonly name: string; readonly valueEnv: string };
export interface CodemodeOpenAPIEntry {
	readonly name: string;
	readonly specFile: string;
	readonly baseUrl: string;
	readonly headersFromEnv?: Readonly<Record<string, string>>;
	readonly authFromEnv?: Readonly<Record<string, CodemodeOpenAPIAuth>>;
}
export interface CodemodeOpenAPISettings {
	readonly entries: unknown;
	readonly directory?: string;
}
export interface CodemodeOpenAPICatalog {
	readonly tools: readonly CodemodeGeneratedTool[];
	readonly skipped: readonly (OpenAPI.Skipped & { readonly namespace: string })[];
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error("Invalid codemodeOpenAPI object or unexpected fields; use env names, not credentials");
	return value;
}
function nonempty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error(`Invalid codemodeOpenAPI ${field}`);
	return value;
}
function envName(value: unknown): string {
	const name = nonempty(value, "env name");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid codemodeOpenAPI env name");
	return name;
}
function headerName(value: unknown): string {
	const name = nonempty(value, "header name").toLowerCase();
	if (
		!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
		["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"].includes(name)
	)
		throw new Error("Invalid codemodeOpenAPI header name");
	return name;
}
function parseAuth(value: unknown): CodemodeOpenAPIAuth {
	const type = record(value) ? value.type : undefined;
	switch (type) {
		case "bearer": {
			const v = fields(value, ["type", "tokenEnv"]);
			return { type, tokenEnv: envName(v.tokenEnv) };
		}
		case "apiKey": {
			const v = fields(value, ["type", "valueEnv"]);
			return { type, valueEnv: envName(v.valueEnv) };
		}
		case "basic": {
			const v = fields(value, ["type", "usernameEnv", "passwordEnv"]);
			return { type, usernameEnv: envName(v.usernameEnv), passwordEnv: envName(v.passwordEnv) };
		}
		case "header": {
			const v = fields(value, ["type", "name", "valueEnv"]);
			return { type, name: headerName(v.name), valueEnv: envName(v.valueEnv) };
		}
		default:
			throw new Error("Invalid codemodeOpenAPI auth type");
	}
}
function destination(value: unknown): string {
	let url: URL;
	try {
		url = new URL(nonempty(value, "baseUrl"));
	} catch {
		throw new Error("Invalid codemodeOpenAPI baseUrl");
	}
	const loopback =
		url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.hostname.includes("*") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"codemodeOpenAPI baseUrl requires HTTPS or explicit HTTP loopback, without credentials/query/fragment",
		);
	return url.href;
}
export function parseCodemodeOpenAPI(settings: CodemodeOpenAPISettings): readonly CodemodeOpenAPIEntry[] {
	if (settings.entries === undefined) return [];
	if (!Array.isArray(settings.entries)) throw new Error("codemodeOpenAPI must be an array");
	const names = new Set<string>();
	const entries: CodemodeOpenAPIEntry[] = [];
	for (const raw of settings.entries) {
		const v = fields(raw, ["name", "specFile", "baseUrl", "headersFromEnv", "authFromEnv"]);
		const name = nonempty(v.name, "name");
		if (
			!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ||
			["__proto__", "prototype", "constructor"].includes(name) ||
			names.has(name)
		)
			throw new Error("Invalid or duplicate codemodeOpenAPI name");
		names.add(name);
		const path = nonempty(v.specFile, "specFile");
		if ((/^[a-z][a-z0-9+.-]*:/i.test(path) && !isAbsolute(path)) || !/\.(json|ya?ml)$/i.test(path))
			throw new Error("codemodeOpenAPI specFile must be a local JSON/YAML file");
		if (!settings.directory && !isAbsolute(path) && !path.startsWith("~/"))
			throw new Error("Relative codemodeOpenAPI specFile requires its settings directory");
		const headersFromEnv: Record<string, string> = Object.create(null);
		if (v.headersFromEnv !== undefined) {
			if (!record(v.headersFromEnv)) throw new Error("Invalid codemodeOpenAPI headersFromEnv");
			for (const [key, value] of Object.entries(v.headersFromEnv)) {
				const header = headerName(key);
				if (Object.hasOwn(headersFromEnv, header)) throw new Error("Duplicate codemodeOpenAPI header name");
				headersFromEnv[header] = envName(value);
			}
		}
		const authFromEnv: Record<string, CodemodeOpenAPIAuth> = Object.create(null);
		if (v.authFromEnv !== undefined) {
			if (!record(v.authFromEnv)) throw new Error("Invalid codemodeOpenAPI authFromEnv");
			for (const [key, value] of Object.entries(v.authFromEnv)) authFromEnv[key] = parseAuth(value);
		}
		entries.push({
			name,
			specFile: resolveUserPath(path, settings.directory ?? "/"),
			baseUrl: destination(v.baseUrl),
			headersFromEnv,
			authFromEnv,
		});
	}
	return entries;
}
function localReferences(value: unknown, parents = new Set<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (parents.has(value)) throw new Error("codemodeOpenAPI spec contains cyclic YAML data");
	const next = new Set([...parents, value]);
	if (record(value) && value.$ref !== undefined && (typeof value.$ref !== "string" || !value.$ref.startsWith("#/")))
		throw new Error("codemodeOpenAPI permits only local document $ref references");
	for (const item of Object.values(value)) localReferences(item, next);
}
function loadSpec(entry: CodemodeOpenAPIEntry): OpenAPI.Document {
	let spec: unknown;
	try {
		if (!statSync(entry.specFile).isFile()) throw new Error("Not a file");
		const source = readFileSync(entry.specFile, "utf8");
		spec = /\.json$/i.test(entry.specFile) ? JSON.parse(source) : parseYaml(source);
	} catch {
		throw new Error(`Cannot parse local OpenAPI spec for openapi.${entry.name}`);
	}
	if (
		!record(spec) ||
		typeof spec.openapi !== "string" ||
		!/^3\.\d+\.\d+(?:[-+].*)?$/.test(spec.openapi) ||
		!record(spec.info) ||
		typeof spec.info.title !== "string" ||
		typeof spec.info.version !== "string" ||
		!record(spec.paths)
	)
		throw new Error(`Invalid OpenAPI 3.x spec for openapi.${entry.name}`);
	localReferences(spec);
	const schemes =
		record(spec.components) && record(spec.components.securitySchemes) ? spec.components.securitySchemes : {};
	for (const name of Object.keys(entry.authFromEnv ?? {})) {
		if (!Object.hasOwn(schemes, name)) throw new Error(`Undeclared OpenAPI security scheme in openapi.${entry.name}`);
	}
	return spec;
}
class OpenAPIRefusal extends Error {}

/** Only the checked executor and request boundary resolve credentials; never catalog construction. */
class Credentials {
	private readonly secrets = new Set<string>();
	constructor(readonly entry: CodemodeOpenAPIEntry) {}
	value(name: string): string {
		const value = process.env[name];
		if (!value) throw new OpenAPIRefusal(`Missing OpenAPI environment variable ${name}`);
		this.secrets.add(value);
		this.secrets.add(encodeURIComponent(value));
		this.secrets.add(new URLSearchParams({ value }).toString().slice("value=".length));
		this.secrets.add(JSON.stringify(value).slice(1, -1));
		return value;
	}
	auth(name: string): OpenAPI.Credential | undefined {
		const mapping = this.entry.authFromEnv?.[name];
		if (!mapping) return undefined;
		switch (mapping.type) {
			case "bearer":
				return { type: mapping.type, token: this.value(mapping.tokenEnv) };
			case "apiKey":
				return { type: mapping.type, value: this.value(mapping.valueEnv) };
			case "header":
				return { type: mapping.type, name: mapping.name, value: this.value(mapping.valueEnv) };
			case "basic": {
				const username = this.value(mapping.usernameEnv),
					password = this.value(mapping.passwordEnv);
				this.secrets.add(Buffer.from(`${username}:${password}`, "utf8").toString("base64"));
				return { type: mapping.type, username, password };
			}
			default: {
				const unhandled: never = mapping;
				return unhandled;
			}
		}
	}
	redact(text: string): string {
		for (const secret of this.secrets) text = text.split(secret).join("[REDACTED]");
		return text;
	}
	json(value: unknown): unknown {
		if (typeof value === "string") return this.redact(value);
		if ((typeof value === "number" || typeof value === "boolean") && this.secrets.has(String(value)))
			return "[REDACTED]";
		if (Array.isArray(value)) return value.map((item) => this.json(item));
		if (record(value))
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.json(item)]));
		return value;
	}
	async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof input !== "string" && !(input instanceof URL))
			throw new OpenAPIRefusal("OpenAPI request input must be a string or URL");
		const url = new URL(input);
		if (url.origin !== new URL(this.entry.baseUrl).origin || url.username || url.password)
			throw new OpenAPIRefusal("OpenAPI destination refused: request must use the configured origin");
		const headers = new Headers(init?.headers);
		for (const [name, variable] of Object.entries(this.entry.headersFromEnv ?? {})) {
			const value = this.value(variable);
			if (!headers.has(name)) headers.set(name, value);
		}
		if (headers.has("host") || headers.has("proxy-authorization"))
			throw new OpenAPIRefusal("OpenAPI authority header refused");
		const response = await fetch(url, { ...init, headers, redirect: "manual", credentials: "omit" });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new OpenAPIRefusal("OpenAPI redirect refused");
		}
		return response;
	}
}
function generatedTools(tools: OpenAPI.Tools, prefix: string, credentials: Credentials): CodemodeGeneratedTool[] {
	const entries: CodemodeGeneratedTool[] = [];
	for (const [name, native] of Object.entries(tools)) {
		const path = `${prefix}.${name}`;
		if (!Tool.isTool(native)) {
			entries.push(...generatedTools(native, path, credentials));
			continue;
		}
		if (Schema.isSchema(native.input) || !native.output) throw new Error("Unexpected generated OpenAPI schema");
		const tool: AgentTool = {
			name: path,
			label: path,
			description: native.description,
			parameters: native.input as TSchema,
			async execute(_id, args, signal) {
				try {
					const operation = Effect.gen(function* () {
						const client = yield* HttpClient.HttpClient;
						const scope = yield* Effect.scope;
						const scoped = HttpClient.transformResponse(HttpClient.withScope(client), (effect) =>
							Effect.provideService(effect, Scope.Scope, scope),
						);
						return yield* native.execute(args).pipe(Effect.provideService(HttpClient.HttpClient, scoped));
					}).pipe(
						Effect.scoped,
						Effect.provide(FetchHttpClient.layer),
						Effect.provideService(FetchHttpClient.Fetch, credentials.fetch.bind(credentials)),
						Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
					);
					const value = await Effect.runPromise(operation, { signal });
					return { content: [{ type: "text", text: JSON.stringify(credentials.json(value)) }], details: {} };
				} catch (error) {
					// Discard request-bearing causes, and redact reflected credentials in native HTTP body errors.
					let message = error instanceof Error ? error.message : "OpenAPI operation failed";
					if (error instanceof ToolError && HttpClientError.isHttpClientError(error.cause)) {
						const reason = error.cause.reason;
						if (reason._tag === "TransportError" && reason.cause instanceof OpenAPIRefusal)
							message = reason.cause.message;
					}
					throw new Error(credentials.redact(message));
				}
			},
		};
		entries.push({
			tool,
			output: native.output,
			redact: credentials.redact.bind(credentials),
			redactValue: credentials.json.bind(credentials),
		});
	}
	return entries;
}
export function createCodemodeOpenAPI(settings: CodemodeOpenAPISettings): CodemodeOpenAPICatalog {
	const entries = parseCodemodeOpenAPI(settings);
	const tools: CodemodeGeneratedTool[] = [];
	const skipped: (OpenAPI.Skipped & { namespace: string })[] = [];
	for (const entry of entries) {
		const spec = loadSpec(entry);
		const credentials = new Credentials(entry);
		const adapter = OpenAPI.fromSpec({
			spec,
			baseUrl: entry.baseUrl,
			headers: {},
			auth: {
				resolve: ({ name }) => Effect.try({ try: () => credentials.auth(name), catch: (error) => error }),
			},
		});
		tools.push(
			...generatedTools(adapter.tools, `openapi.${entry.name}`, credentials).map((tool) => ({
				...tool,
				namespace: {
					path: `openapi.${entry.name}`,
					description:
						typeof spec.info === "object" && spec.info !== null && "title" in spec.info
							? String(spec.info.title)
							: entry.name,
				},
			})),
		);
		skipped.push(...adapter.skipped.map((operation) => ({ ...operation, namespace: `openapi.${entry.name}` })));
	}
	return { tools, skipped };
}
