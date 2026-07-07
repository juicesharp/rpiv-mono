/**
 * Terminal-outcome orchestration — the impure half of the audit layer.
 * Turns a halt reason into the full bundle a terminal outcome owes the
 * user and the system: the JSONL failure row (via `audit-rows.ts`), the
 * status-line clear, the notify toast, the `terminate()` state write, and
 * the `onStageError` lifecycle fire.
 *
 * Depends on audit-rows + audit-ctx + state + messages + events + handle.
 * The pure ctx half (`AuditCtx`, `runIdentityOf`, `auditCtxFor`,
 * `currentStageRef`) now lives in `audit-ctx.ts`; the terminal-args builders
 * (`failedArgs`/`abortedArgs`/`TerminalFailureArgs`) live in `messages.ts`.
 * Both are re-exported below so existing audit-layer consumers keep one
 * import site; new code may import `audit-ctx.ts` / `messages.ts` directly.
 * Shared by the runner + sessions; neither imports back. Pure row
 * persistence (the allocator, `recordStage`, success persistence) lives in
 * `audit-rows.ts`.
 */

import type { AuditCtx } from "./audit-ctx.js";
import { recordStage, unitRowFields } from "./audit-rows.js";
import { lifecycleCtxFromSession, scriptStageRef, skillStageRef } from "./events.js";
import { handleToString } from "./handle.js";
import { assertNever, nowIso } from "./internal-utils.js";
import {
	abortedArgs,
	FAIL_AUDIT_WRITE,
	FAIL_STAGE_ABORTED,
	FAIL_STAGE_NO_RESPONSE,
	FAIL_STAGE_TOOL_STALLED,
	FAIL_STAGE_TRUNCATED,
	failedArgs,
	MSG_FAILURE_ROW_DROPPED,
	MSG_PARTIAL_ARTIFACTS,
	MSG_STAGE_FAILED,
	MSG_WORKFLOW_CANCELLED,
	type TerminalFailureArgs,
} from "./messages.js";
import { listArtifacts } from "./state/index.js";
import type { StopSignal } from "./transcript.js";
import type { RunState, RunTermination, WorkflowHostContext } from "./types.js";

// Preserving barrel — the pre-split import surface is unchanged. Consumers
// (`sessions/`, `runner/`, `loop-kinds`, `loop-parallel`, `internal.ts`,
// `audit.test.ts`) keep importing `AuditCtx`/`runIdentityOf`/`auditCtxFor`/
// `currentStageRef`/`failedArgs`/`abortedArgs`/`TerminalFailureArgs` from
// "./audit.js" with no edit. Symbols now live in their post-split homes:
export type { AuditCtx } from "./audit-ctx.js";
export { auditCtxFor, currentStageRef, runIdentityOf } from "./audit-ctx.js";
// Re-export the persistence half so existing audit-layer consumers keep one
// import site; new code may import audit-rows.js directly.
export { allocateStageNumber, decorateStage, recordStage, unitRowFields } from "./audit-rows.js";
export type { TerminalFailureArgs } from "./messages.js";
export { abortedArgs, failedArgs } from "./messages.js";

/**
 * `state.termination` mutator. Every terminal path — completion
 * (`finalizeWorkflow`), failure/abort (`recordTerminalFailure`), cancellation
 * (`recordCancellation`), audit-write halts — lands its outcome through here,
 * so the union can never be half-set and a new outcome variant has one
 * write-site to thread through. Last write wins (a failure recorded after an
 * earlier failure on the same unwind keeps today's semantics).
 */
export function terminate(state: RunState, outcome: Exclude<RunTermination, { status: "running" }>): void {
	state.termination = outcome;
}

/**
 * Terminal halt for "the success row failed to persist." The audit JSONL is the
 * run's system of record, so a dropped append leaves state un-advanced and ends
 * the run. Notify+terminate idiom shared by the skill/unit success
 * path (`recordStageSuccess`, sessions.ts) and the script path
 * (`runScript`, script-stage.ts); each caller maps the void return to its own
 * halt token (`false` / `"halted"`). `subject` is the skill (or stage) the
 * failure message names.
 */
export function failAuditWrite(ctx: WorkflowHostContext, state: RunState, subject: string): void {
	const failure = FAIL_AUDIT_WRITE(subject);
	ctx.ui.notify(failure.toast, "error");
	terminate(state, { status: "failed", error: failure.error });
}

/** Surface every artifact recorded so far — recap on stage failure. */
export function notifyPartialArtifacts(ctx: WorkflowHostContext, cwd: string, runId: string): void {
	const items = listArtifacts(cwd, runId);
	if (items.length === 0) return;
	const artifactList = items.map((i) => `  • ${i.stage}: ${handleToString(i.artifact.handle)}`).join("\n");
	ctx.ui.notify(MSG_PARTIAL_ARTIFACTS(artifactList), "info");
}

/**
 * Terminal/halt/cancellation row-write authority. `recordStage` + the
 * dropped-row guard (notify + telemetry) — the side effects the three writers
 * (`recordTerminalFailure` / `recordUnitHalt` / `recordCancellation`) share.
 * Each caller builds its row fields (terminal `args.status`; halt
 * `collected:true`; cancellation `status:"skipped"`) and delegates the write +
 * guard here, so the dropped-failure-row invariant — a dropped row corrupts
 * resume: the trail's last row reads "completed" and a later resume routes
 * onward past the stage — is enforced ONCE (parity contract, precedent
 * `advanceCursor` at loop.ts). Returns the assigned stageNumber on success
 * (undefined on drop), matching `audit-rows.ts:recordStage`'s contract.
 *
 * "terminal" here is the RUN-OUTCOME sense (a failure/cancellation that ends
 * the run) — distinct from the `terminal()` stage factory (stage-def.ts) and
 * the graph-sink `edge.mode: "terminal"` (loop-constructors.ts). See the
 * glossary on `stage-def.ts`'s `terminal` export.
 */
