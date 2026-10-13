/**
 * Gate layer 3 of the acyclic gates layering (verdict-core → gate-rosters →
 * gate-passes; the `gates.ts` facade re-exports the composed surface): the
 * per-gate pass predicates, the re-grade arithmetic, the whole-lap progress
 * hooks, the seed-lift classification, and the confirm / failed-unit routing
 * folds. Pure state-reading folds — no fs I/O, no LLM.
 */
import { basename } from "node:path";
import type { Output, ProgressValue, RunView } from "@juicesharp/rpiv-workflow/registration";
import {
	gateRoster,
	gateTier,
	panelRoster,
	planAuthoredRisks,
	type RiskRecord,
	rulingEffectivePass,
	shipRoster,
	verdictRiskRulings,
} from "./gate-rosters.js";
import {
	freshVerdicts,
	latestArtifactPath,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	SLICE_DIMENSIONS,
	type VerdictRecord,
	verdictBlocks,
} from "./verdict-core.js";

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
export const dimensionsToRegrade = (
	dimensions: readonly string[],
	latest: ReadonlyMap<string, Output>,
	risks: ReadonlyMap<string, RiskRecord> = new Map(),
): string[] => {
	return dimensions.filter((d) => {
		const o = latest.get(d);
		if (!o) return true; // never graded — must grade at least once
		const v = o.data as VerdictRecord | undefined;
		if (verdictBlocks(v)) return true;
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
 *
 * SENTINELS: a failed-unit sentinel the fanout fold placed carries
 * `data.dimension` when the dead unit was labeled (grade panels label each
 * dimension unit with the dimension it grades). Such an entry registers here
 * with no `pass`/`severity` — it reads BLOCKING. That is the fix for the
 * three intentional behaviors that composed into the dead-unit gate pass:
 * (1) a collected soft-halt is a PERMANENT skip — the dead unit contributes
 * no verdict, only its sentinel; (2) the fold places the sentinel BY INDEX,
 * overwriting whatever the slot held from prior rounds — the stale round-1
 * fail the gate should have blocked on was erased from the channel;
 * (3) a sentinel with NO dimension is skipped by this fold — absence is not
 * failure — so the gate folded only the four surviving passes and routed
 * onward. The dimension field closes all three: the unresolved dimension now
 * reads as its own latest, blocking entry. (Mirror: an UNFILLED slot — infra
 * death, no row — leaves the stale entry in place and also blocks;
 * `unitFailedDimensions` distinguishes the dead-unit shape for routing.)
 */
export const allDimensionsPass = (entries: readonly Output[] = [], roster?: readonly string[]): boolean => {
	// Roster-filtered when given: a verdict for a dimension outside the tier's
	// roster (a wider earlier round, a shrunk re-slice) neither blocks nor passes
	// a gate it no longer governs.
	const member = roster ? new Set(roster) : undefined;
	const latest = new Map<string, boolean>();
	for (const o of entries) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string") continue;
		if (member && !member.has(v.dimension)) continue;
		// The shared blocking predicate keeps every severity fold on one
		// definition of "blocking" (the anchor-nit clamp backstops the
		// citation-resolution rule: an all-drift-nit verdict never blocks,
		// whatever severity the grader typed).
		latest.set(v.dimension, !verdictBlocks(v));
	}
	const verdicts = [...latest.values()];
	return verdicts.length > 0 && verdicts.every(Boolean);
};

/**
 * The rule core under every whole-lap progress declaration: map the
 * blocking-dimension counts of the COMPLETED rounds behind the current one
 * (oldest first) plus the current round's own count to ONE ProgressValue.
 *
 *   []              ⇒ "unknown"    — nothing completed behind the current
 *                                     round (the first lap): counted, never
 *                                     waived.
 *   < min(earlier)   ⇒ "improved"   — the blocking set strictly shrank past
 *                                     EVERY earlier round's best; no score
 *                                     tiebreak — the count is the whole signal.
 *   > last(earlier)  ⇒ "regressed"  — grew past the immediately previous round.
 *   otherwise        ⇒ "unchanged"  — flat or between: counted.
 *
 * Deliberately coarse: the waiver buys one extra lap only when the panel's
 * blocking set strictly shrank past every completed round, so flat, flapping,
 * or partially-improving trails keep counting toward the backward-jump cap.
 * Pure arithmetic over counts — no state, no channel reads — so the lane
 * instances and the replay harnesses share one definition of "a lap
 * improved".
 */
export const progressFromRoundCounts = (earlier: readonly number[], current: number): ProgressValue => {
	if (earlier.length === 0) return "unknown";
	if (current < Math.min(...earlier)) return "improved";
	if (current > earlier[earlier.length - 1]) return "regressed";
	return "unchanged";
};

/**
 * The whole-lap progress hook factory — the `progress` the quality-panel lanes
 * declare on EVERY stage the backward-jump guard can re-enter (grade /
 * fix-or-confirm / snapshot per lane). One instance per lane, shared by
 * the lane's re-entered destinations, so a lap reads as ONE unit: the hook derives
 * a round's blocking count by folding the lane's OWN verdict channel exactly
 * the way its gate does — latest verdict per dimension over the entries still
 * fresh for the current artifact — and counts blocking dimensions through the
 * shared `verdictBlocks` predicate over the tier roster (`gateRoster(gateTier(
 * state, verdictChannel), dimensions)`, computed once per call and applied to
 * every round uniformly).
 *
 * ROUND DELINEATION — two modes:
 *
 *   snapshot mode (`options.snapshotChannel` set — the plan/code lanes, whose
 *   fixes AMEND the plan in place so the artifact basename never changes):
 *   rounds are cut at each snapshot row's `meta.ts` (ISO-8601 compares
 *   lexicographically); a cut is a COMPLETED earlier round iff the verdict
 *   channel grew strictly past it — the last cut with nothing after it is the
 *   CURRENT round, excluded from the earlier set. The current round folds the
 *   WHOLE channel (carry-forward: a dimension not re-graded keeps its latest
 *   prior verdict — the same cumulative fold the gate itself reads).
 *
 *   basename mode (no snapshotChannel — the slice lane, whose fixes RE-SLICE
 *   to a new file): rounds are maximal runs of entries sharing
 *   `basename(data.artifact)`; earlier = every group but the last, current =
 *   the last group's fold. A regenerated artifact re-grades from scratch, so a
 *   healthy basename group carries the full roster; an in-place amend keeps
 *   the basename, so amended rounds merge — degradation is toward counting,
 *   never toward a spurious waiver.
 *
 * FAIL-SAFE: a roster dimension with NO verdict in the current round's fold ⇒
 * "unknown" (the round is incomplete — never waive on missing evidence); an
 * entry without a string `meta.ts` lands in every earlier snapshot cut and in
 * the current fold, so a malformed trail degrades toward counting. Pure
 * channel history — no module state, no file reads, no model calls — so the
 * hook is resume-safe by construction (the resume fold replays the same
 * channels into `state.named`).
 */
export const panelProgress =
	(
		verdictChannel: string,
		dimensions: readonly string[],
		{ snapshotChannel, artifactChannel }: { snapshotChannel?: string; artifactChannel?: string } = {},
	) =>
	(state: RunView): ProgressValue => {
		// The artifact channel is where `risks:` lives, so a lane that names it
		// folds the risk unit into its roster exactly as its panel and gate do;
		// a lane without one (no plan channel to declare risks on) keeps the
		// tier roster.
		const roster =
			artifactChannel !== undefined
				? panelRoster(state, artifactChannel, verdictChannel, dimensions)
				: gateRoster(gateTier(state, verdictChannel), dimensions);
		const entries = state.named[verdictChannel] ?? [];
		const currentArtifact = artifactChannel !== undefined ? latestArtifactPath(state, artifactChannel) : undefined;
		const foldRound = (rows: readonly Output[]): ReadonlyMap<string, Output> =>
			latestVerdictPerDimension(freshVerdicts(rows, currentArtifact));
		const countBlocking = (fold: ReadonlyMap<string, Output>): number => {
			let blocking = 0;
			for (const d of roster) {
				const o = fold.get(d);
				if (o !== undefined && verdictBlocks(o.data as VerdictRecord)) blocking += 1;
			}
			return blocking;
		};
		// An entry with no string ts reads as "" — it joins every earlier snapshot
		// cut (never after one), so a malformed trail can only INFLATE earlier
		// counts: toward counting, never toward a waiver.
		const tsOf = (o: Output): string => {
			const ts = o.meta?.ts;
			return typeof ts === "string" ? ts : "";
		};
		const earlierCounts: number[] = [];
		let currentRows: readonly Output[] = [];
		if (snapshotChannel !== undefined) {
			for (const snap of state.named[snapshotChannel] ?? []) {
				const cut = snap.meta?.ts;
				if (typeof cut !== "string") continue;
				// A cut the channel never grew strictly past is the CURRENT round,
				// not a completed earlier one.
				if (!entries.some((o) => tsOf(o) > cut)) continue;
				earlierCounts.push(countBlocking(foldRound(entries.filter((o) => tsOf(o) <= cut))));
			}
			currentRows = entries;
		} else {
			const groups: { key: string | undefined; rows: Output[] }[] = [];
			for (const o of entries) {
				const a = (o.data as { artifact?: unknown } | undefined)?.artifact;
				const key = typeof a === "string" && a.length > 0 ? basename(a) : undefined;
				const last = groups.at(-1);
				// An entry with no artifact continues the current group — the same
				// compat default freshVerdicts applies; merging rounds degrades
				// toward counting.
				if (last !== undefined && (key === undefined || last.key === key)) last.rows.push(o);
				else groups.push({ key, rows: [o] });
			}
			for (const g of groups.slice(0, -1)) earlierCounts.push(countBlocking(foldRound(g.rows)));
			currentRows = groups.at(-1)?.rows ?? [];
		}
		const currentFold = foldRound(currentRows);
		// An incomplete current round is "unknown" — the roster must be fully
		// adjudicated before the lap can claim progress.
		for (const d of roster) if (!currentFold.has(d)) return "unknown";
		return progressFromRoundCounts(earlierCounts, countBlocking(currentFold));
	};

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
export const sliceGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["slice-verdicts"], latestArtifactPath(state, "slices"));
	const roster = gateRoster(gateTier(state, "slice-verdicts"), SLICE_DIMENSIONS);
	if (!allDimensionsPass(state.named["slice-check"])) return false;
	return allDimensionsPass(fresh, roster) || citeDischargeCoversCurrentMap(state);
};

