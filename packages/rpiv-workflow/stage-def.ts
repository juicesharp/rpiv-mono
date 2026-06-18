/**
 * Stage vocabulary + factories — what a stage IS (`StageDef` and its three
 * dispatch arms), what a workflow is, and the blessed constructors
 * (`defineWorkflow`, `produces` / `acts` / `terminal` and their `.script` /
 * `.prompt` builders). Split out of api.ts; the loop shapes live in
 * loop-def.ts, the routing DSL in routing-dsl.ts.
 *
 * Factories are pure passthroughs that apply sane defaults. Same idiom as
 * `defineConfig` in Vite/Astro/Tailwind: zero runtime cost, exists solely
 * for type inference + uniform shape at the call site.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AssessLoop, LoopDef, VerifySpec } from "./loop-def.js";
import type { Output, RunView } from "./output.js";
import type { Outcome } from "./output-spec.js";
import type { EdgeTarget } from "./routing-dsl.js";

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
export type StageSchema<TIn = unknown, TOut = TIn> = StandardSchemaV1<TIn, TOut>;

// ===========================================================================
// Stage-shape primitives
// ===========================================================================

/**
 * - `"produces"` — protocol skills that write `.rpiv/artifacts/<bucket>/<file>.md`.
 *   The runner halts the chain if the path doesn't appear in the transcript.
 * - `"side-effect"` — action skills (commit, implement) where the side effect IS
 *   the work; the chain inherits the prior `currentPrimaryArtifact(state)`.
 *
 * Naming is DELIBERATELY split between data and authoring surface: the kind
 * literal is descriptive (`"side-effect"` — what lands in rows and output
 * envelopes) while its factory is a verb (`acts()` — what reads naturally in
 * a stage record). `terminal()` is not a third kind: it builds
 * `"side-effect"` + `inheritsArtifacts: false`. See the README glossary.
 *
 * The `as const` array is the single source of truth: the literal-union type
 * is derived via `(typeof ARRAY)[number]`, and `validate-workflow.ts` consumes
 * the same array for the runtime enum check. Adding a variant updates both
 * type-level and runtime arms in one edit.
 */
export const STAGE_KINDS = ["produces", "side-effect"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * - `"fresh"` — the stage runs in a brand-new detached child session.
 * - `"continue"` — the stage FORKS its predecessor's persisted child session
 *   (`SessionManager.forkFrom`), so the child carries the prior conversation as
 *   context; the continuation turn is then sent into it, and its outcome is
 *   sliced past the inherited prefix by a `branchOffset` re-derived from the
 *   forked branch. No predecessor session (start stage / after a loop / file
 *   gone) degrades to a fresh dispatch.
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
// Channel-read declarations for `reads:` stage fields
// ===========================================================================

/**
 * A single `reads:` entry: a bare channel name (latest-wins, the historical
 * default) or a spec selecting ALL accumulated entries of the channel.
 * `fanin()` builds the all-entries spec — the consumer-side mirror of
 * `fanout()`, the fanout-and-synthesize fan-in idiom.
 */
export type StageRead = string | { readonly name: string; readonly all?: boolean };

/**
 * Read EVERY accumulated entry of a channel (run order), not just the latest.
 * The canonical consumer side of fanout-and-synthesize:
 *   fanout({ ..., outcome: { name: "plans" } })
 *   stage({ reads: [fanin("plans")], skill: "synthesize" })
 * Throws on an empty name, mirroring the value-returning loop/routing builders
 * (gate()/match()/assess()) — NOT the pure passthrough factories in this file
 * (produces()/acts()/terminal()), which apply defaults without validating.
 */
export function fanin(name: string): { readonly name: string; readonly all: true } {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("fanin(name): name must be a non-empty channel name");
	}
	return { name, all: true };
}

/** The channel name of a read, normalizing bare-string and spec forms. */
export function readName(read: StageRead): string {
	return typeof read === "string" ? read : read.name;
}

/** Whether a read consumes ALL accumulated entries (vs. latest-wins). */
export function readsAll(read: StageRead): boolean {
	return typeof read !== "string" && read.all === true;
}

// ===========================================================================
// StageDef — the discriminated union over the dispatch axis (T1)
// ===========================================================================

/**
 * Knobs shared by every stage regardless of how it dispatches — the base the
 * three `StageDef` arms extend. Not exported: authors name the arms (or just
 * `StageDef`), never the base.
 */
interface StageDefBase<TIn = unknown, TOut = unknown> {
	kind: StageKind;
	sessionPolicy: SessionPolicy;
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
}

/**
 * The default dispatch arm: the runner sends `/skill:<skill>` into the
 * stage's session. `skill` defaults to the surrounding `Workflow.stages`
 * record key — set it explicitly only when the stage id and the Pi skill
 * differ (aliased stages like `implement-after-revise` invoking the
 * `implement` skill). Pi resolves the skill at run time; there's no
 * allowlist gate — if Pi can't load it, the runner halts pointing at this
 * stage.
 *
 * The `run?: never` / `prompt?: never` members make the other arms'
 * discriminators structurally unsettable here — an object literal mixing
 * dispatches fails to type-check (see `StageDef`).
 */
