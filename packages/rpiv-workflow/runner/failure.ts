/**
 * Terminal-outcome translation for the chain walk — a LEAF imported downward
 * by runner.ts, chain-advance.ts, and run-stage.ts. Owns the ONE
 * "entry threw" → failure-row translation and the run-completion finalizer,
 * plus the `ChainOutcome` vocabulary the whole walk returns.
 */

import {
	abortedArgs,
	auditCtxFor,
	failedArgs,
	notifyPartialArtifacts,
	recordTerminalFailure,
	terminate,
} from "../audit.js";
import { formatError, isAbortError } from "../internal-utils.js";
import { FAIL_WORKFLOW_ABORTED, MSG_STAGE_THREW, MSG_WORKFLOW_COMPLETE, STATUS_KEY } from "../messages.js";
import type { RunContext, UnitRef, WorkflowHostContext } from "../types.js";
import { StagePreflightError } from "./errors.js";

/**
 * Explicit result of one chain-walk step, threaded up through
 * `advanceChain` / `runStage` / `runStageOrRecordFailure`. The walk's halt
 * protocol used to be record-then-quietly-unwind by convention — every halt
 * site had to remember a bare `return` after `recordTerminalFailure`. With a
 * non-void return type, a branch that records a failure but forgets to stop
 * the walk no longer typechecks: every arm must RETURN an outcome, and halts
 * read `return haltChain(...)`.
 *
 *  - `"halted"`     — a terminal failure/abort row was recorded; the walk
 *                     stops here and unwinds.
 *  - `"completed"`  — the chain reached `stop`; `finalizeWorkflow` ran.
 *  - `"dispatched"` — the walk handed off to a session/loop continuation
 *                     (Pi owns the live session; the eventual outcome
 *                     resolves inside the continuation's own walk frames).
 */
export type ChainOutcome = "halted" | "completed" | "dispatched";

/**
 * The composed chain-advance continuation (run-stage.ts wires it) —
 * injected into stage runners that advance the chain themselves (the script
 * path) so they never import the composition site back.
 */
export type AdvanceFn = (
	curCtx: WorkflowHostContext,
	completedName: string,
	completedIdx: number,
	run: RunContext,
) => Promise<ChainOutcome>;

/**
 * Record a terminal failure and yield the `"halted"` outcome — the standard
 * halt idiom for walk arms: `return haltChain(...)`.
 */
export async function haltChain(
	curCtx: WorkflowHostContext,
	run: RunContext,
	stageName: string,
	skill: string,
	args: Parameters<typeof recordTerminalFailure>[2],
	onFailure?: (ctx: WorkflowHostContext) => void,
	unit?: UnitRef,
): Promise<ChainOutcome> {
	await recordTerminalFailure(
		curCtx,
		auditCtxFor(run, stageName, skill, unit ? { unit } : undefined),
		args,
		onFailure,
	);
	return "halted";
}

/**
 * The ONE "entry threw" → terminal-failure-row translation (live + resume
 * entries). Two flavours of throw land here:
 *
 * - `StagePreflightError` — a known preflight failure carrying its own
 *   attribution + messages. Recorded with the carried payload exactly.
 * - Any other `Error` — unexpected machinery failure; recorded with the
 *   generic `MSG_STAGE_THREW` shape attributed to the stage id.
 *
 * `unit` is present only for the fanout worker-throw sink (`recordWorkerThrow`):
 * its `{ ref, skill }` lands the unit's structured identity on the row
 * (`parent`/`role`/`unitId`/`unitIndex` via `unitRowFields`) and the fanned
 * `skill`, so the unit's identity is NOT folded into the `stage` name string.
 */
export async function recordEntryThrow(
	curCtx: WorkflowHostContext,
	name: string,
	run: RunContext,
	e: unknown,
	unit?: { ref: UnitRef; skill: string },
): Promise<ChainOutcome> {
	if (e instanceof StagePreflightError) {
		return haltChain(
			curCtx,
			run,
			name,
			e.skill,
			failedArgs(e.notifyMsg, e.errMsg),
			e.notifyPartial ? (ctx) => notifyPartialArtifacts(ctx, run.cwd, run.runId) : undefined,
		);
	}
	const reason = formatError(e);
	return haltChain(
		curCtx,
		run,
		name,
		unit?.skill ?? name,
		failedArgs(MSG_STAGE_THREW(name, reason), reason),
		undefined,
		unit?.ref,
	);
}

/**
 * Record the `"aborted"` terminal row for a cooperative-cancellation stop — at
 * the between-stage seam (`run.signal` aborted before `name` ran) OR when a
 * mid-stage `postStage` throws `WorkflowAbortError`. Mirrors the error
 * path's partial-artifacts recap (`recordEntryThrow` → `notifyPartialArtifacts`):
 * artifacts produced by earlier stages are surfaced so the operator sees them
 * instead of grepping the JSONL. No-op when no artifacts exist.
 */
export function recordAbortedAtSeam(curCtx: WorkflowHostContext, name: string, run: RunContext): Promise<ChainOutcome> {
	return haltChain(curCtx, run, name, name, abortedArgs(FAIL_WORKFLOW_ABORTED(name)), (ctx) =>
		notifyPartialArtifacts(ctx, run.cwd, run.runId),
	);
}

/**
 * THE stage-entry guard — the ONE classify-then-record policy both single-stage
 * entries share: pre-check the cooperative-abort signal, run `inner`, and on a
 * throw classify it (mid-stage `WorkflowAbortError` → envelope-safe abort;
 * anything else → terminal entry-throw row). Modeled after `advanceCursor`
 * (loop.ts): one shared authority, callers hold their own preconditions.
 *
 * The two call sites (`runStageOrRecordFailure` live, `resumeStageWithSession`
 * resume) cover DISJOINT scopes — the resume catch protects the reattach ladder
 * (`resumeWithSessionLadder`) the live catch cannot reach — so both must exist.
 * This wrapper merges the CLASSIFICATION POLICY (which throw is an abort vs a
 * real entry-throw), not the scopes: each caller invokes it with its own `inner`
 * + `name`, so a future widening of "what counts as abort" (a new cooperative-
 * cancel signal beyond `WorkflowAbortError`) is one edit, here.
 */
export async function withStageEntryGuard(
	curCtx: WorkflowHostContext,
	name: string,
	run: RunContext,
	inner: () => Promise<ChainOutcome>,
): Promise<ChainOutcome> {
	if (run.signal?.aborted) return recordAbortedAtSeam(curCtx, name, run);
	try {
		return await inner();
	} catch (e) {
		if (isAbortError(e)) return recordAbortedAtSeam(curCtx, name, run);
		return recordEntryThrow(curCtx, name, run, e);
	}
}

export function finalizeWorkflow(curCtx: WorkflowHostContext, run: RunContext): ChainOutcome {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	terminate(run.state, { status: "completed" });
	return "completed";
}
