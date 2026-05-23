/**
 * Workflow audit + bookkeeping helpers.
 *
 * All side-effecting functions that write JSONL rows, clear the status line,
 * notify the user, and update `state.error` for terminal outcomes. Shared by
 * the orchestration layer (`runner.ts`) and the session layer (`sessions.ts`);
 * neither imports back into this module's higher-layer concepts.
 *
 * Imports `state` (the JSONL writer) and `messages` (the user-visible strings)
 * only — no dag / extractors / manifest dependency.
 */

import {
	MSG_STAGE_ABORTED,
	MSG_STAGE_FAILED,
	MSG_STAGE_NO_RESPONSE,
	MSG_STAGE_TOOL_STALLED,
	MSG_STAGE_TRUNCATED,
	MSG_WORKFLOW_CANCELLED,
	STATUS_KEY,
} from "./messages.js";
import { appendStage, readAllStages, type WorkflowStage } from "./state.js";
import { assertNever, type StopSignal } from "./transcript.js";
import type { ChainCtx, RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Single source of ISO-8601 timestamps for audit rows + manifest meta. */
export const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal bookkeeping context — what every audit row needs to identify the
 * run + label the JSONL "skill" field. Both `StageSession` and `PhaseSession`
 * collapse to this shape at every call site, so helpers stay caller-agnostic.
 */
export interface Audit {
	cwd: string;
	runId: string;
	state: RunState;
	/** Label written to the JSONL "skill" field for failed / skipped rows. */
	skill: string;
}

// ---------------------------------------------------------------------------
// Write helpers (fail-soft via state.appendStage)
// ---------------------------------------------------------------------------

/**
 * Allocate the next `stageNumber`, attempt to append the row, and return
 * the assigned number on a successful write (or `undefined` on failure).
 *
 * `jsonlStage` advances monotonically — once per call, regardless of
 * whether the write landed. This costs nothing on the happy path and on
 * a transient I/O failure keeps the next stage from reusing the lost
 * row's number. Callers that only want to bump higher-level counters on
 * successful persistence (e.g. `stagesCompleted`) gate on the returned
 * value being a number rather than `undefined`.
 *
 * `wrapManifest`'s `state.jsonlStage + 1` peek still aligns with the
 * `stageNumber` recordStage will assign for the current stage — the
 * manifest is built BEFORE recordStage is called, so `jsonlStage + 1`
 * computes the value recordStage is about to allocate.
 */
export function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunState,
): number | undefined {
	state.jsonlStage += 1;
	const stageNumber = state.jsonlStage;
	return appendStage(cwd, runId, { stageNumber, ...stage }) ? stageNumber : undefined;
}

/**
 * After a stage fails, surface every artifact recorded so far so the user
 * doesn't have to grep the JSONL to see what survived.
 */
export function notifyPartialArtifacts(ctx: ChainCtx, cwd: string, runId: string): void {
	const artifactPaths = readAllStages(cwd, runId)
		.filter((s) => s.artifact)
		.map((s) => `  • ${s.skill}: ${s.artifact}`)
		.join("\n");
	if (artifactPaths) {
		ctx.ui.notify(`Artifacts produced before failure:\n${artifactPaths}`, "info");
	}
}

/**
 * Record a stage as terminally failed (status, audit row, status-line clear,
 * user-visible notify, and `state.error`), then optionally invoke `onFailure`
 * for the partial-artifacts recap. Shared between stage- and phase-mode.
 */
export function recordTerminalFailure(
	ctx: ChainCtx,
	audit: Audit,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
	},
	onFailure?: (ctx: ChainCtx) => void,
): void {
	recordStage(audit.cwd, audit.runId, { skill: audit.skill, status: args.status, ts: nowIso() }, audit.state);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(args.notifyMsg, args.notifyLevel);
	onFailure?.(ctx);
	audit.state.error = args.errMsg;
}

/**
 * Halt the chain after the agent stopped on a non-OK signal.
 *
 * One arm per `StopSignal` variant (minus `"stop"`, which is the success path
 * and never reaches this function). The JSONL status stays a two-value
 * `"aborted" | "failed"` for downstream-reader compatibility — the per-signal
 * distinction surfaces via `MSG_STAGE_*` and `state.error`. `errorMessage` is
 * the caller-formatted text used for stages-and-phases-differ wording in the
 * generic `"error"` bucket; signal-specific arms build their own text.
 */
export function recordStopFailure(
	ctx: ChainCtx,
	audit: Audit,
	stop: Exclude<StopSignal, "stop">,
	errorMessage: string,
	onFailure?: (ctx: ChainCtx) => void,
): void {
	recordTerminalFailure(ctx, audit, stopFailureArgs(audit.skill, stop, errorMessage), onFailure);
}

/** Per-signal user-visible wording + JSONL status for a non-OK stop. */
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
				errMsg: `${skill} aborted by user (ESC)`,
			};
		case "length":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TRUNCATED(skill),
				notifyLevel: "error",
				errMsg: `${skill} truncated — model hit output-length cap mid-reply`,
			};
		case "toolUse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_TOOL_STALLED(skill),
				notifyLevel: "error",
				errMsg: `${skill} tool loop did not settle before the orchestrator inspected the branch`,
			};
		case "noResponse":
			return {
				status: "failed",
				notifyMsg: MSG_STAGE_NO_RESPONSE(skill),
				notifyLevel: "error",
				errMsg: `${skill} produced no assistant message`,
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

/** Bookkeeping for a user-cancelled fresh session — JSONL row + notify + state.error. */
export function recordCancellation(ctx: ChainCtx, audit: Audit): void {
	recordStage(audit.cwd, audit.runId, { skill: audit.skill, status: "skipped", ts: nowIso() }, audit.state);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	// Distinguish "user cancelled" from "workflow never started" — both land
	// in the caller as `success: false`; the error string is the only signal
	// that disambiguates the two cases.
	audit.state.error = `${audit.skill} cancelled by user`;
}
