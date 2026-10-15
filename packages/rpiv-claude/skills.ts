/**
 * Skill resolution for the Claude Code host.
 *
 * Workflows dispatch `/skill:<name> <args>`, Pi's spelling. Claude Code names a
 * plugin skill `/<plugin>:<name>` and a project or user skill `/<name>`, so the
 * host rewrites every `/skill:` token before a prompt leaves the process. The
 * same catalog feeds the runner's skill-registration preflight, which turns an
 * unknown skill into a stage halt instead of a bare imperative the model guesses at.
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WorkflowHost } from "@juicesharp/rpiv-workflow";
import { claudeConfigDir } from "./transcript.js";

export const PLUGIN_NAME = "rpiv";

/** Directory names under `dir` that hold a SKILL.md. */
function skillDirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md")));
}

/** rpiv-pi's exported Claude plugin (`hosts/claude`), resolved through the workspace dependency. */
export function defaultPluginDir(): string {
	const pkg = createRequire(import.meta.url).resolve("@juicesharp/rpiv-pi/package.json");
	return join(dirname(pkg), "hosts", "claude");
}

export interface SkillCatalog {
	/** Skills the plugin ships, invoked as `/rpiv:<name>`. */
	plugin: ReadonlySet<string>;
	/** Project (`<cwd>/.claude/skills`) and user (`<config>/skills`) skills, invoked as `/<name>`. */
	local: ReadonlySet<string>;
}

export function loadSkillCatalog(pluginDir: string, cwd: string, configDir = claudeConfigDir()): SkillCatalog {
	return {
		plugin: new Set(skillDirs(join(pluginDir, "skills"))),
		local: new Set([...skillDirs(join(cwd, ".claude", "skills")), ...skillDirs(join(configDir, "skills"))]),
	};
}

/** Rewrite `/skill:<name>` to Claude Code's spelling. Unknown names pass through for the preflight to catch. */
export function translateSkillPrompt(prompt: string, catalog: SkillCatalog): string {
	return prompt.replace(/\/skill:([A-Za-z0-9_-]+)/g, (m, name: string) => {
		if (catalog.plugin.has(name)) return `/${PLUGIN_NAME}:${name}`;
		if (catalog.local.has(name)) return `/${name}`;
		return m;
	});
}

/**
 * The registry-level host the runner snapshots for its preflight. Claude Code
 * has no command registry to enumerate from outside a session, so the catalog
 * stands in for it; `registerCommand` is unused off Pi.
 */
export function skillRegistryHost(catalog: SkillCatalog): WorkflowHost {
	const names = [...new Set([...catalog.plugin, ...catalog.local])];
	return {
		registerCommand() {
			throw new Error("rpiv-claude: slash-command registration is Pi-only");
		},
		getCommands: () => names.map((name) => ({ name: `skill:${name}`, source: "skill" })),
	};
}
