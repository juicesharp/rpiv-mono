/**
 * Loop constructors + introspection — control flow as data, completed.
 *
 * `fanout()` / `iterate()` / `assess()` build the `LoopDef` a stage carries on
 * its single `loop` field; `verify()` builds the `VerifySpec` a stage carries
 * on its `verify` field. Unlike the retired spec-attaching builders (which
 * ATTACHED a `.spec` to a bare function), the LoopDef IS data with
 * function-valued fields — the spec is the source of truth in the
 * constructor, so introspection can never lag a new loop kind. `loopSpecOf`
 * projects the pure-data facet.
 *
 * Constructors validate at construction (the `defineRoute` pattern): a bad
 * `max`, an invalid judge shape, or a non-function `done`/`feedForward`
 * throws immediately at authoring time. Load-time validation re-checks the
 * same rules defensively for hand-rolled literals (jiti erases TS types).
 *
 * Skill-agnostic: the unit detectors (`units`/`next`) are consumer-supplied;
 * rpiv-workflow ships no conventions. Runner-free — safe on `registration`.
 */

import { type Static, Type } from "typebox";
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
import {
	type AnyJudge,
	assertShape,
	brandCanonicalFold,
	type CanonicalFoldName,
	canonicalFoldName,
	type FoldFn,
	isPanel,
	type Judge,
	judgeShapeIssues,
	marksCanonicalFold,
	type NamedOutcome,
	type PanelJudge,
	panelMembers,
} from "./judge.js";
import { noopCollector } from "./outcomes/index.js";
import type { Output } from "./output.js";
import { readName, readsAll } from "./stage-def.js";

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
	 * A `panel()` post-condition projects a `PanelJudgeSpec` here (still + `max`).
	 */
	verify?: AnyJudgeSpec & { max: number };
	/**
	 * Present iff the stage declares `reads:`. One entry per read, in declared
	 * order, carrying the normalized channel `name` and `all` (true ⇒ a
	 * `fanin()` read that consumes EVERY accumulated entry — the fan-in barrier;
	 * false ⇒ latest-wins). Pure data — the preview layer renders the marker.
	 */
	reads?: ReadonlyArray<{ name: string; all: boolean }>;
	/**
	 * Outgoing-edge shape. `mode: "terminal"` is the GRAPH-SINK sense (a stage
	 * with no outgoing edge OR an explicit `STOP`) — unrelated to the `terminal()`
	 * stage factory (stage-def.ts) and to "terminal failure" run-outcome prose
	 * (audit.ts). See the glossary on `stage-def.ts`'s `terminal` export.
	 */
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
			// Graph-sink sense (no edge OR explicit STOP) — see `StageShape.edge`.
			edge = { mode: "terminal" };
		} else if (typeof target === "string") {
			edge = { mode: "linear", targets: [target] };
		} else {
			edge = { mode: "route", targets: (target as EdgeFn).targets };
		}

		const reads = stage.reads?.map((r) => ({ name: readName(r), all: readsAll(r) }));
		return {
			stage: name,
			skill: stage.skill,
			control,
			...(stage.verify ? { verify: { ...judgeSlotSpecOf(stage.verify.judge), max: stage.verify.max ?? 1 } } : {}),
			...(reads?.length ? { reads } : {}),
			edge,
		};
	});
}

// ===========================================================================
// Loop constructors — fanout() / iterate() / assess() build StageDef.loop
// ===========================================================================

/** Default round cap when an `assess()` call omits `max`. Clamped by `run.maxIterations`. */
export const DEFAULT_ASSESS_MAX = 8;

/**
 * Per-loop-kind identity — the construction-facet twin of `LOOP_STRATEGIES`
 * (`loop-kinds.ts`, the per-kind runtime strategy table). Each kind's default
 * `onCap`/`result` (and assess's construction `max`) live HERE, consulted by
 * every constructor, so a new loop kind or a default change is a single-row
 * edit instead of a multi-constructor scatter. Co-located with
 * `effectiveLoopOf` (the derivation-authority exemplar) and `freezesEntryArgsOf`
 * (the round-0-arg rule) — the two derivations that consult it.
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
const LOOP_DEFAULTS = {
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
const VERIFY_LOOP_DEFAULTS = {
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

/**
 * THE round-0-entry-arg predicate — one spelling of "which kinds freeze a
 * producer arg." Consulted by the three live/resume entry sites
 * (`run-stage.ts`, `resume.ts`, `resume-loop.ts`) instead of re-spelling
 * `loop.kind === "assess"`, so live and resume can no longer drift on the rule.
 */
