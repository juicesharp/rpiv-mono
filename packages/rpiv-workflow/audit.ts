/**
 * Terminal-outcome orchestration — the impure half of the audit layer.
 * Turns a halt reason into the full bundle a terminal outcome owes the
 * user and the system: the JSONL failure row (via `audit-rows.ts`), the
 * status-line clear, the notify toast, the `terminate()` state write, and
 * the `onStageError` lifecycle fire.
 *
 * Depends on audit-rows + state + messages + events + handle. Shared by
 * the runner + sessions; neither imports back. Pure row persistence (the
 * allocator, `recordStage`, success persistence) lives in `audit-rows.ts`.
 */

import { recordStage, unitRowFields } from "./audit-rows.js";
import { lifecycleCtxFromSession, scriptStageRef, skillStageRef } from "./events.js";
import { handleToString } from "./handle.js";
import { assertNever, nowIso } from "./internal-utils.js";
import {
	FAIL_AUDIT_WRITE,
	FAIL_STAGE_ABORTED,
	FAIL_STAGE_NO_RESPONSE,
	FAIL_STAGE_TOOL_STALLED,
	FAIL_STAGE_TRUNCATED,
	type FailureText,
	MSG_FAILURE_ROW_DROPPED,
	MSG_PARTIAL_ARTIFACTS,
	MSG_STAGE_FAILED,
	MSG_WORKFLOW_CANCELLED,
	STATUS_KEY,
} from "./messages.js";
import { listArtifacts, type SessionRef } from "./state/index.js";
import type { StopSignal } from "./transcript.js";
import type { RunContext, RunState, RunTermination, SessionContext, UnitRef, WorkflowHostContext } from "./types.js";

// Re-export the persistence half so existing audit-layer consumers keep one
// import site; new code may import audit-rows.js directly.
export { allocateStageNumber, decorateStage, recordStage, unitRowFields } from "./audit-rows.js";

/**
 * THE one `state.termination` mutator. Every terminal path — completion
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
 * the run. THE single notify+terminate idiom shared by the skill/unit success
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

/**
 * Minimal bookkeeping ctx. Structurally derived from `SessionContext` so any
 * future field added to the base lands here too — no duplicate
 * maintenance. Every `StageSession` (single stage or loop unit) collapses to this.
 *
 * `isScript` toggles the `onStageError` ref construction in
 * `recordTerminalFailure` from `skillStageRef` to `scriptStageRef` (the
 * script branch carries no `skill` field). Defaulting to `undefined`
 * preserves the skill-path behaviour for every existing caller.
 *
 * `unit` is present iff the failure/cancellation belongs to a loop unit — its
 * identity is spread into the JSONL row so failed trailers carry the
 * structured fields the resume guard consumes.
 *
 * `session` is REQUIRED (`null` = explicitly sessionless) — the compiler
 * forces every audit-row writer to make the provenance decision; the value
 * lands verbatim on the JSONL row (`WorkflowStage.session`), which is what
 * session-backed resume dispatches on.
 */
export type AuditCtx = Pick<
	SessionContext,
	"cwd" | "runId" | "state" | "stageName" | "skill" | "lifecycle" | "runIdentity" | "allocatedStageNumber"
> & {
	session: SessionRef | null;
	isScript?: boolean;
	unit?: UnitRef;
};

/**
 * The read-only run identity (`workflow` name + `totalStages` + `trigger`)
 * threaded onto every `SessionContext` and `AuditCtx`. Single source for the
 * `runIdentity` sub-literal that session/audit constructions across the runner
 * would otherwise re-spell by hand.
 */
export function runIdentityOf(run: RunContext): SessionContext["runIdentity"] {
	return { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger };
}

/**
 * Build the `AuditCtx` `recordTerminalFailure` needs for a stage failure that
 * escaped a session (preflight halts, downstream throws, routing errors,
 * resume-time refusals). One source for the shape so every halt path records
 * a uniform row. `isScript: true` drops the `skill` field from the JSONL row
 * and switches `onStageError` to `scriptStageRef`.
 *
 * `session` is pinned to `null` here BY CONSTRUCTION: every caller of this
 * builder records a failure that escaped (or never reached) a session —
 * preflight halts, seam aborts, entry throws, routing errors, resume drift,
 * script halts. In-session writers build their `AuditCtx` via `auditFor`
 * (sessions/sessions.ts), which threads the captured `SessionRef`.
 */
export function auditCtxFor(
	run: RunContext,
	stageName: string,
	skill: string,
	opts?: { isScript?: boolean; unit?: UnitRef; allocatedStageNumber?: number },
): AuditCtx {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		stageName,
		skill,
		session: null,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		...(opts?.isScript ? { isScript: true } : {}),
		...(opts?.unit ? { unit: opts.unit } : {}),
		...(opts?.allocatedStageNumber !== undefined ? { allocatedStageNumber: opts.allocatedStageNumber } : {}),
	};
}

