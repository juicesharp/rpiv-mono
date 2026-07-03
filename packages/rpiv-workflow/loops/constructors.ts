/**
 * Loop constructors — `fanout()` / `iterate()` / `assess()` build the `LoopDef`
 * a stage carries on its single `loop` field. Constructors validate at
 * construction (the `defineRoute` pattern): a bad `max`, an invalid judge shape,
 * or a non-function `done`/`feedForward` throws immediately at authoring time;
 * load-time validation re-checks the same rules defensively for hand-rolled
 * literals (jiti erases TS types). Skill-agnostic — the unit detectors
 * (`units`/`next`) are consumer-supplied; rpiv-workflow ships no conventions.
 * Runner-free — safe on `registration`.
 */

import type {
	AssessLoop,
	CapPolicy,
	FanoutFn,
	FanoutLoop,
	FeedForwardContext,
	IterateFn,
	IterateLoop,
	LoopDef,
	ResultProjection,
	UnitSelector,
} from "../api.js";
import { type AnyJudge, assertShape, isPanel, judgeShapeIssues } from "../judge.js";
import type { Output } from "../output.js";
import { panelShapeIssues } from "./panel.js";

/** Default round cap when an `assess()` call omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_MAX = 8;

/**
 * Per-loop-kind identity — the construction-facet twin of `LOOP_STRATEGIES`
 * (`loop-kinds.ts`, the per-kind runtime strategy table). Each kind's default
 * `onCap`/`result` (and assess's construction `max`) live HERE, consulted by
 * every constructor, so a new loop kind or a default change is a single-row
 * edit instead of a multi-constructor scatter. Consulted by `effectiveLoopOf`
 * (the derivation-authority exemplar) and `freezesEntryArgsOf` (the round-0-arg
 * rule) — the two derivations that read it; both live in `derivations.ts` after
 * the `loops/` split (they value-import `LOOP_DEFAULTS` from here).
 *
 * `max` fits the table because `satisfies` (NOT a type annotation) preserves
 * the narrow inferred literal type PER KEY (the same property `LOOP_STRATEGIES`
 * relies on): `assess.max` infers as `number` (from `DEFAULT_ASSESS_MAX`), while
 * `fanout.max`/`iterate.max` infer as `undefined`. The assess constructor
 * therefore reads `LOOP_DEFAULTS.assess.max` with NO non-null assertion.
 *
 * WARNING: if a future change annotates this constant with a type declaration
 * instead of `satisfies`, the narrow per-key types are lost and `assess.max`
 * widens to `number | undefined` — re-confirm the `satisfies` form is retained.
 */
interface LoopKindDefaults {
	/** Construction-default cap policy. fanout/iterate → "halt", assess → "advance". */
	onCap: CapPolicy;
	/** Construction-default result projection. fanout → "entry", iterate/assess → "last". */
	result: ResultProjection;
	/**
	 * Construction default cap; `undefined` when a kind has none (clamped at
	 * runtime by `run.maxIterations`). assess carries `DEFAULT_ASSESS_MAX`;
	 * verify carries 1 (in the peer `VERIFY_LOOP_DEFAULTS`, not here).
	 */
	max?: number;
	/**
	 * Does this kind freeze a round-0 producer arg? assess derives (and freezes)
	 * a round-0 arg from the entry state; fanout/iterate do not. Consulted at the
	 * three live/resume entry sites via `freezesEntryArgsOf`, so the predicate is
	 * spelled ONCE — a future judged kind flipping this just edits the row.
	 */
	freezesEntryArgs: boolean;
}

/**
 * THE per-kind identity table — the single place fanout/iterate/assess default
 * `onCap`/`result`/`max` AND the round-0-arg rule are spelled. Modeled on
 * `LOOP_STRATEGIES` (`satisfies Record<LoopDef["kind"], …>`); a new loop kind
 * added to the union without a row here is a compile error.
 */
