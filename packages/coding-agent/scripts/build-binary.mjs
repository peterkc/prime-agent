#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePlatforms } from "../../../scripts/release-platforms.mjs";
import { writeClipboardBinaryBinding } from "./clipboard-binary-binding.mjs";
import { copyBinaryAssets, forkBinaryVersion, setBinaryVersion, validateBinaryAssets } from "./copy-binary-assets.mjs";
import { signMacosBinary } from "./macos-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDir = join(root, "packages/coding-agent");
const platforms = releasePlatforms;
const args = process.argv.slice(2);
const platform = args.length === 0 ? `${process.platform}-${process.arch}` : args[1];
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--platform")) {
	throw new Error(`Usage: npm run build:binary -- [--platform ${[...platforms, "all"].join("|")}]`);
}
if (platform !== "all" && !platforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);

const bun = process.env.BUN_BINARY || "bun";
const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
if (bunVersion !== "1.4.0") throw new Error(`Binary compilation requires Bun 1.4.0; found ${bunVersion}`);

// Emit workspace JavaScript and declarations using the committed model catalog.
for (const name of ["tui", "ai", "agent", "coding-agent"]) {
	execFileSync(join(root, "node_modules/.bin/tsgo"), ["-p", `packages/${name}/tsconfig.build.json`], {
		cwd: root,
		stdio: "inherit",
	});
}

execFileSync("node", ["scripts/catalog-assets.mjs", "copy-source", "--out", "dist"], {
	cwd: packageDir,
	stdio: "inherit",
});

const buildId = execFileSync("git", ["describe", "--tags", "--long", "--always", "--dirty"], {
	cwd: root,
	encoding: "utf8",
}).trim();
// `git describe --dirty` ignores untracked files, but the build copies whole directories.
const dirty =
	execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim() !== "";
const commit = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const packageVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
const binaryVersion = forkBinaryVersion(packageVersion, commit, dirty);
const outputRoot = join(packageDir, "binaries");
mkdirSync(outputRoot, { recursive: true });
for (const target of platform === "all" ? platforms : [platform]) {
	const staging = mkdtempSync(join(outputRoot, ".build-"));
	try {
		writeClipboardBinaryBinding(join(packageDir, "dist/utils/clipboard-binary-binding.js"), target);
		execFileSync(
			bun,
			[
				"build",
				"--compile",
				"--minify",
				"--keep-names",
				"--bytecode",
				"--format=esm",
				"--external",
				"koffi",
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				"--define",
				`__PI_BUILD_ID__=${JSON.stringify(buildId)}`,
				`--target=bun-${target}`,
				"./dist/bun/cli.js",
				"--outfile",
				join(staging, "prime-agent"),
			],
			{ cwd: packageDir, stdio: "inherit" },
		);
		signMacosBinary(join(staging, "prime-agent"), target);
		copyBinaryAssets(staging);
		setBinaryVersion(staging, binaryVersion);
		validateBinaryAssets(staging);
		const destination = join(outputRoot, target);
		rmSync(destination, { recursive: true, force: true });
		renameSync(staging, destination);
		console.log(`Created ${destination} (version ${binaryVersion})`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
