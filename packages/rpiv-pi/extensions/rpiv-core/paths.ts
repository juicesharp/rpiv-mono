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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = (() => {
	const thisFile = fileURLToPath(import.meta.url);
	// extensions/rpiv-core/paths.ts -> rpiv-pi/
	return dirname(dirname(dirname(thisFile)));
})();

export const BUNDLED_AGENTS_DIR = join(PACKAGE_ROOT, "agents");
export const BUNDLED_SKILLS_DIR = join(PACKAGE_ROOT, "skills");
