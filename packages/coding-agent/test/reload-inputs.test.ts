import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectReloadInputs, digestReloadInputs, RELOAD_AREAS } from "../src/core/reload-inputs.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const roots: string[] = [];
function temporary(): string {
	const root = mkdtempSync(join(tmpdir(), "reload-inputs-"));
	roots.push(root);
	return root;
}
function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loaderFixture() {
	const root = temporary(),
		cwd = join(root, "repo", "nested"),
		agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(root, "repo", ".git"));
	const external = join(root, "external"),
		local = join(root, "local");
	write(join(local, "package.json"), JSON.stringify({ pi: { skills: ["skills"] } }));
	write(
		join(agentDir, "settings.json"),
		JSON.stringify({ prompts: [external], packages: [local], enableBuiltinSkills: false }),
	);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		bundledSkillsDir: null,
		noExtensions: true,
		noContextFiles: true,
	});
	await loader.reload();
	const snapshot = loader.getReloadInputSnapshot()!;
	const scan = () => collectReloadInputs(snapshot.spec);
	return { root, cwd, agentDir, external, local, loader, scan };
}
describe("reload input inventory", () => {
	it.each([
		["skill", ["agent", "skills", "demo", "SKILL.md"], "new skill content", "skills"],
		["ancestor add", ["AGENTS.md"], "new context", "context files"],
		["ancestor delete", ["repo", "AGENTS.md"], null, "context files"],
		["external prompt", ["external", "new.md"], "new prompt", "prompts"],
		[
			"local manifest",
			["local", "package.json"],
			'{"pi":{"prompts":["prompts"]}}',
			"extensions,prompts,skills,themes",
		],
		["node_modules", ["local", "node_modules", "helper.js"], undefined, ""],
	] as const)("TM-08 detects %s in the loader's original roots", async (_kind, path, content, expected) => {
		const f = await loaderFixture();
		write(join(f.root, "agent", "skills", "demo", "SKILL.md"), "old skill");
		write(join(f.root, "repo", "AGENTS.md"), "old context");
		write(join(f.root, "local", "node_modules", "helper.js"), "old helper");
		const before = digestReloadInputs(await f.scan());
		const changed = join(f.root, ...path);
		if (content === undefined) utimesSync(changed, 100, 200);
		else if (content === null) rmSync(changed);
		else write(changed, content);
		const after = digestReloadInputs(await f.scan());
		expect(
			RELOAD_AREAS.filter((area) => before[area] !== after[area])
				.sort()
				.join(","),
		).toBe(expected);
	});
	it.each([
		["current", ["a"]],
		["legacy", { enableSkillCommands: true, customDirectories: ["a"] }],
	])("TM-09 ignores %s settings-file stats and defaultModel but tracks skills", async (_form, skills) => {
		const root = temporary(),
			settings = join(root, "settings.json");
		write(settings, JSON.stringify({ defaultModel: "one", skills }));
		const spec = { trees: [], candidates: [], settingsFiles: [settings] };
		const loaded = await collectReloadInputs(spec, undefined, [
			{ ...SettingsManager.create(root, root).getGlobalSettings() },
		]);
		const before = await collectReloadInputs(spec);
		expect(digestReloadInputs(before)).toEqual(digestReloadInputs(loaded));
		write(settings, JSON.stringify({ defaultModel: "different", skills }));
		const ignored = await collectReloadInputs(spec);
		expect(ignored.entries).not.toEqual(before.entries);
		expect(digestReloadInputs(ignored)).toEqual(digestReloadInputs(before));
		write(
			settings,
			JSON.stringify({
				defaultModel: "different",
				skills: ["b"],
				enableSkillCommands: before.settings[0].enableSkillCommands,
			}),
		);
		const changed = digestReloadInputs(await collectReloadInputs(spec));
		expect(RELOAD_AREAS.filter((area) => changed[area] !== digestReloadInputs(before)[area])).toEqual(["settings"]);
	});
	it("TM-10 bounds the inventory and distinguishes an unreadable candidate from absence", async () => {
		const root = temporary(),
			tree = join(root, "tree"),
			unreadable = join(root, "unreadable");
		mkdirSync(tree);
		for (let i = 0; i < 20_000; i++) writeFileSync(join(tree, String(i)), "");
		const limited = await collectReloadInputs({
			trees: [{ path: tree, areas: ["skills"] }],
			candidates: [],
			settingsFiles: [],
		});
		expect(limited.autoReloadable).toBe(false);
		expect(limited.entries).toHaveLength(20_000);
		expect(limited.diagnostics).toHaveLength(1);
		symlinkSync(unreadable, unreadable);
		const failed = await collectReloadInputs({
			trees: [],
			candidates: [{ path: unreadable, areas: ["system prompt"] }],
			settingsFiles: [],
		});
		expect(failed.entries[0].value.state).toBe("unreadable");
		expect(failed.autoReloadable).toBe(false);
		expect(failed.diagnostics).toHaveLength(1);
	});
});
