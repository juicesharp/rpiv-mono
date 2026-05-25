/**
 * Session execution — one Pi session per workflow stage / fanout unit.
 * `runStageSession` and `runFanoutSession` are the two public entries.
 *
 * The fresh-vs-continue policy split is owned by `SessionPolicyHandler`
 * (see `spawn.ts`): `FRESH_HANDLER` and `CONTINUE_HANDLER` implement
 * the three policy-specific decisions (branch offset for extraction,
 * spawn shape, send-into-existing-session). Everything in this file —
 * post-processing, halt routing, success persistence, outcome reading
 * — is policy-agnostic.
 *
 * Companion modules:
 *   - extraction.ts — extractAndValidateManifest + retry loop +
 *                     outcome helpers.
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
import { type BranchEntry, classifyStop, extractArtifactPath, readBranch, type StopSignal } from "../transcript.js";
import type { FanoutSession, RunnerCtx, SessionContext, StageSession } from "../types.js";
import { extractAndValidateManifest } from "./extraction.js";
import { FRESH_HANDLER, handlerFor } from "./spawn.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.node.sessionPolicy);
	const { cancelled } = await handler.spawn(ctx, s.prompt, (sessionCtx) => postStage(sessionCtx, s), s.pi);
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

/** Stage post-processing: classify outcome → extract & validate → persist → chain. */
async function postStage(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.node.sessionPolicy);
	const offset = handler.branchOffset(s.branchOffset);
	const outcome = readSessionOutcome(ctx, offset);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await extractAndValidateManifest(ctx, s, outcome.branch, offset);
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!recordStageSuccess(ctx, s, outcome.artifact, result.manifest)) return;
	await s.onSuccess(ctx, outcome.artifact);
}

/** Fanout-unit post-processing: classify outcome → persist bare row → chain. */
async function postFanout(ctx: RunnerCtx, s: FanoutSession): Promise<void> {
	const outcome = readSessionOutcome(ctx, undefined);
	if (outcome.stop !== "stop") return haltFanout(ctx, s, outcome.stop);

	if (!recordFanoutSuccess(s, outcome.artifact)) return;
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
 * `recordPhaseSuccess`. Returns `true` iff the JSONL row landed. Manifest
 * assignment lives here so both callers get the same "manifest is set iff
 * the row that carried it landed" invariant. Caller-specific bits (notify,
 * `state.termination.error`, `state.fallbackArtifactPath`) stay outside.
 */
function tryRecordStage(s: SessionContext, label: string, args: { artifact?: string; manifest?: Manifest }): boolean {
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{
			skill: label,
			artifact: args.artifact,
			status: "completed",
			ts: nowIso(),
			manifest: args.manifest,
		},
		s.state,
	);
	if (assigned === undefined) return false;
	if (args.manifest) s.state.manifest = args.manifest;
	s.state.stagesCompleted++;
	return true;
}

/**
 * Returns true on successful write — caller gates `onSuccess` on this so the
 * chain advances only when the audit row landed. On failure, leaves
 * `state.manifest` / `state.fallbackArtifactPath` at their prior values (the
 * disk has no row for what just completed, so the in-memory pointers must not
 * advance past it) and sets `state.termination.error` to halt the run.
 */
function recordStageSuccess(
	ctx: RunnerCtx,
	s: StageSession,
	artifact: string | undefined,
	manifest: Manifest | undefined,
): boolean {
	if (tryRecordStage(s, s.skill, { artifact, manifest })) {
		if (!s.state.manifest?.artifact_path && artifact) s.state.fallbackArtifactPath = artifact;
		ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
		return true;
	}
	ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(s.skill);
	return false;
}

function recordFanoutSuccess(s: FanoutSession, artifact: string | undefined): boolean {
	const label = fanoutRowLabel(s);
	if (tryRecordStage(s, label, { artifact })) {
		if (artifact) s.state.fallbackArtifactPath = artifact;
		return true;
	}
	s.state.termination.error = ERR_AUDIT_WRITE_FAILED(label);
	return false;
}

// ===========================================================================
// OUTCOME READER
// ===========================================================================

interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopSignal;
}

/**
 * Always reads the full unsliced branch + applies the policy-derived
 * `branchOffset` to the helpers that need it. The slice is no longer
 * materialised — `classifyStop` and `extractArtifactPath` both accept an
 * `offsetStart` so they skip the prior-stage prefix in place. Same offset
 * value flows through to extract (L6-05: initial == retry).
 */
function readSessionOutcome(ctx: RunnerCtx, branchOffset: number | undefined): SessionOutcome {
	const branch = readBranch(ctx);
	return {
		branch,
		artifact: extractArtifactPath(branch, branchOffset),
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
