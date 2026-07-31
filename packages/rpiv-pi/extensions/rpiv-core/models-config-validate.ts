/**
 * models-config-validate — session_start warn-on-miss for models.json keys.
 *
 * Record-key typos (`skills.committ`, `agents.codebase-analzyer`,
 * `presets.buildd`) pass TypeBox validation (records are structurally dynamic)
 * and silently fall through to the defaults cascade — the override the user
 * meant to set just never applies, with no feedback. This hook surfaces them
 * once per process via `console.warn`.
 *
 * Axes whose key universe can't be determined are SKIPPED, never false-warned:
 *   - agents / skills — always knowable (readdir / pi.getCommands).
 *   - stages / presets — need workflow names from rpiv-workflow; skipped when
 *     the sibling is absent or the load fails (a discarded workflow universe is
 *     no basis for "unknown key" claims, and session_start must never crash).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findUnknownModelKeys, type KnownModelKeys, loadModelsConfig } from "./models-config.js";
import { bundledAgentNames, loadWorkflowMap, skillCommandNames } from "./models-config-sources.js";

/** Warn once per process — sub-session spawns re-fire session_start, but the
 * config is process-cached and the typo set is identical, so repeat warnings
 * are pure noise. Reset by __resetModelsConfigValidation() in test/setup.ts. */
let warned = false;

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetModelsConfigValidation(): void {
	warned = false;
}

export function registerModelsConfigValidation(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: unknown, ctx: { cwd?: string }) => {
		if (warned) return;

		const config = loadModelsConfig();
		// Nothing configured on a record axis → nothing to validate.
		if (!config.agents && !config.stages && !config.skills && !config.presets) return;

		const known: KnownModelKeys = {
			agents: bundledAgentNames(),
			skills: skillCommandNames(pi),
		};

		// `stages` + `presets` validation needs the workflow universe, which only
		// rpiv-workflow can supply. Pay the load only when those axes are present;
		// on any failure (sibling absent or genuine load error) leave them
		// undefined so findUnknownModelKeys skips them rather than false-warning
		// or crashing session_start.
		if ((config.stages || config.presets) && ctx.cwd) {
			try {
				const wfMap = await loadWorkflowMap(ctx.cwd);
				known.workflows = Object.keys(wfMap);
				known.stages = Array.from(new Set(Object.values(wfMap).flat()));
				known.stagesByWorkflow = wfMap;
			} catch {
				// Workflow universe unknown — skip stages/presets warn-on-miss.
			}
		}

		const unknown = findUnknownModelKeys(config, known);
		if (unknown.length === 0) return;

		warned = true;
		for (const key of unknown) {
			console.warn(
				`[rpiv-pi] models.json: unknown key "${key}" — override will not apply (typo, or renamed agent/skill/stage?)`,
			);
		}
	});
}
