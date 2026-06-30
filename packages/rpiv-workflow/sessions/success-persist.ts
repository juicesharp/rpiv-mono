/**
 * Success-persistence facet — extracted from `sessions.ts`'s
 * SUCCESS-PERSISTENCE HELPERS. `recordStageSuccess` persists a successful
 * stage/unit row and fires the lifecycle signal; `unitEventOf` builds the
 * `UnitEvent` payload used by BOTH the success path and the halt path's
 * soft-halt lifecycle signal (halt-routing.ts value-imports it).
 *
 * Companion modules (see `sessions.ts`'s header for the full map):
 *   - halt-routing.ts — the halt pipeline; consumes `unitEventOf`.
 */

import { currentStageRef, failAuditWrite } from "../audit.js";
import { persistStageSuccess, rollLastSession } from "../audit-rows.js";
import { lifecycleCtxFromSession, skillStageRef, type UnitEvent } from "../events.js";
import type { Output } from "../output.js";
import type { SessionRef } from "../state/index.js";
import type { StageSession, WorkflowHostContext } from "../types.js";

/**
 * Returns true on successful write — caller gates `onSuccess` on this so the
 * chain advances only when the audit row landed. On failure, leaves
 * `state.output` / `state.primaryArtifact` at their prior values ("output is
 * set iff the row that carried it landed") and sets `state.termination.error`
 * to halt the run. Persistence + state apply run through
 * `persistStageSuccess` (audit-rows.ts) — the ONE success pipeline shared
 * with the script path: the row reuses the activation's pre-allocated number
 * so `output.meta.stageNumber` and the row agree, and unit rows carry the
 * structured identity fields alongside the decorated display `stage`.
 *
 * Single stages keep the `onStageEnd` contract verbatim. Loop units fire
 * `onUnitEnd` (NEVER `onStageEnd` — that's reserved for single-stage and
 * loop-level semantics), the ref carrying the PARENT stage name so listeners
 * key on graph identity, not the display decoration. Neither path emits a
 * completion toast — the status line is the live progress channel.
 *
 * Exported to the `reattach.ts` companion — promotion persists through this
 * exact pipeline (one success path, live and adopted alike).
 */
export async function recordStageSuccess(
	ctx: WorkflowHostContext,
	s: StageSession,
	output: Output,
	session: SessionRef | null,
): Promise<boolean> {
	const persisted = persistStageSuccess(
		s.state,
		{
			cwd: s.cwd,
			runId: s.runId,
			stage: s.stageName,
			skill: s.skill,
			output,
			session,
			unit: s.unit,
			preAllocated: s.allocatedStageNumber,
		},
		s.stage,
	);
	if (persisted) {
		if (s.unit) {
			await s.lifecycle.fire(
				ctx,
				"onUnitEnd",
				// Same allocator base as every other ref of this activation; the
				// ref's NAME stays the parent stage key (graph identity).
				skillStageRef(s.unit.parent, s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber, s.skill),
				unitEventOf(s),
				output,
				lifecycleCtxFromSession(s),
			);
		} else {
			// Roll the predecessor session forward: a downstream `continue` stage
			// forks THIS session. Single stages only — loop units take the `if (s.unit)`
			// branch above and never seed a continuation. Shared with the resume fold
			// (`rollLastSession`) so the null-handling can't drift between the paths.
			rollLastSession(s.state, session);
			await s.lifecycle.fire(ctx, "onStageEnd", currentStageRef(s), output, lifecycleCtxFromSession(s));
		}
		return true;
	}
	failAuditWrite(ctx, s.state, s.skill);
	return false;
}

/** Public `UnitEvent` payload from the session's `UnitRef` + dispatched skill. */
export function unitEventOf(s: StageSession): UnitEvent {
	const u = s.unit!;
	return { role: u.role, index: u.index, unitId: u.id, label: u.label, skill: s.skill };
}
