/**
 * Routing layer after a stage completes successfully: pick the next node,
 * audit predicate-mediated decisions, enforce the backward-jump guard,
 * then recurse via `runStageOrRecordFailure`.
 *
 * `nextNode` returns a tagged union (post-Phase 5.B); `advanceChain`
 * switches on `kind` instead of catching. `runStageOrRecordFailure` owns
 * the catch for downstream-stage throws.
 */

import { nowIso, recordTerminalFailure } from "../audit.js";
import {
	ERR_BACKWARD_JUMP_EXHAUSTED,
	MSG_BACKWARD_JUMP_EXHAUSTED,
	MSG_CHAIN_ADVANCE_FAILED,
	MSG_ROUTING_AUDIT_DROPPED,
} from "../messages.js";
import { edgeIsDecision, nextNode } from "../routing.js";
import { appendRoutingDecision } from "../state/index.js";
import type { RunContext, RunnerCtx } from "../types.js";
import { finalizeWorkflow, runStageOrRecordFailure } from "./runner.js";

/**
 * Decomposed into three helpers (L5-05): `auditRoutingDecision`,
 * `checkBackwardJumpGuard`, `haltOnRoutingError`. Each owns one
 * structural concern.
 */
export async function advanceChain(
	curCtx: RunnerCtx,
	currentName: string,
	idx: number,
	run: RunContext,
): Promise<void> {
	// Mark the just-completed node as visited BEFORE consulting the next edge.
	// A thrown EdgeFn would otherwise leave currentName un-marked, opening a
	// (narrow) window where a recovery path could under-count revisits.
	run.visited.add(currentName);

	const wasDecision = edgeIsDecision(run.workflow, currentName);
	const result = nextNode(run.workflow, currentName, { manifest: run.state.manifest, state: run.state });

	if (result.kind === "err") {
		haltOnRoutingError(curCtx, run, currentName, result.reason);
		return;
	}
	if (result.kind === "stop") {
		finalizeWorkflow(curCtx, run);
		return;
	}

	const nextName = result.node;
	if (wasDecision) {
		auditRoutingDecision(curCtx, run, idx, currentName, nextName);
		if (!checkBackwardJumpGuard(curCtx, run, nextName)) return;
	}

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
	curCtx: RunnerCtx,
	run: RunContext,
	idx: number,
	currentName: string,
	nextName: string,
): void {
	const fromStage = idx + 1;
	const wrote = appendRoutingDecision(run.cwd, run.runId, {
		type: "routing",
		fromStage,
		fromNode: currentName,
		decision: nextName,
		ts: nowIso(),
	});
	if (!wrote) {
		run.state.telemetry.droppedRoutingRows.push({ fromStage, fromNode: currentName, decision: nextName });
		curCtx.ui.notify(MSG_ROUTING_AUDIT_DROPPED(currentName, nextName), "warning");
	}
}

/**
 * Per-loop cap on decision-edge retries. Returns `true` when the run may
 * continue, `false` when the cap tripped (and the terminal failure has
 * been recorded).
 *
 * A "backward jump" is a *decision-edge* resolving to an already-visited
 * node — i.e. a deliberate retry choice. Deterministic forward edges that
 * pass through a cycle (the body of a multi-node loop) are NOT counted,
 * because they're consequences of the retry decision rather than
 * independent retry events. Without this distinction the cap would trip
 * mid-loop on any cycle longer than 2 nodes, burning the entire budget
 * on a single retry iteration's deterministic hops.
 *
 * Reset-on-escape: a decision resolving to a NOT-visited node escapes the
 * current cycle (we've moved to fresh territory), so the counter resets.
 * Each independent loop gets its own retry budget instead of a single
 * global pool that drains across unrelated loops.
 *
 * Trip attribution targets `nextName` (the stage the guard refused to
 * re-enter), not the just-completed stage. Same lesson as Q12+IB.
 */
function checkBackwardJumpGuard(curCtx: RunnerCtx, run: RunContext, nextName: string): boolean {
	const { state } = run;
	if (!run.visited.has(nextName)) {
		state.telemetry.backwardJumps = 0;
		return true;
	}
	state.telemetry.backwardJumps++;
	if (state.telemetry.backwardJumps <= run.maxBackwardJumps) return true;
	recordTerminalFailure(
		curCtx,
		{ cwd: run.cwd, runId: run.runId, state, skill: nextName },
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
 * `currentName` (the edge belongs to the just-completed node).
 */
function haltOnRoutingError(curCtx: RunnerCtx, run: RunContext, currentName: string, reason: string): void {
	recordTerminalFailure(
		curCtx,
		{ cwd: run.cwd, runId: run.runId, state: run.state, skill: currentName },
		{
			status: "failed",
			notifyMsg: MSG_CHAIN_ADVANCE_FAILED(currentName, reason),
			notifyLevel: "error",
			errMsg: reason,
		},
	);
}
