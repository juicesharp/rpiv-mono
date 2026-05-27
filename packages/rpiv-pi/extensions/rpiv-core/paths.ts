/**
 * Resolved filesystem paths for rpiv-pi's own bundled resources.
 *
 * `PACKAGE_ROOT` is computed at module load from this file's URL. The walk-up
 * is anchored to this file's location (`extensions/rpiv-core/paths.ts`) — three
 * `dirname` levels reach the rpiv-pi package root. Other resource directories
 * mirror the `pi.skills` / `pi.extensions` declarations in package.json.
 *
 * Pi's SDK does not expose a "give me my own extension root" API, so this is
 * the idiomatic resolution path (see also docs/packages.md on `pi.*` manifest
 * paths being relative to the package root).
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = (() => {
	const thisFile = fileURLToPath(import.meta.url);
	// extensions/rpiv-core/paths.ts -> rpiv-pi/
	return dirname(dirname(dirname(thisFile)));
})();

export const BUNDLED_AGENTS_DIR = join(PACKAGE_ROOT, "agents");
export const BUNDLED_SKILLS_DIR = join(PACKAGE_ROOT, "skills");

/**
 * Enumerate skill-directory names under `dir`. Fail-soft: returns an empty
 * Set on any read failure (stripped install, EACCES, missing directory) AND
 * logs a `[rpiv-pi]`-prefixed warning so the failure is diagnosable. Without
 * the log, downstream `validateDag` rejects every skill node as "unknown
 * bundled skill" and the user has no signal that the directory listing
 * itself failed.
 *
 * Exported so tests can drive the failure path against a deterministic dir;
 * production callers use the `BUNDLED_SKILL_NAMES` constant below.
 */
export function loadBundledSkillNames(dir: string): ReadonlySet<string> {
	let names: Set<string>;
	try {
		names = new Set(
			readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name),
		);
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		console.warn(`[rpiv-pi] could not enumerate bundled skills under ${dir}: ${reason}`);
		return new Set<string>();
	}
	// An empty Set also disables the `rpiv:` status-line ownership and is
	// almost always a broken-install symptom (skills/ dir present but
	// pruned by `files` array misconfig, or read returned a non-dir tree).
	// Surface this distinctly from the catch path so the user has signal.
	if (names.size === 0) {
		console.warn(
			`[rpiv-pi] bundled skills directory ${dir} contains no subdirectories — ` +
				"the `rpiv:` skill status-line gate will not match any skill.",
		);
	}
	return names;
}

/**
 * Set of bundled-skill directory names under `BUNDLED_SKILLS_DIR`. Computed
 * once at module load via `loadBundledSkillNames`. Used by:
 *
 *   - `session-hooks.ts` — `[skill] rpiv:` status-line gating: only skills
 *     owned by rpiv-pi claim the status line; user-supplied or third-party
 *     skills passthrough.
 *
 * The TS-native workflow runner does NOT enforce a skill-name allowlist at
 * load time; Pi resolves the skill at run time and surfaces a clear error
 * if it can't load. See `@juicesharp/rpiv-workflow`'s `api.ts` `skill` field.
 */
export const BUNDLED_SKILL_NAMES: ReadonlySet<string> = loadBundledSkillNames(BUNDLED_SKILLS_DIR);
