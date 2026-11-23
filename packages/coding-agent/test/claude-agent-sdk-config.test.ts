import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getAgentDir } from "../src/config.js";
import { readClaudeSettings } from "../src/core/extensions/builtin/claude-agent-sdk-config.js";

it.each(["global only", "malformed", "relative", "~/claude"])("reads claudePath: %s", (mode) => {
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
		writeFileSync(
			file,
			mode === "malformed"
				? "{bad"
				: JSON.stringify({ enabled: true, claudePath: mode === "global only" ? "/owned" : mode }),
		);
		if (mode === "global only") expect(readClaudeSettings(agentDir).claudePath).toBe("/owned");
		else expect(() => readClaudeSettings(agentDir)).toThrow(`Cannot read ${file}:`);
	} finally {
		process.chdir(previous);
	}
});

it.each([
	[{}, 300],
	[{ idleTimeoutSeconds: 17 }, 17],
	[{ idleTimeoutSeconds: 0 }, "invalid"],
] as const)("reads idleTimeoutSeconds from %j", (settings, expected) => {
	const path = join(getAgentDir(), "claude-sdk.json");
	writeFileSync(path, JSON.stringify(settings));
	if (expected === "invalid") expect(() => readClaudeSettings(getAgentDir())).toThrow(/idleTimeoutSeconds/);
	else expect(readClaudeSettings(getAgentDir())).toMatchObject({ idleTimeoutSeconds: expected });
});
