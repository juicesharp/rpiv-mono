/**
 * Stage routing for the /rpiv workflow runner.
 *
 * Replaces the runner's inline `idx + 1` next-stage computation with
 * edge-aware routing. Strict-preset mode only: predicate targets must
 * be in the preset sequence at or after the linear successor.
 */

import type { DagEdge, WorkflowDag } from "./dag.js";
import type { EdgePredicate, PredicateContext } from "./predicates.js";
import type { RunState } from "./types.js";

/**
 * Resolve the next stage id after the current node.
 *
 * - No outgoing edge → linear advance.
 * - `auto` edge      → first target.
 * - `predicate` edge → evaluate predicate, validate target is forward in preset.
 * - `choice` edge    → linear advance (user-prompt routing not yet wired).
 */
export function resolveNextStageId(
	dag: WorkflowDag,
	currentNodeId: string,
	preset: string[],
	idx: number,
	state: Readonly<RunState>,
): string | undefined {
	if (atEndOfPreset(preset, idx)) return undefined;

	const edge = findOutgoingEdge(dag, currentNodeId);
	if (!edge) return linearNextOf(preset, idx);

	switch (edge.condition) {
		case "auto":
			return edge.to[0];
		case "predicate":
			return evaluatePredicateEdge(edge, preset, idx, state);
		default:
			// "choice" — user-prompt routing not yet wired; fall back to linear.
			return linearNextOf(preset, idx);
	}
}

// ---------------------------------------------------------------------------
// Preset navigation
// ---------------------------------------------------------------------------

const atEndOfPreset = (preset: string[], idx: number): boolean => idx + 1 >= preset.length;

const linearNextOf = (preset: string[], idx: number): string | undefined => preset[idx + 1];

const findOutgoingEdge = (dag: WorkflowDag, from: string): DagEdge | undefined =>
	dag.edges.find((e) => e.from === from);

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

/** Run the edge's predicate and verify the chosen target is a valid forward step. */
function evaluatePredicateEdge(edge: DagEdge, preset: string[], idx: number, state: Readonly<RunState>): string {
	const target = invokePredicate(edge, state);
	assertForwardTarget(target, preset, idx);
	return target;
}

/** Call the edge's predicate with a typed context; surface any throw as a halt-shaped error. */
function invokePredicate(edge: DagEdge, state: Readonly<RunState>): string {
	const predicate = (edge as { predicate: EdgePredicate }).predicate;
	const ctx: PredicateContext = { manifest: state.manifest, state };
	try {
		return predicate(ctx);
	} catch {
		throw new Error(`resolveNextStageId: predicate on edge "${edge.from} → [${edge.to.join(", ")}]" threw an error`);
	}
}

/** Strict-preset enforcement: predicate target must be at or after preset[idx + 1]. */
function assertForwardTarget(target: string, preset: string[], idx: number): void {
	const targetIdx = preset.indexOf(target);
	if (targetIdx < 0 || targetIdx < idx + 1) {
		throw new Error(
			`resolveNextStageId: predicate returned "${target}" which is not a valid forward target in preset ` +
				`(must be one of: ${preset.slice(idx + 1).join(", ")})`,
		);
	}
}
