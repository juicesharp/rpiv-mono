/**
 * The routing DSL — edge vocabulary (`EdgeFn` / `EdgeTarget` / `STOP`) and
 * the route builders (`defineRoute`, `gate`) with their structural markers
 * (`READS_DATA`, `ROUTE_NOTE`). Split out of api.ts (M9): how the graph
 * routes is one concept; what a stage is, is another. Runtime edge
 * EXECUTION lives in routing.ts — this module is authoring-surface only.
 */

import type { Output, RunView } from "./output.js";
import type { NumericPredicate } from "./predicates.js";

/**
 * Runtime context handed to an `EdgeFn`. The sole context shape for both
 * data-reading and state-only routes (the single `defineRoute` path covers
 * both via `opts.readsData`).
 */
export interface EdgeContext {
	output: Output | undefined;
	state: RunView;
}

/**
 * Body-type alias for hand-rolled route picks. Internal — users wrap via
 * `defineRoute`, which returns an `EdgeFn` (this alias plus a `.targets`
 * field).
 */
type EdgePredicate = (ctx: EdgeContext) => string;

/**
 * A function that picks the next stage name given current state + output.
 * Optional `targets` field lets graph introspectors enumerate possible
 * returns — `gate` and other built-in route builders populate it.
 */
export type EdgeFn = EdgePredicate & { targets?: readonly string[] };

/**
 * Terminal edge sentinel. Single source of truth for the `"stop"` literal
 * embedded in `EdgeTarget`; `validate-workflow.ts` + `routing.ts` import this rather
 * than re-declaring the string.
 */
export const STOP = "stop" as const;

/**
 * What an `edges` entry resolves to: another stage name (auto-edge), the
 * terminal sentinel `STOP`, or a function chosen at run-time.
 */
export type EdgeTarget = string | typeof STOP | EdgeFn;

/**
 * Marker attached to EdgeFns that read from `output.data`.
 * `validate-workflow.ts:checkPredicateSchemas` warns when a stage feeds a
 * marked route but has no `outputSchema` — routing on un-validated data
 * is the I6-class defect from the bcc34bc review.
 *
 * Default is "marked": `defineRoute(targets, fn)` auto-marks. Opt out by
 * passing `{ readsData: false }` for the rare route that consults only
 * `state` or `output.meta`.
 *
 * Exported as a `Symbol.for` so it survives `import` boundaries cleanly.
 */
export const READS_DATA: unique symbol = Symbol.for("rpiv.workflow.readsData");

/**
 * True iff `fn` was wrapped by `defineRoute(...)` with the data-reading
 * marker attached (the default; opt out via `{ readsData: false }`). The
 * validator uses this to decide whether an `EdgeFn`'s source stage must
 * declare an `outputSchema` — data-reading routes need a validated output
 * shape; state-only routes don't.
 *
 * Centralises the double-cast required to symbol-key into a function object
 * so consumers don't sprinkle `as unknown as Record<symbol, …>` at every
 * read site.
 */
export function marksReadsData(fn: EdgeFn): boolean {
	return Boolean((fn as unknown as Record<symbol, boolean>)[READS_DATA]);
}

/** Options for `defineRoute`. */
export interface DefineRouteOptions {
	/**
	 * Whether the route reads `output.data` (the default). Set to `false` for
	 * routes that consult only `state` or `output.meta` so the load-time
	 * outputSchema lint doesn't warn the source stage lacks an
	 * `outputSchema` (a state-derived route has no data-shape contract to
	 * validate).
	 */
	readsData?: boolean;
}

/**
 * Promote a hand-rolled `EdgePredicate` to an `EdgeFn` by structurally
 * attaching the set of possible returns. `validate-workflow.ts` requires every
 * EdgeFn to carry `.targets` so reachability and load-time edge-target
 * checks see every branch; this factory is the only blessed way to author
 * a multi-branch route.
 *
 * Auto-marks the returned EdgeFn with `READS_DATA` so the outputSchema lint
 * fires when the source stage has no `outputSchema`. If the route consults
 * only `state` / `output.meta` and never reads `output.data`, pass
 * `{ readsData: false }` to suppress the lint.
 *
 * Throws if `targets` is empty — a route that can't return anything
 * declared is by definition a bug.
 */
