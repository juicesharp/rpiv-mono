/**
 * Stage resolution — derive a stage's dispatch identity ONCE, at the top of
 * `runStage`, so the rest of the pipeline switches on data instead of
 * re-probing the def's optional slots (`loop`/`verify`/`run`/`prompt`). The
 * old probe-the-optionals ladder needed a "slot ordering (load-bearing)"
 * comment; the ordering now lives in exactly one place (`stageModeOf`).
 */

import type { LoopDef, StageDef } from "../api.js";
import { resolveSkill } from "../chain-state.js";
import { effectiveLoopOf } from "../control-flow.js";
import type { RunContext } from "../types.js";

/**
 * How a stage's BODY is dispatched:
 *  - `"script"` — `def.run` is called directly (no session).
 *  - `"prompt"` — author-owned raw text is sent (no `/skill:` prefix).
 *  - `"skill"`  — `/skill:<skill> <args>` is sent.
 * Loop stages dispatch each unit with this same body mode (script is
 * load-rejected on loop stages, so loop bodies are prompt or skill).
 */
export type StageDispatch = "script" | "prompt" | "skill";

/** The top-level dispatch slot `runStage` switches on. */
export type StageMode = "loop" | StageDispatch;

export interface ResolvedStage {
	def: StageDef;
	name: string;
	/** 1-based; for status line + audit row. */
	stageNumber: number;
	/** Label written to JSONL + the status line. */
	skill: string;
	/** Top-level dispatch slot — `"loop"` wins over the body mode. */
	mode: StageMode;
	/** Body dispatch — what one activation (or loop unit) actually sends/runs. */
	dispatch: StageDispatch;
	/** The effective loop spec (incl. a verify desugar); set iff `mode === "loop"`. */
	loop?: LoopDef;
}

/** The ONE slot-priority rule: loop (incl. verify desugar) > script > prompt > skill. */
function dispatchOf(def: StageDef): StageDispatch {
	if (def.run) return "script";
	if (def.prompt !== undefined) return "prompt";
	return "skill";
}

export function resolveStage(currentName: string, idx: number, run: RunContext): ResolvedStage {
	const def = run.workflow.stages[currentName];
	if (!def) {
		// validateWorkflow should catch this; defensive for tests bypassing validation.
		throw new Error(`runStage: stage "${currentName}" referenced by edges but missing from workflow.stages`);
	}
	const loop = effectiveLoopOf(def);
	const dispatch = dispatchOf(def);
	// `skill` defaults to the record key; `resolveSkill` is the shared derivation
	// the load-time contract lookups also use, so runtime and load can't disagree.
	return {
		def,
		name: currentName,
		stageNumber: idx + 1,
		skill: resolveSkill(def, currentName),
		mode: loop ? "loop" : dispatch,
		dispatch,
		loop,
	};
}
