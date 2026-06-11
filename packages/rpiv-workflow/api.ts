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
import type { Output, RunView } from "./output.js";
import type { Outcome } from "./output-spec.js";
import type { NumericPredicate } from "./predicates.js";

export type { Outcome } from "./output-spec.js";

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

// ===========================================================================
// Loop vocabulary — the data shapes behind StageDef.loop
// (constructors live in control-flow.ts: fanout() / iterate() / assess())
// ===========================================================================

/**
 * One unit of loop work — the single unit type for all three loop kinds.
 * `prompt` is the body sent to the skill; `label` is the human display tag
 * woven into the status line, the per-unit toast, and the decorated row
 * display; `id` is the stable audit identity written to the row's `unitId`
 * field (falls back to `label`). Post-hoc tooling and the resume drift guard
 * join on `id ?? label` — set `id` when `label` may be reworded.
 */
export interface Unit {
	prompt: string;
	label: string;
	id?: string;
}

/**
 * Push-model unit source: all units computed up front, each run blind to the
 * others. Empty return ⇒ no loop (fall through to the single-stage path).
 * Throws ⇒ stage halts, attributed to this stage (a thrown
 * `StagePreflightError` keeps its own attribution — the `haltPreflight`
 * consumer contract).
 */
export type FanoutFn = (ctx: FanoutContext) => readonly Unit[] | Promise<readonly Unit[]>;

export interface FanoutContext {
	cwd: string;
	/** Primary artifact inherited from upstream (undefined when the loop stage is the entry point). */
	artifact: import("./handle.js").Artifact | undefined;
	state: RunView;
}

/**
 * Pull-model unit source: invoked once per unit, each call receiving the
 * validated `Output`s of every prior unit in this generation. Return the next
 * unit, or `null`/`undefined` to terminate the loop.
 *
 * RESUME CONTRACT (all loop kinds): the unit source must be deterministic
 * w.r.t. the fold-replayed `RunState` at the unit boundary + this
 * generation's accumulated outputs. The resume fold re-calls it at every
 * folded boundary and refuses on drift.
 */
export type IterateFn = (ctx: IterateContext) => Unit | null | Promise<Unit | null>;

export interface IterateContext {
	cwd: string;
	/** Stage-entry primary, FROZEN across every unit (never rolls forward). */
	artifact: import("./handle.js").Artifact | undefined;
	state: RunView;
	/** Validated Outputs of this generation's completed units, in order. */
	accumulated: readonly import("./output.js").Output[];
	/** 0-based index of the unit about to run (== accumulated.length). */
	index: number;
}

/** Context handed to `AssessLoop.feedForward` and `VerifySpec.feedForward`. */
export interface FeedForwardContext {
	cwd: string;
	/** Producer output just judged. */
	output: import("./output.js").Output;
	/** Judge verdict (incl. feedback). */
	verdict: import("./output.js").Output;
	/** 0-based round index of the round just judged (== the attempt index for verify). */
	round: number;
	state: RunView;
}

/**
 * The shared "repeat under a model judge" vocabulary — ONE set of field names
 * for the two judged-repetition shapes (`AssessLoop` rounds, `VerifySpec`
 * attempts). The runtime already admits they're one concept (verify desugars
 * to a degenerate assess loop); this base keeps their vocabularies from
 * drifting again (`pass`/`done`, `maxAttempts`/`max` were two spellings of
 * the same two knobs).
 */
export interface JudgedRepetition {
	judge: import("./judge.js").Judge;
	/**
	 * Sync TS reading the model-made verdict. `true` → the repetition stops
	 * and the chain advances with the last producer pair. RESUME CONTRACT:
	 * recomputed on resume (never persisted) — must be deterministic w.r.t.
	 * the verdict `Output`. A `true` on the final round/attempt is a normal
	 * completion (the predicate wins over the cap).
	 */
	done: (verdict: import("./output.js").Output) => boolean;
	/**
	 * Builds the next round/attempt's prompt arg from the just-judged
	 * producer output + verdict. On a prompt-dispatch stage the returned
	 * string is the COMPLETE retry message (sent raw — there is no skill to
	 * prefix an arg onto).
	 */
	feedForward?: (ctx: FeedForwardContext) => string;
	/** Repetition cap. Integer >= 1; clamped by `run.maxIterations` at runtime. */
	max?: number;
}

