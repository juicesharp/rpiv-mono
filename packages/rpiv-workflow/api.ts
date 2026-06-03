/**
 * Public authoring surface for rpiv workflows. Canonical entry point — users
 * import everything they need (`defineWorkflow`, `produces`, `acts`,
 * `defineRoute`, `gate`, `STOP`, `marksReadsData`, schema adapters, plus the
 * type vocabulary `Workflow` / `StageDef` / `EdgeFn` / `EdgeTarget` /
 * `EdgeContext`) from `@juicesharp/rpiv-workflow`.
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
import type { Output, OutputSpec } from "./output.js";
import type { Predicate } from "./predicates.js";
import type { RunState } from "./types.js";

export type { OutputSpec } from "./output.js";

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
 * What happens when a stage's `outputSchema` rejects the extracted output:
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
	 * The audit `skill` field becomes `<stage.skill> (<id ?? label>)`;
	 * the status line shows `rpiv: stage X/Y — <stage.skill> (<label>)`.
	 * Keep it short and disambiguating (`"phase 2/5"`, `"task 3/8"`).
	 */
	label: string;
	/**
	 * Optional stable identifier used in the JSONL audit row in place of
	 * `label`. Set this when `label` is a human-facing display string that
	 * may be reworded — `id` keeps the audit projection stable across
	 * label edits and matches the pattern post-hoc tooling joins on
	 * (`"phase-2"`, `"task-3"`). Omit to fall back to `label`.
	 */
	id?: string;
}

/**
 * Opt-in iteration — the sequential, accumulating counterpart to `FanoutFn`.
 * Where `fanout` computes all units up front and runs them blind to one
 * another, `iterate` is invoked once per unit (pull model), each call
 * receiving the validated `Output`s of every prior unit in this stage. Return
 * the next unit, or `null`/`undefined` to terminate the stage.
 *
 * Each unit runs the stage's `outcome` collector like a one-shot `produces`
 * stage: it validates against `outputSchema`, appends its `Output` to
 * `state.named[outcome.name]`, and rolls the primary artifact forward.
 *
 * Invariants enforced by the runner:
 * - First call returns null  ⇒ stage completes as a zero-unit no-op (advances).
 * - Throws                   ⇒ stage halts, attributed to this stage.
 * - `accumulated.length` reaching the run-wide `maxIterations` cap ⇒ stage
 *   halts with a terminal failure (the backstop for a generator that never
 *   returns null).
 * - Requires `kind: "produces"` + an `outcome` with a `name`; incompatible
 *   with `sessionPolicy: "continue"` and with `fanout`/`run` (validated at
 *   load + at preflight).
 */
export type IterateFn = (ctx: IterateContext) => IterateUnit | null | Promise<IterateUnit | null>;

export interface IterateContext {
	cwd: string;
	/**
	 * Stage-entry primary artifact, FROZEN across every unit. Does not roll
	 * forward to the prior unit's output — use `accumulated` (or `state.named`)
	 * for that. Undefined when the iterate stage is the entry point.
	 *
	 * On a corrective back-edge re-entry the rolling primary may be a
	 * downstream doc; generators that must re-read their true source should
	 * read it from `state.named` rather than relying on this slot.
	 */
	artifact: import("./handle.js").Artifact | undefined;
	state: Readonly<RunState>;
	/** Validated Outputs of this stage's already-completed units, in order. */
	accumulated: readonly import("./output.js").Output[];
	/** 0-based index of the unit about to run (== accumulated.length). */
	index: number;
}

/** Same shape as `FanoutUnit` (prompt + label + optional stable id). */
export type IterateUnit = FanoutUnit;

// ===========================================================================
// Script-stage primitives — skillless TS functions in place of `/skill:<x>`
// ===========================================================================

/**
 * Context handed to a script stage's `run` function. Shape mirrors
 * `EdgeContext` / `FanoutContext`: frozen identity (`cwd`) + the chain
 * data the function needs (`input` — upstream Output envelope) + a
 * read-only state snapshot.
 *
 * Script stages cannot fanout, cannot use `sessionPolicy: "continue"`,
 * and do not receive a Pi `WorkflowHostContext` — they're pure TS calls.
 */
