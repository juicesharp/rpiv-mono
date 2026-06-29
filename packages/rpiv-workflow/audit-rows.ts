/**
 * Audit-row persistence — the pure half of the audit layer. Owns the
 * monotonic stage-number allocator, JSONL stage-row appends, the structured
 * unit-row projection, and the shared success persistence/apply pair the
 * skill path, the script path, and the resume fold all run through.
 *
 * Depends only on state, chain-state, and generic utils — NO UI, NO
 * lifecycle dispatch. Terminal-outcome orchestration (notify + status-line
 * + lifecycle events + `terminate`) lives in `audit.ts`.
 */

import type { StageDef } from "./api.js";
import { applyCompletedStage } from "./chain-state.js";
import { nowIso } from "./internal-utils.js";
import type { Output } from "./output.js";
import { appendStage, type SessionRef, type WorkflowStage } from "./state/index.js";
import type { RunState, UnitRef } from "./types.js";

/**
 * Advance the monotonic stage-number allocator and return the assigned
 * number. Call ONCE per stage activation, BEFORE the activation's output
 * envelope is built — the envelope's `meta.stageNumber`, the JSONL row, and
 * every lifecycle ref for the activation then share one explicit value
 * instead of peeking `lastAllocatedStageNumber + 1` and relying on a
 * "no record in between" convention.
 */
export function allocateStageNumber(state: RunState): number {
	state.lastAllocatedStageNumber += 1;
	return state.lastAllocatedStageNumber;
}

/**
 * Attempts the append and returns the assigned `stageNumber` on success (or
 * undefined on I/O failure). The number comes from `preAllocated` when the
 * activation already ran `allocateStageNumber` (output-producing paths), or
 * is allocated here (pre-output halts). Either way the allocator advances
 * monotonically — once per activation — so a transient failure doesn't cause
 * the next stage to reuse the lost row's number. Higher-level counters
 * (e.g. `stagesCompleted`) gate on the returned value being defined.
 */
export function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunState,
	preAllocated?: number,
): number | undefined {
	const stageNumber = preAllocated ?? allocateStageNumber(state);
	return appendStage(cwd, runId, { stageNumber, ...stage }) ? stageNumber : undefined;
}

/**
 * DISPLAY decoration for a loop-unit row's `stage` value —
 * `"implement (phase-2)"`, `"breakdown (r0·judge)"`. Pure human label: the
 * machine channel is the structured `parent`/`role`/`unitId`/`unitIndex`
 * fields (`unitRowFields`); nothing may parse this string back. The driver
 * builds the tag (`unit.id ?? unit.label` for fanout/iterate;
 * `r{round}·{phase}` for assess) and decorates once at session construction.
 */
export const decorateStage = (parent: string, tag: string): string => `${parent} (${tag})`;

/**
 * Project a session's unit identity into the structured row fields. Returns
 * `{}` for single stages so call sites spread unconditionally —
 * `JSON.stringify` drops nothing because nothing is added.
 */
export function unitRowFields(
	unit: UnitRef | undefined,
): Pick<WorkflowStage, "parent" | "role" | "unitId" | "unitIndex"> {
	if (!unit) return {};
	return { parent: unit.parent, role: unit.role, unitId: unit.id, unitIndex: unit.index };
}

/**
 * Apply a completed stage's effects to `RunState` — the I/O-free half of
 * success persistence, and exactly what the resume fold replays per
 * completed row: advance the completion counter, roll `state.output`, and
 * advance the artifact slots via the `applyCompletedStage` authority.
 * `output` may be absent (defensive — completed rows normally carry one);
 * the counter still advances, matching the fold's semantics.
 */
export function applyStageSuccess(state: RunState, def: StageDef, stageName: string, output: Output | undefined): void {
	state.stagesCompleted++;
	if (!output) return;
	state.output = output;
	applyCompletedStage(state, def, stageName, output);
}

/**
 * Roll the predecessor session forward after a single-stage success so a
 * downstream `continue` stage forks it. THE single authority for this slot's
 * write rule — the live success path (`recordStageSuccess`, sessions.ts) and the
 * resume fold (`foldKnownStage`, resume.ts) both call it, so the null-handling
 * can't drift between them.
 *
 * A `null` session (sessionless paths — script + side-effect stages persist
 * `session: null`) LEAVES the slot untouched: those stages are transparent to
 * the continuation chain, so a `continue` after one forks the most recent
 * SESSION-BEARING predecessor on both live and resume. Loop-unit rows never
 * reach here (they take the `s.unit` / `foldUnitRow` branch and never seed a
 * continuation).
 */
export function rollLastSession(state: RunState, session: SessionRef | null | undefined): void {
	if (session != null) state.lastSession = session;
}

/**
 * Persist a completed stage's success row, then apply its state effects —
 * the ONE live-path success persistence (skill sessions + script stages).
 * Returns `true` iff the JSONL row landed; on `false` the state is left at
 * its prior values (output is set iff the row that carried it landed) and
 * the CALLER owns the halt (notify + `terminate` — the wording differs per
 * path). The resume fold runs `applyStageSuccess` directly (its rows are
 * already on disk).
 */
export function persistStageSuccess(
	state: RunState,
	row: {
		cwd: string;
		runId: string;
		stage: string;
		/** Omitted on script-stage rows — JSON.stringify drops `undefined`. */
		skill?: string;
		output: Output;
		/**
		 * REQUIRED: the Pi session that backed the activation, or `null` for
		 * sessionless paths (script stages) — the row serializes it verbatim.
		 */
		session: SessionRef | null;
		unit?: UnitRef;
		/** The activation's pre-allocated number (output-producing paths). */
		preAllocated?: number;
	},
	def: StageDef,
): boolean {
	const assigned = recordStage(
		row.cwd,
		row.runId,
		{
			stage: row.stage,
			skill: row.skill,
			status: "completed",
			ts: nowIso(),
			output: row.output,
			session: row.session,
			...unitRowFields(row.unit),
		},
		state,
		row.preAllocated,
	);
	if (assigned === undefined) return false;
	applyStageSuccess(state, def, row.stage, row.output);
	return true;
}