/**
 * Per-stage post-condition judge — the data shape behind `StageDef.verify`.
 * After each attempt of the stage completes (collected, validated, persisted),
 * the judge session grades the attempt's primary artifact; `done(verdict)`
 * true → verified, the chain advances with the attempt's producer pair;
 * false → a fresh retry attempt (prompt arg built by `feedForward`) up to
 * `max` attempts, then a terminal "verification failed" halt. Author via the
 * `verify()` constructor (control-flow.ts), which validates at construction;
 * load-time validation re-checks hand-rolled literals through the same
 * `verifyShapeIssues` rule source.
 *
 * Field semantics on top of the shared `JudgedRepetition` vocabulary:
 *  - `done` — the pass predicate (`true` = verified).
 *  - `max` — total attempt budget; each attempt is a FRESH session running
 *    the full produce→validate→persist cycle. Orthogonal to
 *    `stage.maxRetries` (the cheap in-session schema-fix budget, which stays
 *    live inside every attempt). Default 1 (gate-only).
 *  - `feedForward` — REQUIRED when `max > 1` (without it the retried prompt
 *    would be byte-identical to the original and the model would have no
 *    signal about why it failed); never called when `max` is 1.
 *
 * Runtime: the runner desugars the field into a degenerate assess loop
 * (`max: max ?? 1`, `onCap: "halt"`, `result: "last"`) run by the ONE loop
 * driver. Attempts and verdicts land as unit rows (`role: "produce"` /
 * `role: "verify"`, `unitIndex` = 0-based attempt); the verdict publishes
 * durably to `state.named[judge.outcome.name]` (so declarative fallback
 * routing over `EdgeContext.state.named` works); and `projectResult`
 * restores the last attempt's producer pair before the chain advances —
 * downstream stages never inherit the verdict.
 */
export type VerifySpec = JudgedRepetition;

/**
 * Role a unit row/event carries. Every main-work unit — fanout unit, iterate
 * unit, assess producer, verify attempt — is `"produce"`; assess judge
 * sub-steps are `"judge"`; verify verdict sub-steps are `"verify"`. The
 * `result: "last"` projection and the resume fold's apply rule key on this.
 */
export type UnitRole = "produce" | "judge" | "verify";

/**
 * What happens when a loop hits its effective cap (`min(max, run.maxIterations)`):
 * `"halt"` — terminal failure (mirrors the backward-jump guard);
 * `"advance"` — soft-stop: warn, land a `{type:"loop-cap"}` telemetry row,
 * fire `onLoopCap`, keep the projected result, advance downstream.
 */
export type CapPolicy = "halt" | "advance";

/**
 * What the loop leaves in `{state.output, state.primaryArtifact}` — the PAIR
 * is governed as one (routing + downstream prompts read both):
 * `"entry"` — restore the pair captured at loop entry (fanout default;
 *             reproduces routing-sees-upstream);
 * `"last"`  — the last completed `role: "produce"` unit's pair (iterate /
 *             assess default; zero produce units degrades to entry).
 * Applied at ONE point — loop advance — by the live driver and the resume
 * fold's generation close identically. Mid-loop transient rolls are accepted.
 */
export type ResultProjection = "entry" | "last";

/**
 * How a stage's work is split into units, AS DATA (moved from control-flow.ts;
 * shape unchanged). The framework never interprets `by`/`pattern` — they're
 * introspection hints for agents and the `checkFanoutSource` lint.
 */
export interface UnitSelector {
	by: string;
	pattern?: string;
	meta?: Record<string, unknown>;
}

/** Introspectable data common to all three loop kinds. */
interface LoopCommon {
	/** The named channel the units are split FROM (a `consumes` signal). */
	source?: string;
	/** How units are detected (opaque convention). */
	unit?: UnitSelector;
	/** Cardinality ceiling; clamped by `run.maxIterations` at runtime. */
	max?: number;
	onCap: CapPolicy;
	result: ResultProjection;
}

/** Parallel-shaped push loop (units still run sequentially today). */
export interface FanoutLoop extends LoopCommon {
	kind: "fanout";
	units: FanoutFn;
}

/** Sequential accumulating pull loop. */
export interface IterateLoop extends LoopCommon {
	kind: "iterate";
	next: IterateFn;
}

/**
 * Model-judged until-done loop: producer→judge rounds. Shares the
 * `JudgedRepetition` vocabulary with `VerifySpec`; here `max` (the round cap)
 * and `feedForward` are REQUIRED — the `assess()` constructor defaults `max`
 * to 8 and rejects a missing `feedForward`.
 */
export interface AssessLoop extends LoopCommon, JudgedRepetition {
	kind: "assess";
	/** Round cap — REQUIRED here (the `assess()` constructor defaults it to 8). */
	max: number;
	/** Builds the next producer prompt arg from the just-judged round's pair. */
	feedForward: (ctx: FeedForwardContext) => string;
}

/**
 * The single loop field's value — a DATA object with function-valued fields,
 * introspectable by construction (project with `loopSpecOf`). Author via the
 * `fanout()` / `iterate()` / `assess()` constructors (control-flow.ts), which
 * validate at construction and fill kind-specific defaults.
 */
export type LoopDef = FanoutLoop | IterateLoop | AssessLoop;

/**
 * Runtime enumeration of `LoopDef["kind"]` — exported from where `LoopDef`
 * lives so the validator (kind whitelist) and the per-kind strategy table
 * (loop-kinds.ts) consume one list. The `satisfies` pin rejects a stray
 * member; completeness is enforced by the strategy table's
 * `Record<LoopDef["kind"], …>` shape (a new union arm fails compilation
 * there first).
 */