export interface ScriptContext {
	cwd: string;
	/**
	 * Inherited upstream `Output` envelope. `undefined` when the script
	 * stage is the entry point, or when the upstream stage cleared the
	 * rolling primary slot (a `terminal()` ahead of it).
	 */
	input: Output | undefined;
	state: Readonly<RunState>;
}

/**
 * Script `produces` stage body — returns the `Output` envelope's
 * value-channel fields (`kind` + `artifacts` + `data`) directly. The
 * runner stamps `meta` (stage, stageNumber, ts, runId) — same posture
 * as how `ArtifactParser`s return `{ kind, data }` and `finalizeOutput`
 * fills the meta in.
 */
export type ProducesScriptFn<K extends string = string, D = unknown> = (
	ctx: ScriptContext,
) => Omit<Output<K, D>, "meta"> | Promise<Omit<Output<K, D>, "meta">>;

/**
 * Script `acts` / `terminal` stage body — returns nothing. The runner
 * builds a `SideEffectOutput`-shaped envelope (kind `"side-effect"`,
 * empty `data`) so audit + downstream chain wiring still uniform.
 */
export type ActsScriptFn = (ctx: ScriptContext) => void | Promise<void>;

/**
 * Raw-prompt dispatch body — the third dispatch alongside `skill`
 * (`/skill:<name> <args>`) and script `run` (pure TS, no model). Returns the
 * COMPLETE user message sent into the stage's session: no `/skill:` prefix and
 * no implicit upstream-artifact arg appended. The dynamic form receives the
 * same `ScriptContext` script stages get, so a prompt can weave in the upstream
 * `Output` (`ctx.input`) or the named registry (`ctx.state.named`):
 *
 *   acts({ prompt: "Implement the design spec discussed above.", sessionPolicy: "continue" })
 *   produces({ prompt: ({ input }) =>
 *     `Summarise ${handleToString(input!.artifacts[0]!.handle)} in 3 bullets.`, outcome })
 *
 * A plain `string` is sugar for `() => string`. Unlike a skill stage, a prompt
 * stage skips the skill-registry preflight (there is no skill to register).
 * Mutually exclusive with `skill` (explicit), `run`, `reads`, and — in v1 —
 * `fanout`/`iterate`. Composes with `kind` (a `produces` prompt stage runs the
 * `outcome` collector and publishes; a `side-effect` prompt stage just talks)
 * and `sessionPolicy` (`continue` = a follow-up turn on a session a prior stage
 * populated). (validated at load + preflight.)
 */
export type PromptFn = (ctx: ScriptContext) => string | Promise<string>;

// ===========================================================================
// Types
// ===========================================================================

/**
 * Runtime context handed to an `EdgeFn`. The sole context shape for both
 * data-reading and state-only routes (the single `defineRoute` path covers
 * both via `opts.readsData`).
 */
