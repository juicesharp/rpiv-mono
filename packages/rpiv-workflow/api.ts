/**
 * Public authoring surface for rpiv workflows. Canonical entry point — users
 * import everything they need (`defineWorkflow`, `artifact`, `action`,
 * `definePredicate`, `defineStatePredicate`, `threshold`, `STOP`,
 * `marksFrontmatter`, schema adapters, plus the type vocabulary `Workflow`
 * / `NodeDef` / `EdgeFn` / `EdgeTarget` / `EdgeContext`) from
 * `@juicesharp/rpiv-workflow`.
 *
 * A `Workflow` is a typed graph: a named entry point, a node table, and an
 * edge table that maps each node to either another node name, the sentinel
 * `STOP`, or an `EdgeFn` that picks at runtime. Edges live INSIDE each
 * workflow.
 *
 * Factories are pure passthroughs that apply sane defaults. Same idiom as
 * `defineConfig` in Vite/Astro/Tailwind: zero runtime cost, exists solely
 * for type inference + uniform shape at the call site.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Extractor } from "./manifest.js";
import type { RunState } from "./types.js";

export type { Extractor } from "./manifest.js";

/**
 * Schema attached to a node's `outputSchema` / `inputSchema`. Structurally
 * a Standard Schema v1 (the converged interface implemented by Zod, Valibot,
 * ArkType, TypeBox, et al.) — re-exported under a name that doesn't leak the
 * spec version into our public surface. When the spec versions, this alias
 * picks the right one in a single line.
 */
export type NodeSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

// ===========================================================================
// Node-shape primitives
// ===========================================================================

/**
 * - `"artifact-emit"` — protocol skills that write `.rpiv/artifacts/<bucket>/<file>.md`.
 *   The runner halts the chain if the path doesn't appear in the transcript.
 * - `"agent-end"` — action skills (commit, implement) where the side effect IS
 *   the work; the chain inherits the prior `currentArtifactPath(state)`.
 *
 * The `as const` array is the single source of truth: the literal-union type
 * is derived via `(typeof ARRAY)[number]`, and `validate-workflow.ts` consumes
 * the same array for the runtime enum check. Adding a variant updates both
 * type-level and runtime arms in one edit.
 */
export const COMPLETION_STRATEGIES = ["artifact-emit", "agent-end"] as const;
export type CompletionStrategy = (typeof COMPLETION_STRATEGIES)[number];

/**
 * - `"fresh"` — wraps the stage in `ctx.newSession({ withSession })`.
 * - `"continue"` — reuses the prior session via `pi.sendUserMessage()` +
 *   `ctx.waitForIdle()`; branch sliced by `branchOffset`.
 */
export const SESSION_POLICIES = ["fresh", "continue"] as const;
export type SessionPolicy = (typeof SESSION_POLICIES)[number];

/**
 * What happens when a node's `outputSchema` rejects the extracted manifest:
 * - `"retry"` — re-invoke the stage up to `maxValidationRetries`, threading
 *   the schema's issues back to the agent via a retry prompt.
 * - `"halt"` — record a terminal failure on the first rejection.
 */
export const ON_VALIDATION_FAILURE_VALUES = ["retry", "halt"] as const;
export type OnValidationFailure = (typeof ON_VALIDATION_FAILURE_VALUES)[number];

// ===========================================================================
// Types
// ===========================================================================

/**
 * Runtime context handed to an `EdgeFn`. The sole context shape for both
 * frontmatter-reading (`definePredicate`) and state-only
 * (`defineStatePredicate`) authoring paths.
 */
export interface EdgeContext {
	manifest: import("./manifest.js").Manifest | undefined;
	state: Readonly<RunState>;
}

/**
 * Body-type alias for hand-rolled predicates. Internal — users wrap via
 * `definePredicate` / `defineStatePredicate`, which return an `EdgeFn`
 * (this alias plus a `.targets` field).
 */
type EdgePredicate = (ctx: EdgeContext) => string;

/**
 * A function that picks the next node name given current state + manifest.
 * Optional `targets` field lets graph introspectors enumerate possible
 * returns — `threshold` and other built-in predicate builders populate it.
 */
export type EdgeFn = EdgePredicate & { targets?: readonly string[] };

