import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
	test: { environment: "node", env: { PI_OFFLINE: "1" }, unstubEnvs: true },
	resolve: { alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }] },
}));
