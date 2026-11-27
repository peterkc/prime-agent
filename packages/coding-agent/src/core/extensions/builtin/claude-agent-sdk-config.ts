import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StreamFailureError } from "@earendil-works/pi-ai";

const defaultIdleTimeoutSeconds = 300;
const maxIdleTimeoutSeconds = 0x7fffffff / 1_000;

export function readClaudeSettings(agentDir: string): {
	enabled?: boolean;
	claudePath?: string;
	idleTimeoutSeconds: number;
} {
	const path = join(agentDir, "claude-sdk.json");
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected an object");
		const enabled = "enabled" in value ? value.enabled : false;
		if (typeof enabled !== "boolean") throw Error("expected a boolean enabled");
		if (!enabled) return { enabled, idleTimeoutSeconds: defaultIdleTimeoutSeconds };
		const claudePath = "claudePath" in value ? value.claudePath : undefined;
		if (claudePath !== undefined && (typeof claudePath !== "string" || !claudePath.trim()))
			throw Error("expected a nonempty claudePath");
		if (claudePath !== undefined && !isAbsolute(claudePath)) throw Error("expected an absolute claudePath");
		const idleTimeoutSeconds = "idleTimeoutSeconds" in value ? value.idleTimeoutSeconds : defaultIdleTimeoutSeconds;
		if (
			typeof idleTimeoutSeconds !== "number" ||
			!(idleTimeoutSeconds > 0 && idleTimeoutSeconds <= maxIdleTimeoutSeconds)
		)
			throw Error("expected idleTimeoutSeconds to be a positive number within the timer limit");
		return { enabled, claudePath, idleTimeoutSeconds };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { idleTimeoutSeconds: defaultIdleTimeoutSeconds };
		const message = `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`;
		if (error instanceof Error && "code" in error) throw Error(message);
		throw new StreamFailureError(message, { kind: "invalid_request" });
	}
}
