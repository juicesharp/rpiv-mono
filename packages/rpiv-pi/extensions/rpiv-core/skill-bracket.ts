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
 *  - All pi mutations wrapped in applyOrSkipIfStale (shared with
 *    session-capture.ts).
 *  - Single nullable arm slot — Pi serializes turns; concurrent input cannot
 *    fire while agent_end is pending.
 *  - Restore baseline ALWAYS at agent_end (setModel persists to disk).
 */

import { type ExtensionAPI, type InputEvent, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { loadModelsConfig, type ModelThinkingLevelValue } from "./models-config.js";
import {
	applyEffectiveModel,
	applyOrSkipIfStale,
	type BaselineSnapshot,
	getCapturedModel,
	restoreBaseline,
} from "./session-capture.js";

const SKILL_PREFIX = "/skill:";

// `hasModelChange` tracks whether we actually called pi.setModel during arm —
// at agent_end we skip the restore-setModel when no model change was applied
// (thinking-only overrides), avoiding an unnecessary write to the on-disk
// settings file (Plan Review row #concern-D).
let armedBaseline: BaselineSnapshot | undefined;

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

		const config = loadModelsConfig();
		const override = config.skills?.[parsed.name];
		if (!override || (override.model === undefined && override.thinking === undefined)) {
			return { action: "continue" } as const;
		}

		await applyOrSkipIfStale(async () => {
			const baselineThinking = pi.getThinkingLevel() as ModelThinkingLevelValue;
			armedBaseline = {
				thinking: baselineThinking,
				model: getCapturedModel(),
				hasModelChange: false,
			};

			const { hasModelChange } = await applyEffectiveModel(pi, {
				overrideModel: override.model,
				baselineModel: armedBaseline.model,
				overrideThinking: override.thinking,
				baselineThinking,
				label: `/skill:${parsed.name}`,
				setBaselineModel: false,
			});
			armedBaseline.hasModelChange = hasModelChange;
		});

		return { action: "continue" } as const;
	});

	pi.on("agent_end", async () => {
		if (!armedBaseline) return;
		const baseline = armedBaseline;
		// Clear state BEFORE attempting restore so a non-stale throw can't
		// double-restore on next agent_end.
		armedBaseline = undefined;

		await applyOrSkipIfStale(() => restoreBaseline(pi, baseline));
	});
}