export interface EdgeContext {
	output: import("./output.js").Output | undefined;
	state: Readonly<RunState>;
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
	 * Standard Schema v1 validator run against `output.data` after the
	 * stage's `OutputSpec` produces it (the typed record parsed out of the
	 * agent's emitted artifact). On rejection the runner honours
	 * `onInvalid` ("retry" by default, up to `maxRetries`; "halt" to fail
	 * fast).
	 */
	outputSchema?: StageSchema<unknown, TOut>;
	/**
	 * Standard Schema v1 validator run against the inherited upstream
	 * `output.data` before the stage runs. A rejection halts the
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
	/**
	 * Opt-in sequential accumulation — the dual of `fanout`. When set, the
	 * runner pulls units one at a time, feeding each generator call the prior
	 * units' `Output`s; every unit runs the stage's `outcome` like a one-shot
	 * `produces` stage and accumulates into `state.named[outcome.name]`.
	 *
	 * Mutually exclusive with `fanout` and `run`. Requires `kind: "produces"`,
	 * an `outcome` with a `name`, and `sessionPolicy` other than `"continue"`.
	 * (validated at load + at preflight.)
	 */
	iterate?: IterateFn;
	/**
	 * Whether the stage inherits the chain's primary artifact from
	 * upstream `produces` stages. Default `true`. Set to `false` on a
	 * terminal side-effect — the stage's prompt receives `originalInput`
	 * instead of the upstream artifact handle, the `ensureUpstreamArtifact`
	 * preflight is bypassed, and the rolling primary slot is cleared on
	 * success so any stage following also starts without an inherited
	 * artifact.
	 *
	 * Authored via the `terminal()` factory; the flag is the underlying
	 * mechanism. Meaningless on `kind: "produces"` stages (they emit their
	 * own outcome) — `validateWorkflow` warns when set there.
	 */
	inheritsArtifacts?: boolean;
	/**
	 * Skillless script stage: when present, the runner calls this
	 * function instead of dispatching `/skill:<skill>`. Presence of
	 * `run` is the skill-vs-script discriminator. Authored via
	 * `produces.script(...)`, `acts.script(...)`, or
	 * `terminal.script(...)`.
	 *
	 * Stages with `run` set CANNOT also set `skill`, `outcome`,
	 * `fanout`, or `sessionPolicy: "continue"` — rejected at load time
	 * by `validateWorkflow`.
	 */
	run?: ProducesScriptFn<string, TOut> | ActsScriptFn;
	/**
	 * Raw-prompt dispatch: when set, the runner sends this text (resolved per
	 * the `PromptFn`, or the literal string) into the stage's session instead
	 * of `/skill:<skill>`. The stage runs the model with no skill body and no
	 * skill-registry check. Presence of `prompt` is the third dispatch
	 * discriminator alongside `run`.
	 *
	 * Mutually exclusive with `skill` (explicit), `run`, `reads`, and — in v1 —
	 * `fanout`/`iterate`. Composes with `kind` and `sessionPolicy`. (validated
	 * at load + preflight.)
	 */
	prompt?: string | PromptFn;
	/**
	 * Names this stage consumes from `state.named` to build its prompt.
	 * When set, the runner replaces the default single-artifact prompt
	 * (`/skill:<name> <handle>`) with a labelled-flag form
	 * (`/skill:<name> --<n1> <h1> --<n2> <h2> …`), reading the most recent
	 * `Output` each name has accumulated and iterating its `artifacts` list.
	 * Empty (or unset) → default prompt behaviour preserved.
	 *
	 * Names address `state.named` slots, which are keyed by
	 * `stage.outcome?.name ?? stage.<record-key>`. Every name in `reads:`
	 * must be filled by some upstream stage's produces success (validated
	 * at load time by `validateWorkflow`; the `ensureNamedReads` preflight
	 * catches the "haven't reached the producer yet" case at runtime).
	 */
	reads?: ReadonlyArray<string>;
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
 * Options accepted by `produces.script({ run, ... })`. Subset of the
 * skill-stage `StageDef` knobs that semantically apply to a pure TS
 * function: validation (`inputSchema` / `outputSchema` + retry knobs)
 * and artifact-inheritance opt-out. `kind` and `sessionPolicy` are not
 * configurable — script stages are always `"produces"` + `"fresh"`.
 * `skill`, `outcome`, and `fanout` are unauthorisable here.
 */
interface ProducesScriptOptions<TIn = unknown, TOut = unknown> {
	run: ProducesScriptFn<string, TOut>;
	outputSchema?: StageSchema<unknown, TOut>;
	inputSchema?: StageSchema<unknown, TIn>;
	onInvalid?: OnInvalid;
	maxRetries?: number;
	validateTimeoutMs?: number;
	inheritsArtifacts?: boolean;
	reads?: ReadonlyArray<string>;
}

/**
 * Options accepted by `acts.script({ run, ... })` and
 * `terminal.script({ run, ... })`. Validation surface is narrower than
 * the produces variant: side-effect stages have no `outputSchema`
 * (they emit no data envelope), so the retry knobs don't apply.
 */
interface ActsScriptOptions<TIn = unknown> {
	run: ActsScriptFn;
	inputSchema?: StageSchema<unknown, TIn>;
	inheritsArtifacts?: boolean;
	reads?: ReadonlyArray<string>;
}

/**
 * Options accepted by `produces.prompt({ prompt, outcome, ... })` — the typed
 * builder for a raw-prompt `produces` stage. The dispatch-conflicting fields
 * (`skill`, `run`, `fanout`, `iterate`, `reads`) are STRUCTURALLY ABSENT, so an
 * object-literal call site that sets one fails TypeScript's excess-property
 * check — the load-time exclusion becomes compile-time for the idiomatic path.
 * `outcome` is required (a `produces` stage always needs one).
 */
interface ProducesPromptOptions<TIn = unknown, TOut = unknown> {
	prompt: string | PromptFn;
	outcome: OutputSpec;
	outputSchema?: StageSchema<unknown, TOut>;
	inputSchema?: StageSchema<unknown, TIn>;
	onInvalid?: OnInvalid;
	maxRetries?: number;
	validateTimeoutMs?: number;
	/** `"continue"` makes this a follow-up turn on a session a prior stage populated. */
	sessionPolicy?: SessionPolicy;
}

/**
 * Options accepted by `acts.prompt({ prompt, ... })` — the typed builder for a
 * raw-prompt side-effect stage (a pure chat turn). Narrower than the produces
 * variant: no `outcome` (nothing collected). Dispatch-conflicting fields are
 * structurally absent. For a collecting side-effect prompt stage, use the bare
 * `acts({ prompt, outcome })` field form instead.
 */
interface ActsPromptOptions<TIn = unknown> {
	prompt: string | PromptFn;
	inputSchema?: StageSchema<unknown, TIn>;
	/** `"continue"` makes this a follow-up turn on a session a prior stage populated. */
	sessionPolicy?: SessionPolicy;
}

function producesFn(overrides: Partial<StageDef> = {}): StageDef {
	return {
		kind: "produces",
		sessionPolicy: "fresh",
		...overrides,
	};
}

function producesScript<TIn = unknown, TOut = unknown>(opts: ProducesScriptOptions<TIn, TOut>): StageDef<TIn, TOut> {
	return {
		kind: "produces",
		sessionPolicy: "fresh",
		run: opts.run as ProducesScriptFn<string, TOut>,
		outputSchema: opts.outputSchema,
		inputSchema: opts.inputSchema,
		onInvalid: opts.onInvalid,
		maxRetries: opts.maxRetries,
		validateTimeoutMs: opts.validateTimeoutMs,
		inheritsArtifacts: opts.inheritsArtifacts,
		reads: opts.reads,
	};
}

function producesPrompt<TIn = unknown, TOut = unknown>(opts: ProducesPromptOptions<TIn, TOut>): StageDef<TIn, TOut> {
	return {
		kind: "produces",
		sessionPolicy: opts.sessionPolicy ?? "fresh",
		prompt: opts.prompt,
		outcome: opts.outcome,
		outputSchema: opts.outputSchema,
		inputSchema: opts.inputSchema,
		onInvalid: opts.onInvalid,
		maxRetries: opts.maxRetries,
		validateTimeoutMs: opts.validateTimeoutMs,
	};
}

function actsFn(overrides: Partial<StageDef> = {}): StageDef {
	return {
		kind: "side-effect",
		sessionPolicy: "fresh",
		...overrides,
	};
}

function actsPrompt<TIn = unknown>(opts: ActsPromptOptions<TIn>): StageDef<TIn, void> {
	return {
		kind: "side-effect",
		sessionPolicy: opts.sessionPolicy ?? "fresh",
		prompt: opts.prompt,
		inputSchema: opts.inputSchema,
	};
}

function actsScript<TIn = unknown>(opts: ActsScriptOptions<TIn>): StageDef<TIn, void> {
	return {
		kind: "side-effect",
		sessionPolicy: "fresh",
		run: opts.run,
		inputSchema: opts.inputSchema,
		inheritsArtifacts: opts.inheritsArtifacts,
		reads: opts.reads,
	};
}

function terminalFn(overrides: Partial<StageDef> = {}): StageDef {
	return actsFn({ ...overrides, inheritsArtifacts: false });
}

function terminalScript<TIn = unknown>(opts: ActsScriptOptions<TIn>): StageDef<TIn, void> {
	return actsScript({ ...opts, inheritsArtifacts: false });
}

/**
 * Artifact-producing stage: invokes a Pi skill that writes
 * `.rpiv/artifacts/<bucket>/<file>.md`. Defaults to fresh-session. The
 * skill body defaults to the surrounding `stages` record key — override
 * via `{ skill: "<other>" }` only when the stage id and the Pi skill
 * differ (e.g. a stage keyed `design-after-review` aliasing the
 * `design` skill so it can appear twice in the same workflow's edge graph).
 *
 * Skillless variant: `produces.script({ run, outputSchema?, ... })` runs
 * a pure TS function in place of a Pi skill body. The function returns
 * the `Output<K, D>` envelope directly.
 *
 * Raw-prompt variant: `produces.prompt({ prompt, outcome, ... })` dispatches
 * author-owned text (no `/skill:` prefix) and collects the reply via `outcome`.
 * The typed options omit the dispatch-conflicting fields so invalid combos are
 * un-typable on a literal call site.
 */
export const produces = Object.assign(producesFn, { script: producesScript, prompt: producesPrompt });

/**
 * Side-effect stage: invokes a Pi skill whose side effect IS the work
 * (commit, implement). No artifact-emission check. Defaults to fresh-session.
 * Like `produces`, the skill body defaults to the record key.
 *
 * Skillless variant: `acts.script({ run, ... })` runs a pure TS
 * function in place of a Pi skill body; the runner synthesises a
 * `SideEffectOutput` envelope so the chain stays uniform.
 *
 * Raw-prompt variant: `acts.prompt({ prompt, sessionPolicy? })` dispatches
 * author-owned text as a pure chat turn (no artifact collected) — the typed
 * builder for the continue follow-up shape.
 */
export const acts = Object.assign(actsFn, { script: actsScript, prompt: actsPrompt });

/**
 * Terminal side-effect stage: an `acts`-shaped stage that does NOT inherit
 * the upstream primary artifact. The stage's prompt receives the run's
 * `originalInput` instead of an upstream artifact handle; the
 * `ensureUpstreamArtifact` preflight is bypassed; and the rolling primary
 * slot is cleared on success so anything downstream also starts without an
 * inherited handle.
 *
 * Sibling to `produces()` / `acts()`. The right answer when a final stage
 * (cleanup, summary, post-run notification) shouldn't be coupled to the
 * upstream chain's artifact.
 *
 * Desugars to `acts({ ...overrides, inheritsArtifacts: false })`. The
 * skillless variant `terminal.script({ run, ... })` desugars to
 * `acts.script({ ...opts, inheritsArtifacts: false })`.
 */
export const terminal = Object.assign(terminalFn, { script: terminalScript });

// ===========================================================================
// Route builders — common patterns
// ===========================================================================

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
	const wrapped = fn as EdgeFn;
	wrapped.targets = [...targets];
	if (opts?.readsData !== false) (wrapped as unknown as Record<symbol, boolean>)[READS_DATA] = true;
	return wrapped;
}