/**
 * The verdict fields the seed-only cite classification consults — the ONE
 * spelling shared by the route predicate (`seedOnlyCiteFail`), the discharge
 * stamp (`citeRemedyDischarged`), and the seed-lift stage, so all three agree
 * on what a "seed-only cite fail" is. `where` rides the findings for the
 * lift stage's slice-target parse; the classification itself reads only
 * `requires`.
 */
export type SeedOnlyVerdict = {
	pass?: boolean;
	remedy?: string;
	findings?: readonly { requires?: unknown; where?: unknown }[];
};

/**
 * A verdict is a SEED-ONLY cite fail when it failed, its `remedy` is `"cite"`
 * or absent (an omitted marker must not divert a pure-bookkeeping fail into
 * the structural re-cut arm), it carries at least one finding, and EVERY
 * finding demands a concrete string `requires` seed. A finding without a
 * `requires` is unverifiable — a verdict mixing one in is a structural
 * demand and takes the normal fix arm, exactly as a `remedy` naming another
 * repair would.
 */
export const seedOnlyFindings = (v: SeedOnlyVerdict | undefined): boolean => {
	if (v?.pass !== false) return false;
	if (v.remedy !== undefined && v.remedy !== "cite") return false;
	const findings = Array.isArray(v.findings) ? v.findings : [];
	return (
		findings.length > 0 && findings.every((f) => f != null && typeof f.requires === "string" && f.requires.length > 0)
	);
};

