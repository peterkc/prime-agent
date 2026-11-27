import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
	// test-policy: allow explicit-test-timeout -- Bounds real kernel startup/shutdown failures; readiness uses events and promises.
	test: { environment: "node", env: { PI_OFFLINE: "1" }, unstubEnvs: true, testTimeout: 30000 },
	resolve: { alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }] },
}));
