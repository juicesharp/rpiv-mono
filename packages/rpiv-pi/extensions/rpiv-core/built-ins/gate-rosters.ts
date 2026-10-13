/**
 * Gate layer 2 of the acyclic gates layering (verdict-core → gate-rosters →
 * gate-passes; the `gates.ts` facade re-exports the composed surface): the
 * adaptive gate scaling machinery — scrutiny tier (`gateTier`), tier roster
 * (`gateRoster`), dispatch rosters (`panelRoster`/`shipRoster`) — and the
 * plan-authored risk-duty folds every risk gate consults. Derives everything
 * from signals already replayed by the resume fold (via verdict-core's
 * micro-readers): deterministic by construction, so routes and fanout units
 * that consult it stay resume-safe.
 */
import type { Output, RunView } from "@juicesharp/rpiv-workflow/registration";
import { FILE_LINE_CITATION_RE } from "./shared.js";
import { anchorNitsOnly, channelNumber, latestChannelData, RISK_DIMENSION, SHIP_DIMENSIONS } from "./verdict-core.js";

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

export const gateTier = (state: RunView, verdictChannel: string): GateTier => {
	const slices = channelNumber(state, "slices", "slice_count");
	const phases = channelNumber(state, "plans", "phase_count");
	const severities = new Set<string>();
	for (const o of state.named[verdictChannel] ?? []) {
		const v = o.data as { severity?: unknown; findings?: unknown } | undefined;
		const s = v?.severity;
		// Anchor-nit clamp: an all-drift-nit verdict must not escalate the tier.
		// Deliberately NOT `verdictBlocks` — this fold arbitrates severity VALUES,
		// not blocking; the clamp lowers the recorded value only.
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
export const gateRoster = (tier: GateTier, dimensions: readonly string[]): readonly string[] => {
	if (tier !== "light") return dimensions;
	const light = dimensions.filter((d) => LIGHT_ROSTER.has(d));
	return light.length > 0 ? light : dimensions;
};

/**
 * The roster a panel over `channel` actually dispatches and its gate actually
 * folds: the tier roster (`gateRoster(gateTier(...))`) plus the
 * `RISK_DIMENSION` unit whenever the channel's latest record declares
 * `risks:` — at every tier, never otherwise. ONE construction site shared by
 * the panel's `units()`, the gate predicates, `confirmDue`, and the progress
 * hook, so "dispatch", "fold", "confirm", and "lap complete" can never
 * disagree on whether the risk unit is a roster member. A roster that never
 * declares risks (the slice gate over `slices`) is unchanged. Idempotent over
 * a `dimensions` list that already names the risk dimension.
 */
export const panelRoster = (
	state: RunView,
	channel: string,
	verdictChannel: string,
	dimensions: readonly string[],
): readonly string[] => {
	const roster = gateRoster(gateTier(state, verdictChannel), dimensions);
	if (roster.includes(RISK_DIMENSION) || planAuthoredRisks(state, channel).size === 0) return roster;
	return [...roster, RISK_DIMENSION];
};

/**
 * Ship's tier-independent twin of `panelRoster`: `SHIP_DIMENSIONS` verbatim
 * (never `gateRoster(gateTier(...))`) plus the risk unit when the plan
 * declares `risks:`. Bound by the ship panel, `shipGatePasses`, and ship's
 * stop note alike.
 */
export const shipRoster = (state: RunView): readonly string[] =>
	planAuthoredRisks(state, "plans").size === 0 ? SHIP_DIMENSIONS : [...SHIP_DIMENSIONS, RISK_DIMENSION];

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
export const verdictRiskRulings = (o: Output): RiskRuling[] => {
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
export interface RiskRecord {
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
export const planAuthoredRisks = (state: RunView, channel: string): Map<string, RiskRecord> => {
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
export const evidenceCitesFileLine = (r: RiskRuling, authored?: RiskRecord): boolean => {
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
export const procedureSatisfiesDuty = (r: RiskRuling, authored?: RiskRecord): boolean => {
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
export const rulingEffectivePass = (r: RiskRuling, authored?: RiskRecord): boolean =>
	r.pass === true && evidenceCitesFileLine(r, authored) && procedureSatisfiesDuty(r, authored);
