/**
 * Loop constructors + introspection — control flow as data, completed.
 *
 * `fanout()` / `iterate()` / `assess()` build the `LoopDef` a stage carries on
 * its single `loop` field; `verify()` builds the `VerifySpec` a stage carries
 * on its `verify` field. Unlike the retired spec-attaching builders (which
 * ATTACHED a `.spec` to a bare function), the LoopDef IS data with
 * function-valued fields — the spec is the source of truth in the
 * constructor, so introspection can never lag a new loop kind again (the
 * `09032b1` retrofit lesson). `loopSpecOf` projects the pure-data facet.
 *
 * Constructors validate at construction (the `defineRoute` pattern): a bad
 * `max`, an invalid judge shape, or a non-function `done`/`feedForward`
 * throws immediately at authoring time. Load-time validation re-checks the
 * same rules defensively for hand-rolled literals (jiti erases TS types).
 *
 * Skill-agnostic: the unit detectors (`units`/`next`) are consumer-supplied;
 * rpiv-workflow ships no conventions. Runner-free — safe on `registration`.
 */

import type {
	AssessLoop,
	CapPolicy,
	EdgeFn,
	FanoutFn,
	FanoutLoop,
	FeedForwardContext,
	IterateFn,
	IterateLoop,
	LoopDef,
	ResultProjection,
	StageDef,
	UnitSelector,
	VerifySpec,
	Workflow,
} from "./api.js";
import { STOP } from "./api.js";
import { type Judge, judgeShapeIssues } from "./judge.js";
import type { Output } from "./output.js";

// `UnitSelector` moved to api.ts (it lives with the loop vocabulary now);
// re-exported here so existing consumers' import path is unchanged.
export type { UnitSelector } from "./api.js";

// ===========================================================================
// Introspection — per-stage control-flow + edge shape
// ===========================================================================

/**
 * Per-stage control-flow + edge shape, read entirely from attached data — no
 * probing. The control-flow analogue of `legalNextSkills`: what an
 * analyzing/suggesting agent consumes to render or reason about a flow's
 * structure. `control.mode` now covers assess (previously read as "single").
 */
export interface StageShape {
	stage: string;
	skill?: string;
	control: { mode: "single" | LoopDef["kind"]; spec?: LoopSpec };
	/**
	 * Present iff the stage carries a `verify` post-condition. `control.mode`
	 * stays `"single"` for verify stages — verify is a stage property in the
	 * introspection model, not a loop kind (the desugar is a runtime concern).
	 */
	verify?: JudgeSpec & { max: number };
	edge: { mode: "linear" | "route" | "terminal"; targets?: readonly string[] };
}

/** Describe a workflow's structure stage-by-stage from attached metadata alone. */
export function describeFlow(w: Workflow): StageShape[] {
	return Object.entries(w.stages).map(([name, stage]) => {
		const control: StageShape["control"] = stage.loop
			? { mode: stage.loop.kind, spec: loopSpecOf(stage.loop) }
			: { mode: "single" };

		const target = w.edges[name];
		let edge: StageShape["edge"];
		if (target === undefined || target === STOP) {
			edge = { mode: "terminal" };
		} else if (typeof target === "string") {
			edge = { mode: "linear", targets: [target] };
		} else {
			edge = { mode: "route", targets: (target as EdgeFn).targets };
		}

		return {
			stage: name,
			skill: stage.skill,
			control,
			...(stage.verify ? { verify: { ...judgeSpecOf(stage.verify.judge), max: stage.verify.max ?? 1 } } : {}),
			edge,
		};
	});
}

// ===========================================================================
// Loop constructors — fanout() / iterate() / assess() build StageDef.loop
// ===========================================================================

/** Default round cap when an `assess()` call omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_MAX = 8;

/** Options shared by all three constructors — the introspectable facet + policy knobs. */
interface LoopOptionsBase {
	/** The named channel the units are split FROM (a `consumes` hint for lints/agents). */
	source?: string;
	/** How units are detected (opaque convention — e.g. `{ by: "frontmatter-array", pattern: "phases" }`). */
	unit?: UnitSelector;
	/** Cardinality ceiling. Must be an integer >= 1 (throws at construction). */
	max?: number;
	/** Cap policy override. Defaults: fanout/iterate → "halt", assess → "advance". */
	onCap?: CapPolicy;
	/** Result projection override. Defaults: fanout → "entry", iterate/assess → "last". */
	result?: ResultProjection;
}

export interface FanoutOptions extends LoopOptionsBase {
	/** Push-model unit source — all units computed up front. */
	units: FanoutFn;
}

export interface IterateOptions extends LoopOptionsBase {
	/** Pull-model unit source — one unit per call, fed the accumulated prefix. */
	next: IterateFn;
}

