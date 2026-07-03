/**
 * Legacy-layout migration advisories — the notice strings AND the probes
 * that fire them (the migration shell snippets are a loader concern, not
 * UI constants).
 *
 * Each advisory is a `"warning"` (never blocks the run) probing a distinct
 * stale layout the unified `.rpiv/workflows/` move left behind. Sunset
 * target ~3 release cycles post-1.0 — remove each `existsSync` gate, its
 * message constant, and the co-located test case together.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoadAccumulator } from "./merge.js";
import type { OverlayPaths } from "./paths.js";

/**
 * Legacy `.rpiv-workflow/` overlay directory detected at load time. The
 * package moved project config under the unified `.rpiv/workflows/` tree
 * (config.ts + packs/) alongside run state. The old directory is NO LONGER
 * read — this notice points the user at the new location and the one-line
 * `mv` migration. Emitted as a load WARNING (advisory, non-blocking).
 *
 * The embedded shell is `;`-sequenced (not `&&`-chained) and each move is
 * guarded (`[ -f … ]` for the config, `find … 2>/dev/null` for the packs) so
 * the terminal `rm -rf` ALWAYS runs — a config-only legacy dir (no `workflows/`
 * subdir) no longer halts the chain and re-fires this warning forever.
 */
export const LEGACY_OVERLAY_NOTICE = (cwd: string): string =>
	`rpiv-workflow: detected legacy \`${join(cwd, ".rpiv-workflow")}\` — project config now lives at ` +
	"`.rpiv/workflows/config.ts` + `.rpiv/workflows/packs/` and is the only location read. " +
	"Move it: `mkdir -p .rpiv/workflows/packs; " +
	"[ -f .rpiv-workflow/workflows.config.ts ] && mv .rpiv-workflow/workflows.config.ts .rpiv/workflows/config.ts; " +
	"find .rpiv-workflow/workflows -name '*.ts' -exec mv {} .rpiv/workflows/packs/ \\; 2>/dev/null; " +
	"rm -rf .rpiv-workflow` " +
	"(the old directory is ignored). " +
	"Note: `.rpiv/workflows/` is commonly gitignored (it holds run state), so the moved " +
	"`config.ts` + `packs/` may be silently uncommittable — add `!.rpiv/workflows/config.ts` and " +
	"`!.rpiv/workflows/packs/` to your `.gitignore` to version-control team workflow config.";

/**
 * Orphaned run JSONLs detected directly under `.rpiv/workflows/` at load time.
 * Run state moved one level down into `.rpiv/workflows/runs/`; files written by
 * an older version still sit at the parent and are no longer enumerated by
 * `listRuns` (so `/wf` past-run inspection silently can't see them). Emitted as
 * a load WARNING (advisory, non-blocking) — the files are orphaned, not deleted.
 */
export const LEGACY_RUNS_NOTICE = (cwd: string): string =>
	`rpiv-workflow: detected legacy run files directly under \`${join(cwd, ".rpiv", "workflows")}\` — ` +
	"run state now lives in `.rpiv/workflows/runs/` and these top-level `*.jsonl` files are no longer " +
	"read by `/wf`. Move them: `mkdir -p .rpiv/workflows/runs && mv .rpiv/workflows/*.jsonl .rpiv/workflows/runs/`.";

/**
 * Legacy user-layer config filename (`workflows.config.ts`) detected at load
 * time. The user overlay's inner name was aligned with the project layer
 * (`config.ts`) and is the ONLY name read — a stale `workflows.config.ts` would
 * otherwise silently stop contributing its aliases / default / overlay
 * workflows. Mirrors `LEGACY_OVERLAY_NOTICE` at the user layer. Load WARNING.
 */
export const LEGACY_USER_CONFIG_NOTICE = (dir: string): string =>
	`rpiv-workflow: detected legacy \`${join(dir, "workflows.config.ts")}\` — the user-layer config now lives at ` +
	`\`${join(dir, "config.ts")}\` and is the only name read. ` +
	`Move it: \`mv ${join(dir, "workflows.config.ts")} ${join(dir, "config.ts")}\` (the old name is ignored).`;

/**
 * Push the three independent legacy-migration advisories:
 *   - project dashed dir   `<cwd>/.rpiv-workflow/`           → config.ts + packs/
 *   - orphaned run JSONLs   `<cwd>/.rpiv/workflows/*.jsonl`   → runs/
 *   - user-layer rename     `~/.config/rpiv-workflow/workflows.config.ts` → config.ts
 */
export function pushLegacyNotices(cwd: string, userPaths: OverlayPaths, acc: LoadAccumulator): void {
	if (existsSync(join(cwd, ".rpiv-workflow"))) {
		acc.issues.push({ kind: "load", layer: "project", severity: "warning", message: LEGACY_OVERLAY_NOTICE(cwd) });
	}

	if (hasOrphanedRunFiles(cwd)) {
		acc.issues.push({ kind: "load", layer: "project", severity: "warning", message: LEGACY_RUNS_NOTICE(cwd) });
	}

	const userDir = dirname(userPaths.configFile);
	if (existsSync(join(userDir, "workflows.config.ts"))) {
		acc.issues.push({
			kind: "load",
			layer: "user",
			severity: "warning",
			message: LEGACY_USER_CONFIG_NOTICE(userDir),
		});
	}
}

/**
 * True when `<cwd>/.rpiv/workflows/` holds top-level `*.jsonl` run files written
 * before the `runs/` relocation. `readdirSync` lists only immediate entries, so
 * files already inside `runs/` never match. A missing / unreadable dir → false.
 */
function hasOrphanedRunFiles(cwd: string): boolean {
	try {
		return readdirSync(join(cwd, ".rpiv", "workflows")).some((f) => f.endsWith(".jsonl"));
	} catch {
		return false;
	}
}
