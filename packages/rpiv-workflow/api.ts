/**
 * Public authoring surface for rpiv workflows. Canonical entry point — users
 * import everything they need (`defineWorkflow`, `produces`, `acts`,
 * `definePredicate`, `defineStatePredicate`, `threshold`, `STOP`,
 * `marksFrontmatter`, schema adapters, plus the type vocabulary `Workflow`
 * / `StageDef` / `EdgeFn` / `EdgeTarget` / `EdgeContext`) from
 * `@juicesharp/rpiv-workflow`.
 *
 * A `Workflow` is a typed graph: a named entry point, a stage table, and an
 * edge table that maps each stage to either another stage name, the sentinel
 * `STOP`, or an `EdgeFn` that picks at runtime. Edges live INSIDE each
 * workflow.
 *
 * Factories are pure passthroughs that apply sane defaults. Same idiom as
 * `defineConfig` in Vite/Astro/Tailwind: zero runtime cost, exists solely
 * for type inference + uniform shape at the call site.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { OutputSpec } from "./manifest.js";
import type { RunState } from "./types.js";

export type { OutputSpec } from "./manifest.js";

/**
 * Schema attached to a stage's `outputSchema` / `inputSchema`. Structurally
 * a Standard Schema v1 (the converged interface implemented by Zod, Valibot,
 * ArkType, TypeBox, et al.) — re-exported under a name that doesn't leak the
 * spec version into our public surface. When the spec versions, this alias
 * picks the right one in a single line.
 *
 * Sync schemas are the default and the recommended shape for the 95% case
 * (pure shape contracts: `Type.Object({ … })`, `z.object({ … })`). Async
 * schemas are supported at both seams — the runner awaits `~standard.validate`
 * — and are the right answer when correctness needs I/O (filesystem probes,
 * registry lookups, async-by-default libs like ArkType). A hanging async
 * schema is bounded by the stage's `validateTimeoutMs`. See the
 * "Validators: sync vs async" section of the package README for the full
 * rationale.
 */
export type StageSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

// ===========================================================================
// Stage-shape primitives
// ===========================================================================

/**
 * - `"produces"` — protocol skills that write `.rpiv/artifacts/<bucket>/<file>.md`.
 *   The runner halts the chain if the path doesn't appear in the transcript.
 * - `"side-effect"` — action skills (commit, implement) where the side effect IS
 *   the work; the chain inherits the prior `currentPrimaryArtifact(state)`.
 *
 * The `as const` array is the single source of truth: the literal-union type
 * is derived via `(typeof ARRAY)[number]`, and `validate-workflow.ts` consumes
 * the same array for the runtime enum check. Adding a variant updates both
 * type-level and runtime arms in one edit.
 */
