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
 * Set of bundled-skill directory names under `BUNDLED_SKILLS_DIR`. Computed
 * once at module load via a single `readdirSync`. Used by:
 *
 *   - `workflow/dag.ts` — DAG validation: skill-kind nodes must reference a
 *     bundled skill.
 *   - `session-hooks.ts` — `[skill] rpiv:` status-line gating: only skills
 *     owned by rpiv-pi claim the status line; user-supplied or third-party
 *     skills passthrough.
 *
 * Both consumers used to compute this set independently; unifying here keeps
 * a single source of truth for "what does rpiv-pi ship" and avoids a second
 * directory walk at startup. Fail-soft: empty set on read failure so callers
 * degrade to "nothing is bundled" rather than crashing.
 */
export const BUNDLED_SKILL_NAMES: ReadonlySet<string> = (() => {
	try {
		return new Set(
			readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name),
		);
	} catch {
		return new Set<string>();
	}
})();