export interface SkillStage<TIn = unknown, TOut = unknown> extends StageDefBase<TIn, TOut> {
	skill?: string;
	outcome?: Outcome;
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
	 * Mutually exclusive with `sessionPolicy: "continue"` (validated at load +
	 * at preflight).
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
	 * Composes with `reads`. Mutually exclusive with `loop` and
	 * `sessionPolicy: "continue"` (validated at load).
	 */
	verify?: VerifySpec;
	/**
	 * Names this stage consumes from `state.named` to build its prompt.
	 * When set, the runner replaces the default single-artifact prompt
	 * (`/skill:<name> <handle>`) with a labelled-flag form
	 * (`/skill:<name> --<n1> <h1> --<n2> <h2> …`), reading each name's
	 * accumulated `Output` and iterating its `artifacts` list.
	 *
	 * A bare string reads the channel's LATEST entry (`array.at(-1)`); wrap a
	 * name in `fanin("name")` to read EVERY accumulated entry — the
	 * fanout-and-synthesize fan-in idiom. Empty (or unset) → default prompt
	 * behaviour preserved.
	 *
	 * Names address `state.named` slots, which are keyed by
	 * `stage.outcome?.name ?? stage.<record-key>`. Every name in `reads:`
	 * must be filled by some upstream stage's produces success (validated
	 * at load time by `validateWorkflow`; the `ensureNamedReads` preflight
	 * catches the "haven't reached the producer yet" case at runtime).
	 */
	reads?: ReadonlyArray<StageRead>;
	run?: never;
	prompt?: never;
}

/**
 * Skillless script stage: the runner calls `run` instead of dispatching a Pi
 * skill — presence of `run` is the dispatch discriminator. Authored via
 * `produces.script(...)`, `acts.script(...)`, or `terminal.script(...)`.
 *
 * `skill`/`outcome`/`loop`/`verify`/`prompt` are structurally unsettable
 * (`never`): the function IS the work and returns the `Output` envelope
 * directly — there is no skill body, no transcript for a collector to scan,
 * no session for a judge to grade, and a TS function writes its own loops.
 * `sessionPolicy: "continue"` is additionally rejected at load (no Pi
 * session exists to continue) — kept as a load rule because jiti-loaded
 * literals erase these types.
 */
export interface ScriptStage<TIn = unknown, TOut = unknown> extends StageDefBase<TIn, TOut> {
	run: ProducesScriptFn<string, TOut> | ActsScriptFn;
	/** Same named-channel consumption as a skill stage — `ScriptContext.state.named` still needs the producer gate. `fanin()` reads all entries. */
	reads?: ReadonlyArray<StageRead>;
	skill?: never;
	outcome?: never;
	loop?: never;
	verify?: never;
	prompt?: never;
}

/**
 * Raw-prompt dispatch: the runner sends this text (resolved per the
 * `PromptFn`, or the literal string) into the stage's session instead of
 * `/skill:<skill>`. The stage runs the model with no skill body and no
 * skill-registry check. Presence of `prompt` is the third dispatch
 * discriminator alongside `run`.
 *
 * `skill`/`run`/`reads` are structurally unsettable (`never`): you're either
 * invoking a skill or sending raw text, and a prompt stage's text is
 * author-owned — read `state.named` from the `PromptFn` instead of `reads`.
 * `loop` is narrowed to `AssessLoop` (fanout/iterate units own their
 * prompts); `verify` composes (the prompt is round/attempt 0's message;
 * retries dispatch `feedForward`'s output raw).
 */
export interface PromptStage<TIn = unknown, TOut = unknown> extends StageDefBase<TIn, TOut> {
	prompt: string | PromptFn;
	/** A `produces` prompt stage runs the `outcome` collector and publishes like any other producer. */
	outcome?: Outcome;
	/** Model-judged refinement rounds over this prompt stage — assess only. */
	loop?: AssessLoop;
	verify?: VerifySpec;
	skill?: never;
	run?: never;
	reads?: never;
}

/**
 * A stage in the workflow graph — a discriminated union over the DISPATCH
 * axis (T1): skill (`SkillStage`, the default), script (`ScriptStage`,
 * `run` present), or raw prompt (`PromptStage`, `prompt` present). The
 * stage's identity is the surrounding `Workflow.stages` record key.
 *
 * Illegal dispatch combinations (`run` + `skill`, `prompt` + `reads`, …)
 * are unrepresentable on typed call sites — the `never` members fail the
 * assignability check. The load-time validator re-checks the same rules for
 * hand-rolled literals because jiti erases TS types (same posture as the
 * `Judge` union + `judgeShapeIssues`).
 *
 * TYPING MODEL (T2): `<TIn, TOut>` are LOCAL inference helpers — they tie a
 * factory call's `inputSchema`/`outputSchema`/`run` together, then erase at
 * the `Workflow.stages` boundary (`Record<string, StageDef>`). They do NOT
 * carry types across edges; inter-stage typing is runtime-contract-based
 * (schemas validate `output.data` at run time, skill contracts adjudicate
 * composition at load). A typed builder API is a roadmap item.
 */
