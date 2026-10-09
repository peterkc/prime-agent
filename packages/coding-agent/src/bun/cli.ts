#!/usr/bin/env node
/// <reference path="./quickjs-wasm.d.ts" />
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setCodemodeRuntimeAssets } from "../config.js";

setCodemodeRuntimeAssets(quickjsWasmPath, "./src/bun/codemode-worker.ts");

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.js";

restoreSandboxEnv();

await import("./register-bedrock.js");
await import("../cli.js");