/**
 * Lifecycle ref for the CURRENT activation — ONE numbering base (the
 * allocator value) for every event of one execution, so a listener can
 * correlate a retry ref with the end/error ref it belongs to. Valid once the
 * activation allocated its number (`allocatedStageNumber`); falls back to the
 * last allocated number for record-time allocators (failure paths that never
 * reached output production).
 */
export function currentStageRef(
	s: Pick<SessionContext, "stageName" | "skill" | "state" | "allocatedStageNumber">,
): ReturnType<typeof skillStageRef> {
	return skillStageRef(s.stageName, s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber, s.skill);
}

/** Surface every artifact recorded so far — recap on stage failure. */
export function notifyPartialArtifacts(ctx: WorkflowHostContext, cwd: string, runId: string): void {
	const items = listArtifacts(cwd, runId);
	if (items.length === 0) return;
	const artifactList = items.map((i) => `  • ${i.stage}: ${handleToString(i.artifact.handle)}`).join("\n");
	ctx.ui.notify(MSG_PARTIAL_ARTIFACTS(artifactList), "info");
}

/**
 * The toast + JSONL halves of a terminal failure, paired by construction.
 * Build via `failedArgs` / `abortedArgs` (or `stopFailureArgs`' switch) so a
 * halt site can't mismatch status and notify level.
 */
export interface TerminalFailureArgs {
	status: "failed" | "aborted";
	notifyMsg: string;
	notifyLevel: "warning" | "error";
	errMsg: string;
}

/**
 * Argument constructors for `recordTerminalFailure` — the
 * `{status, notifyMsg, notifyLevel, errMsg}` quadruple every halt site used
 * to spell by hand. One per terminal status: failures notify at `"error"`,
 * aborts at `"warning"` (cooperative cancellation is expected, not
 * exceptional).
 */
export function failedArgs(failure: FailureText): TerminalFailureArgs;
export function failedArgs(notifyMsg: string, errMsg: string): TerminalFailureArgs;
export function failedArgs(a: FailureText | string, b?: string): TerminalFailureArgs {
	const f = typeof a === "string" ? { toast: a, error: b as string } : a;
	return { status: "failed", notifyMsg: f.toast, notifyLevel: "error", errMsg: f.error };
}

export function abortedArgs(failure: FailureText): TerminalFailureArgs;
export function abortedArgs(notifyMsg: string, errMsg: string): TerminalFailureArgs;
export function abortedArgs(a: FailureText | string, b?: string): TerminalFailureArgs {
	const f = typeof a === "string" ? { toast: a, error: b as string } : a;
	return { status: "aborted", notifyMsg: f.toast, notifyLevel: "warning", errMsg: f.error };
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
	const written = recordStage(
		audit.cwd,
		audit.runId,
		// Script-stage failure rows omit `skill` (the row split landed in A.0);
		// skill rows continue to carry it. `undefined` is dropped by JSON.stringify.
		// `errMsg` mirrors `state.termination.error` so the failure reason
		// survives in JSONL even when the `ctx.ui.notify` toast is missed.
		{
			stage: audit.stageName,
			skill: audit.isScript ? undefined : audit.skill,
			status: args.status,
			ts: nowIso(),
			errMsg: args.errMsg,
			session: audit.session,
			...unitRowFields(audit.unit),
		},
		audit.state,
		// Reuse the activation's pre-allocated number when output production
		// already burned one — the failure row carries the SAME stage number
		// the activation's output/lifecycle refs used (no gap, no skew).
		audit.allocatedStageNumber,
	);
	if (written === undefined) {
		// A dropped FAILURE row corrupts resume: the trail's last row reads
		// "completed" and a resume would route onward past this stage. The run
		// is already halting — surface loudly + flag the envelope so callers
		// know the trail is unsafe to resume from.
		ctx.ui.notify(MSG_FAILURE_ROW_DROPPED(audit.stageName), "warning");
		audit.state.telemetry.droppedFailureRows.push(audit.stageName);
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
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
	const written = recordStage(
		audit.cwd,
		audit.runId,
		{
			stage: audit.stageName,
			skill: audit.isScript ? undefined : audit.skill,
			status: "failed",
			collected: true, // distinguishes a soft collect-all halt from a hard terminal failure on resume
			ts: nowIso(),
			errMsg,
			session: audit.session,
			...unitRowFields(audit.unit),
		},
		audit.state,
		audit.allocatedStageNumber,
	);
	if (written === undefined) {
		ctx.ui.notify(MSG_FAILURE_ROW_DROPPED(audit.stageName), "warning");
		audit.state.telemetry.droppedFailureRows.push(audit.stageName);
	}
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
	// Cancellation is a first-class termination outcome (`status: "cancelled"`);
	// `errMsg` is mirrored into the JSONL row so post-mortems work from the
	// trail alone (same posture as `recordTerminalFailure`).
	const errMsg = `${audit.skill} cancelled by user`;
	recordStage(
		audit.cwd,
		audit.runId,
		{
			stage: audit.stageName,
			skill: audit.skill,
			status: "skipped",
			ts: nowIso(),
			errMsg,
			session: audit.session,
			...unitRowFields(audit.unit),
		},
		audit.state,
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	terminate(audit.state, { status: "cancelled", error: errMsg });
}