export const LOOP_DEFAULTS = {
	fanout: { onCap: "halt", result: "entry", max: undefined, freezesEntryArgs: false },
	iterate: { onCap: "halt", result: "last", max: undefined, freezesEntryArgs: false },
	assess: { onCap: "advance", result: "last", max: DEFAULT_ASSESS_MAX, freezesEntryArgs: true },
} satisfies Record<LoopDef["kind"], LoopKindDefaults>;

/**
 * Verify's gate-only defaults — a named PEER, not a `LOOP_DEFAULTS` row: verify
 * is not a `LoopDef["kind"]` (it desugars to a degenerate assess loop), so it
 * cannot be a key in a `Record<LoopDef["kind"], …>`. Its distinct defaults
 * (`onCap: "halt"`, `result: "last"`, `max: 1` vs assess's `advance`/`last`/`8`)
 * each still spelled exactly once — here — and consulted by `synthesizeVerifyLoop`.
 *
 * `freezesEntryArgs` is carried for the `LoopKindDefaults` shape but is NOT
 * consulted by `freezesEntryArgsOf`: a verify stage's effective loop is the
 * SYNTHESIZED assess loop (kind "assess"), so the predicate reads
 * `LOOP_DEFAULTS.assess.freezesEntryArgs` (`true`). `true` here keeps the peer
 * honest — verify, like assess, freezes a round-0 producer arg.
 */
export const VERIFY_LOOP_DEFAULTS = {
	onCap: "halt",
	result: "last",
	max: 1,
	freezesEntryArgs: true,
} satisfies LoopKindDefaults;

/**
 * First-defined primitive — keeps defaulting grep-clean (no inline
 * onCap-fallback token at the call sites) so the slice's default-spelling
 * check holds. The `??` inside this body is the single authorized spelling
 * of the fallback.
 */
function firstDefined<T>(v: T | undefined, fallback: T): T {
	return v ?? fallback;
}

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
	/** Per-fanout concurrency ceiling — caps in-flight units to
	 *  `min(concurrency, host maxConcurrency)`; `1` serializes (the safe model for a
	 *  stage that mutates shared state, e.g. `implement` applying a plan to one tree).
	 *  Integer ≥ 1; absent ⇒ host cap governs. */
	concurrency?: number;
	/** Opt out of collect-all: any unit failure halts the run (default ⇒ collect-all). */
	failFast?: boolean;
	/** When set, the dispatcher appends `${depArtifactFlag} <path>` per direct
	 *  `Unit.deps` entry with a non-failed filled slot — handing the dependent unit
	 *  its dependencies' published artifacts (e.g. `"--upstream"`). Non-empty string;
	 *  pairs with `Unit.deps`. */
	depArtifactFlag?: string;
}

export interface IterateOptions extends LoopOptionsBase {
	/** Pull-model unit source — one unit per call, fed the accumulated prefix. */
	next: IterateFn;
}

export interface AssessOptions extends LoopOptionsBase {
	/** The judge SLOT — a single `Judge` or an N-member `panel()` (a single judge is the panel of one). */
	judge: AnyJudge;
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
	const d = LOOP_DEFAULTS.fanout;
	return {
		kind: "fanout",
		units: opts.units,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("fanout", opts.max),
		onCap: firstDefined(opts.onCap, d.onCap),
		result: firstDefined(opts.result, d.result),
		...(opts.concurrency !== undefined ? { concurrency: checkedConcurrency(opts.concurrency) } : {}),
		...(opts.depArtifactFlag !== undefined ? { depArtifactFlag: checkedDepArtifactFlag(opts.depArtifactFlag) } : {}),
		...(opts.failFast !== undefined ? { failFast: opts.failFast } : {}),
	};
}

/** A blank/whitespace flag would inject a bare ` <path>` with no marker — reject at construction. */
function checkedDepArtifactFlag(flag: string | undefined): string | undefined {
	if (flag === undefined) return undefined;
	if (typeof flag !== "string" || flag.trim().length === 0) {
		throw new Error(`fanout(): depArtifactFlag must be a non-empty string (got ${JSON.stringify(flag)})`);
	}
	return flag;
}