export const freezesEntryArgsOf = (loop: LoopDef): boolean => LOOP_DEFAULTS[loop.kind].freezesEntryArgs;

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
		...(opts.failFast !== undefined ? { failFast: opts.failFast } : {}),
	};
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
 * types). `assess` was previously the only judge-bearing constructor without a
 * rule source (inline `typeof` throws); this restores family uniformity so
 * judge/assess/verify/panel each pair a `*ShapeIssues` source with `assertShape`.
 * NOTE: the load gate (`validate/stage-rules.ts`) keeps its own per-code assess
 * reporting (`assess-judge-shape`/`assess-done-not-function`/`assess-feed-forward-not-function`);
 * it does NOT consume this source — adopting it would change the public issue-code
 * surface (tests at `validate-workflow.test.ts:923,928` pin the current codes).
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
	assertShape("verify", verifyShapeIssues(spec));
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
	// The judge slot is an `AnyJudge` — route a panel through `panelShapeIssues`,
	// a single judge through `judgeShapeIssues` (one rule source per shape).
	const judgeIssues = v.judge && isPanel(v.judge) ? panelShapeIssues(v.judge) : judgeShapeIssues(v.judge);
	const issues: string[] = [...judgeIssues];
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
	const d = VERIFY_LOOP_DEFAULTS;
	return {
		kind: "assess",
		judge: v.judge,
		done: v.done,
		feedForward: v.feedForward ?? NEVER_FEED_FORWARD,
		max: v.max ?? d.max,
		onCap: d.onCap,
		result: d.result,
	};
}

// ===========================================================================
// Panel — N independent judges + a vote fold (the adversarial generalization
// of a single judge). Construction + the canonical verdict surface live here;
// execution (cursor sub-state, member dispatch, fold-close publish) lands in
// later phases behind the one `panelMembers` expander.
// ===========================================================================

/**
 * The canonical fold output shape — what `majority`/`all`/`any` emit and what
 * a downstream `defineRoute`/`gate`/`match` branches on. `agreement` (|majority|
 * / N) is the first-class disagreement signal; `tie` flags an even split. A
 * custom (raw) fold publishes the author's own schema instead (the XOR rule).
 */
export const PANEL_VERDICT = Type.Object({
	pass: Type.Boolean(),
	votes: Type.Object({ pass: Type.Integer(), fail: Type.Integer() }),
	agreement: Type.Number(),
	tie: Type.Boolean(),
});

/** Static type of the canonical {@link PANEL_VERDICT} fold output. */
export type PanelVerdict = Static<typeof PANEL_VERDICT>;

/**
 * Built-in named outcome the CANONICAL path publishes under — the default a
 * sugar panel resolves to (`judge.outcome ?? PANEL_VERDICT_OUTCOME`, wired in
 * the panel-close publish phase). Its `name` is a fallback: the live publish
 * overrides it with the per-stage `<stage>-panel` channel, so distinct panel
 * stages never collide. The collector is a no-op — the fold output is
 * manufactured from the member verdicts (data, not a collected artifact), so
 * nothing is ever collected on this outcome.
 */
export const PANEL_VERDICT_OUTCOME: NamedOutcome = {
	name: "panel-verdict",
	collector: noopCollector,
};

/**
 * Tally the members' per-member `pred` results into the canonical verdict
 * shape. `votes`/`agreement`/`tie` are fold-independent (they describe the
 * split); only `pass` differs per sugar fold, supplied by `passWhen`.
 */
function tally(
	verdicts: readonly Output[],
	pred: (v: Output) => boolean,
	passWhen: (pass: number, fail: number) => boolean,
): PanelVerdict {
	const n = verdicts.length;
	const pass = verdicts.reduce((c, v) => c + (pred(v) ? 1 : 0), 0);
	const fail = n - pass;
	return {
		pass: passWhen(pass, fail),
		votes: { pass, fail },
		agreement: n === 0 ? 0 : Math.max(pass, fail) / n,
		tie: pass === fail,
	};
}

/**
 * Sugar fold — the panel passes iff a STRICT majority of members pass `pred`
 * (an even split is a tie ⇒ fail, surfaced via `tie`/`agreement`). The
 * per-member `pred` interprets each member's OWN verdict schema (no convention
 * on members); the fold's output is the canonical {@link PANEL_VERDICT}. Branded
 * canonical, so pairing it with an explicit `outcome` is a construction error.
 */
export function majority(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("majority", (verdicts) => tally(verdicts, pred, (pass, fail) => pass > fail));
}

/** Sugar fold — unanimous: the panel passes iff EVERY member passes `pred` (one fail vetoes). */
export function all(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("all", (verdicts) => tally(verdicts, pred, (pass, fail) => pass > 0 && fail === 0));
}

/** Sugar fold — veto/rescue: the panel passes iff ANY member passes `pred` (one pass carries it). */
export function any(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("any", (verdicts) => tally(verdicts, pred, (pass) => pass > 0));
}

