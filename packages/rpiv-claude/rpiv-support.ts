/**
 * Register what rpiv-pi registers at Pi startup, without Pi.
 *
 * rpiv-pi's extension entry wires three things into the rpiv-workflow
 * registry: the built-in workflows, skill contracts read from each skill's
 * `contract:` frontmatter, and the outcome deriver that turns a contract's
 * artifact kind into the `outcome` a `produces` stage needs. Without them the
 * built-ins fail validation. This module does the same from Pi-free rpiv-pi
 * modules, with Claude Code's skill directories standing in for Pi's.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { claudeConfigDir } from "./transcript.js";

/** rpiv-pi's package root, resolved through the workspace dependency. */
export function rpivPiRoot(): string {
	return dirname(createRequire(import.meta.url).resolve("@juicesharp/rpiv-pi/package.json"));
}

function rpivCore(file: string): string {
	return pathToFileURL(join(rpivPiRoot(), "extensions", "rpiv-core", file)).href;
}

/** `{ name, filePath }` for every `<dir>/<skill>/SKILL.md`; the frontmatter `name` wins over the dir name. */
export function skillFiles(dir: string): Array<{ name: string; filePath: string }> {
	if (!existsSync(dir)) return [];
	const out: Array<{ name: string; filePath: string }> = [];
	for (const entry of readdirSync(dir).sort()) {
		const filePath = join(dir, entry, "SKILL.md");
		if (!existsSync(filePath)) continue;
		let name = entry;
		try {
			const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(filePath, "utf8"));
			const declared = fm ? (parse(fm[1]) as { name?: unknown } | null)?.name : undefined;
			if (typeof declared === "string" && declared) name = declared;
		} catch {
			// malformed frontmatter: keep the directory name, as Pi's loader does
		}
		out.push({ name, filePath });
	}
	return out;
}

export async function registerRpivWorkflowSupport(cwd: string, configDir = claudeConfigDir()): Promise<void> {
	const startup = await import("@juicesharp/rpiv-workflow/startup");
	const core = await import(rpivCore("skill-contracts-core.ts"));
	const { deriveOutcomes } = await import(rpivCore("outcome-derivation.ts"));
	const bundled = join(rpivPiRoot(), "skills");

	startup.registerBuiltInsProvider(async () => {
		const { builtInWorkflows } = await import(rpivCore("built-in-workflows.ts"));
		startup.registerBuiltIns(builtInWorkflows);
	});
	startup.registerCompositionComparator("plans", core.artifactKindComparator);
	startup.registerSkillContractsProvider(() => {
		startup.registerSkillContracts(core.contractEntriesFrom(skillFiles(bundled)), "rpiv-pi");
	});
	startup.registerSkillContractsProvider(() => {
		const local = [...skillFiles(join(cwd, ".claude", "skills")), ...skillFiles(join(configDir, "skills"))];
		startup.registerSkillContracts(core.contractEntriesFrom(local), "user-skills");
	});
	startup.registerOutcomeDeriver(deriveOutcomes);
}