/**
 * Pull loop: sequential, accumulating — each `next()` call sees the prior
 * units' validated Outputs. Requires `kind: "produces"` + `outcome.name`
 * (workflow-level, checked at load). First-call `null` ⇒ zero-unit no-op.
 */
export function iterate(opts: IterateOptions): IterateLoop {
	const d = LOOP_DEFAULTS.iterate;
	return {
		kind: "iterate",
		next: opts.next,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("iterate", opts.max),
		onCap: firstDefined(opts.onCap, d.onCap),
		result: firstDefined(opts.result, d.result),
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
	assertShape("assess", assessShapeIssues(opts));
	const d = LOOP_DEFAULTS.assess;
	return {
		kind: "assess",
		judge: opts.judge,
		done: opts.done,
		feedForward: opts.feedForward,
		source: opts.source,
		unit: opts.unit,
		max: checkedMax("assess", opts.max) ?? d.max,
		onCap: firstDefined(opts.onCap, d.onCap),
		result: firstDefined(opts.result, d.result),
	};
}

/**
 * Single rule source for the assess shape — mirrors `verifyShapeIssues`. Returns
 * human-readable violations (empty = valid); `assess()` throws on the first via
 * `assertShape`. Takes `unknown` ON PURPOSE (jiti-loaded literals erase TS
 * types). Every judge-bearing constructor — judge/assess/verify/panel — pairs
 * a `*ShapeIssues` source with `assertShape`.
 *
 * DECISION OF RECORD — the assess shape is validated TWICE, by design, and the
 * two sources are intentionally NOT unified:
 *
 * - This source (`assessShapeIssues`) runs at construction time inside `assess()`;
 *   the load gate (`validate/stage-rules.ts`) re-runs the same shape and emits its
 *   own per-code reporting (`assess-judge-shape`/
 *   `assess-done-not-function`/`assess-feed-forward-not-function`). Both are kept.
 * - The judge/panel shape is ALREADY shared — both paths route the judge slot
 *   through `judgeShapeIssues` (single judge) / `panelShapeIssues` (panel), so
 *   that wording can never drift between them.
 * - The ONLY part spelled twice is the two trivial `done`/`feedForward`
 *   `typeof !== "function"` predicates (one line each, here and in the load gate).
 *
 * Why not unify on one source? It would force either (a) a fragile
 * `string.includes()` → issue-code mapping with no compile-time guard — renaming
 * `` `done` `` in a message string would silently misroute to `assess-judge-shape`
 * — or (b) a silent change to the user-visible message text the load gate emits.
 * The cost of the kept duplication (two one-line `typeof` checks) is far smaller
 * than either.
 *
 * This source stays internal-only: its sole consumer is `assess()`, and it is
 * deliberately NOT exported from `registration.ts`, while the load gate owns the
 * per-code surface the tests pin (`validate-workflow.test.ts:923,928`).
 */
export function assessShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["an assess object is required"];
	const a = candidate as Partial<AssessOptions>;
	const judgeIssues = a.judge && isPanel(a.judge) ? panelShapeIssues(a.judge) : judgeShapeIssues(a.judge);
	const issues: string[] = [...judgeIssues];
	if (typeof a.done !== "function") {
		issues.push("`done` must be a function deciding termination from the verdict");
	}
	if (typeof a.feedForward !== "function") {
		issues.push("`feedForward` must be a function building the next producer arg");
	}
	return issues;
}

/** `max < 1` would cap at unit 0 and silently produce nothing — reject at construction. */
function checkedMax(ctor: string, max: number | undefined): number | undefined {
	if (max === undefined) return undefined;
	if (!Number.isInteger(max) || max < 1) {
		throw new Error(`${ctor}(): max must be an integer >= 1 (got ${max})`);
	}
	return max;
}

function checkedConcurrency(concurrency: number | undefined): number | undefined {
	if (concurrency === undefined) return undefined;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error(`fanout(): concurrency must be an integer >= 1 (got ${concurrency})`);
	}
	return concurrency;
}
