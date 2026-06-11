/**
 * Session execution — one Pi session per workflow stage / loop unit.
 * `runStageSession` is the only public entry (loop units run through it too,
 * threading their identity via `StageSession.unit`).
 *
 * The fresh-vs-continue policy split is owned by `SessionPolicyHandler`
 * (see `spawn.ts`): `FRESH_HANDLER` and `CONTINUE_HANDLER` implement
 * the three policy-specific decisions. Everything in this file —
 * post-processing, halt routing, success persistence, outcome reading
 * — is policy-agnostic.
 *
 * Companion modules:
 *   - extraction.ts — produceAndValidateOutput + retry loop +
 *                     outcome helpers (collector → parser pipeline).
 *   - spawn.ts      — SessionPolicyHandler + FRESH/CONTINUE handlers +
 *                     handlerFor.
 */

import {
	type AuditCtx,
	currentStageRef,
	recordCancellation,
	recordStopFailure,
	recordTerminalFailure,
	terminate,
} from "../audit.js";
import { persistStageSuccess } from "../audit-rows.js";
import { lifecycleCtxFromSession, skillStageRef, type UnitEvent } from "../lifecycle.js";
import {
	ERR_AUDIT_WRITE_FAILED,
	ERR_VALIDATION_FAILED,
	MSG_AUDIT_WRITE_FAILED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_UNIT_COMPLETE,
	MSG_VALIDATION_EXHAUSTED,
} from "../messages.js";
import type { Output } from "../output.js";
import { type BranchEntry, classifyStop, readBranch, type StopSignal } from "../transcript.js";
import type { StageSession, WorkflowHostContext } from "../types.js";
import { produceAndValidateOutput } from "./extraction.js";
import { handlerFor } from "./spawn.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage (or loop unit) in its own session. */
export async function runStageSession(ctx: WorkflowHostContext, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const { cancelled } = await handler.spawn(ctx, s.prompt, (sessionCtx) => postStage(sessionCtx, s), s.continueHost);
	if (cancelled) recordCancellation(ctx, auditFor(s));
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/** Stage post-processing: classify outcome → produce & validate output → persist → chain. */
async function postStage(ctx: WorkflowHostContext, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const offset = handler.branchOffset(s.branchOffset);
	const outcome = readSessionOutcome(ctx, offset);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await produceAndValidateOutput(ctx, s, outcome.branch, offset);
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!(await recordStageSuccess(ctx, s, result.output))) return;
	// The validated Output goes to the continuation directly — loop drivers
	// thread it into accumulated / feedForward without state back-reads.
	await s.onSuccess(ctx, result.output);
}

// ===========================================================================
// HALT HELPERS — turn a halt reason into the right audit-layer call
// ===========================================================================

async function haltStage(ctx: WorkflowHostContext, s: StageSession, stop: Exclude<StopSignal, "stop">): Promise<void> {
	await recordStopFailure(ctx, auditFor(s), stop, `${s.skill} failed`, s.onFailure);
}

async function haltStageWithExtractionError(ctx: WorkflowHostContext, s: StageSession, message: string): Promise<void> {
	await recordTerminalFailure(
		ctx,
		auditFor(s),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

async function haltStageWithValidationFailure(
	ctx: WorkflowHostContext,
	s: StageSession,
	failureSummary: string,
): Promise<void> {
	await recordTerminalFailure(
		ctx,
		auditFor(s),
		{
			status: "failed",
			notifyMsg: MSG_VALIDATION_EXHAUSTED(s.skill),
			notifyLevel: "error",
			errMsg: ERR_VALIDATION_FAILED(s.skill, failureSummary),
		},
		s.onFailure,
	);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

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
 * Single stages keep the `onStageEnd` + `MSG_STAGE_COMPLETE` contract
 * verbatim. Loop units fire `onUnitEnd` (NEVER `onStageEnd` — that's reserved
 * for single-stage and loop-level semantics) with a labeled toast, the ref
 * carrying the PARENT stage name so listeners key on graph identity, not the
 * display decoration.
 */
async function recordStageSuccess(ctx: WorkflowHostContext, s: StageSession, output: Output): Promise<boolean> {
	const persisted = persistStageSuccess(
		s.state,
		{
			cwd: s.cwd,
			runId: s.runId,
			stage: s.stageName,
			skill: s.skill,
			output,
			unit: s.unit,
			preAllocated: s.allocatedStageNumber,
		},
		s.stage,
	);
	if (persisted) {
		if (s.unit) {
			ctx.ui.notify(MSG_UNIT_COMPLETE(s.skill, s.unit.label), "info");
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
			ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
			await s.lifecycle.fire(ctx, "onStageEnd", currentStageRef(s), output, lifecycleCtxFromSession(s));
		}
		return true;
	}
	ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
	terminate(s.state, { status: "failed", error: ERR_AUDIT_WRITE_FAILED(s.skill) });
	return false;
}

/** Public `UnitEvent` payload from the session's `UnitRef` + dispatched skill. */
function unitEventOf(s: StageSession): UnitEvent {
	const u = s.unit!;
	return { role: u.role, index: u.index, unitId: u.id, label: u.label, skill: s.skill };
}

// ===========================================================================
// OUTCOME READER
// ===========================================================================

interface SessionOutcome {
	branch: BranchEntry[];
	stop: StopSignal;
}

/**
 * Always reads the full unsliced branch + applies the policy-derived
 * `branchOffset` to `classifyStop` so the prior-stage prefix is
 * skipped in place. The same offset value flows through to
 * `produceAndValidateOutput` (initial == retry).
 *
 * No longer scans the transcript for an artifact path — discovery is
 * the collector's job, not the runner's.
 */
function readSessionOutcome(ctx: WorkflowHostContext, branchOffset: number | undefined): SessionOutcome {
	const branch = readBranch(ctx);
	return {
		branch,
		stop: classifyStop(branch, branchOffset),
	};
}

// ===========================================================================
// Helpers
// ===========================================================================

const auditFor = (s: StageSession): AuditCtx => ({
	cwd: s.cwd,
	runId: s.runId,
	state: s.state,
	stageName: s.stageName,
	skill: s.skill,
	lifecycle: s.lifecycle,
	runIdentity: s.runIdentity,
	// The activation's pre-allocated stage number (set once output production
	// began) — a failure row reuses it instead of burning a second number.
	allocatedStageNumber: s.allocatedStageNumber,
	// Loop units thread their identity onto failure/cancellation rows so failed
	// trailers carry the structured fields the resume drift guard consumes.
	...(s.unit ? { unit: s.unit } : {}),
});