export function defineRoute(targets: readonly string[], fn: EdgePredicate, opts?: DefineRouteOptions): EdgeFn {
	if (targets.length === 0) {
		throw new Error("defineRoute: targets must declare at least one possible return value");
	}
	// Fresh delegating wrapper — NEVER mutate the caller's function. Reusing
	// one predicate across two defineRoute calls must not alias their targets
	// (the second call would overwrite the first's), and `readsData: false`
	// must not inherit a marker a prior call attached.
	const wrapped: EdgeFn = (ctx) => fn(ctx);
	wrapped.targets = [...targets];
	if (opts?.readsData !== false) (wrapped as unknown as Record<symbol, boolean>)[READS_DATA] = true;
	return wrapped;
}

/**
 * Symbol under which an `EdgeFn` records a note about its most recent pick —
 * today: `gate`'s "no branch matched, fallback fired" diagnostic. The runner's
 * routing audit reads-and-clears it via `takeRouteNote` right after invoking
 * the edge (same tick — single-threaded, no other decision can interleave)
 * and persists it on the `RoutingDecision` row's `note`.
 *
 * Framework plumbing, not authoring surface — NOT re-exported from
 * `registration.ts`. `Symbol.for` so it survives import boundaries, matching
 * `READS_DATA`.
 */
export const ROUTE_NOTE: unique symbol = Symbol.for("rpiv.workflow.routeNote");

/**
 * Read-and-clear the note an `EdgeFn` attached to its most recent invocation.
 * Returns undefined when the edge recorded nothing (the common case).
 */
export function takeRouteNote(fn: EdgeFn): string | undefined {
	const slot = fn as unknown as Record<symbol, string | undefined>;
	const note = slot[ROUTE_NOTE];
	if (note !== undefined) slot[ROUTE_NOTE] = undefined;
	return note;
}

/**
 * Matches the keys JS engines hoist and reorder ahead of string keys
 * (canonical array indices). `gate` evaluates branches in declaration order,
 * so an integer-like stage name would silently change match priority.
 */
const INTEGER_LIKE_KEY = /^\d+$/;

/**
 * Conditional routing keyed on a numeric field in `output.data`. Each
 * branch's predicate is evaluated against `Number(output.data[field])` in
 * declaration order; the first matching branch wins. When no predicate
 * matches (including a missing or non-numeric field, which coerces to `NaN`),
 * the EXPLICIT `otherwise` branch is taken and the routing-audit row carries
 * a `note` saying the fallback fired — no-match is a visible event, not a
 * silent property of declaration order.
 *
 * ```ts
 * gate("blockers_count", { revise: gt(0), commit: eq(0) }, "commit")
 * // value > 0  → "revise"
 * // value = 0  → "commit"
 * // value < 0, missing, NaN → "commit" (otherwise; audit row notes the fallback)
 * ```
 *
 * Branch keys must not be integer-like (`"2"`): JS object literals hoist
 * array-index keys ahead of declaration order, which would silently reorder
 * match priority — rejected at construction.
 *
 * Built on `defineRoute` so the `.targets` metadata is attached structurally
 * (the `otherwise` target included) and the `READS_DATA` marker auto-applies
 * (routing reads `output.data`).
 */
export function gate(field: string, branches: Record<string, NumericPredicate>, otherwise: string): EdgeFn {
	const branchTargets = Object.keys(branches);
	if (branchTargets.length === 0) {
		throw new Error("gate: branches must declare at least one possible return value");
	}
	if (typeof otherwise !== "string" || otherwise.length === 0) {
		throw new Error("gate: an explicit `otherwise` branch is required — the no-match fallback must be deliberate");
	}
	for (const key of branchTargets) {
		if (INTEGER_LIKE_KEY.test(key)) {
			throw new Error(
				`gate: branch key "${key}" is integer-like — JS reorders such keys ahead of declaration order, ` +
					`silently changing match priority. Rename the stage or route to it via \`otherwise\`.`,
			);
		}
	}
	const targets = [...new Set([...branchTargets, otherwise])];
	const route: EdgeFn = defineRoute(targets, ({ output }) => {
		const value = Number((output?.data as Record<string, unknown> | undefined)?.[field]);
		for (const target of branchTargets) {
			if (branches[target]!(value)) return target;
		}
		(route as unknown as Record<symbol, string>)[ROUTE_NOTE] =
			`gate("${field}"): no branch matched value ${value} — fell back to "${otherwise}"`;
		return otherwise;
	});
	return route;
}
