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
import { requireNonEmptyString } from "../internal-utils.js";
import { type AnyJudge, assertShape, isPanel, judgeShapeIssues } from "../judge.js";
import type { Output } from "../output.js";
import { panelShapeIssues } from "./panel.js";

/** Default round cap when an `assess()` call omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_MAX = 8;

/**
 * The per-kind defaults row shape — the construction facts each loop kind's
 * row carries in the identity tables (`LOOP_DEFAULTS`, `VERIFY_LOOP_DEFAULTS`).
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
 * `onCap`/`result`/`max` AND the round-0-arg rule are spelled: the
 * construction-facet twin of `LOOP_STRATEGIES` (`loop-kinds.ts`, the per-kind
 * runtime strategy table). Consulted by every constructor and by the two
 * derivations that read it — `effectiveLoopOf` and `freezesEntryArgsOf`, both
 * in `derivations.ts` (they value-import `LOOP_DEFAULTS` from here) — so a new
 * loop kind or a default change is a single-row edit instead of a
 * multi-constructor scatter; a new loop kind added to the union without a row
 * here is a compile error.
 *
 * `satisfies` (NOT a type annotation) preserves the narrow inferred literal
 * type PER KEY (the same property `LOOP_STRATEGIES` relies on): `assess.max`
 * infers as `number` (from `DEFAULT_ASSESS_MAX`), while `fanout.max`/
 * `iterate.max` infer as `undefined`. The assess constructor therefore reads
 * `LOOP_DEFAULTS.assess.max` with NO non-null assertion.
 *
 * WARNING: if a future change annotates this constant with a type declaration
 * instead of `satisfies`, the narrow per-key types are lost and `assess.max`
 * widens to `number | undefined` — re-confirm the `satisfies` form is retained.
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
		max: checkedPositiveInt(opts.max, "fanout(): max"),
		onCap: firstDefined(opts.onCap, d.onCap),
		result: firstDefined(opts.result, d.result),
		...(opts.concurrency !== undefined
			? { concurrency: checkedPositiveInt(opts.concurrency, "fanout(): concurrency") }
			: {}),
		...(opts.depArtifactFlag !== undefined ? { depArtifactFlag: checkedDepArtifactFlag(opts.depArtifactFlag) } : {}),
		...(opts.failFast !== undefined ? { failFast: opts.failFast } : {}),
	};
}

/** A blank/whitespace flag would inject a bare ` <path>` with no marker — reject at construction. */
function checkedDepArtifactFlag(flag: string | undefined): string | undefined {
	if (flag === undefined) return undefined;
	requireNonEmptyString(flag, "fanout()", `depArtifactFlag must be a non-empty string (got ${JSON.stringify(flag)})`, {
		trim: true,
	});
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
		max: checkedPositiveInt(opts.max, "iterate(): max"),
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
		max: checkedPositiveInt(opts.max, "assess(): max") ?? d.max,
		onCap: firstDefined(opts.onCap, d.onCap),
		result: firstDefined(opts.result, d.result),
	};
}

/**
 * THE panel-vs-single judge-slot shape dispatch — the single place a judge
 * slot's panel-vs-single branch is decided. Mirrors `judgeSlotSpecOf`
 * (`loops/introspection.ts`), the introspection-facet twin: both route an
 * `AnyJudge` slot through one panel-vs-single branch (a panel →
 * `panelShapeIssues`, a single judge → `judgeShapeIssues`). Consulted by all
 * three judge-slot shape sites — `assessShapeIssues` (here), `verifyShapeIssues`
 * (`loops/verify.ts`), and the assess load gate (`validate/stage-rules.ts`
 * `checkLoopInvariants`) — so the wording can never drift between the
 * construction and load-gate paths (the same divergence class the
 * `forEachJudgeChannel` extraction caught).
 *
 * `slot` is `unknown` ON PURPOSE — the call sites feed it jiti-loaded literals
 * whose TS types are erased, NOT a typed `AnyJudge` (cf. `judgeSlotSpecOf`,
 * whose param IS the typed `AnyJudge` and therefore needs no guard). The
 * `slot &&` guard is load-bearing: `isPanel` (`judge.ts`) is
 * `(j) => (j as PanelJudge).kind === "panel"` with NO null guard, so a
 * hand-rolled assess/verify literal MISSING its `judge` field must fall through
 * to `judgeShapeIssues(undefined)` = `["a judge object is required"]` rather
 * than throw a raw `TypeError`. Dropping the guard would regress that clean
 * message into an uncaught `TypeError`.
 *
 * Internal-only posture matching `assessShapeIssues`: module-exported and
 * barrel-re-exported via `loop-constructors.ts` (so the load gate reaches it
 * through the existing `../loop-constructors.js` import), but deliberately NOT
 * added to `registration.ts` — the public judge-slot projection stays
 * `judgeSlotSpecOf`.
 */
export function judgeSlotShapeIssues(slot: unknown): string[] {
	return slot && isPanel(slot as AnyJudge) ? panelShapeIssues(slot) : judgeShapeIssues(slot);
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
 * per-code surface the tests pin (`validate-workflow.test.ts`).
 */
export function assessShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["an assess object is required"];
	const a = candidate as Partial<AssessOptions>;
	const judgeIssues = judgeSlotShapeIssues(a.judge);
	const issues: string[] = [...judgeIssues];
	if (typeof a.done !== "function") {
		issues.push("`done` must be a function deciding termination from the verdict");
	}
	if (typeof a.feedForward !== "function") {
		issues.push("`feedForward` must be a function building the next producer arg");
	}
	return issues;
}

/**
 * Construction-time positive-int gate for `max`/`concurrency` — the single
 * spelling of the "integer >= 1" check across all three constructors. Throws
 * at construction (the `defineRoute` pattern).
 *
 * Deliberately NOT unified with the load-gate per-code reports
 * (`validate/stage-rules.ts` `loop-max-invalid`,
 * `loop-concurrency-invalid`) or the `loops/verify.ts` collect-all probe —
 * those are a different layer (collect-all + per-code messaging), mirroring the
 * `assessShapeIssues` DECISION-OF-RECORD posture. Internal-only: module-private,
 * NOT exported from `registration.ts`.
 *
 * The `label` is the full origin+field prefix (e.g. `"fanout(): max"`); the
 * throw message is `` `${label} must be an integer >= 1 (got ${value})` ``.
 */
function checkedPositiveInt(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be an integer >= 1 (got ${value})`);
	}
	return value;
}
