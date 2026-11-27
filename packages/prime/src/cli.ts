#!/usr/bin/env node
import { APP_NAME, type MainOptions, main } from "@earendil-works/pi-coding-agent";
import ipython from "./ipython.ts";

export async function run(
	argv: string[],
	entry: (args: string[], options: MainOptions) => Promise<void>,
): Promise<void> {
	// The same process setup as pi's setupCli, which pi does not export.
	// pi's main configures the HTTP dispatcher only after auth subcommands run,
	// so `prime-agent auth` does not use proxy settings (a stated limit).
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	await entry(argv, { extensionFactories: [ipython] });
}

if (import.meta.main) {
	await run(process.argv.slice(2), main);
}
