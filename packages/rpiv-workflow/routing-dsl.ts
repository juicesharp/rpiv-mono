/**
 * The routing DSL — edge vocabulary (`EdgeFn` / `EdgeTarget` / `STOP`) and
 * the route builders (`defineRoute`, `gate`) with their structural markers
 * (`READS_DATA`, `ROUTE_NOTE`). Split out of api.ts: how the graph
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
 * is a defect.
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

/** A discrete value a `match` branch compares its field against (strict `===`). */
export type MatchValue = string | number | boolean;

/** Options for `match`. */
export interface MatchOptions {
	/**
	 * Stage to route to when no branch value matches. Optional: when omitted, an
	 * unmatched value TERMINATES the chain (`STOP`). Either way the no-match is a
	 * visible event — the routing-audit row carries a `note`. Provide a fallback
	 * to keep the run going on an unexpected value (the roadmap-P4 `triage` shape).
	 */
	fallback?: string;
	/**
	 * Read the matched field from a NAMED CHANNEL's latest output
	 * (`state.named[from].at(-1).data[field]`) instead of the stage's projected
	 * `output.data`. This is how a `match` routes on a panel's PUBLISHED verdict
	 * (the `<stage>-panel` channel) — the fold lands on a channel, never on the
	 * stage's projected output (which stays the producer artifact). A
	 * channel-sourced route validates the channel's data, not the source stage's
	 * output, so it does NOT mark the source stage `READS_DATA`.
	 */
	from?: string;
}

/**
 * Conditional routing keyed on an ENUM field — the string/boolean companion to
 * the numeric `gate`. Each branch maps a target stage to the discrete value that
 * routes to it; the field is compared by strict `===` in declaration order and
 * the first match wins:
 *
 * ```ts
 * match("severity", { escalate: "p0", fix: "p1", backlog: "p2" })
 * match("tie", { escalate: true }, { fallback: "keep", from: "review-panel" })
 * ```
 *
 * Sourcing (`opts.from`) lets a `match` branch on a panel's published verdict —
 * `match("tie", …, { from: "<stage>-panel" })` reads the folded `PANEL_VERDICT`
 * off its channel, the disagreement-routing companion to `panel()`.
 *
 * No-match handling is EXPLICIT, never silent: with an `opts.fallback` the
 * unmatched value routes there; without one it terminates (`STOP`). Both record
 * a routing-audit `note`.
 *
 * Each enum value must map to exactly one stage (a duplicate value is ambiguous
 * → construction error), and branch keys must not be integer-like (`"2"`) — JS
 * hoists array-index keys ahead of declaration order, silently reordering match
 * priority. Built on `defineRoute`, so `.targets` is attached structurally
 * (reachability BFS sees every branch incl. the fallback) and `READS_DATA`
 * auto-applies (unless `from` sources a channel instead of the stage output).
 */
export function match(field: string, branches: Record<string, MatchValue>, opts?: MatchOptions): EdgeFn {
	const branchTargets = Object.keys(branches);
	if (branchTargets.length === 0) {
		throw new Error("match: branches must declare at least one possible return value");
	}
	const claimedBy = new Map<string, string>();
	for (const key of branchTargets) {
		if (INTEGER_LIKE_KEY.test(key)) {
			throw new Error(
				`match: branch key "${key}" is integer-like — JS reorders such keys ahead of declaration order, ` +
					`silently changing match priority. Rename the stage.`,
			);
		}
		// Type-tag the value so 0/"0"/false stay distinct when deduping.
		const value = branches[key]!;
		const valueKey = `${typeof value}:${String(value)}`;
		const prior = claimedBy.get(valueKey);
		if (prior !== undefined) {
			throw new Error(
				`match: value ${JSON.stringify(value)} is claimed by both "${prior}" and "${key}" — ` +
					`each enum value must map to exactly one stage`,
			);
		}
		claimedBy.set(valueKey, key);
	}

	const fallback = opts?.fallback;
	if (fallback !== undefined && (typeof fallback !== "string" || fallback.length === 0)) {
		throw new Error("match: `fallback`, when provided, must be a non-empty stage name");
	}
	const noMatch = fallback ?? STOP;
	const targets = [...new Set([...branchTargets, noMatch])];

	const from = opts?.from;
	const route: EdgeFn = defineRoute(
		targets,
		({ output, state }) => {
			const source =
				from !== undefined
					? (state.named[from]?.at(-1)?.data as Record<string, unknown> | undefined)
					: (output?.data as Record<string, unknown> | undefined);
			const raw = source?.[field];
			for (const target of branchTargets) {
				if (raw === branches[target]) return target;
			}
			(route as unknown as Record<symbol, string>)[ROUTE_NOTE] =
				`match("${field}"): value ${JSON.stringify(raw ?? null)} matched no branch — ${
					fallback ? `fell back to "${fallback}"` : `terminated (no fallback)`
				}`;
			return noMatch;
		},
		// A channel-sourced match validates the CHANNEL's data, not the source
		// stage's projected output — so don't demand the source stage carry an
		// outputSchema. A stage-output match reads `output.data` (default mark).
		from !== undefined ? { readsData: false } : undefined,
	);
	return route;
}
