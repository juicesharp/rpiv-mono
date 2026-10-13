/**
 * Conservation facade over the gates layer split — `verdict-core.ts` (rosters
 * + verdict micro-folds) → `gate-rosters.ts` (tier machinery + risk-duty
 * folds) → `gate-passes.ts` (pass predicates + progress hooks). Re-exports
 * the exact pre-split 36-symbol surface, grouped by source module, so every
 * consumer — the built-in workflows, the composition test's deep imports,
 * the graph-attached movers — keeps its `./gates.js` specifier unchanged.
 * Zero logic lives here: pure named re-exports, no `export *`; new gate code
 * lands in the layer that owns it and is surfaced here by name.
 */

export {
	allDimensionsPass,
	codeGatePasses,
	confirmDue,
	dimensionsToRegrade,
	panelProgress,
	planGatePasses,
	progressFromRoundCounts,
	type SeedOnlyVerdict,
	seedLiftStuck,
	seedOnlyCiteFail,
	seedOnlyFindings,
	shipGatePasses,
	sliceGatePasses,
	subplanGatePasses,
	unitFailedDimensions,
} from "./gate-passes.js";
export {
	evidenceCitesFileLine,
	gateRoster,
	gateTier,
	panelRoster,
	planAuthoredRisks,
	procedureSatisfiesDuty,
	type RiskRecord,
	rulingEffectivePass,
	shipRoster,
	verdictRiskRulings,
} from "./gate-rosters.js";
export {
	anchorNitsOnly,
	freshVerdicts,
	GOAL_DIMENSIONS,
	latestArtifactPath,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	RISK_DIMENSION,
	SHIP_DIMENSIONS,
	SLICE_DIMENSIONS,
	type VerdictRecord,
	verdictBlocks,
} from "./verdict-core.js";
