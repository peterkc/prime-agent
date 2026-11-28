/*!
 * Adapted from rynfar/meridian src/proxy/passthroughTools.ts at commit 510da1d9 (MIT, per its README)
 *
 * MIT License
 *
 * Copyright (c) 2026 Trevor Walker
 * (per the upstream LICENSE added after 510da1d9).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";

export const primeMcpPrefix = "mcp__prime__";
const maxAliasLength = 64 - primeMcpPrefix.length;

function validAlias(name: string): boolean {
	return name.length <= maxAliasLength && /^[a-zA-Z0-9_-]+$/.test(name) && !name.startsWith(primeMcpPrefix);
}

export function aliasPrimeTools(tools: readonly Tool[]): ReadonlyMap<string, Tool> {
	const names = [...new Set(tools.map((tool) => tool.name))].sort();
	const aliases = new Map<string, string>();
	const used = new Set(names.filter(validAlias));
	for (const name of names) {
		if (validAlias(name)) continue;
		let base = name;
		while (base.startsWith(primeMcpPrefix)) base = base.slice(primeMcpPrefix.length);
		if (!validAlias(base)) base = `tool_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
		let alias = base;
		for (let i = 2; used.has(alias); i++) {
			const suffix = `_${i}`;
			alias = base.slice(0, maxAliasLength - suffix.length) + suffix;
		}
		used.add(alias);
		aliases.set(name, alias);
	}
	return new Map(tools.map((tool) => [aliases.get(tool.name) ?? tool.name, tool]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repairValue(value: unknown, schema: unknown): unknown {
	if (!isRecord(schema)) return value;
	if (typeof value === "string" && (schema.type === "object" || schema.type === "array")) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (schema.type === "array" ? Array.isArray(parsed) : isRecord(parsed)) value = parsed;
		} catch {
			return value;
		}
	}
	if (schema.type === "array" && Array.isArray(value)) return value.map((item) => repairValue(item, schema.items));
	if (schema.type === "object" && isRecord(value)) return repairToolInput(value, schema);
	return value;
}

export function repairToolInput(input: Record<string, unknown>, schema: unknown): Record<string, unknown> {
	if (!isRecord(schema) || !isRecord(schema.properties)) return input;
	const properties = schema.properties;
	const missing = new Set(
		(Array.isArray(schema.required) ? schema.required : []).filter(
			(key): key is string =>
				typeof key === "string" && Object.hasOwn(properties, key) && !Object.hasOwn(input, key),
		),
	);
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => {
			if (!Object.hasOwn(properties, key) && missing.size) {
				const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
				const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
				if (missing.delete(camel)) key = camel;
				else if (missing.delete(snake)) key = snake;
			}
			return [key, Object.hasOwn(properties, key) ? repairValue(value, properties[key]) : value];
		}),
	);
}
