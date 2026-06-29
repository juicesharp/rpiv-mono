/**
 * Next-stage lookup over a `Workflow`'s edge graph.
 *
 * `nextStage` is the single chokepoint: given the current stage name + the
 * runtime context, it returns a `RoutingResult` — `{ kind: "next", stage }`
 * if the chain continues, `{ kind: "stop" }` for terminal stages (no
 * outgoing edge OR explicit `STOP`), `{ kind: "err", reason }` if the
 * routing layer detected a violation (an `EdgeFn` body threw, or an
 * `EdgeFn` returned an undeclared target).
 *
 * `{ kind: "stop" }` (and "terminal stages" above/below) is the GRAPH-SINK
 * sense — a stage with no outgoing edge OR an explicit `STOP`. Unrelated to
 * the `terminal()` stage factory (stage-def.ts) and to "terminal failure"
 * run-outcome prose (audit.ts). See the glossary on `stage-def.ts`'s
 * `terminal` export. The `kind: "stop"` literal is untouched.
 *
 * Errors are returned, not thrown. The caller (runner) switches on
 * `kind` and routes `"err"` through `recordTerminalFailure` — same as
 * any other halt site.
 */

import { type EdgeContext, type EdgeFn, STOP, type Workflow } from "./api.js";
import { formatError } from "./internal-utils.js";

/**
 * Three-way return from `nextStage`. Matches the convention established by
 * `sessions.ts:ExtractionOutcome` and `load.ts:NormalizeResult` — every
 * multi-state result in the package carries an explicit `kind` discriminator.
 */
export type RoutingResult = { kind: "next"; stage: string } | { kind: "stop" } | { kind: "err"; reason: string };

/**
 * Returns `{ kind: "next", stage }` to advance, `{ kind: "stop" }` for
 * terminal stages (no outgoing edge OR explicit `STOP`), or
 * `{ kind: "err", reason }` when an `EdgeFn` threw or returned an
 * undeclared target. Load-time `validateWorkflow` should catch the
 * undeclared-target case for predicates with `.targets` metadata; the
 * runtime check is the last line of defense.
 */
export function nextStage(workflow: Workflow, current: string, ctx: EdgeContext): RoutingResult {
	const target = workflow.edges[current];
	if (target === undefined || target === STOP) return { kind: "stop" };
	if (typeof target === "string") return resolveTarget(workflow, current, target);

	const picked = invokeEdgeFn(target, ctx, current);
	if (picked.kind === "err") return picked;
	if (picked.value === STOP) return { kind: "stop" };
	return resolveTarget(workflow, current, picked.value);
}

/**
 * True iff the current stage's edge is an `EdgeFn` — i.e., a routing decision
 * was made. The runner uses this to decide whether to write a routing-audit
 * row. String edges are deterministic and not worth auditing.
 */
export function edgeIsDecision(workflow: Workflow, current: string): boolean {
	return typeof workflow.edges[current] === "function";
}

/**
 * The not-taken targets of a DECISION edge that are pure RECOVERY arms — a
 * stage whose own out-edge is a STRING edge pointing at an already-visited
 * stage, i.e. taking it would loop BACK into covered territory rather than make
 * forward progress.
 *
 * Used by the progress bridge (`rpiv-pi` lane-progress): when a gate takes its
 * pass arm, the failure arm (carve's `reslice` / `refine`) is bypassed for good
 * on this path, so it counts toward "distinct nodes covered" — the bar reaches
 * full WHILE the terminal stage runs instead of freezing one-below until the
 * `onWorkflowEnd` snap. Surfaced as the `onRoute` lifecycle event's `bypassed`
 * argument.
 *
 * Deliberately narrow: a not-taken target is credited ONLY when its successor
 * is a string edge to an already-visited stage. A FORWARD arm (its successor
 * not yet visited) is merely deferred, not bypassed — crediting it would push
 * the numerator AHEAD of the stages actually reached. An arm with a gate/
 * terminal out-edge is left uncredited (conservative; never over-counts).
 *
 * Returns distinct names; `chosen`, `STOP`, and already-visited arms are
 * excluded, so the credited set never inflates the numerator past the reachable
 * total.
 */
export function bypassedRecoveryArms(
	workflow: Workflow,
	from: string,
	chosen: string,
	visited: ReadonlySet<string>,
): string[] {
	const edge = workflow.edges[from];
	if (typeof edge !== "function" || !Array.isArray(edge.targets)) return [];
	const out: string[] = [];
	for (const t of edge.targets) {
		if (t === chosen || t === STOP || visited.has(t)) continue;
		const succ = workflow.edges[t]; // one-hop loop-back test
		if (typeof succ === "string" && visited.has(succ)) out.push(t);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function invokeEdgeFn(
	fn: EdgeFn,
	ctx: EdgeContext,
	current: string,
): { kind: "ok"; value: string } | { kind: "err"; reason: string } {
	try {
		return { kind: "ok", value: fn(ctx) };
	} catch (e) {
		return {
			kind: "err",
			reason: `workflow edge function at "${current}" threw: ${formatError(e)}`,
		};
	}
}

function resolveTarget(workflow: Workflow, current: string, target: string): RoutingResult {
	if (workflow.stages[target]) return { kind: "next", stage: target };
	return {
		kind: "err",
		reason: `workflow edge from "${current}" returned "${target}" which is not a declared stage in workflow "${workflow.name}"`,
	};
}
