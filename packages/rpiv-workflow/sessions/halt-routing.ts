/**
 * Halt-routing facet — extracted from `sessions.ts`'s HALT HELPERS. Turns a
 * halt reason into the right audit-layer call. `haltStageOrSoftHalt` is the
 * single gate `postStage` dispatches through (a `collectAll` fanout unit
 * soft-halts; everything else fail-fast halts). `haltStageWithValidationFailure`
 * is also exported for the `reattach.ts` companion.
 *
 * `auditFor` lives here (moved from `sessions.ts`) — its only callers are the
 * halt helpers below; relocating it keeps the value-import DAG acyclic (the
 * success-persistence facet in `success-persist.ts` does not use `auditFor`,
 * so no edge from there back here).
 *
 * Companion modules (see `sessions.ts`'s header for the full map):
 *   - success-persist.ts — `recordStageSuccess` + `unitEventOf` (the soft-halt
 *     lifecycle signal borrows `unitEventOf` from here).
 */

import { type AuditCtx, failedArgs, recordStopFailure, recordTerminalFailure, recordUnitHalt } from "../audit.js";
import { allocateStageNumber } from "../audit-rows.js";
import { lifecycleCtxFromSession, skillStageRef } from "../events.js";
import { nowIso } from "../internal-utils.js";
import { FAIL_VALIDATION_EXHAUSTED, MSG_STAGE_FAILED } from "../messages.js";
import { failedOutput, type OutputMeta, outputMeta } from "../output.js";
import type { SessionRef } from "../state/index.js";
import type { StopSignal } from "../transcript.js";
import type { StageSession, WorkflowHostContext } from "../types.js";
import { unitEventOf } from "./success-persist.js";

/**
 * A stage's reason-to-halt, tagged by the post-processing arm that produced it.
 * Carries BOTH the fail-fast halt shape (the per-arm record call) and the
 * collect-all soft-halt reason string, so ONE gate decides between them.
 */
type HaltReason =
	| { kind: "stop"; stop: Exclude<StopSignal, "stop"> }
	| { kind: "extraction"; message: string }
	| { kind: "validation"; failureSummary: string }
	// A watchdog aborted a runaway tool call (bash) past its per-command timeout. The
	// host surfaces it via `WorkflowSessionContext.toolTimeout`; carries the operator-grade
	// reason string written to the failed row (soft-halt errMsg / terminal errMsg).
	| { kind: "timeout"; reason: string };

/**
 * The single collect-all fork. A `collectAll` fanout unit soft-halts (a
 * NON-terminal `collected:true` row + a `failedOutput` sentinel the parallel fold
 * places by index); every other stage takes the arm's fail-fast terminal halt.
 * Replaces the `if (s.collectAll)` that was inlined at all three halt sites.
 */
export async function haltStageOrSoftHalt(
	ctx: WorkflowHostContext,
	s: StageSession,
	reason: HaltReason,
	session: SessionRef | null,
): Promise<void> {
	if (s.collectAll) return softHaltUnit(ctx, s, softHaltReason(s, reason), session);
	return failFastHalt(ctx, s, reason, session);
}

/** Collect-all reason text per arm — byte-identical to the prior inline strings. */
function softHaltReason(s: StageSession, reason: HaltReason): string {
	switch (reason.kind) {
		case "stop":
			return `${s.skill} stopped (${reason.stop})`;
		case "extraction":
			return reason.message;
		case "validation":
			return reason.failureSummary;
		case "timeout":
			return reason.reason;
	}
}

/** Fail-fast terminal halt per arm — dispatches to the existing helpers, unchanged. */
function failFastHalt(
	ctx: WorkflowHostContext,
	s: StageSession,
	reason: HaltReason,
	session: SessionRef | null,
): Promise<void> {
	switch (reason.kind) {
		case "stop":
			return haltStage(ctx, s, reason.stop, session);
		case "extraction":
			return haltStageWithExtractionError(ctx, s, reason.message, session);
		case "validation":
			return haltStageWithValidationFailure(ctx, s, reason.failureSummary, session);
		case "timeout":
			// A non-fan-out stage whose bash overran the watchdog: terminal "failed" row whose
			// errMsg carries the timeout reason (same shape as an extraction-fatal halt).
			return haltStageWithExtractionError(ctx, s, reason.reason, session);
	}
}

