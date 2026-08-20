/**
 * Halt-routing facet — extracted from `sessions.ts`'s HALT HELPERS. Turns a
 * halt reason into the right audit-layer call. `haltStageOrSoftHalt` is the
 * single gate `postStage` dispatches through (a `collectAll` fanout unit
 * soft-halts SEMANTIC failures; an infra-death stop hard-fails even there —
 * see `isInfraDeath`; everything else fail-fast halts).
 * `haltStageWithValidationFailure` is also exported for the `reattach.ts`
 * companion.
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

import { type AuditContext, failedArgs, recordFatalFailure, recordStopFailure, recordUnitHalt } from "../audit.js";
import { allocateStageNumber } from "../audit-rows.js";
import { lifecycleCtxFromSession, skillStageRef } from "../events.js";
import { nowIso } from "../internal-utils.js";
import { FAIL_VALIDATION_EXHAUSTED, MSG_STAGE_FAILED } from "../messages.js";
import { failedOutput, type OutputMeta, outputMeta } from "../output.js";
import type { SessionRef } from "../state/index.js";
import type { StopSignal } from "../transcript.js";
import type { StageSessionContext, WorkflowHostContext } from "../types.js";
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
 * Stop signals that witness an INFRA death — the child session never delivered
 * a complete agentic pass:
 *   - `error`      — the SDK/API errored out under the session;
 *   - `noResponse` — the model never spoke (the child died before producing
 *                    anything, e.g. killed at spawn);
 *   - `toolUse`    — the transcript ENDS on a tool request: an agentic loop
 *                    truncated mid-flight, the signature of a killed child
 *                    process (the OOM killer's favourite).
 * `length` is deliberately absent: the model consumed its output budget — a
 * genuine model-behavior outcome an identical retry would likely reproduce, so
 * it stays a collected (semantic) failure for the downstream floors to judge.
 * `aborted` never reaches the stop arm (`classifyAndHandleAbort` owns it and
 * throws `WorkflowAbortError` — no row, slot unfilled, resume re-dispatches).
 */
const INFRA_DEATH_STOPS: ReadonlySet<StopSignal> = new Set(["error", "noResponse", "toolUse"]);

/**
 * True when the halt reason witnesses infrastructure death rather than a
 * judged-bad output. The distinction is load-bearing for collect-all fanout
 * units: a collected soft-halt is a PERMANENT skip — the resume fold rebuilds
 * its `failedOutput` sentinel by `unitIndex` and never re-dispatches the unit
 * (runner/resume.ts `foldFanoutRow`), so collecting a transient infra death
 * turns one OOM'd unit into an unrepairable hole three stages downstream
 * (the slice-design → subplan-check incident). `extraction`/`validation`/
 * `timeout` stay collected: there the skill RAN and its output (or runaway
 * tool call) was judged — an identical retry is not obviously better, and the
 * deterministic floors downstream are the right judge.
 */
const isInfraDeath = (reason: HaltReason): boolean => reason.kind === "stop" && INFRA_DEATH_STOPS.has(reason.stop);

/**
 * The single collect-all fork. A `collectAll` fanout unit soft-halts a
 * SEMANTIC failure (a NON-terminal `collected:true` row + a `failedOutput`
 * sentinel the parallel fold places by index); an infra-death stop takes the
 * fail-fast terminal halt EVEN for collect-all — the trail then carries an
 * UNCOLLECTED failed unit row, the resume fold leaves the slot unfilled, and
 * resume re-dispatches exactly the dead unit. Completed siblings are unharmed:
 * the parallel dispatcher never sibling-cancels a non-`failFast` fanout, and
 * `recordStageSuccess` is not status-gated, so their rows land before the
 * generation settles and the terminated run stops advancing. Every other stage
 * takes the arm's fail-fast terminal halt, unchanged.
 */
export async function haltStageOrSoftHalt(
	ctx: WorkflowHostContext,
	s: StageSessionContext,
	reason: HaltReason,
	session: SessionRef | null,
): Promise<void> {
	if (s.collectAll && !isInfraDeath(reason)) return softHaltUnit(ctx, s, softHaltReason(s, reason), session);
	return failFastHalt(ctx, s, reason, session);
}

/** Collect-all reason text per arm — byte-identical to the prior inline strings. */
function softHaltReason(s: StageSessionContext, reason: HaltReason): string {
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
	s: StageSessionContext,
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
	s: StageSessionContext,
	stop: Exclude<StopSignal, "stop">,
	session: SessionRef | null,
): Promise<void> {
	await recordStopFailure(ctx, auditFor(s, session), stop, `${s.skill} failed`, s.onFailure);
}

async function haltStageWithExtractionError(
	ctx: WorkflowHostContext,
	s: StageSessionContext,
	message: string,
	session: SessionRef | null,
): Promise<void> {
	await recordFatalFailure(
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
	s: StageSessionContext,
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
function outputMetaFor(s: StageSessionContext): OutputMeta {
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
	s: StageSessionContext,
	failureSummary: string,
	session: SessionRef | null,
): Promise<void> {
	await recordFatalFailure(
		ctx,
		auditFor(s, session),
		failedArgs(FAIL_VALIDATION_EXHAUSTED(s.skill, failureSummary)),
		s.onFailure,
	);
}

const auditFor = (s: StageSessionContext, session: SessionRef | null): AuditContext => ({
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
	// Host-injected persisted-session branch reader — the death-scene artifact
	// writer reads it off AuditContext. Absent for programmatic embedders / no
	// provider (the writer degrades silently). Conditional spread keeps the
	// common case (reader present) byte-clean and the no-provider case undefined.
	...(s.readSessionBranch ? { readSessionBranch: s.readSessionBranch } : {}),
	// Loop units thread their identity onto failure/cancellation rows so failed
	// trailers carry the structured fields the resume drift guard consumes.
	...(s.unit ? { unit: s.unit } : {}),
});