/**
 * Terminal edge sentinel. Single source of truth for the `"stop"` literal
 * embedded in `EdgeTarget`; `validate-workflow.ts` + `routing.ts` import this rather
 * than re-declaring the string.
 */
export const STOP = "stop" as const;

/**
 * What an `edges` entry resolves to: another node name (auto-edge), the
 * terminal sentinel `STOP`, or a function chosen at run-time.
 */
export type EdgeTarget = string | typeof STOP | EdgeFn;

/**
 * A node in the workflow graph. The node's identity is the surrounding
 * `Workflow.nodes` record key. `skill` is the Pi skill body to invoke —
 * defaulted to the record key by the runner when omitted, so the
 * authoring-time call site usually doesn't restate the name. Set `skill`
 * explicitly only when the node id and the Pi skill differ (aliased
 * nodes like `implement-after-revise` invoking the `implement` skill).
 *
 * Pi resolves the skill at run time; there's no allowlist gate. If Pi
 * can't load the skill, the runner halts with a clear error pointing
 * at this node.
 */
export interface NodeDef {
	skill?: string;
	completionStrategy: CompletionStrategy;
	sessionPolicy: SessionPolicy;
	extractor?: Extractor;
	outputSchema?: NodeSchema;
	inputSchema?: NodeSchema;
	onValidationFailure?: OnValidationFailure;
	maxValidationRetries?: number;
	validationRetryTimeoutMs?: number;
}

/**
 * A complete workflow. `name` is what users type as `/wf <name>`; `start`
 * is the entry node; `nodes` is the lexicon; `edges` is the wiring. Every
 * key in `edges` must exist in `nodes`; every string value must exist in
 * `nodes` or be `"stop"`. Validated at load time by `validate-workflow.ts`.
 */
export interface Workflow {
	name: string;
	description?: string;
	start: string;
	nodes: Record<string, NodeDef>;
	edges: Record<string, EdgeTarget>;
}

// ===========================================================================
// Factories — passthroughs with defaults
// ===========================================================================

/** Identity passthrough; reserved for future normalization / metadata hooks. */
export function defineWorkflow(spec: Workflow): Workflow {
	return spec;
}

/**
 * Artifact-emitting node: invokes a Pi skill that writes
 * `.rpiv/artifacts/<bucket>/<file>.md`. Defaults to fresh-session. The
 * skill body defaults to the surrounding `nodes` record key — override
 * via `{ skill: "<other>" }` only when the node id and the Pi skill
 * differ (e.g. `code-review-large` aliasing the `code-review` skill).
 */
export function artifact(overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		completionStrategy: "artifact-emit",
		sessionPolicy: "fresh",
		...overrides,
	};
}

/**
 * Action node: invokes a Pi skill whose side effect IS the work
 * (commit, implement). No artifact-emission check. Defaults to fresh-session.
 * Like `artifact`, the skill body defaults to the record key.
 */
export function action(overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		completionStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	};
}

// ===========================================================================
// Predicate builders — common patterns
// ===========================================================================

/**
 * Marker attached to EdgeFns that read from `manifest.data`.
 * `validate-workflow.ts:checkPredicateSchemas` warns when a node feeds a marked
 * predicate but has no `outputSchema` — routing on un-validated frontmatter
 * is the I6-class defect from the bcc34bc review.
 *
 * Default is "marked": `definePredicate` auto-marks. Hand-roll
 * `defineStatePredicate` for the rare predicate that consults only `state`
 * or `manifest.meta` — that's the opt-out path. The previous direction
 * (opt-in marker, default unmarked) silently exempted every user-authored
 * predicate from the lint.
 *
 * Exported as a `Symbol.for` so it survives `import` boundaries cleanly.
 */
export const READS_FRONTMATTER: unique symbol = Symbol.for("rpiv.workflow.readsFrontmatter");

/**
 * True iff `fn` was wrapped by `definePredicate` (which sets the
 * `READS_FRONTMATTER` marker). The validator uses this to decide whether an
 * `EdgeFn`'s source node must declare an `outputSchema` — frontmatter-reading
 * predicates need a validated manifest shape; state-only predicates don't.
 *
 * Centralises the double-cast required to symbol-key into a function object
 * so consumers don't sprinkle `as unknown as Record<symbol, …>` at every
 * read site.
 */
