/**
 * Stage routing for the /rpiv workflow runner (Phase 6).
 *
 * Replaces the runner's inline `idx + 1` next-stage computation with
 * edge-aware routing. Strict-preset mode only: predicate targets must
 * be in the preset sequence at or after the linear successor.
 */

import type { WorkflowDag } from "./dag.js";
import type { EdgePredicate, PredicateContext } from "./predicates.js";
import type { RunState } from "./types.js";

/**
 * Resolve the next stage id after the current node.
 *
 * Resolution order:
 * 1. No outgoing edges → return preset[idx + 1] (linear advance).
 * 2. Single auto edge → return edge.to[0].
 * 3. Predicate edge → evaluate predicate, return target.
 * 4. Choice edge → return preset[idx + 1] (choice requires user prompt,
 *    not yet wired in the runner; falls back to linear).
 *
 * Strict-preset enforcement: predicate targets must be in preset at
 * idx + 1 or later. Off-preset targets trigger a diagnostic error.
 */
export function resolveNextStageId(
	dag: WorkflowDag,
	currentNodeId: string,
	preset: string[],
	idx: number,
	state: Readonly<RunState>,
): string | undefined {
	// Linear default: next in preset, or undefined if at end
	const linearNext = preset[idx + 1];
	if (idx + 1 >= preset.length) return undefined;

	// Find outgoing edge for this node
	const edge = dag.edges.find((e) => e.from === currentNodeId);
	if (!edge) return linearNext;

	if (edge.condition === "auto") {
		return edge.to[0];
	}

	if (edge.condition === "predicate") {
		const predicate = (edge as { predicate: EdgePredicate }).predicate;
		const ctx: PredicateContext = {
			manifest: state.manifest,
			state,
		};

		let target: string;
		try {
			target = predicate(ctx);
		} catch {
			// Predicate threw — treat as halt
			throw new Error(
				`resolveNextStageId: predicate on edge "${edge.from} → [${edge.to.join(", ")}]" threw an error`,
			);
		}

		// Strict-preset enforcement: target must be in preset at or after idx + 1
		const targetIdx = preset.indexOf(target);
		if (targetIdx < 0 || targetIdx < idx + 1) {
			throw new Error(
				`resolveNextStageId: predicate returned "${target}" which is not a valid forward target in preset (must be one of: ${preset.slice(idx + 1).join(", ")})`,
			);
		}
		return target;
	}

	// choice edges fall through to linear advance (user-prompt not yet wired)
	return linearNext;
}