async function haltStage(
	ctx: WorkflowHostContext,
	s: StageSession,
	stop: Exclude<StopSignal, "stop">,
	session: SessionRef | null,
): Promise<void> {
	await recordStopFailure(ctx, auditFor(s, session), stop, `${s.skill} failed`, s.onFailure);
}

async function haltStageWithExtractionError(
	ctx: WorkflowHostContext,
	s: StageSession,
	message: string,
	session: SessionRef | null,
): Promise<void> {
	await recordTerminalFailure(
		ctx,
		auditFor(s, session),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

/**
 * Collect-all fanout unit halt: write a NON-terminal failed row, then hand a
 * `failedOutput` sentinel to the continuation (`onSuccess`) so the parallel fold
 * places it by declared index (`foldFanoutCompletion` → `placeFanoutOutput`) and
 * `fanin(...).filter(Boolean)` skips it. The run survives — no `terminate()`. No
 * direct `applyCompletedStage` here (the fold owns the single channel-write — a
 * push here would double-write the slot). Recording + `onSuccess` run on the
 * launcher/observer `ctx` (the same posture as `postStage`).
 */
async function softHaltUnit(
	ctx: WorkflowHostContext,
	s: StageSession,
	reason: string,
	session: SessionRef | null,
): Promise<void> {
	s.allocatedStageNumber ??= allocateStageNumber(s.state);
	recordUnitHalt(ctx, auditFor(s, session), reason); // status:"failed" collected:true row (resume reads errMsg)
	// Fire the soft-halt lifecycle signal (mirrors recordStageSuccess's onUnitEnd) AFTER the row
	// lands. Without it this unit emits NO terminal lifecycle event — recordUnitHalt deliberately
	// skips onStageError ("not a hard fail") and the success-only onUnitEnd never runs — so a lane
	// bridge would leave the sub-row spinning until onWorkflowEnd, where a completed run's sweep
	// paints it ✓ (a failed-but-collected unit mis-rendered as success). The ref carries the PARENT
	// stage name (graph identity), same allocator base as every other ref of this activation.
	await s.lifecycle.fire(
		ctx,
		"onUnitHalt",
		skillStageRef(s.unit!.parent, s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber, s.skill),
		unitEventOf(s),
		reason,
		lifecycleCtxFromSession(s),
	);
	await s.onSuccess(ctx, failedOutput(outputMetaFor(s), reason));
}

/** OutputMeta for a sentinel — same stage number the failed row carries, so the
 *  live sentinel and the resume-rebuilt one are byte-identical. */
function outputMetaFor(s: StageSession): OutputMeta {
	return outputMeta({
		stage: s.stageName,
		skill: s.skill,
		stageNumber: s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber,
		ts: nowIso(),
		runId: s.runId,
	});
}

/** Exported to the `reattach.ts` companion — a promotion's validation-exhausted halt is identical to live. */
export async function haltStageWithValidationFailure(
	ctx: WorkflowHostContext,
	s: StageSession,
	failureSummary: string,
	session: SessionRef | null,
): Promise<void> {
	await recordTerminalFailure(
		ctx,
		auditFor(s, session),
		failedArgs(FAIL_VALIDATION_EXHAUSTED(s.skill, failureSummary)),
		s.onFailure,
	);
}

const auditFor = (s: StageSession, session: SessionRef | null): AuditCtx => ({
	cwd: s.cwd,
	runId: s.runId,
	state: s.state,
	stageName: s.stageName,
	skill: s.skill,
	// The Pi session backing this activation — `null` only for pre-open
	// cancellation (the one writer here that never entered a session).
	session,
	lifecycle: s.lifecycle,
	runIdentity: s.runIdentity,
	// The activation's pre-allocated stage number (set once output production
	// began) — a failure row reuses it instead of burning a second number.
	allocatedStageNumber: s.allocatedStageNumber,
	// Loop units thread their identity onto failure/cancellation rows so failed
	// trailers carry the structured fields the resume drift guard consumes.
	...(s.unit ? { unit: s.unit } : {}),
});
