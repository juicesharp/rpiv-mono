/**
 * Session execution — one Pi session per workflow stage / loop unit.
 * `runStageSession` is the only public entry (loop units run through it too,
 * threading their identity via `StageSession.unit`).
 *
 * Every stage runs in its own detached child session (`spawnChildAndRun`,
 * spawn.ts); the only surviving policy divergence is the branch offset
 * (`branchOffsetFor`). Everything in this file — post-processing, halt routing,
 * success persistence, outcome reading — is policy-agnostic.
 *
 * Companion modules:
 *   - extraction.ts — produceAndValidateOutput + retry loop +
 *                     outcome helpers (collector → parser pipeline).
 *   - spawn.ts      — the child-spawn primitives (`spawnChildAndRun`,
 *                     `reattachChildSession`, `resendIntoChild`) + `laneFor` /
 *                     `branchOffsetFor`.
 *   - reattach.ts   — session-backed resume (promotion + reattach); reuses
 *                     postStage / recordStageSuccess / the halt helpers
 *                     exported below instead of duplicating them.
 */

import {
	type AuditCtx,
	currentStageRef,
	failedArgs,
	recordStopFailure,
	recordTerminalFailure,
	recordUnitHalt,
	terminate,
} from "../audit.js";
import { allocateStageNumber, persistStageSuccess } from "../audit-rows.js";
import { lifecycleCtxFromSession, skillStageRef, type UnitEvent } from "../events.js";
import { nowIso, WorkflowAbortError } from "../internal-utils.js";
import {
	FAIL_AUDIT_WRITE,
	FAIL_VALIDATION_EXHAUSTED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_UNIT_COMPLETE,
	MSG_UNIT_FAILED,
} from "../messages.js";
import { failedOutput, type Output, type OutputMeta } from "../output.js";
import type { SessionRef } from "../state/index.js";
import { type BranchEntry, classifyStop, readBranch, readSessionRef, type StopSignal } from "../transcript.js";
import type { StageSession, WorkflowHostContext, WorkflowSessionContext } from "../types.js";
import { produceAndValidateOutput } from "./extraction.js";
import { branchOffsetFor, spawnChildAndRun } from "./spawn.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage (or loop unit) in its own detached child session. */
export async function runStageSession(ctx: WorkflowHostContext, s: StageSession): Promise<void> {
	await spawnChildAndRun(ctx, s, (child) => postStage(ctx, child, s));
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/**
 * Stage post-processing: classify outcome → produce & validate output →
 * persist → chain. Exported to the `reattach.ts` companion — a reattached
 * session's continuation runs this exact pipeline, byte-identical to live.
 *
 * TWO ctxs (detachment): `obsCtx` is the long-lived LAUNCHER/observer ctx the
 * walk threads — it stays valid across every stage, so the user-facing recording
 * (success/halt rows + notifications + lifecycle) AND the chain continuation
 * (`onSuccess` → advance/step, which spawns the NEXT stage's child) all run on
 * it, NOT on the per-stage child (whose UI is the lane binding — noOp in the
 * background lane — and which is disposed when the stage ends). `child` is the
 * in-session ctx: the agent transcript (`readBranch`/`readSessionRef`) and the
 * validation-retry re-prompt (`produceAndValidateOutput` → `resendIntoChild`)
 * read/write through it. Spawning the next stage off `obsCtx` is what keeps the
 * launcher the single spawner (no nested-child chain).
 *
 * The backing `SessionRef` is captured ONCE at entry — every row this
 * pipeline can write (success, stop-failure, extraction/validation failure)
 * carries the same provenance value.
 */
export async function postStage(
	obsCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSession,
): Promise<void> {
	const offset = branchOffsetFor(s.stage.sessionPolicy, s.branchOffset);
	const session = readSessionRef(child, offset);
	const outcome = readSessionOutcome(child, offset);
	// Abort surfaces as a STOP CLASSIFICATION, not a promise rejection:
	// `session.abort()` makes the SDK RESOLVE `prompt()` with a
	// `stopReason:"aborted"` transcript message, so an aborted in-flight child runs
	// straight into here. Throw BEFORE haltStage/softHaltUnit/any row write so:
	// (a) no `collected:true` row is written (else the resume fold marks the unit
	// "don't re-dispatch" → permanent work loss), (b) the parallel fold's
	// `isAbortError` branch leaves the slot unfilled, and (c) resume re-dispatches
	// the unit cleanly.
	if (s.signal?.aborted || outcome.stop === "aborted") throw new WorkflowAbortError();
	// A fanout unit marked `collectAll` records a NON-terminal failed row + a
	// sentinel slot instead of halting the run; everything else keeps the existing
	// fail-fast halt. Recording + the continuation run on obsCtx (the launcher) —
	// the per-stage child is disposed when the stage ends.
	if (outcome.stop !== "stop") {
		if (s.collectAll) return softHaltUnit(obsCtx, s, `${s.skill} stopped (${outcome.stop})`, session);
		return haltStage(obsCtx, s, outcome.stop, session);
	}

	const result = await produceAndValidateOutput(child, s, outcome.branch, offset);
	if (result.kind === "fatal") {
		if (s.collectAll) return softHaltUnit(obsCtx, s, result.message, session);
		return haltStageWithExtractionError(obsCtx, s, result.message, session);
	}
	if (result.kind === "validation-exhausted") {
		if (s.collectAll) return softHaltUnit(obsCtx, s, result.failureSummary, session);
		return haltStageWithValidationFailure(obsCtx, s, result.failureSummary, session);
	}

	if (!(await recordStageSuccess(obsCtx, s, result.output, session))) return;
	// The validated Output goes to the continuation directly — loop drivers
	// thread it into accumulated / feedForward without state back-reads. Runs on
	// obsCtx so the next stage's child is spawned off the launcher.
	await s.onSuccess(obsCtx, result.output);
}

// ===========================================================================
// HALT HELPERS — turn a halt reason into the right audit-layer call
// ===========================================================================

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
	ctx.ui.notify(MSG_UNIT_FAILED(s.skill, s.unit?.label ?? s.stageName), "warning");
	await s.onSuccess(ctx, failedOutput(outputMetaFor(s), reason));
}

/** OutputMeta for a sentinel — same stage number the failed row carries, so the
 *  live sentinel and the resume-rebuilt one are byte-identical. */
function outputMetaFor(s: StageSession): OutputMeta {
	return {
		stage: s.stageName,
		skill: s.skill,
		stageNumber: s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber,
		ts: nowIso(),
		runId: s.runId,
	};
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
	const auditFailure = FAIL_AUDIT_WRITE(s.skill);
	ctx.ui.notify(auditFailure.toast, "error");
	terminate(s.state, { status: "failed", error: auditFailure.error });
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
