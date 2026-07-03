/**
 * Graph-topology checks — the workflow as a directed graph, nothing about
 * what individual stages mean (that's `stage-rules.ts`) or whether contracts
 * compose (`contract-compat.ts`).
 *
 * Covers: workflow name, start-stage existence, edge keys/targets, implicit
 * terminals, reachability. The edge-target check also emits
 * `edge-fn-no-targets` for hand-rolled EdgeFns missing `.targets` metadata;
 * the orchestrator gates `checkReachability` on that code's presence (a BFS
 * over unenumerable edges would emit "unreachable" cascades whose root cause
 * is the metadata error already reported).
 *
 * "terminal"/"implicit terminals" throughout this module is the GRAPH-SINK
 * sense (a stage with no outgoing edge OR an explicit `STOP`) — unrelated to
 * the `terminal()` stage factory (../stage-def.ts) and to "terminal failure"
 * run-outcome prose (../audit.ts). See the glossary on `stage-def.ts`'s
 * `terminal` export.
 */

import { type EdgeTarget, STOP, type Workflow } from "../api.js";
import type { IssueReporter } from "./issue.js";

/** `name` is what users type as `/wf <name>` — empty string makes the workflow unreachable. */
export function checkWorkflowName(w: Workflow, r: IssueReporter): void {
	if (typeof w.name !== "string" || w.name.length === 0) {
		r.report("workflow-name-invalid");
	}
}

export function checkStartStage(w: Workflow, r: IssueReporter): void {
	if (!w.stages[w.start]) {
		r.report("start-stage-missing", { start: w.start });
	}
}

/** Every key in `edges` must be a declared stage. */
export function checkEdgeKeys(w: Workflow, r: IssueReporter): void {
	for (const from of Object.keys(w.edges)) {
		if (!w.stages[from]) {
			r.forStage(from)("edge-key-unknown", { from });
		}
	}
}

/**
 * Every edge target must resolve to a declared stage or the `"stop"` sentinel.
 * String targets are checked directly. `EdgeFn` targets are checked via the
 * paired `checkEdgeFnTargets` (emits `edge-fn-no-targets`) and enumerated via
 * the pure `enumerateTargets`.
 */
export function checkEdgeTargets(w: Workflow, r: IssueReporter): void {
	for (const [from, target] of Object.entries(w.edges)) {
		checkEdgeFnTargets(target, from, r);
		for (const candidate of enumerateTargets(target)) {
			if (candidate === STOP) continue;
			if (!w.stages[candidate]) {
				r.forStage(from)("edge-target-unknown", { from, target: candidate });
			}
		}
	}
}

/**
 * Stages with no outgoing edge are implicit terminals — usually a missing
 * connection. ("terminal" = graph-sink sense; see the module header.)
 */
export function checkMissingEdges(w: Workflow, r: IssueReporter): void {
	for (const name of Object.keys(w.stages)) {
		if (!(name in w.edges)) {
			r.forStage(name)("edge-missing", { stage: name });
		}
	}
}

/**
 * BFS from `start`; every declared stage should be reachable. Orphans aren't
 * a runner error (they can't fire) but they're almost always a mistake worth
 * surfacing.
 */
export function checkReachability(w: Workflow, r: IssueReporter): void {
	if (!w.stages[w.start]) return; // already reported by checkStartStage

	const reachable = new Set<string>();
	const frontier: string[] = [w.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (reachable.has(cur)) continue;
		reachable.add(cur);

		const target = w.edges[cur];
		if (target === undefined || target === STOP) continue;

		for (const next of enumerateTargets(target)) {
			if (next !== STOP && w.stages[next] && !reachable.has(next)) frontier.push(next);
		}
	}

	for (const name of Object.keys(w.stages)) {
		if (!reachable.has(name)) {
			r.forStage(name)("stage-unreachable", { start: w.start });
		}
	}
}

/**
 * Returns the set of possible string targets an `EdgeTarget` could resolve to.
 * Pure — no issue emission.
 *
 * - String → singleton.
 * - `EdgeFn` with `.targets` metadata → declared targets.
 * - `EdgeFn` without `.targets` → empty list. The missing-metadata error is
 *   the responsibility of `checkEdgeFnTargets` (paired emit-only function);
 *   call it alongside `enumerateTargets` only at sites that lint edges
 *   (currently `checkEdgeTargets`). Reachability traversal calls only the
 *   pure form.
 */
function enumerateTargets(target: EdgeTarget): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target.targets) && target.targets.length > 0) return [...target.targets];
	return [];
}

/**
 * Emits `edge-fn-no-targets` for an `EdgeTarget` that's a hand-rolled
 * `EdgeFn` lacking the marker. Pairs with `enumerateTargets`: lint sites
 * call both; reachability calls only the enumerator. Users authoring routes
 * by hand MUST go through `defineRoute(targets, fn)` so the `.targets`
 * metadata is structurally attached.
 */
function checkEdgeFnTargets(target: EdgeTarget, from: string, r: IssueReporter): void {
	if (typeof target === "string") return;
	if (Array.isArray(target.targets) && target.targets.length > 0) return;
	r.forStage(from)("edge-fn-no-targets", { from });
}