/**
 * The seed-only classification over the run state: the LATEST
 * `design-readiness` verdict (via `latestVerdictPerDimension` — deliberately
 * the same consultation `citeRemedyDischarged` makes, not a fresh-verdict
 * filter) is a seed-only cite fail. The `slice-grade` edge consults this to
 * route the deterministic seed lift instead of the structural fix arm.
 */
export const seedOnlyCiteFail = (state: RunView): boolean =>
	seedOnlyFindings(
		latestVerdictPerDimension(state.named["slice-verdicts"]).get("design-readiness")?.data as
			| SeedOnlyVerdict
			| undefined,
	);

/**
 * Stuck detection for the seed-lift loop: the gate still fails, the verdict is
 * seed-only, and the LATEST post-verdict fix publication is the seed lift
 * itself — no later re-slice has superseded it. A lift that already ran and
 * still left the gate red cannot be helped by re-grading (the verdict is
 * unchanged) or re-lifting (the dedup makes the second lift a no-op), so the
 * `slice-check` edge routes the structural fix arm instead of another panel.
 * Timestamps are the channel-tail `meta.ts` comparison (ISO-8601 compares
 * lexicographically); a missing timestamp reads not-stuck — the fail-closed
 * direction here is the ordinary re-grade, never a stuck loop.
 */