/**
 * Single rule source for the panel shape — mirrors `judgeShapeIssues` /
 * `verifyShapeIssues`. Returns human-readable violations (empty = valid);
 * `panel()` throws on the first, `validateWorkflow` maps each to a load issue
 * for hand-rolled literals. Takes `unknown` ON PURPOSE: typed call sites are
 * already guarded by the `PanelJudge` type, so everything reaching here is an
 * untyped jiti-loaded literal.
 *
 * Enforces: a non-empty `members` array, each member a VALID single judge with
 * NO nesting (`members` is `Judge[]`), a function `fold`, and the XOR rule
 * (canonical sugar ⊕ `outcome` — exactly one names the verdict schema/channel).
 */
export function panelShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a panel object is required"];
	const p = candidate as { members?: unknown; fold?: unknown; outcome?: { name?: unknown } };
	const issues: string[] = [];

	if (!Array.isArray(p.members) || p.members.length === 0) {
		issues.push("panel.members must be a non-empty array of judges");
	} else {
		for (const m of p.members) {
			if (m && typeof m === "object" && (m as PanelJudge).kind === "panel") {
				issues.push("panel.members may not nest another panel — members are single judges (skill or prompt)");
				continue;
			}
			for (const issue of judgeShapeIssues(m)) issues.push(`panel member: ${issue}`);
		}
	}

	const foldIsFn = typeof p.fold === "function";
	if (!foldIsFn) {
		issues.push("panel.fold must be a function reducing the member verdicts to the panel's decision");
	}

	// The XOR rule — a sugar fold OWNS the canonical verdict (no `outcome`); a raw
	// fold REQUIRES an `outcome` to name + validate its channel. Never both.
	const isSugar = foldIsFn && marksCanonicalFold(p.fold as FoldFn);
	const hasOutcome = p.outcome !== undefined;
	if (isSugar && hasOutcome) {
		issues.push(
			"a canonical fold (majority/all/any) publishes the built-in PANEL_VERDICT — drop `outcome` (sugar ⊕ outcome)",
		);
	}
	if (foldIsFn && !isSugar && !hasOutcome) {
		issues.push("a custom (raw) fold requires an `outcome` naming + validating its verdict channel (raw ⊕ outcome)");
	}
	if (hasOutcome && !p.outcome?.name) {
		issues.push("panel.outcome must carry a `name` so the folded verdict publishes to its own named channel");
	}

	return issues;
}

/** Authoring input for {@link panel} — the `PanelJudge` minus the injected `kind` discriminator. */
export interface PanelSpec {
	members: readonly Judge[];
	fold: FoldFn;
	outcome?: NamedOutcome;
}

/**
 * Promote a panel literal to a validated `PanelJudge` — injects the
 * `kind: "panel"` discriminator and throws on the first shape issue, so a
 * `panel(...)`-authored value is correct by construction (cf. `judge()` /
 * `defineRoute`). The judge SITES already accept it through the widened
 * `AnyJudge` slot; their member dispatch + fold-close publish arrive in the
 * execution phases, so `assess`/`verify` don't yet route a panel here.
 */
export function panel(spec: PanelSpec): PanelJudge {
	const candidate: PanelJudge = { kind: "panel", ...spec };
	assertShape("panel", panelShapeIssues(candidate));
	return candidate;
}

/**
 * The channel a panel's FOLDED verdict publishes to — the author's
 * `outcome.name` on the custom path, or the `<stage>-panel` convention on the
 * canonical path (sugar fold, no `outcome`). ONE definition so the load gate
 * (`validateWorkflow`) and the panel-close publish (later phases) can never
 * drift on the name. Member verdicts publish to their OWN `outcome.name`
 * channels; this is only the fold's slot.
 */
export function panelVerdictChannel(p: PanelJudge, stageName: string): string {
	return p.outcome?.name ?? `${stageName}-panel`;
}

/**
 * Synthetic `produces` def the panel-close publish lands the FOLDED verdict
 * under — the twin of `judgeStageDef` (which a single MEMBER runs on). The
 * publish channel is resolved ONCE through {@link panelVerdictChannel} and baked
 * into `outcome.name`, so the canonical path's per-stage `<stage>-panel` channel
 * OVERRIDES `PANEL_VERDICT_OUTCOME`'s fallback name (distinct panel stages never
 * collide) and the custom path keeps the author's own `outcome`. The folded
 * Output carries no artifact, so `applyCompletedStage` leaves the rolling primary
 * untouched and only appends to the named channel. ONE construction site —
 * the live publish (`loop.ts`) and the resume fold (`runner/resume.ts`) share it,
 * so the two paths can never drift on the def or the channel.
 */
