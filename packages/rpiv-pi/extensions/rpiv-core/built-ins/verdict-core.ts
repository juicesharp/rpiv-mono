/**
 * Gate layer 1 of the acyclic gates layering (verdict-core → gate-rosters →
 * gate-passes; the `gates.ts` facade re-exports the composed surface): the
 * dimension rosters and the verdict micro-folds every layer above builds on —
 * channel micro-readers, artifact-freshness folds, the anchor-nit clamp, and
 * `verdictBlocks`, THE shared blocking predicate. Pure state-reading folds —
 * no fs I/O, no LLM.
 */
import { basename } from "node:path";
import { handleToString, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { latestFsArtifact } from "./shared.js";

/**
 * The single LLM dimension the EARLY gate grades the slice map against — before
 * any design. `design-readiness` asks the one question the whole gate exists to
 * answer: is each slice chewable by ONE `design-slice` pass? It subsumes the old
 * four-way panel (right-sizing + vertical-shape + design-readiness + the
 * contract-ownership half of independence) into one holistic judgment — taking
 * its own name from that design-readiness member, the dominant sub-aspect — so
 * the formerly-opposing split-pressure (right-sizing) and merge-pressure
 * (vertical-shape) forces are reconciled by ONE grader instead of two blind
 * panelists that ping-pong the reslice loop. The structural floor that was the
 * other half of independence — dependency-cycle freedom — plus brief-coverage
 * conservation are enforced DETERMINISTICALLY by `slice-check`, not graded
 * here. Mirrors the `design-readiness` rubric row in the `grade` skill.
 */
export const SLICE_DIMENSIONS = ["design-readiness"] as const;

/**
 * Quality dimensions the LATER gate grades the synthesized plan against.
 * Includes `architecture-fit`: build front-loads a `research` stage, so the
 * research artifact is always present to feed that dimension's `--context`
 * (threaded in by `gradePanelFanout` for this one dimension).
 */
export const PLAN_DIMENSIONS = [
	"completeness",
	"correctness",
	"actionability",
	"pattern-following",
	"architecture-fit",
] as const;

/**
 * The FIXED three-dimension roster ship's grade panel grades — the bespoke,
 * tier-independent counterpart of `PLAN_DIMENSIONS`. Ship is a lightweight
 * preset: it front-loads `research` (so `architecture-fit` always has its
 * `--context`) and grades a trimmed, always-on set regardless of run shape.
 * `SHIP_DIMENSION_FANOUT` and `shipGatePasses` bind this roster DIRECTLY — no
 * `gateRoster(gateTier(...))` wrap — so a single-phase ship run still grades
 * `architecture-fit`, the dimension a tiered gate would drop in the light
 * roster. Order mirrors `PLAN_DIMENSIONS` (goal-anchored dimensions first,
 * fit last) so the emitted units stay stable.
 */
export const SHIP_DIMENSIONS = ["completeness", "correctness", "architecture-fit"] as const;

/**
 * The plan-authored risk-flag ruling unit, split OUT of `correctness` so the
 * two judgments run as concurrent panel members instead of one serial judge.
 * Across 175 build panels the correctness unit finished last in 140 (80%), at
 * 2.2× the median sibling with no flags and no prior, and the risk-ruling +
 * prior-adjudication duties added ~1.7 min on top (4.9 → 6.6 min p50) — the
 * panel's wall time IS the correctness unit's. This dimension rules every
 * `risks:` flag (the mechanics-evidence and verify-at-implement duties move
 * with it, see the `grade` skill), adjudicates its OWN prior rulings on a
 * re-grade, and emits `risk_rulings` — the field every risk fold reads
 * (`allRiskFlagsPass`, `dimensionsToRegrade` clause 3, `confirmDue`,
 * `demoteDuties`, amend's cite derivation). Correctness keeps only its
 * semantic three-class findings. Dispatched ONLY when the graded channel's
 * latest record declares `risks:` (`panelRoster`) — a plan with no flags
 * pays for no unit — and at EVERY tier when it does (the light roster used to
 * rule risks through its correctness member; the duty follows the split). A
 * legacy trail whose correctness verdicts still carry `risk_rulings` folds
 * unchanged: every risk fold is dimension-agnostic.
 */
export const RISK_DIMENSION = "risk-rulings" as const;

/**
 * The two dimensions the grade panels anchor against the verbatim brief.
 * "Complete" and "correct" MEAN "against what the user asked" — without the
 * goal, completeness grades the plan against the plan's own claims. The other
 * dimensions (and the slice gate's `design-readiness`) deliberately stay
 * goal-blind: fit/actionability/pattern-following judge the artifact against
 * the codebase, and an ambient goal at those seams invites scope inflation.
 */
export const GOAL_DIMENSIONS: ReadonlySet<string> = new Set(["completeness", "correctness"]);

/** Latest `data` record published under `name` (undefined when absent/non-record). */
export const latestChannelData = (state: RunView, name: string): Record<string, unknown> | undefined => {
	const data = state.named[name]?.at(-1)?.data;
	return data !== null && typeof data === "object" && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: undefined;
};

/** A finite numeric field off the latest `data` on `name` (undefined otherwise). */
export const channelNumber = (state: RunView, name: string, field: string): number | undefined => {
	const v = latestChannelData(state, name)?.[field];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Repo-relative path of the latest fs artifact on `name` (undefined if none). */
export const latestArtifactPath = (state: RunView, name: string): string | undefined => {
	const a = latestFsArtifact(state, name);
	return a?.handle.kind === "fs" ? handleToString(a.handle) : undefined;
};

/**
 * Drop verdicts judged against an artifact the channel has since REPLACED. A
 * grade verdict embeds the `artifact` path it judged; when a fix REGENERATES
 * the artifact (`slice-fix` re-slices to a NEW file) a passing verdict on the
 * old document must not carry forward to a document that was never judged —
 * the carry-forward would otherwise let a regenerated slice map skip its
 * design-readiness judgment entirely. An in-place `amend` keeps the path, so
 * the plan-fix/code-fix carry-forward is unaffected. A verdict without an
 * `artifact` field (older trails, the deterministic structure checks) is kept:
 * matching is the compat default.
 */
export const freshVerdicts = (entries: readonly Output[] = [], currentArtifact?: string): readonly Output[] => {
	if (!currentArtifact) return entries;
	const current = basename(currentArtifact);
	return entries.filter((o) => {
		const a = (o.data as { artifact?: unknown } | undefined)?.artifact;
		return typeof a !== "string" || a.length === 0 || basename(a) === current;
	});
};

/**
 * Latest verdict per dimension off an accumulated verdict channel — the shared
 * fold under `dimensionsToRegrade` (which dimensions still block) and the
 * confirm panels' `--prior` threading (which verdict file the confirming
 * grader must adjudicate).
 */
export const latestVerdictPerDimension = (entries: readonly Output[] = []): Map<string, Output> => {
	const latest = new Map<string, Output>();
	for (const o of entries) {
		const dim = (o.data as { dimension?: unknown } | undefined)?.dimension;
		if (typeof dim === "string") latest.set(dim, o);
	}
	return latest;
};

/**
 * Anchor-drift-nit phrasing, two tiers: only phrasings naming drift itself
 * count standalone; the location shapes (off-by-N, "is at line N", "line N is
 * the/a") also match REAL defects ("line 42 is a comment that falsely claims
 * X", "the loop bound is off by one") and count ONLY alongside citing-context
 * vocabulary — every observed drift nit has it, real-defect phrasings don't.
 * Do NOT widen, and do NOT promote a location shape to standalone.
 */
const ANCHOR_NIT_DRIFT_RE = /\bdrifted?\s+~?\d+\s+lines?\b|\bcitation (?:is )?drifted\b/i;
const ANCHOR_NIT_LOCATION_RE =
	/\boff[- ]by[- ](?:one|two|three|\d+)\b|(?::\d+|\bline \d+) is (?:the|a)\b|\bis at line \d+\b/i;
const ANCHOR_NIT_CITE_CONTEXT_RE = /\bcit(?:es?|ed|ation)\b|\banchor/i;

const isAnchorNitDetail = (detail: string): boolean =>
	ANCHOR_NIT_DRIFT_RE.test(detail) || (ANCHOR_NIT_LOCATION_RE.test(detail) && ANCHOR_NIT_CITE_CONTEXT_RE.test(detail));

/**
 * TRUE when a verdict carries ≥1 finding and EVERY finding is an anchor-drift
 * nit (`isAnchorNitDetail`). Such a verdict is severity-clamped to non-blocking
 * at the gate fold regardless of the grader's own `severity` — line-number
 * drift was measured at 34% of all grader findings with zero downstream harm,
 * and a mis-rated all-nit `medium` verdict buys a full fix round + re-grade
 * panel that repairs nothing. A verdict mixing a drift nit with ANY other
 * finding is untouched — the other finding may be the real blocker.
 */
export const anchorNitsOnly = (v: { findings?: unknown } | undefined): boolean => {
	const findings = Array.isArray(v?.findings) ? v.findings : [];
	return (
		findings.length > 0 &&
		findings.every((f) => {
			const detail = (f as { detail?: unknown } | undefined)?.detail;
			return typeof detail === "string" && isAnchorNitDetail(detail);
		})
	);
};

/**
 * The shared verdict shape every blocking fold reads: `pass` (the grader's
 * free-judgment boolean), `severity` (the graded bar — `low`/`none` never
 * block), and `findings` (the anchor-nit clamp's input). Consumers narrow
 * further at their own cast (`allDimensionsPass` also reads `dimension`), so
 * the dead-unit sentinel shape — a dimension label with none of these
 * fields — still satisfies it.
 */
export type VerdictRecord = { pass?: boolean; severity?: string; findings?: unknown };

/**
 * The ONE blocking predicate over a grade verdict's own fields: a verdict
 * blocks UNLESS its `pass` is `true`, its severity sits at the `low`/`none`
 * floor, or the anchor-nit clamp applies (every finding a drift nit).
 * `dimensionsToRegrade`, `allDimensionsPass`, `confirmDue`, and ship's
 * `shipGradeStopNote` all fold through this single definition, so the
 * re-grade list, the gate folds, the confirm arm, and the stop note can
 * never drift apart (each site used to hand-roll the same disjunction).
 * Deliberately RISK-BLIND: `risk_rulings` compose ON TOP only where owed
 * (`confirmDue`), never folded in here. A record with none of the three
 * exits — a dimension-bearing sentinel, an older bare trail — reads
 * BLOCKING: fail-safe, same direction as a failed verdict.
 */
export const verdictBlocks = (v: VerdictRecord | undefined): boolean =>
	!(v?.pass === true || v?.severity === "low" || v?.severity === "none" || anchorNitsOnly(v));
