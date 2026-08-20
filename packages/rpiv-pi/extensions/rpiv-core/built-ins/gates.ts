/**
 * The deterministic gate layer the built-in workflows' quality gates consult:
 * dimension rosters, tier machinery, verdict folds, risk-duty folds, and the
 * per-gate pass predicates. Pure state-reading folds — no fs I/O, no LLM.
 */
import { basename } from "node:path";
import { handleToString, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { FILE_LINE_CITATION_RE, latestFsArtifact } from "./shared.js";

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
const SLICE_DIMENSIONS = ["design-readiness"] as const;

/**
 * Quality dimensions the LATER gate grades the synthesized plan against.
 * Includes `architecture-fit`: build front-loads a `research` stage, so the
 * research artifact is always present to feed that dimension's `--context`
 * (threaded in by `gradePanelFanout` for this one dimension).
 */
const PLAN_DIMENSIONS = [
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
 * The two dimensions the grade panels anchor against the verbatim brief.
 * "Complete" and "correct" MEAN "against what the user asked" — without the
 * goal, completeness grades the plan against the plan's own claims. The other
 * dimensions (and the slice gate's `design-readiness`) deliberately stay
 * goal-blind: fit/actionability/pattern-following judge the artifact against
 * the codebase, and an ambient goal at those seams invites scope inflation.
 */
const GOAL_DIMENSIONS: ReadonlySet<string> = new Set(["completeness", "correctness"]);

// ---------------------------------------------------------------------------
// Adaptive gate scaling — tier, roster, verdict freshness.
// ---------------------------------------------------------------------------

/** Latest `data` record published under `name` (undefined when absent/non-record). */
const latestChannelData = (state: RunView, name: string): Record<string, unknown> | undefined => {
	const data = state.named[name]?.at(-1)?.data;
	return data !== null && typeof data === "object" && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: undefined;
};

/** A finite numeric field off the latest `data` on `name` (undefined otherwise). */
const channelNumber = (state: RunView, name: string, field: string): number | undefined => {
	const v = latestChannelData(state, name)?.[field];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Repo-relative path of the latest fs artifact on `name` (undefined if none). */
const latestArtifactPath = (state: RunView, name: string): string | undefined => {
	const a = latestFsArtifact(state, name);
	return a?.handle.kind === "fs" ? handleToString(a.handle) : undefined;
};

/**
 * Gate scrutiny tier, derived ONLY from signals already replayed by the resume
 * fold (the slices/plans channels' frontmatter data and the gate's own verdict
 * severities) — deterministic by construction, so routes and fanout units that
 * consult it stay resume-safe.
 *
 * `risks:` flags are deliberately NOT a tier signal: `synthesize` declares
 * them routinely (observed: 1-phase plans shipping 2-3 flags), so counting
 * them would push every small run out of the light tier. Risk flags are
 * already force-ruled per dimension via `risk_rulings`, and a blocking
 * verdict lifts the tier on its own (below).
 *
 * A missing signal never yields light, and verdict severities are read over
 * the FULL channel history (a stale medium/high is still evidence of a risky
 * run) — ambiguity always resolves toward more scrutiny.
 */
type GateTier = "light" | "standard" | "strict";
const TIER_LIGHT_MAX_SLICES = 1;
const TIER_LIGHT_MAX_PHASES = 2;
const TIER_STRICT_MIN_SLICES = 5;
const TIER_STRICT_MIN_PHASES = 6;

/**
 * The dimensions a light-tier run still grades: correctness and completeness
 * are the two whose failures ship real defects (and the two that anchor on the
 * goal); fit/actionability/pattern-following are low-consequence on a
 * one-slice, <=2-phase diff, and `validate` still runs at every tier.
 */
const LIGHT_ROSTER: ReadonlySet<string> = new Set(["correctness", "completeness"]);

const gateTier = (state: RunView, verdictChannel: string): GateTier => {
	const slices = channelNumber(state, "slices", "slice_count");
	const phases = channelNumber(state, "plans", "phase_count");
	const severities = new Set<string>();
	for (const o of state.named[verdictChannel] ?? []) {
		const v = o.data as { severity?: unknown; findings?: unknown } | undefined;
		const s = v?.severity;
		// Anchor-nit clamp: an all-drift-nit verdict must not escalate the tier.
		if (typeof s === "string") severities.add(anchorNitsOnly(v) ? "low" : s);
	}
	if (
		(slices !== undefined && slices >= TIER_STRICT_MIN_SLICES) ||
		(phases !== undefined && phases >= TIER_STRICT_MIN_PHASES) ||
		severities.has("high")
	) {
		return "strict";
	}
	if (
		slices !== undefined &&
		slices <= TIER_LIGHT_MAX_SLICES &&
		phases !== undefined &&
		phases <= TIER_LIGHT_MAX_PHASES &&
		!severities.has("medium")
	) {
		return "light";
	}
	return "standard";
};

/**
 * The subset of `dimensions` the tier actually grades. Never empty: a
 * dimension list with no light-roster member (the slice gate's lone
 * `design-readiness`) keeps its full list at every tier.
 */
const gateRoster = (tier: GateTier, dimensions: readonly string[]): readonly string[] => {
	if (tier !== "light") return dimensions;
	const light = dimensions.filter((d) => LIGHT_ROSTER.has(d));
	return light.length > 0 ? light : dimensions;
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
const freshVerdicts = (entries: readonly Output[] = [], currentArtifact?: string): readonly Output[] => {
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
const latestVerdictPerDimension = (entries: readonly Output[] = []): Map<string, Output> => {
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
const anchorNitsOnly = (v: { findings?: unknown } | undefined): boolean => {
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
 * The subset of `dimensions` a re-grade must actually re-run, given the latest
 * verdict per dimension accumulated so far. A dimension needs re-grading when it
 * has NO prior verdict (first pass ⇒ grade every dimension), when its latest
 * verdict fails above the severity floor, or when that verdict ruled any plan
 * risk flag `fail` (the ruling is re-opened by re-grading its owning dimension).
 * A dimension that already passed — dimension AND its risk rulings — is carried
 * forward untouched: re-running it after a surgical fix only re-rolls a free LLM
 * judgment that flaps pass↔fail on an unchanged artifact, manufacturing extra
 * loops (the observed correctness risk-flag flap). The accumulating verdict
 * channel + `allDimensionsPass`'s latest-per-dimension fold mean a carried
 * dimension's prior passing verdict still counts at the gate.
 */
const dimensionsToRegrade = (
	dimensions: readonly string[],
	latest: ReadonlyMap<string, Output>,
	risks: ReadonlyMap<string, RiskRecord> = new Map(),
): string[] => {
	return dimensions.filter((d) => {
		const o = latest.get(d);
		if (!o) return true; // never graded — must grade at least once
		const v = o.data as { pass?: boolean; severity?: string; findings?: unknown } | undefined;
		const dimPass = v?.pass === true || v?.severity === "low" || v?.severity === "none" || anchorNitsOnly(v);
		if (!dimPass) return true;
		return verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id)));
	});
};

/**
 * Fold the per-dimension verdicts into a gate decision: keep the latest verdict
 * per dimension (verdicts accumulate across fix loops), require all-pass.
 * Deterministic ⇒ resume-safe for a `readsData: false` route.
 *
 * Severity floor: a verdict whose worst finding is `low`/`none` never blocks the
 * gate, even when the grader set `pass: false` on a nit. `grade` decides `pass`
 * by a free judgment against a prose bar (independent of `severity`), so a
 * marginal dimension can flip pass↔fail across rounds on an unchanged artifact —
 * that flapping, ANDed over a 5-dimension panel, stalled the build gate loops
 * until the backward-jump guard halted them. Flooring on severity reserves a hard
 * fail for `medium`+ findings (the deterministic `slice-check` check emits
 * `high` on a real structural break, so it still blocks). A verdict with no
 * `severity` (an older or replayed grade) falls back to the raw `pass` boolean.
 */
const allDimensionsPass = (entries: readonly Output[] = [], roster?: readonly string[]): boolean => {
	// Roster-filtered when given: a verdict for a dimension outside the tier's
	// roster (a wider earlier round, a shrunk re-slice) neither blocks nor passes
	// a gate it no longer governs.
	const member = roster ? new Set(roster) : undefined;
	const latest = new Map<string, boolean>();
	for (const o of entries) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string") continue;
		if (member && !member.has(v.dimension)) continue;
		// The anchor-nit clamp: an all-drift-nit verdict never blocks, whatever
		// severity the grader typed (backstop for the citation-resolution rule).
		const lowOrNone = v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		latest.set(v.dimension, v.pass === true || lowOrNone);
	}
	const verdicts = [...latest.values()];
	return verdicts.length > 0 && verdicts.every(Boolean);
};

/**
 * One plan-authored risk flag ruled by a grade panel. The plan declares a
 * `risks:` frontmatter array (`{ id, claim }`) — the structured, first-class
 * channel that replaces the old prose-in-a-Notes-section flagging that graders
 * were free to skip. Each grade verdict that engages a flag emits a ruling here.
 */
interface RiskRuling {
	id: string;
	pass: boolean;
	/**
	 * `mechanics` marks a risk whose `pass` asserts a verified mechanism (a
	 * behavior that holds because code was checked), so a passing ruling MUST
	 * cite the checked `file:line` in `evidence` — an un-evidenced mechanics
	 * pass demotes. Absent on
	 * an ordinary risk ⇒ no evidence duty.
	 */
	claim_type?: string;
	/** The `file:line`-shaped citation a mechanics pass must ground itself on. */
	evidence?: string;
	/**
	 * `verify-at-implement` marks a risk the panel defers: ruled `pass` ONLY when
	 * a concrete `procedure` + `owner` phase will re-check it at implement/validate
	 * time. Absent ⇒ the risk is judged in this panel, not deferred.
	 */
	disposition?: string;
	/** Named command/test the owner phase runs to discharge a deferred risk. */
	procedure?: string;
	/** The phase (`n`) that owns the deferred verify step. */
	owner?: number;
}

/** The `risk_rulings` a grade verdict emitted (empty when it ruled on none). */
const verdictRiskRulings = (o: Output): RiskRuling[] => {
	const raw = (o.data as { risk_rulings?: unknown } | undefined)?.risk_rulings;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((e) => {
		const r = (e ?? {}) as Record<string, unknown>;
		if (typeof r.id !== "string") return [];
		// Read the duty fields defensively (same typeof-guard idiom as id/pass):
		// absent on an older/ordinary verdict ⇒ undefined ⇒ the duty helpers no-op.
		const claim_type = typeof r.claim_type === "string" ? r.claim_type : undefined;
		const evidence = typeof r.evidence === "string" ? r.evidence : undefined;
		const disposition = typeof r.disposition === "string" ? r.disposition : undefined;
		const procedure = typeof r.procedure === "string" ? r.procedure : undefined;
		const owner = typeof r.owner === "number" ? r.owner : undefined;
		return [
			{
				id: r.id,
				pass: r.pass === true,
				...(claim_type !== undefined ? { claim_type } : {}),
				...(evidence !== undefined ? { evidence } : {}),
				...(disposition !== undefined ? { disposition } : {}),
				...(procedure !== undefined ? { procedure } : {}),
				...(owner !== undefined ? { owner } : {}),
			},
		];
	});
};

/**
 * A plan-authored risk flag — the duty shape `synthesize` declares in the plan
 * frontmatter `risks:` array (`synthesize/SKILL.md:136`: `{ id, claim,
 * claim_type?, disposition?, procedure?, owner? }`). The prose `claim` is grading
 * copy, not a duty signal, so it is not carried here. `claim_type: "mechanics"`
 * and `disposition: "verify-at-implement"` are the two duty TRIGGERS — sourced
 * from the PLAN (not the ruling) so a panel cannot drop its discharge obligation
 * by simply omitting the field from its ruling (the dropped-duty bypass).
 */
interface RiskRecord {
	id: string;
	claim_type?: string;
	disposition?: string;
	procedure?: string;
	owner?: number;
}

/**
 * Read the plan-authored risk flags off the latest record on `channel`, keyed
 * by `id`. The duty triggers live HERE (the plan's `risks:` frontmatter), not on
 * the grade panel's ruling, so a ruling that drops its discharge field cannot
 * escape the duty the plan declared (a bare `{ id, pass }` ruling against a
 * plan-authored `claim_type: "mechanics"` risk still demotes). Reads only
 * `state.named[channel]` via `latestChannelData` — no `readFileSync`, no
 * `cwd`, no throw — so the route's `readsData: false` / determinism /
 * resume-safety contract holds and a resumed run re-evaluates identically.
 * Degrades to an empty map (fail-open ⇒ no duty ⇒ plain ruling ⇒
 * `rulingEffectivePass(r) === r.pass`) when `risks:` is absent/non-array/
 * malformed, mirroring `latestChannelData`'s degrade-to-undefined contract.
 */
const planAuthoredRisks = (state: RunView, channel: string): Map<string, RiskRecord> => {
	const risks = latestChannelData(state, channel)?.risks;
	const out = new Map<string, RiskRecord>();
	if (!Array.isArray(risks)) return out;
	for (const e of risks) {
		const r = (e ?? {}) as Record<string, unknown>;
		if (typeof r.id !== "string") continue;
		const claim_type = typeof r.claim_type === "string" ? r.claim_type : undefined;
		const disposition = typeof r.disposition === "string" ? r.disposition : undefined;
		const procedure = typeof r.procedure === "string" ? r.procedure : undefined;
		const owner = typeof r.owner === "number" ? r.owner : undefined;
		const rec: RiskRecord = { id: r.id };
		if (claim_type !== undefined) rec.claim_type = claim_type;
		if (disposition !== undefined) rec.disposition = disposition;
		if (procedure !== undefined) rec.procedure = procedure;
		if (owner !== undefined) rec.owner = owner;
		out.set(r.id, rec);
	}
	return out;
};

/**
 * A mechanics-pass ruling's evidence duty: when the plan AUTHORED a
 * `claim_type: "mechanics"` risk for the ruling's id, a `pass` ruling MUST
 * cite the checked `file:line` in `evidence` (forces engagement — a pass with
 * no evidence is an unverified mechanism). The trigger is sourced from the
 * plan-authored `RiskRecord`, NOT the ruling — so a panel cannot drop the
 * evidence duty by omitting `claim_type` from its ruling (the dropped-duty
 * bypass). Reuses `FILE_LINE_CITATION_RE` via `.match()` — NOT `.test()`: the
 * regex carries the `/g` flag, so `.test()` is stateful across calls
 * (`lastIndex` advances) and would
 * intermittently miss a present citation. An id with no authored mechanics
 * risk carries no evidence duty ⇒ returns `true`.
 */
const evidenceCitesFileLine = (r: RiskRuling, authored?: RiskRecord): boolean => {
	if (authored?.claim_type !== "mechanics") return true;
	return typeof r.evidence === "string" && r.evidence.match(FILE_LINE_CITATION_RE) !== null;
};

/**
 * A deferred-risk's verify-at-implement duty: when the plan AUTHORED a
 * `disposition: "verify-at-implement"` risk for the ruling's id, a `pass`
 * ruling MUST carry a concrete `procedure` (the named command/test the owner
 * phase runs) AND a numeric `owner` phase — a bare "verify later" with no
 * procedure demotes. The trigger is sourced from the plan-authored
 * `RiskRecord`, NOT the ruling (the dropped-duty bypass). An id with no
 * authored verify-at-implement risk is judged in THIS panel, not deferred ⇒
 * returns `true`.
 */
const procedureSatisfiesDuty = (r: RiskRuling, authored?: RiskRecord): boolean => {
	if (authored?.disposition !== "verify-at-implement") return true;
	return typeof r.procedure === "string" && r.procedure.length > 0 && typeof r.owner === "number";
};

/**
 * The single gate-fold authority: a ruling is effective-pass iff it is a bare
 * `pass` AND (when the plan authored a mechanics risk for its id) its evidence
 * cites a `file:line` AND (when the plan authored a verify-at-implement risk
 * for its id) its procedure+owner discharge the verify duty. `allRiskFlagsPass`,
 * `dimensionsToRegrade` clause 3, and `confirmDue`'s `riskFail` ALL consult this
 * — so the three risk folds agree on what "passing" means and a demoted
 * mechanics/deferred pass blocks the gate AND re-opens its owning dimension
 * AND counts as blocking for confirm (no incoherent re-grading). For a ruling
 * whose id the plan authored no duty for (no mechanics/verify-at-implement
 * risk, no `risks:` at all, or no matching id) every duty no-ops, so
 * `rulingEffectivePass(r, authored) === r.pass` — prior behavior is preserved.
 */
const rulingEffectivePass = (r: RiskRuling, authored?: RiskRecord): boolean =>
	r.pass === true && evidenceCitesFileLine(r, authored) && procedureSatisfiesDuty(r, authored);

/**
 * Fold the grade panel's per-flag risk rulings into a gate decision: every
 * plan-authored risk flag the panel ruled on must be ruled PASS (latest ruling
 * per flag wins, mirroring `allDimensionsPass`). A flag ruled `fail` — the
 * grader confirmed the risk is real and unaddressed — blocks the gate, so a
 * self-flagged risk (e.g. an override-vs-env validation mismatch) can no longer
 * ride a green conformance pass into commit. An empty panel (no flag engaged)
 * imposes no constraint; the plan simply declared no risks.
 */
const allRiskFlagsPass = (
	entries: readonly Output[] = [],
	risks: ReadonlyMap<string, RiskRecord> = new Map(),
): boolean => {
	const latest = new Map<string, boolean>();
	for (const o of entries)
		for (const r of verdictRiskRulings(o)) latest.set(r.id, rulingEffectivePass(r, risks.get(r.id)));
	return [...latest.values()].every(Boolean);
};

/**
 * The three gates' pass predicates — the SINGLE authority each gate consults at
 * BOTH of its seams. A gate is satisfied when its deterministic cite/structure
 * floor is green AND every quality dimension passes (severity-floored) AND — for
 * the plan/code gates — every plan-authored risk flag is ruled pass.
 *
 * Reading the identical predicate at the cite/structure-check edge (which SKIPS
 * the re-grade straight to the next stage) and at the grade edge (which gates
 * forward-vs-fix) makes the skip provably equivalent to "re-grade, then pass",
 * minus the wasted panel: after a fix that only cleared the deterministic floor,
 * the accumulated verdicts already clear the gate, so re-running the LLM panel
 * would at best reproduce them and at worst flap a passing dimension into a
 * spurious fix loop. On the FIRST pass the verdict channel is empty, so
 * `allDimensionsPass` returns false and the edge correctly routes INTO the grade
 * panel. Any regression a fix introduces is still caught downstream: the plan
 * gate by the full first-time `code-grade`, the code gate by `validate`.
 */
// Each predicate folds the verdicts still FRESH for the channel's current
// artifact, restricted to the tier's roster — the SAME projections the panel's
// `units()` uses, so "skip the re-grade" stays provably equivalent to
// "re-grade, then pass". The deterministic cite/structure channels fold
// unfiltered: they re-run every round and carry no tier.
// The latest structure verdict carries a `citeDischarged` stamp for the
// CURRENT slice map. After a fix for a `remedy: "cite"` fail, the failing
// design-readiness verdict is stale (the fix re-sliced to a NEW file) and the
// gate's lone dimension has no fresh verdict, so the verdict fold can never
// pass — yet the fix is deterministically verifiable: `sliceStructureCheck`
// stamps the map basename it verified (demanded seeds present + shape
// unchanged, see `citeRemedyDischarged`). Honoring the stamp only for the
// current map means it can never carry across a later re-slice.
const citeDischargeCoversCurrentMap = (state: RunView): boolean => {
	const stamp = (state.named["slice-check"]?.at(-1)?.data as { citeDischarged?: unknown } | undefined)?.citeDischarged;
	const current = latestArtifactPath(state, "slices");
	return typeof stamp === "string" && current !== undefined && stamp === basename(current);
};
const sliceGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["slice-verdicts"], latestArtifactPath(state, "slices"));
	const roster = gateRoster(gateTier(state, "slice-verdicts"), SLICE_DIMENSIONS);
	if (!allDimensionsPass(state.named["slice-check"])) return false;
	return allDimensionsPass(fresh, roster) || citeDischargeCoversCurrentMap(state);
};
// The single authority the new `subplan-check` edge consults — the twin of
// `sliceGatePasses`, but carrying no LLM-verdict roster or risk flags: the
// `subplan-check` floor is the sole (deterministic) dimension on its channel.
const subplanGatePasses = (state: RunView): boolean => allDimensionsPass(state.named["subplan-check"]);
const planGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["plan-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "plan-verdicts"), PLAN_DIMENSIONS);
	const risks = planAuthoredRisks(state, "plans");
	return (
		allDimensionsPass(state.named["plan-cite-check"]) &&
		allDimensionsPass(fresh, roster) &&
		allRiskFlagsPass(fresh, risks)
	);
};
const codeGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["code-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "code-verdicts"), PLAN_DIMENSIONS);
	const risks = planAuthoredRisks(state, "plans");
	return (
		allDimensionsPass(state.named["code-cite-check"]) &&
		allDimensionsPass(fresh, roster) &&
		allRiskFlagsPass(fresh, risks)
	);
};

/**
 * Ship's grade gate — the tier-independent fold over `SHIP_DIMENSIONS` reading
 * the `ship-verdicts` channel. Satisfied when every ship dimension passes
 * (severity-floored) AND every plan-authored risk flag is ruled pass. Unlike
 * `planGatePasses`/`codeGatePasses` it folds NO deterministic cite channel —
 * ship's `plan-cite-check` gate is routed at its own edge — and binds the
 * roster to `SHIP_DIMENSIONS` verbatim (never `gateRoster(gateTier(...))`), so
 * the gate consults the same fixed set the panel graded.
 */
export const shipGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	const risks = planAuthoredRisks(state, "plans");
	return allDimensionsPass(fresh, SHIP_DIMENSIONS) && allRiskFlagsPass(fresh, risks);
};

/**
 * Confirm-before-block: a dimension's FIRST blocking verdict against the
 * current artifact gets ONE independent second judgment before it buys a fix
 * round. Single-judge verdicts observably flap (pass/score/severity disagree
 * across rolls on a near-unchanged artifact), and a spurious block
 * manufactures an entire grade→fix cycle. Routing to the confirm stage
 * re-runs only the pending dimensions on the same verdict channel;
 * latest-per-dimension wins, so a confirming pass clears the gate and a
 * confirming fail routes to the fix with two agreeing judgments behind it. A
 * blocker already judged twice for this artifact routes straight to the fix —
 * confirmation is one extra opinion, not an unbounded re-roll.
 *
 * No tier guard is needed: a blocking verdict is medium+ by the severity
 * floor, and a medium+ severity already lifts `gateTier` out of light — every
 * run with a genuine blocker has confirm-level scrutiny by construction.
 */
const confirmDue = (
	state: RunView,
	channel: string,
	verdictChannel: string,
	dimensions: readonly string[],
): boolean => {
	const roster = new Set(gateRoster(gateTier(state, verdictChannel), dimensions));
	const fresh = freshVerdicts(state.named[verdictChannel], latestArtifactPath(state, channel));
	const risks = planAuthoredRisks(state, channel);
	const byDim = new Map<string, { blocking: boolean; count: number }>();
	for (const o of fresh) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string" || !roster.has(v.dimension)) continue;
		// anchorNitsOnly keeps this floor coherent with the other three
		// severity-fold consumers (gateTier/dimensionsToRegrade/allDimensionsPass).
		const floored = v.pass === true || v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		const riskFail = verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id)));
		byDim.set(v.dimension, {
			blocking: !floored || riskFail,
			count: (byDim.get(v.dimension)?.count ?? 0) + 1,
		});
	}
	const blockers = [...byDim.values()].filter((e) => e.blocking);
	return blockers.length > 0 && blockers.some((e) => e.count < 2);
};

export {
	allDimensionsPass,
	anchorNitsOnly,
	codeGatePasses,
	confirmDue,
	dimensionsToRegrade,
	evidenceCitesFileLine,
	freshVerdicts,
	GOAL_DIMENSIONS,
	gateRoster,
	gateTier,
	latestArtifactPath,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	planAuthoredRisks,
	planGatePasses,
	procedureSatisfiesDuty,
	rulingEffectivePass,
	SLICE_DIMENSIONS,
	sliceGatePasses,
	subplanGatePasses,
	verdictRiskRulings,
};
