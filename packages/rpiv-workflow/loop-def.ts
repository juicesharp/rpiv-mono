/**
 * Loop vocabulary — the data shapes behind `StageDef.loop` and
 * `StageDef.verify`, AS TYPES. Constructors live in loop-constructors.ts
 * (`fanout()` / `iterate()` / `assess()` / `verify()`); the per-kind runtime
 * strategy table lives in loop-kinds.ts. Split out of api.ts so the
 * loop concept has one home instead of accreting into the stage module.
 *
 * Leaf-ish: imports only types from judge/output/handle.
 */

import type { Artifact } from "./handle.js";
import type { AnyJudge } from "./judge.js";
import type { Output, RunView } from "./output.js";

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
	artifact: Artifact | undefined;
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
	artifact: Artifact | undefined;
	state: RunView;
	/** Validated Outputs of this generation's completed units, in order. */
	accumulated: readonly Output[];
	/** 0-based index of the unit about to run (== accumulated.length). */
	index: number;
}

/** Context handed to `AssessLoop.feedForward` and `VerifySpec.feedForward`. */
export interface FeedForwardContext {
	cwd: string;
	/** Producer output just judged. */
	output: Output;
	/** Judge verdict (incl. feedback). */
	verdict: Output;
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
	/**
	 * The judge SLOT — a single `Judge` or an N-member `PanelJudge` (a single
	 * judge is the panel of one). Widened to `AnyJudge` so `assess`/`verify`
	 * compose a panel with zero per-site code; the runtime expands it through
	 * `panelMembers` at the one judge-dispatch site.
	 */
	judge: AnyJudge;
	/**
	 * Sync TS reading the model-made verdict. `true` → the repetition stops
	 * and the chain advances with the last producer pair. RESUME CONTRACT:
	 * recomputed on resume (never persisted) — must be deterministic w.r.t.
	 * the verdict `Output`. A `true` on the final round/attempt is a normal
	 * completion (the predicate wins over the cap).
	 */
	done: (verdict: Output) => boolean;
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
 * `verify()` constructor (loop-constructors.ts), which validates at construction;
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
 * How a stage's work is split into units, AS DATA. The framework never
 * interprets `by`/`pattern` — they're introspection hints for agents and the
 * `checkFanoutSource` lint.
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
 * `fanout()` / `iterate()` / `assess()` constructors (loop-constructors.ts), which
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