function writeFailureRow(
	ctx: WorkflowHostContext,
	audit: AuditCtx,
	row: Parameters<typeof recordStage>[2],
): number | undefined {
	const written = recordStage(audit.cwd, audit.runId, row, audit.state, audit.allocatedStageNumber);
	if (written === undefined) {
		ctx.ui.notify(MSG_FAILURE_ROW_DROPPED(audit.stageName), "warning");
		audit.state.telemetry.droppedFailureRows.push(audit.stageName);
	}
	return written;
}

export async function recordTerminalFailure(
	ctx: WorkflowHostContext,
	audit: AuditCtx,
	args: TerminalFailureArgs,
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	// First-failure-wins: under parallel fanout dispatch with
	// `failFast`, two siblings can fail near-simultaneously and BOTH reach here.
	// This writer is NOT status-gated, so without this guard it would write two
	// terminal rows + fire `onStageError` twice + `terminate()` twice. Skip the
	// duplicate so the trail records the ONE original failure.
	// Harmless on the sequential path (always `"running"` at the
	// first and only terminal failure).
	if (audit.state.termination.status !== "running") return;
	writeFailureRow(ctx, audit, {
		stage: audit.stageName,
		// Script-stage failure rows omit `skill` (the row split landed in A.0);
		// skill rows continue to carry it. `undefined` is dropped by JSON.stringify.
		// `errMsg` mirrors `state.termination.error` so the failure reason
		// survives in JSONL even when the `ctx.ui.notify` toast is missed.
		skill: audit.isScript ? undefined : audit.skill,
		status: args.status,
		ts: nowIso(),
		errMsg: args.errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
	});
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	terminate(audit.state, { status: args.status, error: args.errMsg });
	const ref = audit.isScript
		? scriptStageRef(audit.stageName, audit.state.lastAllocatedStageNumber)
		: skillStageRef(audit.stageName, audit.state.lastAllocatedStageNumber, audit.skill);
	await audit.lifecycle.fire(ctx, "onStageError", ref, args.errMsg, lifecycleCtxFromSession(audit));
}

/**
 * Persist a NON-TERMINAL failed unit row (collect-all fanout): the unit halted,
 * but the run survives and the synthesis stage sees a failed slot. Mirrors
 * `recordTerminalFailure`'s `recordStage` write (same unit fields, same
 * pre-allocated number) WITHOUT `terminate()` (the only state mutation it skips)
 * and WITHOUT the `onStageError` fire (this is not a hard fail). The row carries
 * `collected: true` so the resume fold can tell it apart from a hard
 * `recordTerminalFailure` row (byte-identical otherwise) and rebuild the
 * `failedOutput` sentinel by `unitIndex` instead of re-dispatching it.
 */
export function recordUnitHalt(ctx: WorkflowHostContext, audit: AuditCtx, errMsg: string): void {
	writeFailureRow(ctx, audit, {
		stage: audit.stageName,
		skill: audit.isScript ? undefined : audit.skill,
		status: "failed",
		collected: true, // distinguishes a soft collect-all halt from a hard terminal failure on resume
		ts: nowIso(),
		errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
	});
}

/**
 * One arm per StopSignal variant (minus `"stop"`, the success path).
 * JSONL `status` stays `"aborted" | "failed"` for downstream-reader
 * compatibility; the per-signal distinction surfaces via MSG_STAGE_*
 * and state.termination.error.
 */
export async function recordStopFailure(
	ctx: WorkflowHostContext,
	audit: AuditCtx,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
	onFailure?: (ctx: WorkflowHostContext) => void,
): Promise<void> {
	await recordTerminalFailure(ctx, audit, stopFailureArgs(audit.skill, stop, errorMessage), onFailure);
}

function stopFailureArgs(skill: string, stop: Exclude<StopSignal, "stop">, errorMessage: string): TerminalFailureArgs {
	switch (stop) {
		case "aborted":
			return abortedArgs(FAIL_STAGE_ABORTED(skill));
		case "length":
			return failedArgs(FAIL_STAGE_TRUNCATED(skill));
		case "toolUse":
			return failedArgs(FAIL_STAGE_TOOL_STALLED(skill));
		case "noResponse":
			return failedArgs(FAIL_STAGE_NO_RESPONSE(skill));
		case "error":
			return failedArgs(MSG_STAGE_FAILED(skill), errorMessage);
		default:
			return assertNever(stop);
	}
}

export function recordCancellation(ctx: WorkflowHostContext, audit: AuditCtx): void {
	// Cancellation is a first-class termination outcome: the canonical in-memory
	// name is `RunTermination.status: "cancelled"` (types.ts), but the JSONL row
	// is written with the FROZEN `StageStatus: "skipped"` (state/state.ts) — a
	// deliberate split (the row value is a versioned on-disk contract; renaming
	// it would break resume + every past-run reader). THIS is the sole writer of
	// a `"skipped"` row. `errMsg` is mirrored into the row so post-mortems work
	// from the trail alone (same posture as `recordTerminalFailure`).
	const errMsg = `${audit.skill} cancelled by user`;
	writeFailureRow(ctx, audit, {
		stage: audit.stageName,
		skill: audit.skill,
		status: "skipped",
		ts: nowIso(),
		errMsg,
		session: audit.session,
		...unitRowFields(audit.unit),
	});
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	terminate(audit.state, { status: "cancelled", error: errMsg });
}
