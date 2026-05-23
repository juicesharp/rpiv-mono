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

import { MSG_STAGE_ABORTED, MSG_STAGE_FAILED, MSG_WORKFLOW_CANCELLED, STATUS_KEY } from "./messages.js";
import { appendStage, readAllStages, type WorkflowStage } from "./state.js";
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

/** What kind of terminal outcome (if any) the branch shows after the agent stops. */
export type StopOutcome = "ok" | "aborted" | "failed";

// ---------------------------------------------------------------------------
// Write helpers (fail-soft via state.appendStage)
// ---------------------------------------------------------------------------

/**
 * Record a stage on disk and bump the in-memory counter only on a successful
 * write — keeps stage numbers in the JSONL file contiguous even if a write
 * silently fails (see `appendStage`'s boolean return).
 */
export function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunState,
): void {
	const nextStageNumber = state.jsonlStage + 1;
	if (appendStage(cwd, runId, { stageNumber: nextStageNumber, ...stage })) {
		state.jsonlStage = nextStageNumber;
	}
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
 * Halt the chain because the agent stopped abnormally (ESC abort or empty /
 * errored response). `errorMessage` is the caller-formatted text stored in
 * `state.error` for the "failed" case (stages and phases format differently).
 */
export function recordStopFailure(
	ctx: ChainCtx,
	audit: Audit,
	stop: Exclude<StopOutcome, "ok">,
	errorMessage: string,
	onFailure?: (ctx: ChainCtx) => void,
): void {
	if (stop === "aborted") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "aborted",
				notifyMsg: MSG_STAGE_ABORTED(audit.skill),
				notifyLevel: "warning",
				errMsg: `${audit.skill} aborted by user (ESC)`,
			},
			onFailure,
		);
		return;
	}
	recordTerminalFailure(
		ctx,
		audit,
		{
			status: "failed",
			notifyMsg: MSG_STAGE_FAILED(audit.skill),
			notifyLevel: "error",
			errMsg: errorMessage,
		},
		onFailure,
	);
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
