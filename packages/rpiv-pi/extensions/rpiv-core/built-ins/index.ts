/**
 * Barrel for the extracted built-in-workflows leaf clusters. The monolith
 * `../built-in-workflows.ts` imports its relocated helpers from here. Each
 * re-export targets a `.js` specifier (Node16 ESM, source stays `.ts`).
 */

export {
	allDimensionsPass,
	anchorNitsOnly,
	codeGatePasses,
	confirmDue,
	freshVerdicts,
	latestArtifactPath,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	planAuthoredRisks,
	planGatePasses,
	rulingEffectivePass,
	SHIP_DIMENSIONS,
	shipGatePasses,
	sliceGatePasses,
	subplanGatePasses,
	verdictRiskRulings,
} from "./gates.js";
export {
	COMMIT_BASELINE_PROMPT,
	captureGoal,
	VALIDATE_GOAL_PROMPT,
} from "./goal-baseline.js";
export {
	CODE_CONFIRM_FANOUT,
	CODE_DIMENSION_FANOUT,
	PLAN_CONFIRM_FANOUT,
	PLAN_DIMENSION_FANOUT,
	SHIP_DIMENSION_FANOUT,
	SLICE_DIMENSION_FANOUT,
	shipVerdictOutcome,
} from "./grade-panel.js";
export {
	closesFence,
	countHeadingsOutsideFences,
	FENCE_LINE_RE,
	fencedSpans,
	forEachLineOutsideFences,
} from "./markdown-fence.js";
export { planCitationCheck } from "./plan-cite.js";
export {
	FRONTMATTER_PHASE_FANOUT,
	IMPLEMENT_DAG_FANOUT,
	IMPLEMENT_PLANS_FANOUT,
	latestPlans,
	REVIEW_PHASE_ITERATE,
} from "./plan-phases.js";
export { codeDemote, codeSnapshot, planDemote, planSnapshot } from "./priors.js";
export { reconcile } from "./reconcile.js";
export { remediationOutcome } from "./remediation.js";
export { implementScopeCheck, implementScopeCheckVet, ScopeVerdict, scopeQuarantine } from "./scope-checks.js";
export {
	FILE_LINE_CITATION_RE,
	FsArtifact,
	haltPreflight,
	latestFsArtifact,
	MAX_PHASES,
	PhaseRecord,
	readArtifactFile,
	StructureFinding,
	TEST_PATH_RE,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
	writeStructureVerdict,
} from "./shared.js";
export { sliceStructureCheck, subplanCoverageCheck } from "./slice-checks.js";
export { SLICE_DESIGN_FANOUT, SYNTH_CLUSTER_FANOUT } from "./slices.js";