export interface AssessOptions extends LoopOptionsBase {
	judge: Judge;
	/** Sync TS reading the model-made verdict. `true` → loop stops, producer output is the result. */
	done: (verdict: Output) => boolean;
	/** Builds the next producer prompt arg from the just-judged round's output + verdict. */
	feedForward: (ctx: FeedForwardContext) => string;
}

/**
 * Push loop: all units precomputed, each unit its own session. On a
 * `produces` stage units COLLECT (full collect→validate→publish per unit;
 * `outcome.name` required); on an `acts` stage units are side-effects.
 * Empty `units()` return ⇒ single-stage fall-through.
 */
export function fanout(opts: FanoutOptions): FanoutLoop {
	return {
		kind: "fanout",
		units: opts.units,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("fanout", opts.max),
		onCap: opts.onCap ?? "halt",
		result: opts.result ?? "entry",
	};
}

/**
 * Pull loop: sequential, accumulating — each `next()` call sees the prior
 * units' validated Outputs. Requires `kind: "produces"` + `outcome.name`
 * (workflow-level, checked at load). First-call `null` ⇒ zero-unit no-op.
 */
export function iterate(opts: IterateOptions): IterateLoop {
	return {
		kind: "iterate",
		next: opts.next,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("iterate", opts.max),
		onCap: opts.onCap ?? "halt",
		result: opts.result ?? "last",
	};
}

/**
 * Model-judged until-done loop: each round runs a producer session (this
 * stage's skill/outcome) then a judge session (`opts.judge`). `done(verdict)`
 * decides termination; `feedForward` carries the verdict into the next
 * producer round. The cap soft-stops by default (`onCap: "advance"`).
 * Requires `kind: "produces"` + `outcome.name` (workflow-level, checked at
 * load) — every round runs the produces collector, so the producer needs a
 * stable named slot like any other collecting loop.
 */
export function assess(opts: AssessOptions): AssessLoop {
	const issues = judgeShapeIssues(opts.judge);
	if (issues.length > 0) throw new Error(`assess(): ${issues[0]}`);
	if (typeof opts.done !== "function") {
		throw new Error("assess(): `done` must be a function deciding termination from the verdict");
	}
	if (typeof opts.feedForward !== "function") {
		throw new Error("assess(): `feedForward` must be a function building the next producer arg");
	}
	return {
		kind: "assess",
		judge: opts.judge,
		done: opts.done,
		feedForward: opts.feedForward,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("assess", opts.max) ?? DEFAULT_ASSESS_MAX,
		onCap: opts.onCap ?? "advance",
		result: opts.result ?? "last",
	};
}

/**
 * Per-stage post-condition judge: after each attempt of the stage completes,
 * `judge` grades it and `done(verdict)` gates advancement — true → advance
 * with the attempt's producer pair; false → fresh retry attempt (prompt arg
 * from `feedForward`) up to `max` attempts (default 1 = gate-only), then a
 * terminal "verification failed" halt. Requires `kind: "produces"` + an
 * `outcome` with a `name` (workflow-level, checked at load). Composes with
 * `reads` and with `prompt` dispatch (attempt 0 sends the stage's resolved
 * prompt; retries send `feedForward`'s output raw); mutually exclusive with
 * `loop`/`run`/continue.
 *
 * The runner desugars the spec into a degenerate assess loop
 * (`synthesizeVerifyLoop`) run by the ONE driver — verify rides the tested
 * pair-restore / per-attempt-snapshot / resume machinery rather than forking it.
 */
export function verify(spec: VerifySpec): VerifySpec {
	const issues = verifyShapeIssues(spec);
	if (issues.length > 0) throw new Error(`verify(): ${issues[0]}`);
	return spec;
}

/**
 * Single rule source for the verify shape. Returns human-readable violations
 * (empty array = valid). `verify()` throws on the first; `validateWorkflow`
 * maps each to a load issue for hand-rolled literals that bypassed the
 * factory (jiti-loaded configs erase TS types). Same pattern as
 * `judgeShapeIssues` / `judge()`.
 */
export function verifyShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a verify object is required"];
	const v = candidate as Partial<VerifySpec>;
	const issues: string[] = [...judgeShapeIssues(v.judge)];
	if (typeof v.done !== "function") {
		issues.push("verify requires `done` to be a function deciding pass/fail from the verdict");
	}
	if (v.max !== undefined && (!Number.isInteger(v.max) || v.max < 1)) {
		issues.push(`verify.max: ${v.max} — must be an integer >= 1 (run.maxIterations caps the upper bound)`);
	}
	if (v.feedForward !== undefined && typeof v.feedForward !== "function") {
		issues.push("verify `feedForward` must be a function building the next attempt's prompt arg");
	}
	if ((v.max ?? 1) > 1 && v.feedForward === undefined) {
		issues.push(
			"verify.max > 1 requires `feedForward` — without it the retried prompt would be byte-identical to the original",
		);
	}
	return issues;
}

