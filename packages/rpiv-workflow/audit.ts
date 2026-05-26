/**
 * Audit / bookkeeping — JSONL writes, status-line clears, notify, and
 * `state.termination.error` for terminal outcomes. Shared by runner.ts + sessions.ts;
 * neither imports back. Depends only on state + messages.
 */

import { handleToString } from "./handle.js";
import { assertNever } from "./internal-utils.js";
import { buildLifecycleContext, skillStageRef } from "./lifecycle.js";
import {
	ERR_STAGE_ABORTED,
	ERR_STAGE_NO_RESPONSE,
	ERR_STAGE_TOOL_STALLED,
	ERR_STAGE_TRUNCATED,
	MSG_PARTIAL_ARTIFACTS,
	MSG_STAGE_ABORTED,
	MSG_STAGE_FAILED,
	MSG_STAGE_NO_RESPONSE,
	MSG_STAGE_TOOL_STALLED,
	MSG_STAGE_TRUNCATED,
	MSG_WORKFLOW_CANCELLED,
	STATUS_KEY,
} from "./messages.js";
import { appendStage, listArtifacts, type WorkflowStage } from "./state/index.js";
import type { StopSignal } from "./transcript.js";
import type { FanoutSession, RunnerCtx, RunState, SessionContext } from "./types.js";

/** Single source of ISO-8601 timestamps for audit rows + output meta. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Minimal bookkeeping ctx. Structurally derived from `SessionContext` so any
 * future field added to the base lands here too — no duplicate
 * maintenance. Both `StageSession` and `FanoutSession` collapse to this.
 */
export type AuditCtx = Pick<
	SessionContext,
	"cwd" | "runId" | "state" | "stageName" | "skill" | "lifecycle" | "runIdentity"
>;

/**
 * JSONL `WorkflowStage.stage` value for fanout-unit rows — built from
 * the parent stage's record key (`stageName`) suffixed with the
 * user-supplied `id` when present, falling back to `label`
 * (e.g. `"implement (phase-2)"` or `"implement (phase 2/4)"`) so
 * post-hoc readers can distinguish loop iterations. Owned by the audit
 * layer because the JSONL row shape is its concern; the runner stays
 * neutral about the wording.
 */
export const fanoutRowStage = (s: FanoutSession): string => `${s.stageName} (${s.id ?? s.label})`;

/**
 * Allocates the next `stageNumber`, attempts the append, and returns the
 * assigned number on success (or undefined on I/O failure). `lastAllocatedStageNumber`
 * advances monotonically — once per call — so a transient failure doesn't
 * cause the next stage to reuse the lost row's number. Higher-level counters
 * (e.g. `stagesCompleted`) gate on the returned value being defined.
 *
 * `wrapOutput`'s `state.lastAllocatedStageNumber + 1` peek aligns with this allocation
 * because the output is built BEFORE recordStage is called.
 */
export function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunState,
): number | undefined {
	state.lastAllocatedStageNumber += 1;
	const stageNumber = state.lastAllocatedStageNumber;
	return appendStage(cwd, runId, { stageNumber, ...stage }) ? stageNumber : undefined;
}

/** Surface every artifact recorded so far — recap on stage failure. */
export function notifyPartialArtifacts(ctx: RunnerCtx, cwd: string, runId: string): void {
	const items = listArtifacts(cwd, runId);
	if (items.length === 0) return;
	const artifactList = items.map((i) => `  • ${i.stage}: ${handleToString(i.artifact.handle)}`).join("\n");
	ctx.ui.notify(MSG_PARTIAL_ARTIFACTS(artifactList), "info");
}

export async function recordTerminalFailure(
	ctx: RunnerCtx,
	audit: AuditCtx,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
	},
	onFailure?: (ctx: RunnerCtx) => void,
): Promise<void> {
	recordStage(
		audit.cwd,
		audit.runId,
		{ stage: audit.stageName, skill: audit.skill, status: args.status, ts: nowIso() },
		audit.state,
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	audit.state.termination.error = args.errMsg;
	await audit.lifecycle.fire(
		ctx,
		"onStageError",
		skillStageRef(audit.stageName, audit.state.lastAllocatedStageNumber, audit.skill),
		args.errMsg,
		buildLifecycleContext({
			cwd: audit.cwd,
			runId: audit.runId,
			workflow: audit.runIdentity.workflow,
			totalStages: audit.runIdentity.totalStages,
			trigger: audit.runIdentity.trigger,
			state: audit.state,
		}),
	);
}

/**
 * One arm per StopSignal variant (minus `"stop"`, the success path).
 * JSONL `status` stays `"aborted" | "failed"` for downstream-reader
 * compatibility; the per-signal distinction surfaces via MSG_STAGE_*
 * and state.termination.error.
 */
export async function recordStopFailure(
	ctx: RunnerCtx,
	audit: AuditCtx,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
	onFailure?: (ctx: RunnerCtx) => void,
): Promise<void> {
	await recordTerminalFailure(ctx, audit, stopFailureArgs(audit.skill, stop, errorMessage), onFailure);
}

function stopFailureArgs(
	skill: string,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
): {
	status: "failed" | "aborted";
	notifyMsg: string;
	notifyLevel: "warning" | "error";
	errMsg: string;
} {
	switch (stop) {
		case "aborted":
			return {
				status: "aborted",
				notifyMsg: MSG_STAGE_ABORTED(skill),
				notifyLevel: "warning",
				errMsg: ERR_STAGE_ABORTED(skill),
			};
		case "length":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TRUNCATED(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_TRUNCATED(skill),
			};
		case "toolUse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TOOL_STALLED(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_TOOL_STALLED(skill),
			};
		case "noResponse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_NO_RESPONSE(skill),
				notifyLevel: "error",
				errMsg: ERR_STAGE_NO_RESPONSE(skill),
			};
		case "error":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_FAILED(skill),
				notifyLevel: "error",
				errMsg: errorMessage,
			};
		default:
			return assertNever(stop);
	}
}

export function recordCancellation(ctx: RunnerCtx, audit: AuditCtx): void {
	recordStage(
		audit.cwd,
		audit.runId,
		{ stage: audit.stageName, skill: audit.skill, status: "skipped", ts: nowIso() },
		audit.state,
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	// `success: false` alone can't distinguish "cancelled" from "never started";
	// the error string is the signal.
	audit.state.termination.error = `${audit.skill} cancelled by user`;
}
