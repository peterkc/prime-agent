import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function readClaudeSettings(agentDir: string): { claudePath?: string } {
	const path = join(agentDir, "claude-sdk.json");
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected an object");
		if (!("claudePath" in value)) return {};
		if (typeof value.claudePath !== "string" || !value.claudePath.trim())
			throw Error("expected a nonempty claudePath");
		if (!isAbsolute(value.claudePath)) throw Error("expected an absolute claudePath");
		return { claudePath: value.claudePath };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
