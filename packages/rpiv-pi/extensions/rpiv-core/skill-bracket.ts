/**
 * skill-bracket — standalone `/skill:<name>` model/effort override via the
 * input → agent_end event pair.
 *
 * Pi exposes no skill-scoped lifecycle event; skills are pure text-substitution
 * via `_expandSkillCommand` inside AgentSession.prompt(). The `input` event
 * fires BEFORE expansion; `agent_end` is the only reliable terminator (per
 * rpiv-warp/index.ts:127-176 comment).
 *
 * Contract:
 *  - Filter event.source === "interactive" (Decision 4). Workflow path owns
 *    source="extension"; rpc is rare and deferred.
 *  - Parse skill name via parseSkillInvocation (both raw `/skill:foo` AND
 *    wrapped `<skill name="…">…</skill>` — Decision 3).
 *  - Arm ONLY on explicit config.skills?.[name] entry (Decision 7 refined —
 *    defaults are not a trigger; only explicit per-skill entries arm).
 *  - Defer when isWorkflowBaselineCaptured() is true (Decision 5).
 *  - All pi mutations wrapped in applyOrSkipIfStale (shared with
 *    model-override.ts).
 *  - Single nullable arm slot — Pi serializes turns; concurrent input cannot
 *    fire while agent_end is pending.
 *  - Restore baseline ALWAYS at agent_end (setModel persists to disk).
 */

import { type ExtensionAPI, type InputEvent, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { applyOrSkipIfStale, getCapturedModel, isWorkflowBaselineCaptured, resolveModel } from "./model-override.js";
import { loadModelsConfig, type ModelThinkingLevelValue } from "./models-config.js";

type CapturedModel = ReturnType<typeof getCapturedModel>;

const SKILL_PREFIX = "/skill:";

// `hasModelChange` tracks whether we actually called pi.setModel during arm —
// at agent_end we skip the restore-setModel when no model change was applied
// (thinking-only overrides), avoiding an unnecessary write to the on-disk
// settings file (Plan Review row #concern-D).
let armedBaseline: { thinking: string; model: CapturedModel; hasModelChange: boolean } | undefined;

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetSkillBracketState(): void {
	armedBaseline = undefined;
}

/**
 * Parse the skill name from an input-event text. Handles BOTH raw
 * `/skill:<name>` (when rpiv-args hasn't transformed yet, or is uninstalled)
 * AND wrapped `<skill name="…" location="…">…</skill>` (post-transform).
 * Decision 3.
 *
 * Tokenizes the raw form on the first whitespace (space/newline/tab) so
 * `/skill:commit\n` yields `name="commit"`, not `"commit\n"` (Plan Review
 * row #concern-A).
 */
export function parseSkillInvocation(text: string): { name: string } | undefined {
	if (text.startsWith(SKILL_PREFIX)) {
		const wsIdx = text.search(/\s/);
		const name = wsIdx === -1 ? text.slice(SKILL_PREFIX.length) : text.slice(SKILL_PREFIX.length, wsIdx);
		return name.length > 0 ? { name } : undefined;
	}
	const wrapped = parseSkillBlock(text);
	return wrapped ? { name: wrapped.name } : undefined;
}

export function registerSkillBracket(pi: ExtensionAPI): void {
	pi.on("input", async (event: InputEvent) => {
		if (event.source !== "interactive") return { action: "continue" } as const;
		const parsed = parseSkillInvocation(event.text);
		if (!parsed) return { action: "continue" } as const;
		if (isWorkflowBaselineCaptured()) return { action: "continue" } as const;

		const config = loadModelsConfig();
		const override = config.skills?.[parsed.name];
		if (!override || (override.model === undefined && override.thinking === undefined)) {
			return { action: "continue" } as const;
		}

		await applyOrSkipIfStale(async () => {
			// Re-check workflow re-entrancy INSIDE applyOrSkipIfStale to defend
			// against a workflow arming between the outer guard and this point
			// (Plan Review row #concern-B).
			if (isWorkflowBaselineCaptured()) return;

			const baselineThinking = pi.getThinkingLevel();
			armedBaseline = {
				thinking: baselineThinking,
				model: getCapturedModel(),
				hasModelChange: false,
			};

			if (override.model !== undefined) {
				const resolved = resolveModel(override.model);
				if (resolved) {
					const ok = await pi.setModel(resolved);
					if (!ok) {
						console.warn(
							`[rpiv-pi] setModel failed for /skill:${parsed.name} (no API key?) — proceeding on current model`,
						);
					}
					armedBaseline.hasModelChange = true;
				} else {
					console.warn(
						`[rpiv-pi] model not found: ${override.model} (/skill:${parsed.name}) — using baseline model`,
					);
				}
			}
			pi.setThinkingLevel((override.thinking ?? baselineThinking) as ModelThinkingLevelValue);
		});

		return { action: "continue" } as const;
	});

	pi.on("agent_end", async () => {
		if (!armedBaseline) return;
		const baseline = armedBaseline;
		// Clear state BEFORE attempting restore so a non-stale throw can't
		// double-restore on next agent_end.
		armedBaseline = undefined;

		await applyOrSkipIfStale(async () => {
			// Skip setModel restore if we never changed the model (thinking-only
			// override). pi.setModel persists to the on-disk settings file even
			// when called with the same value — the skip avoids an unnecessary
			// disk write (Plan Review row #concern-D).
			if (baseline.hasModelChange && baseline.model !== undefined) {
				const ok = await pi.setModel(baseline.model);
				if (!ok) {
					console.warn(
						"[rpiv-pi] failed to restore baseline model after /skill: bracket — proceeding on current model",
					);
				}
			}
			pi.setThinkingLevel(baseline.thinking as ModelThinkingLevelValue);
		});
	});
}