export const STAGE_KINDS = ["produces", "side-effect"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * - `"fresh"` — wraps the stage in `ctx.newSession({ withSession })`.
 * - `"continue"` — reuses the prior session via `host.sendUserMessage()` +
 *   `ctx.waitForIdle()`; branch sliced by `branchOffset`.
 */
export const SESSION_POLICIES = ["fresh", "continue"] as const;
export type SessionPolicy = (typeof SESSION_POLICIES)[number];

/**
 * What happens when a stage's `outputSchema` rejects the extracted manifest:
 * - `"retry"` — re-invoke the stage up to `maxRetries`, threading the
 *   schema's issues back to the agent via a retry prompt.
 * - `"halt"` — record a terminal failure on the first rejection.
 */
export const ON_INVALID_VALUES = ["retry", "halt"] as const;
export type OnInvalid = (typeof ON_INVALID_VALUES)[number];

/**
 * Opt-in fanout — a user-supplied function that decomposes a stage's work
 * into N units, one Pi session per unit. The runner owns iteration +
 * audit; the FanoutFn owns the convention (how units are detected, what
 * each session's prompt body says, how each is labelled).
 *
 * rpiv-workflow ships ZERO fanout conventions: no markdown regex, no
 * phase counter, no schema. A consumer wanting markdown-heading fanout
 * writes the ~10 lines themselves and reuses one constant across stages.
 *
 * Invariants enforced by the runner:
 * - Empty return ⇒ no fanout (fall through to the single-stage path).
 * - Throws ⇒ stage halts, attributed to this stage.
 * - `stage.sessionPolicy === "continue"` is incompatible with fanout
 *   (validated at load + at preflight).
 *
 * Cap policy: the runner does not bound `units.length`. Authors of bespoke
 * FanoutFns own their own safety bounds — same posture as
 * `maxBackwardJumps` (the only run-wide cap the runner enforces).
 */
export type FanoutFn = (ctx: FanoutContext) => readonly FanoutUnit[] | Promise<readonly FanoutUnit[]>;

export interface FanoutContext {
	cwd: string;
	/**
	 * Primary artifact inherited from the upstream stage (or undefined when
	 * the fanout stage is the entry point). FanoutFns that need to read an
	 * upstream artifact short-circuit to `[]` when undefined — the runner
	 * treats that as "no fanout" and runs the single-stage path. The
	 * handle's serialized form (path / URL / opaque id) is what most
	 * FanoutFns weave into their per-unit prompt body.
	 */
	artifact: import("./handle.js").Artifact | undefined;
	state: Readonly<RunState>;
}

export interface FanoutUnit {
	/**
	 * Body sent to the skill: the runner dispatches `/skill:<stage.skill>
	 * <prompt>` once per unit. The unit owns artifact-path threading + any
	 * per-unit cue — the runner adds nothing implicit.
	 */
	prompt: string;
	/**
	 * Short label woven into the status line + JSONL audit row.
	 * The audit `skill` field becomes `<stage.skill> (<label>)`; the status
	 * line shows `rpiv: stage X/Y — <stage.skill> (<label>)`. Keep it short
	 * and disambiguating (`"phase 2/5"`, `"task 3/8"`).
	 */
	label: string;
}

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
 * A function that picks the next stage name given current state + manifest.
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
 * What an `edges` entry resolves to: another stage name (auto-edge), the
 * terminal sentinel `STOP`, or a function chosen at run-time.
 */
export type EdgeTarget = string | typeof STOP | EdgeFn;

/**
 * A stage in the workflow graph. The stage's identity is the surrounding
 * `Workflow.stages` record key. `skill` is the Pi skill body to invoke —
 * defaulted to the record key by the runner when omitted, so the
 * authoring-time call site usually doesn't restate the name. Set `skill`
 * explicitly only when the stage id and the Pi skill differ (aliased
 * stages like `implement-after-revise` invoking the `implement` skill).
 *
 * Pi resolves the skill at run time; there's no allowlist gate. If Pi
 * can't load the skill, the runner halts with a clear error pointing
 * at this stage.
 */
export interface StageDef<TIn = unknown, TOut = unknown> {
	skill?: string;
	kind: StageKind;
	sessionPolicy: SessionPolicy;
	outcome?: OutputSpec;
	/**
	 * Standard Schema v1 validator run against `manifest.data` after the
	 * stage's `OutputSpec` produces it (the typed record parsed out of the
	 * agent's emitted artifact). On rejection the runner honours
	 * `onInvalid` ("retry" by default, up to `maxRetries`; "halt" to fail
	 * fast).
	 */
	outputSchema?: StageSchema<unknown, TOut>;
	/**
	 * Standard Schema v1 validator run against the inherited upstream
	 * `manifest.data` before the stage runs. A rejection halts the
	 * chain immediately (no retry path — the upstream stage is already
	 * frozen).
	 */
	inputSchema?: StageSchema<unknown, TIn>;
	onInvalid?: OnInvalid;
	maxRetries?: number;
	validateTimeoutMs?: number;
	/**
	 * Opt-in fanout. When set, the runner invokes the function with a
	 * `FanoutContext`, awaits the returned units, and runs one Pi session
	 * per unit (single-stage path when the array is empty). Incompatible
	 * with `sessionPolicy: "continue"` — fanout requires per-unit session
	 * isolation.
	 */
	fanout?: FanoutFn;
}

/**
 * A complete workflow. `name` is what users type as `/wf <name>`; `start`
 * is the entry stage; `stages` is the lexicon; `edges` is the wiring. Every
 * key in `edges` must exist in `stages`; every string value must exist in
 * `stages` or be `"stop"`. Validated at load time by `validate-workflow.ts`.
 */
export interface Workflow {
	name: string;
	description?: string;
	start: string;
	stages: Record<string, StageDef>;
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
 * Artifact-producing stage: invokes a Pi skill that writes
 * `.rpiv/artifacts/<bucket>/<file>.md`. Defaults to fresh-session. The
 * skill body defaults to the surrounding `stages` record key — override
 * via `{ skill: "<other>" }` only when the stage id and the Pi skill
 * differ (e.g. `code-review-large` aliasing the `code-review` skill).
 */
export function produces(overrides: Partial<StageDef> = {}): StageDef {
	return {
		kind: "produces",
		sessionPolicy: "fresh",
		...overrides,
	};
}

/**
 * Side-effect stage: invokes a Pi skill whose side effect IS the work
 * (commit, implement). No artifact-emission check. Defaults to fresh-session.
 * Like `produces`, the skill body defaults to the record key.
 */
export function acts(overrides: Partial<StageDef> = {}): StageDef {
	return {
		kind: "side-effect",
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
