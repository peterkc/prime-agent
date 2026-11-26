#!/usr/bin/env node
import { APP_NAME, type MainOptions, main } from "@earendil-works/pi-coding-agent";
import ipython from "./ipython.ts";

export async function run(
	argv: string[],
	entry: (args: string[], options: MainOptions) => Promise<void>,
): Promise<void> {
	process.title = APP_NAME;
	await entry(argv, { extensionFactories: [ipython] });
}

if (import.meta.main) {
	await run(process.argv.slice(2), main);
}