/**
 * Unreachable by construction: the driver's cap check precedes the
 * feedForward call (loop.ts pullNext), so a gate-only verify (`max` 1, the
 * only shape allowed to omit `feedForward`) caps before a second attempt
 * could ever ask for an arg. A throw here means that invariant broke
 * — fail loudly (propagates to the runner's single catch) rather than
 * silently dispatching an empty-arg prompt.
 */
const NEVER_FEED_FORWARD = (): string => {
	throw new Error("verify: feedForward invoked on a gate-only verify (max 1) — driver invariant violated");
};

/**
 * The desugar: a `VerifySpec` as a degenerate assess loop — the shared
 * `JudgedRepetition` fields flow straight through (`max` defaulted to 1 for
 * the gate-only shape); the cap policy is always `"halt"`
 * (a failing final verdict = "verification failed"; `done` wins over the cap
 * so a pass on the final attempt is a normal completion), and `result:
 * "last"` restores the last attempt's producer pair at loop advance.
 * Allocates per call — callers cache (LoopEntry live; OpenGeneration on the
 * fold), and nothing compares loop identity.
 *
 * NOT re-exported from registration.ts — runtime plumbing, not authoring
 * surface (precedent: `judgeStageDef`).
 */
export function synthesizeVerifyLoop(v: VerifySpec): AssessLoop {
	return {
		kind: "assess",
		judge: v.judge,
		done: v.done,
		feedForward: v.feedForward ?? NEVER_FEED_FORWARD,
		max: v.max ?? 1,
		onCap: "halt",
		result: "last",
	};
}

/**
 * THE loop-or-verify consult — the one derivation of "does this stage run
 * through the loop driver, and with what spec." Consulted by `tryLoop`
 * (live), the resume fold's generation open, and `resumeLoopStage`, so the
 * three can never disagree about a verify stage's loop shape.
 */
export function effectiveLoopOf(def: StageDef): LoopDef | undefined {
	if (def.loop) return def.loop;
	return def.verify ? synthesizeVerifyLoop(def.verify) : undefined;
}

/**
 * THE judge-of-stage derivation — an assess loop's judge or the verify
 * post-condition's, whichever the stage carries (they're mutually exclusive
 * by load validation). Twin of `effectiveLoopOf` for the judge facet, so the
 * validator's judge-dependent rules key off one expression.
 */
export function judgeOf(stage: StageDef): Judge | undefined {
	return stage.loop?.kind === "assess" ? stage.loop.judge : stage.verify?.judge;
}

/** `max < 1` would cap at unit 0 and silently produce nothing — reject at construction. */
function checkedMax(ctor: string, max: number | undefined): number | undefined {
	if (max === undefined) return undefined;
	if (!Number.isInteger(max) || max < 1) {
		throw new Error(`${ctor}(): max must be an integer >= 1 (got ${max})`);
	}
	return max;
}

// ===========================================================================
// Introspection — one channel for all loop kinds
// ===========================================================================

/**
 * Pure-data projection of a LoopDef — what `describeFlow`, `preview`, and the
 * `checkFanoutSource` lint consume. `judge` summarises the dispatch without
 * exposing functions: `prompt: true` means a prompt judge (the text/closure
 * itself stays opaque).
 */
/** Pure-data judge summary — `prompt: true` means a prompt judge (the text/closure stays opaque). */
export interface JudgeSpec {
	skill?: string;
	prompt: boolean;
	outcome: string;
}

/** Project the introspectable facet off a Judge — shared by `loopSpecOf` and the `StageShape.verify` projection so the two can't drift. */
export function judgeSpecOf(judge: Judge): JudgeSpec {
	return { skill: judge.skill, prompt: judge.prompt !== undefined, outcome: judge.outcome.name ?? "" };
}

export interface LoopSpec {
	kind: LoopDef["kind"];
	source?: string;
	unit?: UnitSelector;
	max?: number;
	onCap: CapPolicy;
	result: ResultProjection;
	judge?: JudgeSpec;
}

/** Project the introspectable facet off a stage's loop, or undefined for non-loop stages. */
export function loopSpecOf(loop: LoopDef | undefined): LoopSpec | undefined {
	if (!loop) return undefined;
	const base: LoopSpec = {
		kind: loop.kind,
		source: loop.source,
		unit: loop.unit,
		max: loop.max,
		onCap: loop.onCap,
		result: loop.result,
	};
	if (loop.kind === "assess") base.judge = judgeSpecOf(loop.judge);
	return base;
}
