import { readFileSync } from "node:fs";

/** Derive the agent-folder override from the tested product's manifest. */
export function agentDirEnvName(manifestPath) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const appName = manifest.piConfig?.name || "pi";
	const prefix = appName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PI";
	return `${prefix}_CODING_AGENT_DIR`;
}
