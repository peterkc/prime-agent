import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getAgentDir } from "../src/config.js";
import { readClaudeSettings } from "../src/core/extensions/builtin/claude-agent-sdk-config.js";

it.each(["global only", "malformed"])("reads claudePath: %s", (mode) => {
	const agentDir = getAgentDir();
	const project = join(agentDir, "project");
	mkdirSync(project, { recursive: true });
	const previous = process.cwd();
	process.chdir(project);
	try {
		for (const path of [join(agentDir, "settings.json"), join(project, "settings.json")])
			writeFileSync(path, JSON.stringify({ claudeAgentSdk: { claudePath: "ignored" } }));
		writeFileSync(join(project, "claude-sdk.json"), JSON.stringify({ claudePath: "ignored" }));
		const file = join(agentDir, "claude-sdk.json");
		writeFileSync(file, mode === "malformed" ? "{bad" : JSON.stringify({ claudePath: "owned" }));
		if (mode === "malformed") expect(() => readClaudeSettings(agentDir)).toThrow(file);
		else expect(readClaudeSettings(agentDir).claudePath).toBe("owned");
	} finally {
		process.chdir(previous);
	}
});
