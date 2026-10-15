/**
 * Inject rpiv-pi's bundled skill contracts into the @juicesharp/rpiv-workflow
 * registry. Mirrors register-built-in-workflows.ts: rpiv-workflow is a SIBLING
 * (peerDependency a clean install does not pull), so we NEVER statically import
 * it at runtime — a lazy provider behind a dynamic import, no-op when absent.
 *
 * The framework is skill-agnostic; rpiv-pi is the primary consumer that reads
 * each bundled skill's `contract:` frontmatter block and supplies the parsed
 * contracts (Pi-free core: skill-contracts-core.ts). Skills
 * without a `contract:` block are skipped — the provider is a no-op until skills
 * declare one.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { getAgentDir, loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillContract } from "@juicesharp/rpiv-workflow/registration";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import { artifactKindComparator, contractEntriesFrom } from "./skill-contracts-core.js";
import { isModuleNotFound } from "./utils.js";

export { artifactKindComparator, normalizeContract } from "./skill-contracts-core.js";

/**
 * Scan rpiv-pi's bundled skills dir for `contract:` frontmatter blocks.
 * Never throws — a missing/unreadable dir yields an empty list.
 */
export function buildSkillContractsFromFrontmatter(skillsDir: string): Array<[string, SkillContract]> {
	try {
		return contractEntriesFrom(loadSkillsFromDir({ dir: skillsDir, source: "rpiv-pi" }).skills);
	} catch {
		return [];
	}
}

/**
 * True iff `filePath` lives inside rpiv-pi's bundled skills dir. Both sides
 * are realpath'd so a workspace/npm-link symlink (node_modules entry →
 * package source) can't defeat the check, and the comparison is
 * separator-safe (`skills-extra` is NOT inside `skills`). Fail-soft: if
 * realpath misses (file vanished mid-scan), falls back to a separator-safe
 * literal prefix check.
 */
export function isBundledSkillPath(filePath: string): boolean {
	try {
		const rel = relative(realpathSync(BUNDLED_SKILLS_DIR), realpathSync(filePath));
		return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
	} catch {
		return filePath === BUNDLED_SKILLS_DIR || filePath.startsWith(BUNDLED_SKILLS_DIR + sep);
	}
}

/**
 * Build skill contracts from user-installed skills by enumerating the SAME
 * default locations Pi's own loader reads (`<agentDir>/skills` +
 * `<cwd>/.pi/skills`), via Pi's exported `loadSkills` — so name-collision
 * precedence matches what Pi actually dispatches.
 *
 * Filesystem-based rather than `pi.getCommands()`: Pi invalidates every
 * captured `pi` handle on any session replacement or `/reload` ("extension
 * ctx is stale"), and this builder runs inside a lazy contract provider
 * whose flush time is the first `/wf` load — which can postdate either.
 * The filesystem read has no handle lifetime.
 *
 * Skills shipped by OTHER Pi packages (their `pi.skills` manifest /
 * settings-declared skill paths) are intentionally out of scope — the
 * owning package registers its own contracts via `registerSkillContracts`,
 * exactly as rpiv-pi does for its bundled skills. Bundled rpiv-pi skills
 * are excluded by path (already covered by the `"rpiv-pi"` owner).
 */
export function buildUserSkillContracts(cwd: string = process.cwd()): Array<[string, SkillContract]> {
	let skills: ReadonlyArray<{ name: string; filePath: string }>;
	try {
		skills = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills;
	} catch {
		return [];
	}
	return contractEntriesFrom(skills.filter((s) => !isBundledSkillPath(s.filePath)));
}

/**
 * Register a lazy provider that builds contracts from user-installed skill
 * frontmatter (filesystem enumeration — see `buildUserSkillContracts`).
 * Runs at flush time (first `/wf` load); re-registration on `/reload`
 * re-flushes, so the `"user-skills"` owner snapshot prunes contracts for
 * skills removed since. Missing sibling resolves to a no-op; any other
 * failure re-throws.
 */
export async function registerUserSkillContractsSource(): Promise<void> {
	try {
		const { registerSkillContracts, registerSkillContractsProvider } = await import(
			"@juicesharp/rpiv-workflow/startup"
		);
		registerSkillContractsProvider(() => {
			registerSkillContracts(buildUserSkillContracts(), "user-skills");
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}

/**
 * Register a lazy provider that builds contracts from bundled skill frontmatter.
 * Missing sibling resolves to a no-op; any other failure re-throws so genuine
 * bugs surface. Fire AFTER registerBuiltInWorkflows (chained in the composer) so
 * the two sibling dynamic imports never race jiti.
 */
export async function registerSkillContractsSource(): Promise<void> {
	try {
		const { registerCompositionComparator, registerSkillContracts, registerSkillContractsProvider } = await import(
			"@juicesharp/rpiv-workflow/startup"
		);
		registerCompositionComparator("plans", artifactKindComparator);
		registerSkillContractsProvider(() => {
			// Reuse the existing PACKAGE_ROOT/skills constant rather than re-deriving
			// the path via an ad-hoc import.meta.url walk.
			// Pass an owner so a `/reload` that drops a skill prunes its stale contract
			// and a divergent override from another extension is surfaced.
			registerSkillContracts(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR), "rpiv-pi");
		});
		// Register the contract-derived outcome resolver so `produces` stages
		// auto-wire `rpivBucketOutcome(bucket)` from `artifactKind` at load time.
		// Dynamic import (not static): `outcome-derivation.js` pulls in
		// `artifact-collector.js`, which value-imports `@juicesharp/rpiv-workflow/registration`
		// at module-eval. A static edge would make THAT a load-time requirement of the
		// whole extension — so when the sibling is absent or not co-located, rpiv-core
		// fails to load entirely (the bug in #66). Deferring it here keeps the sibling
		// edge off the entry path: it only resolves after the `/startup` import above
		// already succeeded, and a missing/non-resolvable sibling degrades to the
		// isModuleNotFound no-op below instead of crashing the extension.
		const { registerOutcomeDerivation } = await import("./outcome-derivation.js");
		await registerOutcomeDerivation();
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}