export type StageDef<TIn = unknown, TOut = unknown> =
	| SkillStage<TIn, TOut>
	| ScriptStage<TIn, TOut>
	| PromptStage<TIn, TOut>;

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
 * Builder options are PROJECTIONS of the union arms (T13): each interface
 * `Pick`s its fields from the arm the factory constructs, and the factory
 * spreads the options over the arm's fixed fields. Adding a knob to an arm
 * is one edit here (extend the `Pick` key list — a stale key no longer on
 * the arm fails compilation); the spread means the factory can never
 * silently drop it.
 */

/**
 * Options accepted by `produces.script({ run, ... })`. The validation +
 * inheritance knobs that semantically apply to a pure TS function. `kind`
 * and `sessionPolicy` are not configurable — script stages are always
 * `"produces"` + `"fresh"`.
 */
interface ProducesScriptOptions<TIn = unknown, TOut = unknown>
	extends Pick<
		ScriptStage<TIn, TOut>,
		"outputSchema" | "inputSchema" | "onInvalid" | "maxRetries" | "validateTimeoutMs" | "inheritsArtifacts" | "reads"
	> {
	run: ProducesScriptFn<string, TOut>;
}

/**
 * Options accepted by `acts.script({ run, ... })` and
 * `terminal.script({ run, ... })`. Validation surface is narrower than
 * the produces variant: side-effect stages have no `outputSchema`
 * (they emit no data envelope), so the retry knobs don't apply.
 */
interface ActsScriptOptions<TIn = unknown>
	extends Pick<ScriptStage<TIn, void>, "inputSchema" | "inheritsArtifacts" | "reads"> {
	run: ActsScriptFn;
}

/**
 * Options accepted by `produces.prompt({ prompt, outcome, ... })` — the typed
 * builder for a raw-prompt `produces` stage. Dispatch-conflicting fields
 * (`skill`, `run`, `reads`) are structurally absent (the `PromptStage` arm
 * pins them `never`). `outcome` is required (a `produces` stage always needs
 * one); `loop` is `AssessLoop` per the arm.
 */
interface ProducesPromptOptions<TIn = unknown, TOut = unknown>
	extends Pick<
		PromptStage<TIn, TOut>,
		"prompt" | "outputSchema" | "inputSchema" | "onInvalid" | "maxRetries" | "validateTimeoutMs" | "loop" | "verify"
	> {
	outcome: Outcome;
	/** `"continue"` makes this a follow-up turn on a session a prior stage populated. */
	sessionPolicy?: SessionPolicy;
}

/**
 * Options accepted by `acts.prompt({ prompt, ... })` — the typed builder for a
 * raw-prompt side-effect stage (a pure chat turn). Narrower than the produces
 * variant: no `outcome` (nothing collected). For a collecting side-effect
 * prompt stage, use the bare `acts({ prompt, outcome })` field form instead.
 */
interface ActsPromptOptions<TIn = unknown> extends Pick<PromptStage<TIn, void>, "prompt" | "inputSchema"> {
	/** `"continue"` makes this a follow-up turn on a session a prior stage populated. */
	sessionPolicy?: SessionPolicy;
}

function producesFn(overrides: Partial<StageDef> = {}): StageDef {
	// The cast is the factory's one concession: a `Partial` of a union can't be
	// proven to complete a single arm. Call sites stay arm-checked (an object
	// literal mixing dispatches fails before it reaches the spread).
	return {
		kind: "produces",
		sessionPolicy: "fresh",
		...overrides,
	} as StageDef;
}

function producesScript<TIn = unknown, TOut = unknown>(opts: ProducesScriptOptions<TIn, TOut>): StageDef<TIn, TOut> {
	return {
		kind: "produces",
		sessionPolicy: "fresh",
		...opts,
	};
}

function producesPrompt<TIn = unknown, TOut = unknown>(opts: ProducesPromptOptions<TIn, TOut>): StageDef<TIn, TOut> {
	return {
		kind: "produces",
		...opts,
		sessionPolicy: opts.sessionPolicy ?? "fresh",
	};
}

function actsFn(overrides: Partial<StageDef> = {}): StageDef {
	return {
		kind: "side-effect",
		sessionPolicy: "fresh",
		...overrides,
	} as StageDef;
}

function actsPrompt<TIn = unknown>(opts: ActsPromptOptions<TIn>): StageDef<TIn, void> {
	return {
		kind: "side-effect",
		...opts,
		sessionPolicy: opts.sessionPolicy ?? "fresh",
	};
}

function actsScript<TIn = unknown>(opts: ActsScriptOptions<TIn>): StageDef<TIn, void> {
	return {
		kind: "side-effect",
		sessionPolicy: "fresh",
		...opts,
	};
}

function terminalFn(overrides: Partial<StageDef> = {}): StageDef {
	return actsFn({ ...overrides, inheritsArtifacts: false } as Partial<StageDef>);
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
