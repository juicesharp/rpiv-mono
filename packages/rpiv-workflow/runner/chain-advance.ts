/**
 * Routing layer after a stage completes successfully: pick the next stage,
 * audit predicate-mediated decisions, enforce the backward-jump guard,
 * then recurse via `runStageOrRecordFailure`.
 *
 * `nextStage` returns a tagged union; `advanceChain` switches on `kind`
 * instead of catching. `runStageOrRecordFailure` owns the catch for
 * downstream-stage throws.
 */

import { nowIso, recordTerminalFailure } from "../audit.js";
import { skillStageRef } from "../lifecycle.js";
import {
	ERR_BACKWARD_JUMP_EXHAUSTED,
	MSG_BACKWARD_JUMP_EXHAUSTED,
	MSG_CHAIN_ADVANCE_FAILED,
	MSG_ROUTING_AUDIT_DROPPED,
} from "../messages.js";
import { edgeIsDecision, nextStage } from "../routing.js";
import { appendRoutingDecision } from "../state/index.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { finalizeWorkflow, lifecycleCtxFor, runStageOrRecordFailure } from "./runner.js";

/**
 * Decomposed into three helpers — `auditRoutingDecision`,
 * `checkBackwardJumpGuard`, `haltOnRoutingError` — each owning one
 * structural concern.
 */
export async function advanceChain(
	curCtx: WorkflowHostContext,
	currentName: string,
	idx: number,
	run: RunContext,
): Promise<void> {
	// Mark the just-completed stage as visited BEFORE consulting the next edge.
	// A thrown EdgeFn would otherwise leave currentName un-marked, opening a
	// (narrow) window where a recovery path could under-count revisits.
	run.visited.add(currentName);

	const wasDecision = edgeIsDecision(run.workflow, currentName);
	const result = nextStage(run.workflow, currentName, { output: run.state.output, state: run.state });

	if (result.kind === "err") {
		await haltOnRoutingError(curCtx, run, currentName, result.reason);
		return;
	}

	const fromRef = skillStageRef(currentName, idx + 1, run.workflow.stages[currentName]?.skill ?? currentName);

	if (result.kind === "stop") {
		await run.lifecycle.fire(curCtx, "onRoute", fromRef, "stop", lifecycleCtxFor(run));
		finalizeWorkflow(curCtx, run);
		return;
	}

	const nextName = result.stage;
	if (wasDecision) {
		auditRoutingDecision(curCtx, run, idx, currentName, nextName);
		if (!(await checkBackwardJumpGuard(curCtx, run, nextName))) return;
	}

	// Fire onRoute after the routing decision has been audited (when applicable),
	// before the next stage runs. Deterministic auto-edges still fire so
	// listeners see every transition.
	await run.lifecycle.fire(curCtx, "onRoute", fromRef, nextName, lifecycleCtxFor(run));

	// runStageOrRecordFailure owns the catch for throws out of the *next* stage,
	// so the JSONL row records `nextName` (the stage that actually threw)
	// rather than `currentName` (which would mis-attribute the failure to
	// the prior stage that already completed successfully).
	await runStageOrRecordFailure(curCtx, nextName, idx + 1, run);
}

/**
 * Persist a routing-decision audit row for a predicate-mediated transition.
 * Deterministic auto-edges aren't audited (no decision was made).
 *
 * A dropped audit row degrades the trail but does NOT invalidate the run;
 * on write failure we surface the gap (live notify + result-envelope
 * field) and continue. Halting here would discard a correct in-memory
 * decision to recover from transient disk weather — the asymmetry with
 * `recordStage` is deliberate (stage rows are reconstruction inputs;
 * routing rows are pure telemetry).
 */
function auditRoutingDecision(
	curCtx: WorkflowHostContext,
	run: RunContext,
	idx: number,
	currentName: string,
	nextName: string,
): void {
	const fromStageIndex = idx + 1;
	const wrote = appendRoutingDecision(run.cwd, run.runId, {
		type: "routing",
		fromStageIndex,
		fromStage: currentName,
		decision: nextName,
		ts: nowIso(),
	});
	if (!wrote) {
		run.state.telemetry.droppedRoutingRows.push({ fromStageIndex, fromStage: currentName, decision: nextName });
		curCtx.ui.notify(MSG_ROUTING_AUDIT_DROPPED(currentName, nextName), "warning");
	}
}

/**
 * Per-loop cap on decision-edge retries. Returns `true` when the run may
 * continue, `false` when the cap tripped (and the terminal failure has
 * been recorded).
 *
 * A "backward jump" is a *decision-edge* resolving to an already-visited
 * stage — i.e. a deliberate retry choice. Deterministic forward edges that
 * pass through a cycle (the body of a multi-stage loop) are NOT counted,
 * because they're consequences of the retry decision rather than
 * independent retry events. Without this distinction the cap would trip
 * mid-loop on any cycle longer than 2 stages, burning the entire budget
 * on a single retry iteration's deterministic hops.
 *
 * Reset-on-escape: a decision resolving to a NOT-visited stage escapes the
 * current cycle (we've moved to fresh territory), so the counter resets.
 * Each independent loop gets its own retry budget instead of a single
 * global pool that drains across unrelated loops.
 *
 * Trip attribution targets `nextName` (the stage the guard refused to
 * re-enter), not the just-completed stage. Same lesson as Q12+IB.
 */
async function checkBackwardJumpGuard(
	curCtx: WorkflowHostContext,
	run: RunContext,
	nextName: string,
): Promise<boolean> {
	const { state } = run;
	if (!run.visited.has(nextName)) {
		state.telemetry.backwardJumps = 0;
		return true;
	}
	state.telemetry.backwardJumps++;
	if (state.telemetry.backwardJumps <= run.maxBackwardJumps) return true;
	await recordTerminalFailure(
		curCtx,
		{
			cwd: run.cwd,
			runId: run.runId,
			state,
			stageName: nextName,
			skill: nextName,
			lifecycle: run.lifecycle,
			runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		},
		{
			status: "failed",
			notifyMsg: MSG_BACKWARD_JUMP_EXHAUSTED(state.telemetry.backwardJumps, run.maxBackwardJumps),
			notifyLevel: "error",
			errMsg: ERR_BACKWARD_JUMP_EXHAUSTED(state.telemetry.backwardJumps, run.maxBackwardJumps),
		},
	);
	return false;
}

/**
 * Halt the chain on a routing-layer error result (e.g. the EdgeFn returned
 * an undeclared target, or threw and was wrapped). Attribution targets
 * `currentName` (the edge belongs to the just-completed stage).
 */
async function haltOnRoutingError(
	curCtx: WorkflowHostContext,
	run: RunContext,
	currentName: string,
	reason: string,
): Promise<void> {
	await recordTerminalFailure(
		curCtx,
		{
			cwd: run.cwd,
			runId: run.runId,
			state: run.state,
			stageName: currentName,
			skill: currentName,
			lifecycle: run.lifecycle,
			runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		},
		{
			status: "failed",
			notifyMsg: MSG_CHAIN_ADVANCE_FAILED(currentName, reason),
			notifyLevel: "error",
			errMsg: reason,
		},
	);
}