/**
 * Conditional routing keyed on a numeric field in `output.data`. Each
 * branch's predicate is evaluated against `Number(output.data[field])` in
 * declaration order; the first matching branch wins. If no predicate
 * matches, the last declared branch is the fallback — same posture as the
 * prior `threshold` builder, which routed missing/non-numeric fields to its
 * `ifBelow` branch by virtue of `NaN > anything === false`.
 *
 * ```ts
 * gate("blockers_count", { revise: gt(0), commit: eq(0) })
 * // value > 0  → "revise"
 * // value = 0  → "commit"
 * // value < 0  → "commit" (no match, falls to last)
 * // missing/NaN → "commit" (no match, falls to last)
 * ```
 *
 * Built on `defineRoute` so the `.targets` metadata is attached structurally
 * and the `READS_DATA` marker auto-applies (routing reads `output.data`).
 */
export function gate(field: string, branches: Record<string, Predicate>): EdgeFn {
	const targets = Object.keys(branches);
	if (targets.length === 0) {
		throw new Error("gate: branches must declare at least one possible return value");
	}
	const fallback = targets[targets.length - 1]!;
	return defineRoute(targets, ({ output }) => {
		const value = Number((output?.data as Record<string, unknown> | undefined)?.[field]);
		for (const target of targets) {
			if (branches[target]!(value)) return target;
		}
		return fallback;
	});
}