export function marksFrontmatter(fn: EdgeFn): boolean {
	return Boolean((fn as unknown as Record<symbol, boolean>)[READS_FRONTMATTER]);
}

/**
 * Shared body for `definePredicate` + `defineStatePredicate`. Validates the
 * `targets` invariant, attaches `.targets` to the function, and (when
 * `marker` is true) sets the `READS_FRONTMATTER` symbol so the load-time
 * predicate-schema lint can distinguish frontmatter-reading predicates
 * from state-only ones. `factory` is used only to brand the throw message
 * so the offending call site is obvious in stack traces.
 */
function wrapEdgeFn(factory: string, targets: readonly string[], fn: EdgePredicate, marker: boolean): EdgeFn {
	if (targets.length === 0) {
		throw new Error(`${factory}: targets must declare at least one possible return value`);
	}
	const wrapped = fn as EdgeFn;
	wrapped.targets = [...targets];
	if (marker) (wrapped as unknown as Record<symbol, boolean>)[READS_FRONTMATTER] = true;
	return wrapped;
}

/**
 * Promote a hand-rolled `EdgePredicate` to an `EdgeFn` by structurally
 * attaching the set of possible returns. `validate-workflow.ts` requires every
 * EdgeFn to carry `.targets` so reachability and load-time edge-target
 * checks see every branch; this factory is the only blessed way to author
 * a multi-branch predicate.
 *
 * Auto-marks the returned EdgeFn with `READS_FRONTMATTER` so the
 * predicate-schema lint fires when the source node has no `outputSchema`.
 * If the predicate consults only `state` / `manifest.meta` and never reads
 * `manifest.data`, use `defineStatePredicate` instead.
 *
 * Throws if `targets` is empty — a predicate that can't return anything
 * declared is by definition a bug.
 */
export function definePredicate(targets: readonly string[], fn: EdgePredicate): EdgeFn {
	return wrapEdgeFn("definePredicate", targets, fn, true);
}

/**
 * Like `definePredicate` but for predicates that consult only `state` or
 * `manifest.meta` and never read `manifest.data`. Omits the
 * `READS_FRONTMATTER` marker so `checkPredicateSchemas` doesn't warn the
 * source node lacks an `outputSchema` (a state-derived predicate has no
 * frontmatter-shape contract to validate).
 */
export function defineStatePredicate(targets: readonly string[], fn: EdgePredicate): EdgeFn {
	return wrapEdgeFn("defineStatePredicate", targets, fn, false);
}

/**
 * Internal body for `threshold`. Reads `manifest.data[field]`, coerces via
 * `Number(...)`, and picks `ifAbove` / `ifBelow` on strict greater-than. The
 * caller-facing missing-field policy lives in `threshold`'s JSDoc.
 */
const predicateThreshold =
	(field: string, n: number, ifAbove: string, ifBelow: string): EdgePredicate =>
	({ manifest }) => {
		const value = Number((manifest?.data as Record<string, unknown>)?.[field]);
		return value > n ? ifAbove : ifBelow;
	};

/**
 * Routes to `ifAbove` when `Number(manifest.data[field]) > n`; otherwise to
 * `ifBelow`. Built on `definePredicate` so the contract is enforced
 * structurally; the `READS_FRONTMATTER` marker is inherited from
 * `definePredicate`.
 *
 * Missing-field policy: `Number(undefined)` is `NaN`, and `NaN > anything` is
 * `false`. So a missing or non-numeric field always routes to `ifBelow` —
 * regardless of the threshold's sign. Negative thresholds therefore also
 * route missing fields to `ifBelow` (NaN compares false against any value).
 * This symmetry frees workflow authors from remembering per-factory coercion
 * rules; if a different missing-field default is needed, declare it
 * explicitly via `definePredicate`:
 *
 * ```ts
 * definePredicate(["a","b"], ({ manifest }) =>
 *   Number((manifest?.data as Record<string, unknown>)?.foo ?? -1) > 0 ? "a" : "b"
 * )
 * ```
 */
export function threshold(field: string, n: number, ifAbove: string, ifBelow: string): EdgeFn {
	return definePredicate([ifAbove, ifBelow], predicateThreshold(field, n, ifAbove, ifBelow));
}
