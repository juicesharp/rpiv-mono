/**
 * Routing layer after a stage completes successfully: pick the next stage,
 * audit predicate-mediated decisions, enforce the backward-jump guard,
 * then recurse via the injected `deps.runNext`.
 *
 * `nextStage` returns a tagged union; `advanceChain` switches on `kind`
 * instead of catching. The injected runner owns the catch for
 * downstream-stage throws — the `ChainDeps` injection (the `LoopDeps`
 * pattern) keeps this module's imports strictly downward: the chain walk's
 * runStage ↔ advanceChain recursion is composed in run-stage.ts, not
 * spelled as a module cycle.
 */

import { takeRouteNote } from "../api.js";
import { auditCtxFor, failedArgs, recordTerminalFailure } from "../audit.js";
import { resolveSkill } from "../chain-state.js";
import { lifecycleCtxFor, skillStageRef } from "../events.js";
import { nowIso } from "../internal-utils.js";
import { FAIL_BACKWARD_JUMP_EXHAUSTED, MSG_CHAIN_ADVANCE_FAILED, MSG_ROUTING_AUDIT_DROPPED } from "../messages.js";
import { bypassedRecoveryArms, edgeIsDecision, nextStage } from "../routing.js";
import { appendRoutingDecision } from "../state/index.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { type ChainOutcome, finalizeWorkflow } from "./failure.js";

/**
 * The walk continuation injected by the composition site
 * (run-stage.ts): run the routed next stage through the single catch
 * site. Injected so this module never imports the per-stage pipeline back —
 * the mutual recursion of the chain walk lives in ONE composing module.
 */
export interface ChainDeps {
	runNext: (curCtx: WorkflowHostContext, name: string, idx: number, run: RunContext) => Promise<ChainOutcome>;
}

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
	deps: ChainDeps,
): Promise<ChainOutcome> {
	// Mark the just-completed stage as visited BEFORE consulting the next edge.
	// A thrown EdgeFn would otherwise leave currentName un-marked, opening a
	// (narrow) window where a recovery path could under-count revisits.
	run.visited.add(currentName);

	const wasDecision = edgeIsDecision(run.workflow, currentName);
	const result = nextStage(run.workflow, currentName, { output: run.state.output, state: run.state });

	if (result.kind === "err") {
		return haltOnRoutingError(curCtx, run, currentName, result.reason);
	}

	const fromRef = skillStageRef(currentName, idx + 1, resolveSkill(run.workflow.stages[currentName]!, currentName));

	// Recovery arms this decision passed over for good — credited toward progress
	// "coverage" by the bridge so a clean run's bar isn't frozen one-below until the
	// end (carve's slice-fix/plan-fix/code-fix). Empty for deterministic edges (no alternatives).
	const chosen = result.kind === "stop" ? "stop" : result.stage;
	const bypassed = wasDecision ? bypassedRecoveryArms(run.workflow, currentName, chosen, run.visited) : [];

	if (result.kind === "stop") {
		await run.lifecycle.fire(curCtx, "onRoute", fromRef, "stop", lifecycleCtxFor(run), bypassed);
		return finalizeWorkflow(curCtx, run);
	}

	const nextName = result.stage;
	if (wasDecision) {
		auditRoutingDecision(curCtx, run, idx, currentName, nextName);
		const guard = await checkBackwardJumpGuard(curCtx, run, nextName);
		if (guard !== "continue") return guard;
	}

	// Fire onRoute after the routing decision has been audited (when applicable),
	// before the next stage runs. Deterministic auto-edges still fire so
	// listeners see every transition.
	await run.lifecycle.fire(curCtx, "onRoute", fromRef, nextName, lifecycleCtxFor(run), bypassed);

	// deps.runNext owns the catch for throws out of the *next* stage, so the
	// JSONL row records `nextName` (the stage that actually threw) rather than
	// `currentName` (which would mis-attribute the failure to the prior stage
	// that already completed successfully).
	return deps.runNext(curCtx, nextName, idx + 1, run);
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
	// Read-and-clear any note the edge attached to THIS pick (e.g. gate's
	// fallback-fired diagnostic). Same tick as the invocation — no other
	// decision can interleave. `undefined` is dropped by JSON.stringify.
	const edge = run.workflow.edges[currentName];
	const note = typeof edge === "function" ? takeRouteNote(edge) : undefined;
	const fromStageIndex = idx + 1;
	const wrote = appendRoutingDecision(run.cwd, run.runId, {
		type: "routing",
		fromStageIndex,
		fromStage: currentName,
		decision: nextName,
		note,
		ts: nowIso(),
	});
	if (!wrote) {
		run.state.telemetry.droppedRoutingRows.push({ fromStageIndex, fromStage: currentName, decision: nextName });
		curCtx.ui.notify(MSG_ROUTING_AUDIT_DROPPED(currentName, nextName), "warning");
	}
}

/**
 * Per-DESTINATION cap on decision-edge retries. Returns `"continue"` when the
 * run may proceed, or the `"halted"` outcome when the cap tripped (and the
 * terminal failure has been recorded).
 *
 * A "backward jump" is a *decision-edge* resolving to an already-visited
 * stage — i.e. a deliberate retry choice. Deterministic forward edges that
 * pass through a cycle (the body of a multi-stage loop) are NOT counted,
 * because they're consequences of the retry decision rather than
 * independent retry events. Without this distinction the cap would trip
 * mid-loop on any cycle longer than 2 stages, burning the entire budget
 * on a single retry iteration's deterministic hops.
 *
 * Each destination owns its budget (`run.revisits`): a stage may be
 * re-entered via decision edges at most `maxBackwardJumps` times, regardless
 * of how many OTHER decision edges the cycle crosses on the way. A shared
 * streak counter would make the effective retry budget a function of the
 * cycle's hop count — inserting a checking stage into a fix loop (a
 * deterministic-floor edge, a confirm arm) silently taxed the fix budget.
 * Per-destination counts are invariant to the cycle's shape, and unrelated
 * loops are independent by construction (different destinations), which is
 * what the old reset-on-escape rule existed to approximate.
 *
 * `state.telemetry.backwardJumps` stays the run-wide cumulative total of
 * counted backward jumps (post-hoc telemetry only — never consulted for the
 * halt decision, never reset).
 *
 * Trip attribution targets `nextName` (the stage the guard refused to
 * re-enter), not the just-completed stage.
 */
async function checkBackwardJumpGuard(
	curCtx: WorkflowHostContext,
	run: RunContext,
	nextName: string,
): Promise<"continue" | ChainOutcome> {
	if (!run.visited.has(nextName)) return "continue";
	const revisits = (run.revisits.get(nextName) ?? 0) + 1;
	run.revisits.set(nextName, revisits);
	run.state.telemetry.backwardJumps++;
	if (revisits <= run.maxBackwardJumps) return "continue";
	await recordTerminalFailure(
		curCtx,
		auditCtxFor(run, nextName, nextName),
		failedArgs(FAIL_BACKWARD_JUMP_EXHAUSTED(nextName, revisits, run.maxBackwardJumps)),
	);
	return "halted";
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
): Promise<ChainOutcome> {
	await recordTerminalFailure(
		curCtx,
		auditCtxFor(run, currentName, currentName),
		failedArgs(MSG_CHAIN_ADVANCE_FAILED(currentName, reason), reason),
	);
	return "halted";
}
