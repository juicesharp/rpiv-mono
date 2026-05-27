/**
 * Session execution — one Pi session per workflow stage / fanout unit.
 * `runStageSession` and `runFanoutSession` are the two public entries.
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
	fanoutRowStage,
	nowIso,
	recordCancellation,
	recordStage,
	recordStopFailure,
	recordTerminalFailure,
} from "../audit.js";
import { resolvePublishName } from "../internal-utils.js";
import { buildLifecycleContext, skillStageRef } from "../lifecycle.js";
import {
	ERR_AUDIT_WRITE_FAILED,
	ERR_VALIDATION_FAILED,
	MSG_AUDIT_WRITE_FAILED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_VALIDATION_EXHAUSTED,
} from "../messages.js";
import type { Output } from "../output.js";
import { type BranchEntry, classifyStop, readBranch, type StopSignal } from "../transcript.js";
import type { FanoutSession, RunnerCtx, SessionContext, StageSession } from "../types.js";
import { produceAndValidateOutput } from "./extraction.js";
import { FRESH_HANDLER, handlerFor } from "./spawn.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const { cancelled } = await handler.spawn(ctx, s.prompt, (sessionCtx) => postStage(sessionCtx, s), s.continueHost);
	if (cancelled) await recordCancellation(ctx, auditFor(s));
}

/** Execute one fanout-unit iteration. Always fresh. */
export async function runFanoutSession(ctx: RunnerCtx, s: FanoutSession): Promise<void> {
	const { cancelled } = await FRESH_HANDLER.spawn(ctx, s.prompt, (sessionCtx) => postFanout(sessionCtx, s));
	if (cancelled) await recordCancellation(ctx, auditFor(s));
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/** Stage post-processing: classify outcome → produce & validate output → persist → chain. */
async function postStage(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const offset = handler.branchOffset(s.branchOffset);
	const outcome = readSessionOutcome(ctx, offset);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await produceAndValidateOutput(ctx, s, outcome.branch, offset);
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!(await recordStageSuccess(ctx, s, result.output))) return;
	await s.onSuccess(ctx, result.output.artifacts[0]);
}

/** Fanout-unit post-processing: classify outcome → persist bare row → chain. */
async function postFanout(ctx: RunnerCtx, s: FanoutSession): Promise<void> {
	const outcome = readSessionOutcome(ctx, undefined);
	if (outcome.stop !== "stop") return haltFanout(ctx, s, outcome.stop);

	if (!(await recordFanoutSuccess(ctx, s))) return;
	await s.onSuccess(ctx);
}

// ===========================================================================
// HALT HELPERS — turn a halt reason into the right audit-layer call
// ===========================================================================

async function haltStage(ctx: RunnerCtx, s: StageSession, stop: Exclude<StopSignal, "stop">): Promise<void> {
	await recordStopFailure(ctx, auditFor(s), stop, `${s.skill} failed`, s.onFailure);
}

async function haltStageWithExtractionError(ctx: RunnerCtx, s: StageSession, message: string): Promise<void> {
	await recordTerminalFailure(
		ctx,
		auditFor(s),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

async function haltStageWithValidationFailure(ctx: RunnerCtx, s: StageSession, failureSummary: string): Promise<void> {
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

async function haltFanout(ctx: RunnerCtx, s: FanoutSession, stop: Exclude<StopSignal, "stop">): Promise<void> {
	await recordStopFailure(ctx, auditFor(s), stop, `${s.skill} unit ${s.unitIndex} (${s.label}) failed`);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

/**
 * Write + counter-increment guard shared by `recordStageSuccess` and
 * `recordFanoutSuccess`. Returns `true` iff the JSONL row landed.
 * Output assignment lives here so callers get the same "output is
 * set iff the row that carried it landed" invariant.
 */
function tryRecordStage(s: SessionContext, row: { stage: string; skill?: string; output?: Output }): boolean {
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{
			stage: row.stage,
			skill: row.skill,
			status: "completed",
			ts: nowIso(),
			output: row.output,
		},
		s.state,
	);
	if (assigned === undefined) return false;
	if (row.output) s.state.output = row.output;
	s.state.stagesCompleted++;
	return true;
}

/**
 * Update the rolling chain-input slot. Three cases:
 *   1. `produces` stages whose collector returned at least one artifact
 *      advance the primary (first artifact wins; `role` is user-facing
 *      metadata, not a framework gate).
 *   2. `side-effect` stages with `inheritsArtifacts: false` (authored via
 *      `terminal()`) CLEAR the slot — they explicitly break the chain
 *      so anything after also starts without an inherited artifact.
 *   3. Other `side-effect` stages (commit, implement) leave it in place
 *      so a stage after them inherits the upstream chain input.
 */
function maybeAdvancePrimary(s: StageSession, output: Output): void {
	if (s.stage.kind === "produces") {
		const next = output.artifacts[0];
		if (next) s.state.primaryArtifact = next;
		const key = resolvePublishName(s.stage, s.stageName);
		const slot = s.state.named[key];
		if (slot) slot.push(output);
		else s.state.named[key] = [output];
		return;
	}
	if (s.stage.inheritsArtifacts === false) {
		s.state.primaryArtifact = undefined;
	}
}

/**
 * Returns true on successful write — caller gates `onSuccess` on this so the
 * chain advances only when the audit row landed. On failure, leaves
 * `state.output` / `state.primaryArtifact` at their prior values and sets
 * `state.termination.error` to halt the run.
 */
async function recordStageSuccess(ctx: RunnerCtx, s: StageSession, output: Output): Promise<boolean> {
	if (tryRecordStage(s, { stage: s.stageName, skill: s.skill, output })) {
		maybeAdvancePrimary(s, output);
		ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
		await s.lifecycle.fire(
			ctx,
			"onStageEnd",
			skillStageRef(s.stageName, s.state.lastAllocatedStageNumber, s.skill),
			output,
			lifecycleCtxFromSession(s),
		);
		return true;
	}
	ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(s.skill);
	return false;
}

async function recordFanoutSuccess(ctx: RunnerCtx, s: FanoutSession): Promise<boolean> {
	const stageLabel = fanoutRowStage(s);
	if (tryRecordStage(s, { stage: stageLabel, skill: s.skill })) {
		await s.lifecycle.fire(
			ctx,
			"onFanoutUnitEnd",
			skillStageRef(s.stageName, s.stageIndex + 1, s.skill),
			{ prompt: s.prompt, label: s.label, ...(s.id !== undefined && { id: s.id }) },
			s.unitIndex,
			lifecycleCtxFromSession(s),
		);
		return true;
	}
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(stageLabel);
	return false;
}

/** Build a `LifecycleContext` from any SessionContext-shaped object. */
function lifecycleCtxFromSession(s: SessionContext) {
	return buildLifecycleContext({
		cwd: s.cwd,
		runId: s.runId,
		workflow: s.runIdentity.workflow,
		totalStages: s.runIdentity.totalStages,
		trigger: s.runIdentity.trigger,
		state: s.state,
	});
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
function readSessionOutcome(ctx: RunnerCtx, branchOffset: number | undefined): SessionOutcome {
	const branch = readBranch(ctx);
	return {
		branch,
		stop: classifyStop(branch, branchOffset),
	};
}

// ===========================================================================
// Helpers
// ===========================================================================

const auditFor = (s: StageSession | FanoutSession): AuditCtx => ({
	cwd: s.cwd,
	runId: s.runId,
	state: s.state,
	stageName: "unitIndex" in s ? fanoutRowStage(s) : s.stageName,
	skill: s.skill,
	lifecycle: s.lifecycle,
	runIdentity: s.runIdentity,
});
