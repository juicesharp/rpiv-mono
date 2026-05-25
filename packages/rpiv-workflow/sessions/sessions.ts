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
 *   - extraction.ts — produceAndValidateManifest + retry loop +
 *                     outcome helpers (collector → parser pipeline).
 *   - spawn.ts      — SessionPolicyHandler + FRESH/CONTINUE handlers +
 *                     handlerFor.
 */

import {
	type AuditCtx,
	fanoutRowLabel,
	nowIso,
	recordCancellation,
	recordStage,
	recordStopFailure,
	recordTerminalFailure,
} from "../audit.js";
import type { Manifest } from "../manifest.js";
import {
	ERR_AUDIT_WRITE_FAILED,
	ERR_VALIDATION_FAILED,
	MSG_AUDIT_WRITE_FAILED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_VALIDATION_EXHAUSTED,
} from "../messages.js";
import { type BranchEntry, classifyStop, readBranch, type StopSignal } from "../transcript.js";
import type { FanoutSession, RunnerCtx, SessionContext, StageSession } from "../types.js";
import { produceAndValidateManifest } from "./extraction.js";
import { FRESH_HANDLER, handlerFor } from "./spawn.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const { cancelled } = await handler.spawn(ctx, s.prompt, (sessionCtx) => postStage(sessionCtx, s), s.host);
	if (cancelled) recordCancellation(ctx, auditFor(s));
}

/** Execute one fanout-unit iteration. Always fresh. */
export async function runFanoutSession(ctx: RunnerCtx, s: FanoutSession): Promise<void> {
	const { cancelled } = await FRESH_HANDLER.spawn(ctx, s.prompt, (sessionCtx) => postFanout(sessionCtx, s));
	if (cancelled) recordCancellation(ctx, auditFor(s));
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/** Stage post-processing: classify outcome → produce & validate manifest → persist → chain. */
async function postStage(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.stage.sessionPolicy);
	const offset = handler.branchOffset(s.branchOffset);
	const outcome = readSessionOutcome(ctx, offset);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await produceAndValidateManifest(ctx, s, outcome.branch, offset);
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!recordStageSuccess(ctx, s, result.manifest)) return;
	await s.onSuccess(ctx, result.manifest.artifacts[0]);
}

/** Fanout-unit post-processing: classify outcome → persist bare row → chain. */
async function postFanout(ctx: RunnerCtx, s: FanoutSession): Promise<void> {
	const outcome = readSessionOutcome(ctx, undefined);
	if (outcome.stop !== "stop") return haltFanout(ctx, s, outcome.stop);

	if (!recordFanoutSuccess(s)) return;
	await s.onSuccess(ctx);
}

// ===========================================================================
// HALT HELPERS — turn a halt reason into the right audit-layer call
// ===========================================================================

function haltStage(ctx: RunnerCtx, s: StageSession, stop: Exclude<StopSignal, "stop">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} failed`, s.onFailure);
}

function haltStageWithExtractionError(ctx: RunnerCtx, s: StageSession, message: string): void {
	recordTerminalFailure(
		ctx,
		auditFor(s),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

function haltStageWithValidationFailure(ctx: RunnerCtx, s: StageSession, failureSummary: string): void {
	recordTerminalFailure(
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

function haltFanout(ctx: RunnerCtx, s: FanoutSession, stop: Exclude<StopSignal, "stop">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} unit ${s.unitIndex} (${s.label}) failed`);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

/**
 * Write + counter-increment guard shared by `recordStageSuccess` and
 * `recordFanoutSuccess`. Returns `true` iff the JSONL row landed.
 * Manifest assignment lives here so callers get the same "manifest is
 * set iff the row that carried it landed" invariant.
 */
function tryRecordStage(s: SessionContext, label: string, manifest: Manifest | undefined): boolean {
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{
			skill: label,
			status: "completed",
			ts: nowIso(),
			manifest,
		},
		s.state,
	);
	if (assigned === undefined) return false;
	if (manifest) s.state.manifest = manifest;
	s.state.stagesCompleted++;
	return true;
}

/**
 * Update the rolling chain-input slot. Only `produces` stages whose
 * collector returned at least one artifact advance the primary —
 * `side-effect` stages (commit, implement) leave it in place so a stage
 * after them inherits the upstream chain input. The first artifact in
 * the manifest is the primary; `role` is user-facing metadata, not a
 * framework gate.
 */
function maybeAdvancePrimary(s: StageSession, manifest: Manifest): void {
	if (s.stage.kind !== "produces") return;
	const next = manifest.artifacts[0];
	if (next) s.state.primaryArtifact = next;
}

/**
 * Returns true on successful write — caller gates `onSuccess` on this so the
 * chain advances only when the audit row landed. On failure, leaves
 * `state.manifest` / `state.primaryArtifact` at their prior values and sets
 * `state.termination.error` to halt the run.
 */
function recordStageSuccess(ctx: RunnerCtx, s: StageSession, manifest: Manifest): boolean {
	if (tryRecordStage(s, s.skill, manifest)) {
		maybeAdvancePrimary(s, manifest);
		ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
		return true;
	}
	ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(s.skill);
	return false;
}

function recordFanoutSuccess(s: FanoutSession): boolean {
	const label = fanoutRowLabel(s);
	if (tryRecordStage(s, label, undefined)) return true;
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(label);
	return false;
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
 * `produceAndValidateManifest` (L6-05: initial == retry).
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
	skill: s.skill,
});