export const seedLiftStuck = (state: RunView): boolean => {
	if (sliceGatePasses(state)) return false;
	if (!seedOnlyCiteFail(state)) return false;
	const verdictTs = latestVerdictPerDimension(state.named["slice-verdicts"]).get("design-readiness")?.meta?.ts;
	const liftTs = state.named["slice-seed-lift"]?.at(-1)?.meta?.ts;
	const resliceTs = state.named.slices?.at(-1)?.meta?.ts;
	if (typeof verdictTs !== "string" || typeof liftTs !== "string" || liftTs <= verdictTs) return false;
	return typeof resliceTs !== "string" || liftTs > resliceTs;
};

// The single authority the new `subplan-check` edge consults — the twin of
// `sliceGatePasses`, but carrying no LLM-verdict roster or risk flags: the
// `subplan-check` floor is the sole (deterministic) dimension on its channel.
export const subplanGatePasses = (state: RunView): boolean => allDimensionsPass(state.named["subplan-check"]);
export const planGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["plan-verdicts"], latestArtifactPath(state, "plans"));
	const roster = panelRoster(state, "plans", "plan-verdicts", PLAN_DIMENSIONS);
	const risks = planAuthoredRisks(state, "plans");
	return (
		allDimensionsPass(state.named["plan-cite-check"]) &&
		allDimensionsPass(fresh, roster) &&
		allRiskFlagsPass(fresh, risks)
	);
};
export const codeGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["code-verdicts"], latestArtifactPath(state, "plans"));
	const roster = panelRoster(state, "plans", "code-verdicts", PLAN_DIMENSIONS);
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
 * roster to `shipRoster` (`SHIP_DIMENSIONS` verbatim plus the risk unit when
 * the plan declares `risks:` — never `gateRoster(gateTier(...))`), so the gate
 * consults the same fixed set the panel graded, and a dead risk unit's
 * dimension-bearing sentinel blocks instead of vanishing behind a vacuous
 * `allRiskFlagsPass`.
 */
export const shipGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	const risks = planAuthoredRisks(state, "plans");
	return allDimensionsPass(fresh, shipRoster(state)) && allRiskFlagsPass(fresh, risks);
};