export const LOOP_KINDS = ["fanout", "iterate", "assess"] as const satisfies readonly LoopDef["kind"][];

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
	state: RunView;
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
 * Mutually exclusive with `skill` (explicit), `run`, `reads`, and
 * `fanout`/`iterate` loops (units own their prompts). Composes with `kind` (a
 * `produces` prompt stage runs the `outcome` collector and publishes; a
 * `side-effect` prompt stage just talks), with `sessionPolicy` (`continue` = a
 * follow-up turn on a session a prior stage populated), and with `assess`
 * loops / `verify` — the prompt is round/attempt 0's message; `feedForward`
 * builds each retry's complete message. (validated at load + preflight.)
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
 *
 * TYPING MODEL (T2): `<TIn, TOut>` are LOCAL inference helpers — they tie a
 * factory call's `inputSchema`/`outputSchema`/`run` together, then erase at
 * the `Workflow.stages` boundary (`Record<string, StageDef>`). They do NOT
 * carry types across edges; inter-stage typing is runtime-contract-based
 * (schemas validate `output.data` at run time, skill contracts adjudicate
 * composition at load). A typed builder API is a roadmap item.
 */
export interface StageDef<TIn = unknown, TOut = unknown> {
	skill?: string;
	kind: StageKind;
	sessionPolicy: SessionPolicy;
	outcome?: Outcome;
	/**
	 * Standard Schema v1 validator run against `output.data` after the
	 * stage's `Outcome` produces it (the typed record parsed out of the
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
	 * Opt-in unit loop. When set, the runner expands this stage into one Pi
	 * session per unit through ONE driver (`loop.ts`); the constructor picked
	 * the kind:
	 *   - `fanout({...})`  — push: all units precomputed; `produces` kind =
	 *     collecting units (full collect→validate→publish, `outcome.name`
	 *     required); `acts` kind = side-effect units.
	 *   - `iterate({...})` — pull: one unit per call, accumulating; requires
	 *     `kind: "produces"` + `outcome.name`.
	 *   - `assess({...})`  — producer→judge rounds; requires `kind: "produces"`
	 *     + `outcome.name` (the producer is a collecting unit too).
	 * Mutually exclusive with `run` and `sessionPolicy: "continue"`; `prompt`
	 * composes with `assess` only (round 0 = the resolved prompt; retries =
	 * `feedForward` raw) — fanout/iterate units own their prompts. (validated
	 * at load + at preflight.)
	 */
	loop?: LoopDef;
	/**
	 * Opt-in post-condition judge. When set, the runner desugars this stage
	 * into a degenerate assess loop (attempt → verify rounds through the ONE
	 * driver, loop.ts): each attempt is graded by `verify.judge`;
	 * `verify.done(verdict)` gates advancement; failures retry with
	 * `verify.feedForward` feedback up to `verify.max` attempts, then halt
	 * with "verification failed". Author via the `verify()` constructor.
	 *
	 * Lifecycle follows LOOP semantics: `onLoopStart` fires with
	 * `kind: "verify"`, attempts/verdicts fire `onUnitStart`/`onUnitEnd`, and
	 * the stage does NOT fire `onStageEnd` (same contract as every loop
	 * stage). The verdict publishes to `state.named[verify.judge.outcome.name]`.
	 *
	 * Requires `kind: "produces"` (the judge grades the attempt's artifact).
	 * Composes with `reads` and with `prompt` dispatch (attempt 0 sends the
	 * stage's resolved `prompt`; retries send `feedForward`'s output raw).
	 * Mutually exclusive with `loop`, `run`, and `sessionPolicy: "continue"`
	 * (validated at load).
	 */
	verify?: VerifySpec;
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
	 * Mutually exclusive with `skill` (explicit), `run`, `reads`, and
	 * `fanout`/`iterate` loops. Composes with `kind`, `sessionPolicy`, `assess`
	 * loops, and `verify` (the prompt is round/attempt 0's message; retries
	 * dispatch `feedForward`'s output raw). (validated at load + preflight.)
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
 * `skill`, `outcome`, and `loop` are unauthorisable here.
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
 * (`skill`, `run`, `reads`) are STRUCTURALLY ABSENT, so an object-literal call
 * site that sets one fails TypeScript's excess-property check — the load-time
 * exclusion becomes compile-time for the idiomatic path. `loop` is narrowed to
 * `AssessLoop` (fanout/iterate units own their prompts — un-typable here, and
 * rejected at load on the bare-field form); `verify` composes (attempt 0 sends
 * the resolved prompt; retries send `feedForward`'s output raw). `outcome` is
 * required (a `produces` stage always needs one).
 */
interface ProducesPromptOptions<TIn = unknown, TOut = unknown> {
	prompt: string | PromptFn;
	outcome: Outcome;
	outputSchema?: StageSchema<unknown, TOut>;
	inputSchema?: StageSchema<unknown, TIn>;
	onInvalid?: OnInvalid;
	maxRetries?: number;
	validateTimeoutMs?: number;
	/** Model-judged refinement rounds over this prompt stage — assess only. */
	loop?: AssessLoop;
	/** Post-condition judge gating the prompt stage's output. */
	verify?: VerifySpec;
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
		loop: opts.loop,
		verify: opts.verify,
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
 * un-typable on a literal call site; `loop` is narrowed to `AssessLoop` and
 * `verify` composes (prompt = round/attempt 0; `feedForward` = retries, raw).
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
