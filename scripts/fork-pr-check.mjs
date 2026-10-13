#!/usr/bin/env node
// Local pre-PR check for two Testing Policy rules that `npm run check` does not cover: the added test
// line limit and shuffle-seed runs of changed test files. Run it after `npm run check`, so the counts
// include Biome's formatting. It reports a line-rule breach without failing, because the maintainer
// can grant an exception; a failed test run exits 1.
// Usage: node scripts/fork-pr-check.mjs [--base <ref>] [--no-run]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Keep in step with testFilePattern in scripts/check-test-policy.mjs.
const testFilePattern =
	/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)vitest\.config\.[cm]?[jt]s$|^prime-agent-runtime\/test\/.*\.py$/;
const codeFilePattern = /\.(?:[cm]?[jt]sx?|py)$/;
const runnableTestPattern = /^(packages\/[^/]+)\/(.+\.test\.[cm]?[jt]sx?)$/;
const seeds = [17, 43, 101];

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function lines(output) {
	return output.split("\n").filter(Boolean);
}

// Count lines as git --numstat does: blank lines count, and a last line without a newline counts too.
function countLines(text) {
	return text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);
}

function resolveBase() {
	const index = process.argv.indexOf("--base");
	if (index !== -1) return git(["merge-base", "HEAD", process.argv[index + 1]]);
	for (const ref of ["fork/main", "origin/main"]) {
		try {
			return git(["merge-base", "HEAD", ref]);
		} catch {}
	}
	throw new Error("Neither fork/main nor origin/main exists; pass --base <ref>.");
}

function kindOf(path) {
	if (testFilePattern.test(path)) return "test";
	return codeFilePattern.test(path) ? "source" : undefined;
}

function changes(base) {
	const counts = { test: { added: 0, deleted: 0 }, source: { added: 0, deleted: 0 } };
	const files = [];
	for (const row of lines(git(["diff", "--numstat", "--no-renames", "--diff-filter=d", base]))) {
		const [added, deleted, path] = row.split("\t");
		const kind = kindOf(path);
		files.push(path);
		if (!kind || added === "-") continue;
		counts[kind].added += Number(added);
		counts[kind].deleted += Number(deleted);
	}
	for (const row of lines(git(["diff", "--numstat", "--no-renames", "--diff-filter=D", base]))) {
		const [, deleted, path] = row.split("\t");
		const kind = kindOf(path);
		if (kind && deleted !== "-") counts[kind].deleted += Number(deleted);
	}
	for (const path of lines(git(["ls-files", "--others", "--exclude-standard"]))) {
		const kind = kindOf(path);
		files.push(path);
		if (kind) counts[kind].added += countLines(readFileSync(resolve(root, path), "utf8"));
	}
	return { counts, files };
}

function lineRule({ test, source }) {
	if (source.added === 0 && source.deleted === 0) {
		return test.deleted >= test.added
			? "ok"
			: `test-only change adds ${test.added} test lines and deletes ${test.deleted}; needs a maintainer exception`;
	}
	return test.added <= source.added
		? "ok"
		: `adds ${test.added} test lines for ${source.added} source lines; needs a maintainer exception`;
}

function runShuffled(files) {
	const byPackage = new Map();
	for (const path of files) {
		const match = runnableTestPattern.exec(path);
		if (match) byPackage.set(match[1], [...(byPackage.get(match[1]) ?? []), match[2]]);
	}
	for (const [pkg, tests] of byPackage) {
		for (const seed of seeds) {
			console.log(`\n${pkg}, seed ${seed}: ${tests.join(" ")}`);
			const args = ["vitest", "--run", "--sequence.shuffle", `--sequence.seed=${seed}`, ...tests];
			const result = spawnSync("npx", args, { cwd: resolve(root, pkg), stdio: "inherit" });
			if (result.status !== 0) return false;
		}
	}
	if (byPackage.size === 0) console.log("\nNo changed test files to run.");
	return true;
}

const base = resolveBase();
const { counts, files } = changes(base);
console.log(`Base ${base.slice(0, 9)}`);
console.log(`Source lines +${counts.source.added} -${counts.source.deleted}`);
console.log(`Test lines   +${counts.test.added} -${counts.test.deleted}`);
console.log(`Line rule: ${lineRule(counts)}`);
if (!process.argv.includes("--no-run") && !runShuffled(files)) process.exit(1);