export function panelVerdictDef(p: PanelJudge, stageName: string): StageDef {
	const base = p.outcome ?? PANEL_VERDICT_OUTCOME;
	return { kind: "produces", outcome: { ...base, name: panelVerdictChannel(p, stageName) }, sessionPolicy: "fresh" };
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
	const slot = judgeSlotOf(stage);
	// Panel widening: collapse the `AnyJudge` slot to its member-0
	// view so the single-`Judge` consumers not yet panel-aware (introspection,
	// contract-compat) keep their signature. For a single judge this is an
	// identity; panel-aware sites use `judgeSlotOf` to see the whole panel.
	return slot ? panelMembers(slot)[0] : undefined;
}

/**
 * THE judge-SLOT-of-stage derivation — the RAW `AnyJudge` (a single `Judge` or
 * an N-member `PanelJudge`) a stage carries, before any member collapse. Twin
 * of `judgeOf`, which returns its member-0 view; panel-aware sites (the load
 * gate's channel rules, `publishedNamesOf`) read the whole slot through this.
 */
export function judgeSlotOf(stage: StageDef): AnyJudge | undefined {
	return stage.loop?.kind === "assess" ? stage.loop.judge : stage.verify?.judge;
}

/**
 * Enumerate the verdict channels a stage's judge slot publishes, each with the
 * skill that SIGNS it — `undefined` for the manufactured panel-fold channel
 * (`panelVerdictChannel`), which is data-only and carries no producer contract.
 * THE single judge-publisher walk: `publishedNamesOf` (load reachability —
 * consumes EVERY channel) and `checkReadsChannelCompat`'s publisher index
 * (contract adjudication — consumes only SIGNED channels) both read it, so a
 * panel-member channel can no longer be seen by one and missed by the other. The
 * contract-compat index used to walk only member-0 (via `judgeOf`), silently
 * skipping panel members 1..N-1 and the fold — that gap closes here.
 */
export function forEachJudgeChannel(
	stage: StageDef,
	name: string,
	visit: (channel: string, signingSkill: string | undefined) => void,
): void {
	const slot = judgeSlotOf(stage);
	if (!slot) return;
	if (isPanel(slot)) {
		for (const m of slot.members) if (m?.outcome?.name) visit(m.outcome.name, m.skill);
		visit(panelVerdictChannel(slot, name), undefined); // manufactured fold — unsigned
	} else if (slot.outcome?.name) {
		visit(slot.outcome.name, slot.skill);
	}
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

/**
 * Pure-data summary of an N-member panel — the introspection twin of
 * `PanelJudge`. `panel` carries one `JudgeSpec` per member; `fold` is the sugar
 * name (`majority`/`all`/`any`) for a canonical fold, `"custom"` for a raw
 * author fold; `outcome` is the custom verdict channel, or `""` when the panel
 * uses the canonical `<stage>-panel` default. Discriminated from `JudgeSpec` by
 * the presence of `panel`.
 */
export interface PanelJudgeSpec {
	panel: JudgeSpec[];
	fold: CanonicalFoldName | "custom";
	outcome: string;
}

/** Pure-data summary of a judge SLOT — a single judge or a panel (the introspection twin of `AnyJudge`). */
export type AnyJudgeSpec = JudgeSpec | PanelJudgeSpec;

/**
 * Project the introspectable facet off a Judge — shared by `loopSpecOf` and the
 * `StageShape.verify` projection so the two can't drift. Defensive on `outcome`:
 * `validateWorkflow`'s lints run this over UNVALIDATED configs (a malformed
 * member can lack `outcome` entirely), so a projection must never throw.
 */
export function judgeSpecOf(judge: Judge): JudgeSpec {
	return { skill: judge.skill, prompt: judge.prompt !== undefined, outcome: judge.outcome?.name ?? "" };
}

/**
 * Project the introspectable facet off a panel — member summaries + fold flavor
 * + verdict channel. Defensive (like `judgeSpecOf`): a hand-rolled panel reaching
 * a load-time lint may carry a non-array `members` or non-function `fold`.
 */
export function panelSpecOf(p: PanelJudge): PanelJudgeSpec {
	const members = Array.isArray(p.members) ? p.members : [];
	return {
		panel: members.map(judgeSpecOf),
		fold: typeof p.fold === "function" ? (canonicalFoldName(p.fold) ?? "custom") : "custom",
		outcome: p.outcome?.name ?? "",
	};
}

/** Project the introspectable facet off a judge SLOT — a panel through `panelSpecOf`, a single judge through `judgeSpecOf`. */
export function judgeSlotSpecOf(slot: AnyJudge): AnyJudgeSpec {
	return isPanel(slot) ? panelSpecOf(slot) : judgeSpecOf(slot);
}

export interface LoopSpec {
	kind: LoopDef["kind"];
	source?: string;
	unit?: UnitSelector;
	max?: number;
	onCap: CapPolicy;
	result: ResultProjection;
	judge?: AnyJudgeSpec;
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
	if (loop.kind === "assess") base.judge = judgeSlotSpecOf(loop.judge);
	return base;
}
