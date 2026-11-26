import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./check-test-policy.mjs", import.meta.url);

function git(root, ...args) {
	return execFileSync(
		"git",
		["-C", root, "-c", "user.name=Policy test", "-c", "user.email=policy@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-test-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "packages/example/test"), { recursive: true });
	await copyFile(script, join(root, "scripts/check-test-policy.mjs"));
	await writeFile(join(root, "packages/example/test/policy.test.ts"), 'it("existing test", () => {});\n');
	git(root, "init", "--initial-branch=policy");
	git(root, "add", "scripts/check-test-policy.mjs", "packages/example/test/policy.test.ts");
	git(root, "commit", "-m", "Policy baseline");
	return { root, base: git(root, "rev-parse", "HEAD") };
}

function check(root, env = {}) {
	return spawnSync(process.execPath, [join(root, "scripts/check-test-policy.mjs")], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, TEST_POLICY_BASE: "", GITHUB_BASE_REF: "", ...env },
	});
}

test("uses next merge bases, rejects a new skip, and resolves refs again after removal and re-adding", async (t) => {
	const { root, base } = await fixture(t);
	git(root, "update-ref", "refs/remotes/fork/next", base);
	const initial = check(root);
	assert.equal(initial.status, 0, initial.stderr);
	assert.match(initial.stdout, new RegExp(`against ${base}`));
	await writeFile(join(root, "packages/example/test/policy.test.ts"), 'it.skip("new skip", () => {});\n');
	const rejected = check(root);
	assert.equal(rejected.status, 1);
	assert.match(rejected.stderr, /packages\/example\/test\/policy\.test\.ts:1.*new skip: \.skip/);
	git(root, "add", "packages/example/test/policy.test.ts");
	git(root, "commit", "-m", "Add a fixture violation");
	git(root, "update-ref", "refs/remotes/origin/next", "HEAD");
	assert.equal(check(root).status, 1, "fork/next takes precedence over origin/next");
	git(root, "update-ref", "-d", "refs/remotes/fork/next");
	const fallback = check(root);
	assert.equal(fallback.status, 0, fallback.stderr);
	assert.match(fallback.stdout, new RegExp(`against ${git(root, "rev-parse", "HEAD")}`));
	git(root, "update-ref", "refs/remotes/fork/next", base);
	assert.equal(check(root).status, 1, "re-added fork/next restores the older baseline");
});

test("uses the shared ancestor when HEAD and next diverge, without allowing next-side violations on HEAD", async (t) => {
	const { root, base } = await fixture(t);
	git(root, "checkout", "-b", "next-side");
	await writeFile(join(root, "packages/example/test/policy.test.ts"), 'it.skip("diverged skip", () => {});\n');
	git(root, "add", "packages/example/test/policy.test.ts");
	git(root, "commit", "-m", "Next-side violation");
	git(root, "update-ref", "refs/remotes/fork/next", "HEAD");
	git(root, "checkout", "policy");
	git(root, "commit", "--allow-empty", "-m", "Diverged HEAD");
	const initial = check(root);
	assert.equal(initial.status, 0, initial.stderr);
	await writeFile(join(root, "packages/example/test/policy.test.ts"), 'it.skip("diverged skip", () => {});\n');
	const rejected = check(root);
	assert.equal(rejected.status, 1);
	assert.match(rejected.stderr, /packages\/example\/test\/policy\.test\.ts:1.*diverged skip: \.skip/);
	assert.match(initial.stdout, new RegExp(`against ${base}`));
});

test("rejects missing next refs even when origin/main and HEAD parent exist", async (t) => {
	const { root, base } = await fixture(t);
	git(root, "update-ref", "refs/remotes/origin/main", base);
	git(root, "commit", "--allow-empty", "-m", "Parent fallback must not apply");
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /No test-policy base: neither fork\/next nor origin\/next has a merge base with HEAD/);
	assert.doesNotMatch(result.stdout, /Test policy check passed/);
});

for (const [name, env] of [
	["explicit base", { TEST_POLICY_BASE: "HEAD", GITHUB_BASE_REF: "review" }],
	["GitHub PR base", { GITHUB_BASE_REF: "review" }],
]) {
	test(`preserves ${name} precedence over the next refs`, async (t) => {
		const { root, base } = await fixture(t);
		git(root, "update-ref", "refs/remotes/fork/next", base);
		await writeFile(join(root, "packages/example/test/policy.test.ts"), 'it.skip("baseline skip", () => {});\n');
		git(root, "add", "packages/example/test/policy.test.ts");
		git(root, "commit", "-m", "Existing baseline violation");
		git(root, "update-ref", "refs/remotes/origin/review", name === "explicit base" ? base : "HEAD");
		const result = check(root, env);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Test policy check passed against/);
	});
}

for (const [rules, reason, expected] of [
	["test-retry, explicit-test-timeout", "Upstream test options are unchanged", []],
	["test-retry", "Upstream test options are unchanged", ["explicit-test-timeout"]],
	["test-retry, explicit-test-timout", "Upstream test options are unchanged", ["test-retry", "explicit-test-timeout"]],
	["test-retry, fixed-resource", "Upstream test options are unchanged", ["explicit-test-timeout"]],
	["test-retry, explicit-test-timeout", "Too short", ["test-retry", "explicit-test-timeout"]],
]) {
	test(`allows only the named known test-policy rules (${rules}; ${reason})`, async (t) => {
		const { root, base } = await fixture(t);
		git(root, "update-ref", "refs/remotes/fork/next", base);
		await writeFile(
			join(root, "packages/example/test/policy.test.ts"),
			`// test-policy: allow ${rules} -- ${reason}\nit("upstream options", { retry: 3, timeout: 60000 }, () => {});\n`,
		);
		const result = check(root);
		assert.equal(result.status, expected.length === 0 ? 0 : 1, result.stderr);
		assert.deepEqual([...result.stderr.matchAll(/policy\.test\.ts:2 \[([a-z-]+)\]/g)].map((match) => match[1]), expected);
	});
}