/**
 * Confirm-before-block, severity-gated: a dimension's FRESH blocking verdict
 * against the current artifact gets ONE independent second judgment before it
 * buys a fix round — but only when the second opinion is worth its price. Run
 * telemetry over the whole runs corpus measured the confirm arms at ~13:1 and
 * ~10:1 onward-to-fix vs overturn: ~90% of confirms added 4–7 minutes and an
 * extra grade session before the fix that was going to happen anyway. So a
 * fresh blocker (the dimension's previous fresh verdict, if any, did not
 * block — a repeated block routes straight to the fix: confirmation is one
 * extra opinion, not an unbounded re-roll) confirms only in the three shapes
 * where the insurance has real expected value:
 *
 *   - a HIGH-severity blocker — the expensive class: its fix round is the
 *     broadest, so a spurious high deserves one adversarial check before it
 *     buys that;
 *   - a RISK-ruling blocker (a `pass: false` ruling or a duty-demoted pass) —
 *     the confirm's uphold-or-refute-with-evidence contract is the designed
 *     remedy for an un-grounded ruling, and `amend` legitimately re-emits
 *     UNCHANGED for a demotions-only verdict, so routing that class to the
 *     fix instead would lap an unchanged plan against an unchanged lazy
 *     judgment until the backward-jump guard halted it;
 *   - a FLAP — the dimension previously passed and now blocks on the same
 *     artifact (a broad re-grade regressing a carried pass), i.e. the exact
 *     single-judge instability the confirm exists to adjudicate.
 *
 * A first-time MEDIUM finding-driven blocker routes straight to the fix:
 * amend is surgical and cheap (observed under a minute), and the delta
 * re-grade guard keeps the re-judgment narrow — a wrong medium now costs one
 * lean fix lap instead of every medium costing a confirm session.
 *
 * No tier guard is needed: a blocking verdict is medium+ by the severity
 * floor, and a medium+ severity already lifts `gateTier` out of light — every
 * run with a genuine blocker has confirm-level scrutiny by construction.
 */
export const confirmDue = (
	state: RunView,
	channel: string,
	verdictChannel: string,
	dimensions: readonly string[],
): boolean => {
	const roster = new Set(panelRoster(state, channel, verdictChannel, dimensions));
	const fresh = freshVerdicts(state.named[verdictChannel], latestArtifactPath(state, channel));
	const risks = planAuthoredRisks(state, channel);
	const byDim = new Map<string, { blocking: boolean; confirmWorthy: boolean; prevBlocking?: boolean }>();
	for (const o of fresh) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string" || !roster.has(v.dimension)) continue;
		const riskFail = verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id)));
		// `verdictBlocks` keeps this fold coherent with the other severity-fold
		// consumers (dimensionsToRegrade/allDimensionsPass/shipGradeStopNote);
		// risk composes ON TOP — the predicate itself is risk-blind.
		const blocking = verdictBlocks(v) || riskFail;
		const prev = byDim.get(v.dimension);
		byDim.set(v.dimension, {
			blocking, // the latest verdict decides whether the dimension currently blocks
			confirmWorthy: blocking && (v.severity === "high" || riskFail),
			prevBlocking: prev?.blocking,
		});
	}
	return [...byDim.values()].some(
		(e) => e.blocking && e.prevBlocking !== true && (e.confirmWorthy || e.prevBlocking === false),
	);
};

/**
 * Roster dimensions whose latest FRESH verdict entry is a failed sentinel —
 * the dead-unit routing signal. A dimension-bearing sentinel means the unit
 * grading that dimension soft-halted (after its re-dispatch, when the panel
 * wires one) and left "unresolved" as the dimension's channel state; route
 * bodies convert it into the fix arm with a unit-failed note instead of
 * letting the fold's absence-is-not-failure default — or a confirm divert —
 * decide. Pure state reads — resume-safe for `readsData: false` routes. A
 * sentinel survives `freshVerdicts` (no `artifact` field — the compat
 * default), so regenerating the artifact cannot launder a dead unit.
 */
export const unitFailedDimensions = (
	state: RunView,
	channel: string,
	verdictChannel: string,
	dimensions: readonly string[],
): string[] => {
	const fresh = freshVerdicts(state.named[verdictChannel], latestArtifactPath(state, channel));
	const latest = latestVerdictPerDimension(fresh);
	return dimensions.filter((d) => latest.get(d)?.kind === "failed");
};
