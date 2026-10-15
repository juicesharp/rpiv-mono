import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPluginDir, loadSkillCatalog, skillRegistryHost, translateSkillPrompt } from "./skills.js";

const catalog = { plugin: new Set(["plan", "commit"]), local: new Set(["write-note"]) };

describe("translateSkillPrompt", () => {
	it("routes plugin skills through the rpiv namespace and local skills bare", () => {
		expect(translateSkillPrompt("/skill:plan x", catalog)).toBe("/rpiv:plan x");
		expect(translateSkillPrompt("run /skill:write-note then /skill:commit", catalog)).toBe(
			"run /write-note then /rpiv:commit",
		);
	});

	it("leaves an unknown skill untouched for the preflight to reject", () => {
		expect(translateSkillPrompt("/skill:nope x", catalog)).toBe("/skill:nope x");
	});
});

describe("loadSkillCatalog", () => {
	it("reads plugin, project and user skill directories that hold a SKILL.md", () => {
		const root = mkdtempSync(join(tmpdir(), "rpiv-skills-"));
		const skill = (dir: string) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
		};
		skill(join(root, "plugin", "skills", "plan"));
		mkdirSync(join(root, "plugin", "skills", "_shared"), { recursive: true });
		skill(join(root, "proj", ".claude", "skills", "write-note"));
		skill(join(root, "config", "skills", "personal"));
		const c = loadSkillCatalog(join(root, "plugin"), join(root, "proj"), join(root, "config"));
		expect([...c.plugin]).toEqual(["plan"]);
		expect([...c.local].sort()).toEqual(["personal", "write-note"]);
	});

	it("resolves the exported plugin from rpiv-pi", () => {
		expect(defaultPluginDir()).toMatch(/rpiv-pi[/\\]hosts[/\\]claude$/);
		expect(loadSkillCatalog(defaultPluginDir(), "/nonexistent").plugin.has("commit")).toBe(true);
	});
});

describe("skillRegistryHost", () => {
	it("lists every known skill in Pi's skill-command shape, which the preflight snapshot reads", () => {
		const h = skillRegistryHost(catalog);
		expect(h.getCommands()).toEqual([
			{ name: "skill:plan", source: "skill" },
			{ name: "skill:commit", source: "skill" },
			{ name: "skill:write-note", source: "skill" },
		]);
		expect(() => h.registerCommand("wf", { handler: async () => {} })).toThrow("Pi-only");
	});
});
