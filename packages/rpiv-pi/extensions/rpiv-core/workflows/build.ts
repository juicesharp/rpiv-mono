// ===========================================================================
// build — goal (verbatim-brief capture) → research → acceptance (the
//         goal-derived executable standard of completion) → slice → slice-check
//         (deterministic floor) → slice-grade (design-readiness, slice-fix loop)
//         → slice-design (fanout) → design-review (one human checkpoint) →
//         subplan (cluster fanout) → plan → plan-grade (plan-fix loop) →
//         code (fanout) → code-splice → code-grade (code-fix loop) →
//         implement → implement-scope-check → reconcile → validate → commit
//   The sliced, panel-gated heavy path: capture the user's brief verbatim as the
//   `goal` channel (the north star the judgment seams — the two grade panels'
//   completeness/correctness dimensions and validate — anchor against), research
//   the brief (so every slice
//   rests on a real, cited footing and the plan gate can grade architecture-fit),
//   decompose it into independent
//   vertical slices, gate that breakdown BEFORE any design so each slice is
//   chewable by one design-slice pass. The gate is two-phase: a DETERMINISTIC
//   floor (`slice-check`) enforces dependency-cycle freedom and brief-coverage
//   conservation (a slice-fix may redistribute the brief, never drop scope to pass),
//   then ONE LLM `design-readiness` judgment reconciles the formerly-opposing
//   split/merge forces. Then design every slice in parallel and pause at ONE
//   consolidated human checkpoint (`design-review`) — the single fan-in seam where
//   every design exists and nothing parallel runs — to accept or adjust the
//   proposed interfaces/data types before synthesis. Then merge hierarchically
//   (per-cluster sub-plans → one plan) so no pass holds every design, gate the
//   plan on quality dimensions BEFORE any code, elaborate code per phase and
//   splice it in, re-grade the code-bearing plan, then implement/validate/commit.
// ===========================================================================

import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	fanin,
	gitCommitOutcome,
	type PromptFn,
	produces,
	setRouteNote,
} from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "../artifact-collector.js";
import {
	CODE_CONFIRM_FANOUT,
	CODE_DIMENSION_FANOUT,
	CODE_PANEL_PROGRESS,
	COMMIT_BASELINE_PROMPT,
	captureGoal,
	codeDemote,
	codeGatePasses,
	codeSnapshot,
	confirmDue,
	designOutcome,
	ELABORATE_PHASE_FANOUT,
	elaborationOutcome,
	haltPreflight,
	IMPLEMENT_DAG_FANOUT,
	implementScopeCheck,
	latestFsArtifact,
	PLAN_CONFIRM_FANOUT,
	PLAN_DIMENSION_FANOUT,
	PLAN_DIMENSIONS,
	PLAN_PANEL_PROGRESS,
	planCitationCheck,
	planDemote,
	planGatePasses,
	planSnapshot,
	RISK_DIMENSION,
	reconcile,
	remediationOutcome,
	SLICE_DESIGN_FANOUT,
	SLICE_DIMENSION_FANOUT,
	SLICE_DIMENSIONS,
	SLICE_PANEL_PROGRESS,
	SYNTH_CLUSTER_FANOUT,
	scopeQuarantine,
	seedLiftStuck,
	seedOnlyCiteFail,
	sliceGatePasses,
	sliceSeedLift,
	sliceStructureCheck,
	subplanCoverageCheck,
	subplanGatePasses,
	unitFailedDimensions,
	VALIDATE_GOAL_PROMPT,
	verdictOutcome,
} from "../built-ins/index.js";
import {
	RECONCILE_FIX_OUTCOME,
	RECONCILE_FIX_PROMPT,
	reconcileGate,
	scopeFloorGate,
	unitFailedNote,
	validateFixGate,
	validateGate,
} from "./shared.js";

/**
 * `goal` displaces `research` as build's start stage, and ONLY the start stage
 * receives `originalInput` as its skill arg (`stageEntryArgs` case 1) — a plain
 * `produces()` research would silently receive the rolling primary (the goal
 * FILE PATH) instead of the brief text. A prompt stage owns its whole message,
 * so this rebuilds research's pre-goal dispatch byte-for-byte; the outcome
 * deriver still wires the `research` bucket off the record key (the polish
 * `validate` prompt-stage precedent).
 */
const RESEARCH_BRIEF_PROMPT: PromptFn = ({ state }) => `/skill:research ${state.originalInput}`;
/**
 * Verdict channels — grade writes JSON to `.rpiv/artifacts/verdicts/`, so
 * these use the disk-first verdict factory in `built-ins/verdict-outcome.ts`
 * (NOT the md `rpivBucketOutcome`). The slice gate and plan gate publish to
 * DISTINCT named channels (same dir, different artifact basenames) so their
 * verdicts never collide and `plan-fix`/`code-fix` can pick each via the
 * `-verdicts` suffix convention.
 */
const sliceVerdictOutcome = verdictOutcome("slice-verdicts", "slices");
const planVerdictOutcome = verdictOutcome("plan-verdicts", "plans");
// The post-splice code gate re-grades the now code-bearing plan on its own
// channel, so its verdicts never mix with the pre-elaborate plan gate's. Named
// for the object under judgment — the code the gate grades — completing the
// slice-verdicts / plan-verdicts / code-verdicts parallel.
const codeVerdictOutcome = verdictOutcome("code-verdicts", "plans");
/**
 * Absolute path to rpiv-pi's bundled deterministic stitch script. Resolved off
 * this module's own URL so it points inside the installed package at runtime
 * (this module lives in extensions/rpiv-core/workflows — one level deeper than
 * the monolith was, hence THREE `..` hops up to the package root; the script
 * in skills/_shared).
 */
const STITCH_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"skills",
	"_shared",
	"stitch-elaborations.mjs",
);
/** The slice gate's grade edge — design-readiness pass ⇒ design; a dead
 *  dimension unit ⇒ slice-fix with the note (a verdict-less dead dimension is
 *  never a classification candidate). A SEED-ONLY cite fail (every finding
 *  naming a concrete seed to add) ⇒ the deterministic `slice-seed-lift` arm,
 *  which appends the seeds and re-enters `slice-check` for the discharge
 *  stamp; anything else ⇒ slice-fix. Belt-and-suspenders for the live graph:
 *  the slice roster is one dimension, so a double miss makes the generation
 *  all-failed and `haltWhenAllFailed` halts at the panel close before any
 *  route runs — the arms pin the route contract for any future multi-dimension
 *  slice roster and for constructed-state trails. */
const sliceGradeRoute: EdgeFn = defineRoute(
	["slice-design", "slice-seed-lift", "slice-fix"],
	({ state }) => {
		if (sliceGatePasses(state)) return "slice-design";
		const unitFailed = unitFailedDimensions(state, "slices", "slice-verdicts", SLICE_DIMENSIONS);
		if (unitFailed.length > 0) {
			setRouteNote(sliceGradeRoute, unitFailedNote(unitFailed));
			return "slice-fix";
		}
		return seedOnlyCiteFail(state) ? "slice-seed-lift" : "slice-fix";
	},
	{ readsData: false },
);

/**
 * Every unit a plan/code panel can dispatch — the tier roster's dimensions
 * plus the risk unit `panelRoster` adds when the plan declares `risks:`. The
 * dead-unit preemption filters on a failed sentinel per dimension, so naming
 * the risk unit here is safe when it was never dispatched (no sentinel ⇒ not
 * listed) and load-bearing when it was (a dead risk unit is a dead panel
 * member, not a vacuous risk pass).
 */
const PLAN_PANEL_UNITS: readonly string[] = [...PLAN_DIMENSIONS, RISK_DIMENSION];

/** The plan gate's demote edge — the unit-failed preemption fires BEFORE the
 *  confirm divert (a previously-passing dimension whose re-grade died is not
 *  a flap to adjudicate; there is no verdict to adjudicate). */
const planDemoteRoute: EdgeFn = defineRoute(
	["code", "plan-confirm", "plan-snapshot"],
	({ state }) => {
		if (planGatePasses(state)) return "code";
		const unitFailed = unitFailedDimensions(state, "plans", "plan-verdicts", PLAN_PANEL_UNITS);
		if (unitFailed.length > 0) {
			setRouteNote(planDemoteRoute, unitFailedNote(unitFailed));
			return "plan-snapshot";
		}
		return confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS) ? "plan-confirm" : "plan-snapshot";
	},
	{ readsData: false },
);

/** The code gate's demote edge — the plan gate's twin on `code-verdicts`. */
const codeDemoteRoute: EdgeFn = defineRoute(
	["implement", "code-confirm", "code-snapshot"],
	({ state }) => {
		if (codeGatePasses(state)) return "implement";
		const unitFailed = unitFailedDimensions(state, "plans", "code-verdicts", PLAN_PANEL_UNITS);
		if (unitFailed.length > 0) {
			setRouteNote(codeDemoteRoute, unitFailedNote(unitFailed));
			return "code-snapshot";
		}
		return confirmDue(state, "plans", "code-verdicts", PLAN_DIMENSIONS) ? "code-confirm" : "code-snapshot";
	},
	{ readsData: false },
);
const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Ship, sliced: capture the verbatim brief as a goal artifact (the north star the quality gates' completeness/correctness dimensions and validate anchor against) → research the brief → derive a goal-anchored acceptance inventory (the executable standard of completion, frozen before any plan so it cannot inherit the plan's scope; the completeness gates anchor on it and validate executes its evidence commands) → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → one consolidated developer checkpoint (accept or adjust the proposed interfaces/data types, adjustments applied surgically and cascaded to dependents) → synthesize hierarchically (per-cluster sub-plans → one merged plan) → tier-scaled quality-panel gate (a one-slice, <=2-phase run grades correctness+completeness only; larger or previously-failing runs grade the full completeness/correctness/actionability/pattern-following/architecture-fit roster; a plan declaring risk flags adds a concurrent risk-rulings unit at every tier) where a dimension's fresh HIGH-severity, risk-ruling, or regressed-pass blocking verdict gets one confirming second judgment before it buys a plan-fix round (a first-time medium finding routes straight to the surgical fix) → elaborate code per phase in parallel → splice it into the plan → re-grade the code-bearing plan (same tier + confirm contract) → implement → implement-scope-check → reconcile → validate → commit. Research-led; three automated gates plus one human design checkpoint, before design, before code, and after the splice.",
	start: "goal",
	stages: {
		// The user's brief, verbatim, on its own channel — the judgment seams
		// (plan/code gates' completeness+correctness, validate) anchor against
		// it. Deliberately NOT fed to the generative stages (slice, design-slice):
		// bounded per-slice context is build's whole point, and an ambient goal
		// there invites re-litigating settled decompositions.
		goal: produces.script({ run: captureGoal }),
		// Front-loaded research grounds every slice's footing and feeds the plan
		// gate's architecture-fit dimension its --context. Prompt-dispatched so it
		// still receives the raw brief now that `goal` holds the start slot.
		research: produces({ prompt: RESEARCH_BRIEF_PROMPT }),
		// The goal-derived acceptance inventory (see ship's twin comment): the
		// executable standard of completion, frozen before slicing/planning so
		// it cannot inherit their scope. Threaded to the plan/code gates'
		// completeness units (--acceptance) and to validate, which executes the
		// evidence commands. Deliberately NOT fed to slice/design/synthesize —
		// the bounded-context doctrine that keeps `goal` out of the generative
		// stages applies to its derived standard too.
		acceptance: produces({ reads: ["goal", "research"] }),
		// `reads: ["research"]` (not the rolling primary): `acceptance` now sits
		// between research and slice, so the rolling primary at this stage is
		// the acceptance doc — the explicit read restores the research artifact
		// as slice's grounding input (dispatched as `--research <path>`; the
		// slice skill accepts the flag form of its fresh input).
		slice: produces({ reads: ["research"] }),
		// Deterministic floor (no LLM): dependency-cycle freedom + brief-coverage conservation.
		"slice-check": produces.script({ reads: ["slices"], run: sliceStructureCheck }),
		// One LLM design-readiness judgment; verdicts on their own channel.
		"slice-grade": produces({
			skill: "grade",
			loop: SLICE_DIMENSION_FANOUT,
			outcome: sliceVerdictOutcome,
			// Whole-lap progress: the slice lane's three re-entered destinations
			// (grade/fix/seed-lift) share ONE hook instance, so every counted
			// re-entry reads the same verdict-channel fold.
			progress: SLICE_PANEL_PROGRESS,
			reads: ["slices"],
		}),
		// Re-cut the slice map from the failing verdicts. Routes through `slice`
		// (re-slice mode), NOT the surgical `amend`: a `design-readiness` or structural
		// failure needs STRUCTURAL authority — split an epic, break a cycle, renumber —
		// which a surgical "touch only the cited line" edit cannot do, so `amend`
		// looped without converging until the backward-jump guard halted the run.
		"slice-fix": produces({
			skill: "slice",
			outcome: rpivBucketOutcome("slices"),
			progress: SLICE_PANEL_PROGRESS,
			reads: ["slices", fanin("slice-verdicts"), fanin("slice-check")],
		}),
		// Deterministic seed lift — the engine-owned half of the cite remedy: a
		// seed-only design-readiness fail (every finding demanding a concrete
		// `requires` citation) is repaired by appending the seeds to the named
		// slices' `Draws on` lines in place, never by a full re-slice + re-grade.
		// Publishes on its OWN stage channel (a script stage cannot carry an
		// outcome; the in-place amend keeps `latestFsArtifact(state, "slices")`
		// resolving the same amended file), then re-enters `slice-check`, whose
		// re-run stamps the cite discharge the gate folds on — no second panel.
		"slice-seed-lift": produces.script({
			reads: ["slices", fanin("slice-verdicts")],
			run: sliceSeedLift,
			progress: SLICE_PANEL_PROGRESS,
		}),
		// Design every slice in parallel.
		// `designOutcome` derives `filename_slice` beside the frontmatter so the
		// design-slice contract refuses a path whose `_slice-<N>_` token is missing
		// or disagrees with `slice_n` while the lane can still rename it.
		"slice-design": produces({ skill: "design-slice", loop: SLICE_DESIGN_FANOUT, outcome: designOutcome }),
		// One consolidated developer checkpoint over EVERY per-slice design, at the
		// single fan-in seam where they all exist and nothing parallel is running.
		// Presents the proposed shape (interfaces, data types, scope) and lets the
		// developer accept or adjust; an adjustment is applied surgically in place
		// and cascaded to the changed contract's dependents BEFORE synthesis sees
		// the designs. Re-emits designs on their channel (latest-wins, same paths),
		// so `subplan`/`synthesize` read the accepted/edited docs. The interactive
		// counterpart to the LLM gates — the one human pass on the parallel path.
		"design-review": produces({
			skill: "design-review",
			outcome: rpivBucketOutcome("designs"),
			reads: [fanin("designs"), "slices"],
		}),
		// Hierarchical fan-in: merge each slice-DAG cluster into a sub-plan in
		// parallel (bounded context), then merge the sub-plans into one plan.
		subplan: produces({
			skill: "synthesize",
			loop: SYNTH_CLUSTER_FANOUT,
			outcome: rpivBucketOutcome("subplans"),
		}),
		// Deterministic cluster-coverage floor between the cluster fanout and the
		// root merge — the subplan twin of `slice-check`. Reconciles dispatched
		// `_cluster-<k>` sub-plans against the slice map's promised cluster count +
		// `sources:` design coverage BEFORE the root merge fans them in, so a lost
		// or clobbered cluster fails structurally and routes back to `subplan`
		// rather than silently dropping slices from the merged plan.
		"subplan-check": produces.script({ reads: [fanin("subplans"), "slices"], run: subplanCoverageCheck }),
		// The root merge reads `research` (threaded as `--research` so cross-slice
		// constraints reach the merge directly, not only via each subplan's
		// refraction) alongside the cluster sub-plans it fans in. `goal` +
		// `acceptance` reach it too: synthesize disposes every inventory id in the
		// plan's `acceptance:` block, the same anchors the completeness judge and
		// validate read.
		plan: produces({ skill: "synthesize", reads: ["research", "goal", "acceptance", fanin("subplans")] }),
		// Deterministic citation floor BEFORE the LLM plan gate (twin of `slice-check`):
		// a fabricated `file:line` in the plan fails structurally and routes to `plan-fix`.
		"plan-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("plan-cite-check") }),
		// Quality gate over the plan; verdicts on their own channel.
		"plan-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: planVerdictOutcome,
			// Whole-lap progress: the plan lane's three re-entered destinations
			// (grade/confirm/snapshot) share ONE hook instance — a lap is one unit.
			progress: PLAN_PANEL_PROGRESS,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		// Stamp the duty demotion onto the graded verdicts as legible on-disk data
		// (a `risk_duty_demotions` array written in place onto each demoted
		// verdict JSON) one hop BEFORE the gate routes — the gate's route lives on
		// `plan-demote` so this write-back lands before confirm/`--prior`/amend
		// read the verdict. Reads `plans` (the plan-authored risk flags) and fans
		// in the verdicts it just graded. Gate outcomes are unchanged: every fold
		// consults in-memory `state.named` via `rulingEffectivePass`, never the
		// rewritten file (the write-back is an additive, read-only signal).
		"plan-demote": produces.script({ reads: ["plans", fanin("plan-verdicts")], run: planDemote }),
		// One independent second judgment on the blocking dimensions before they
		// buy a fix round (see `confirmDue`). Same panel machinery, same verdict
		// channel — its OWN stage name so a stronger judge model can be pinned to
		// exactly the verdicts about to block (models.json `stages["plan-confirm"]`).
		"plan-confirm": produces({
			skill: "grade",
			loop: PLAN_CONFIRM_FANOUT,
			outcome: planVerdictOutcome,
			progress: PLAN_PANEL_PROGRESS,
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		"plan-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			// Lineage threads for completeness-class repairs: `goal` (verbatim brief),
			// `research` (architecture/precedent findings), `subplans` (per-cluster
			// sub-plans). `goal`/`research` mirror `plan-confirm`'s reads; `subplans`
			// mirrors `plan`'s own `reads: ["research", fanin("subplans")]`. `subplans`
			// is plan-fix-ONLY — by the code gate the plan's completeness is settled, so
			// code-fix repairs code-shape defects and threads no subplans.
			reads: [
				"plans",
				fanin("plan-verdicts"),
				fanin("plan-cite-check"),
				"goal",
				"acceptance",
				"research",
				fanin("subplans"),
			],
		}),
		// Snapshot the graded plan BEFORE plan-fix amends it — one deterministic
		// hop inside the existing fix loop (plan-grade/plan-confirm → plan-snapshot
		// → plan-fix). The re-grade reads the prior off the snapshot's OWN channel
		// (`plan-snapshot`) to decide whether the amend was surgical (re-grade only
		// the failing dims) or broad (re-grade the full roster). `produces.script`
		// rides its stage-name channel, so this publishes to `plan-snapshot`, NOT
		// `plans` — `latestFsArtifact(state, "plans")` still resolves to the real
		// (amended) plan.
		"plan-snapshot": produces.script({ reads: ["plans"], run: planSnapshot, progress: PLAN_PANEL_PROGRESS }),
		// Elaborate implement-ready code into each phase in parallel (fanout),
		// deterministically splice it back into the plan (code-splice), then
		// re-grade the now code-bearing plan — guarding the blind-splice risk.
		code: produces({
			skill: "elaborate",
			loop: ELABORATE_PHASE_FANOUT,
			reads: ["plans"],
			outcome: elaborationOutcome,
		}),
		"code-splice": acts.script({
			reads: ["plans"],
			run: ({ state, cwd }) => {
				const plan = latestFsArtifact(state, "plans");
				if (plan?.handle.kind !== "fs") {
					throw haltPreflight(
						"code-splice",
						"code-splice: no plan to splice into",
						"code-splice: no fs plan artifact on the 'plans' channel — synthesize must run before elaborate/code-splice",
					);
				}
				const planPath = isAbsolute(plan.handle.path) ? plan.handle.path : join(cwd, plan.handle.path);
				try {
					execFileSync("node", [STITCH_SCRIPT, planPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
				} catch (err) {
					const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
					throw haltPreflight(
						"code-splice",
						"code-splice: stitch refused the elaborations",
						stderr || (err instanceof Error ? err.message : String(err)),
					);
				}
			},
		}),
		// Deterministic citation floor over the SPLICED (code-bearing) plan before
		// the LLM code gate — the code-scope twin of `plan-cite-check`.
		"code-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("code-cite-check") }),
		"code-grade": produces({
			skill: "grade",
			loop: CODE_DIMENSION_FANOUT,
			outcome: codeVerdictOutcome,
			// Whole-lap progress: the code lane's three re-entered destinations
			// (grade/confirm/snapshot) share ONE hook instance — a lap is one unit.
			progress: CODE_PANEL_PROGRESS,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		// The code-gate twin of `plan-demote`: stamp the duty demotion onto the
		// code-graded verdicts (re-grading `plans` on `code-verdicts`) one hop
		// before the code gate routes (`code-demote` owns the route body).
		"code-demote": produces.script({ reads: ["plans", fanin("code-verdicts")], run: codeDemote }),
		// Repair arm for the code gate. Surgical `amend` over the SAME code-bearing
		// plan from the code verdicts — NOT a blind re-elaborate: `elaborate` never
		// sees the findings and can only rewrite a phase's code body, so it cannot fix
		// what the gate actually fails on (fabricated edit anchors, drifted line
		// citations, a cross-phase naming collision) and sometimes regressed a passing
		// dimension. `amend` reads the verdicts and edits the spliced plan in place
		// (its embedded code blocks included), then loops straight back to re-grade —
		// the mirror of the plan gate's `plan-fix` arm, on its own `code-verdicts`
		// channel so the two loops' verdicts never cross.
		// The code gate's confirm arm — the mirror of `plan-confirm`, on the
		// `code-verdicts` channel.
		"code-confirm": produces({
			skill: "grade",
			loop: CODE_CONFIRM_FANOUT,
			outcome: codeVerdictOutcome,
			progress: CODE_PANEL_PROGRESS,
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		"code-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			// Lineage threads for code-shape repairs: `goal`/`research` give amend the
			// brief + architecture context (mirroring `code-confirm`'s reads). NO
			// `subplans` — the plan's completeness was settled at the plan gate, so the
			// code arm only repairs code-shape defects (fabricated edit anchors, drifted
			// `file:line` citations, cross-phase naming collisions).
			reads: ["plans", fanin("code-verdicts"), fanin("code-cite-check"), "goal", "research"],
		}),
		// Snapshot the graded plan BEFORE code-fix amends it — the code-gate twin
		// of `plan-snapshot` (code-grade/code-confirm → code-snapshot → code-fix),
		// publishing the prior on the `code-snapshot` channel.
		"code-snapshot": produces.script({ reads: ["plans"], run: codeSnapshot, progress: CODE_PANEL_PROGRESS }),
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Lane-level scope floor — the structural backstop beneath the quality
		// gates. After the (now concurrent) implement lane lands, judge the working
		// tree's dirty set against the plan's declared write-set: any undeclared
		// write is a phase that escaped the upstream write-scope discipline. Tiered
		// route (scopeFloorGate): untracked-only excess ⇒ the deterministic
		// quarantine arm; tracked excess ⇒ recorded and adjudicated by validate
		// (threaded via --scope); missing verdict ⇒ STOP. No schema is declared
		// (matching slice-check/plan-cite-check — the route reads the channel).
		// Reads `goal` for the run-start baseline that subtracts pre-existing dirt.
		// On a validate-fix re-entry the floor additionally accepts the latest
		// report's blockers-named writes as declared scope — a validate-fix hop's
		// targeted repair is the one writer the plan cannot declare (it predates
		// the report); fail-closed on missing/older remediation (see
		// validateReportAcceptance).
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheck }),
		// Deterministic remedy arm for the untracked-only tier: move (never
		// delete) run-created untracked excess under .rpiv/tmp/scope-quarantine/
		// and publish a manifest, then re-enter the floor — see scopeQuarantine.
		"scope-quarantine": produces.script({ reads: ["implement-scope-check"], run: scopeQuarantine }),
		// Deterministic post-implement reconciliation (no LLM): applies every
		// `#### Reconciliation` directive (find→replace, write-restricted to the
		// plan's declared write-set), fail-soft — a coherence backstop the parallel
		// implement lane needs (a phase's correct change can invalidate a sibling's test, and the
		// combined tree can break in ways no single phase's checks surface). Pass ⇒
		// validate; fail ⇒ the reconcile-fix arm (see reconcileGate); missing ⇒
		// STOP. `reads: ["plans"]` only — no run-start goal baseline (the scope
		// floor already proved the write-set).
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		// Repair arm for the reconciliation gate: /skill:amend over the plan's
		// directives from the reconcile verdict (a prompt stage — see
		// RECONCILE_FIX_PROMPT), re-emitting the plan latest-wins, then back
		// through reconcile to apply. Bounded by the runner's per-destination
		// backward-jump budget (the plan-fix precedent).
		"reconcile-fix": produces.prompt({ prompt: RECONCILE_FIX_PROMPT, outcome: RECONCILE_FIX_OUTCOME }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		// Repair arm the validate gate dispatches on a remediable `verdict: "fail"`.
		// `acts()` (not `produces()`) because remediate is `side-effect`/`code-mutation`
		// (the tools twin of `implement`: re-runs verification commands via `Bash(*)`
		// and edits the working tree). `reads: ["plans","validation"]` ⇒
		// `stageEntryArgs` derives `--plans <plan> --validation <latest-report>`;
		// `validation` is validate's own publish bucket, so validate-fix always reads
		// the latest failing report. `remediationOutcome` publishes the deterministic
		// did-anything-change digest verdict on the `remediation` channel (the
		// `commit`/`gitCommitOutcome` pattern) — the arm's OWN edge folds it, so a
		// no-op remediation stops instead of re-validating an unchanged tree.
		"validate-fix": acts({ skill: "remediate", reads: ["plans", "validation"], outcome: remediationOutcome }),
		commit: acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		// The acceptance inventory derives between research (which grounds its
		// evidence commands) and slice (which must never see it — bounded
		// context). Slice's research input rides its explicit `reads` now that
		// the rolling primary here is the acceptance doc.
		research: "acceptance",
		acceptance: "slice",
		slice: "slice-check",
		// Skip the design-readiness re-grade when the gate is already satisfied — after
		// a `slice-fix` that only cleared the deterministic structure floor (the common
		// case: a bare-basename citation), the accumulated design-readiness verdict
		// already passes, so re-grading would only re-roll a flappy judgment. Also
		// skips after a fix for a `remedy: "cite"` fail once `slice-check` has
		// deterministically verified the demanded seeds landed on a structurally
		// unchanged map (the `citeDischarged` stamp — see `citeRemedyDischarged`),
		// and after a seed lift for the same reason.
		// First pass (no verdict yet) ⇒ not satisfied ⇒ into `slice-grade`. A
		// seed lift that already ran and left the gate red is STUCK — re-grading
		// or re-lifting cannot change the outcome — so the fail branch routes
		// the structural fix arm BEFORE the re-grade fallthrough.
		"slice-check": defineRoute(
			["slice-design", "slice-fix", "slice-grade"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : seedLiftStuck(state) ? "slice-fix" : "slice-grade"),
			{ readsData: false },
		),
		// Design-readiness gate BEFORE any design. Structure + design-readiness pass ⇒
		// design; a SEED-ONLY cite fail (every finding naming a concrete seed to add) ⇒
		// the deterministic `slice-seed-lift` arm, which appends the seeds and re-enters
		// `slice-check` for the discharge stamp — a full re-slice + re-grade for pure
		// citation bookkeeping repairs nothing the verdict flagged; anything else ⇒
		// slice-fix and loop back. (A dimension whose re-dispatch produced no verdict
		// takes the fix arm ahead of the seed-only check — a verdict-less dead
		// dimension is never seed-only.) Bounded by the runner's maxBackwardJumps
		// (default 3) under the absolute per-stage maxLaps ceiling (default 8;
		// both budgets fresh per invocation — a resume re-opens the loop).
		"slice-grade": sliceGradeRoute,
		"slice-fix": "slice-check",
		// Deterministic re-entry after the seed lift: the re-run structure check
		// stamps the discharge the gate folds on (a plain string edge — the
		// counted decision is the slice-grade route's lift pick).
		"slice-seed-lift": "slice-check",
		// Design fanout → consolidated human checkpoint → hierarchical synthesis.
		"slice-design": "design-review",
		"design-review": "subplan",
		// Route the cluster fanout through the deterministic coverage floor before
		// the root merge — the twin of `slice → slice-check`. A pass folds straight
		// to `plan`; a lost/clobbered cluster routes the backward edge to `subplan`,
		// bounded by the runner's maxBackwardJumps (default 3) under the absolute
		// per-stage maxLaps ceiling (default 8; both budgets fresh per invocation
		// — a resume re-opens the loop).
		subplan: "subplan-check",
		// Subplan coverage gate. Pass ⇒ root merge. A fail (lost cluster, clobbered
		// ordinal, tokenless basename, or a slice design absent from every sources:)
		// routes the backward edge to `subplan` — re-dispatch the cluster fanout,
		// which re-supplies each cluster's '--cluster <k>'. Bounded by the runner's
		// maxBackwardJumps (default 3) under the absolute per-stage maxLaps ceiling
		// (default 8; both budgets fresh per invocation — a resume re-opens the
		// loop). `readsData: false` — the route consults only the
		// deterministic verdict channel (mirrors the slice-check/plan-cite-check routes).
		"subplan-check": defineRoute(
			["plan", "subplan"],
			({ state }) => (subplanGatePasses(state) ? "plan" : "subplan"),
			{ readsData: false },
		),
		plan: "plan-cite-check",
		// Skip the quality re-grade straight to `code` when the gate is already
		// satisfied — a `plan-fix` that only cleared the citation floor leaves every
		// dimension + risk flag already passing, so re-grading the whole panel would
		// only re-roll flappy judgments. First pass (empty verdict channel) ⇒ not
		// satisfied ⇒ into `plan-grade`. If a fix left the cite floor RED, the gate
		// isn't satisfied and we re-enter `plan-grade` (which re-runs the subset).
		"plan-cite-check": defineRoute(
			["code", "plan-grade"],
			({ state }) => (planGatePasses(state) ? "code" : "plan-grade"),
			{ readsData: false },
		),
		// Quality gate BEFORE any code. The grade runs at `plan-grade`; the route
		// lives one hop later on `plan-demote` so the duty-demotion write-back
		// lands on the verdict JSON BEFORE this fold consults the downstream
		// readers. `plan-grade` is now a simple always-hop edge to `plan-demote`;
		// the route body below is the verbatim logic that used to live here.
		"plan-grade": "plan-demote",
		// Pass ⇒ code. A dimension's fresh confirm-worthy blocking verdict — a
		// HIGH-severity or risk-ruling blocker, or a regressed carried pass — ⇒
		// plan-confirm (one independent second judgment — see `confirmDue`; a
		// first-time medium finding skips the confirm and buys the surgical fix
		// directly); a confirmed blocker, or
		// a failure with no dimension blocking (the citation floor alone is red) ⇒
		// plan-fix, looping back THROUGH the citation floor so the amended plan
		// re-verifies. Route logic unchanged — merely shifted one hop later so the
		// demote write-back precedes it.
		"plan-demote": planDemoteRoute,
		// After the second judgment the gate re-folds on the latest verdicts: a
		// confirming pass overwrote the flap and clears the gate; a confirming
		// fail routes to the fix with two agreeing judgments behind it.
		"plan-confirm": defineRoute(
			["code", "plan-snapshot"],
			({ state }) => (planGatePasses(state) ? "code" : "plan-snapshot"),
			{ readsData: false },
		),
		// The snapshot is one deterministic hop between the grade/confirm route and
		// the fix — no new backward edge, inside the existing fix loop.
		"plan-snapshot": "plan-fix",
		"plan-fix": "plan-cite-check",
		code: "code-splice",
		"code-splice": "code-cite-check",
		// Skip the code re-grade straight to `implement` when the code gate is already
		// satisfied — a `code-fix` that only cleared the citation floor leaves the
		// panel already green. First pass (empty channel) ⇒ into `code-grade`.
		"code-cite-check": defineRoute(
			["implement", "code-grade"],
			({ state }) => (codeGatePasses(state) ? "implement" : "code-grade"),
			{ readsData: false },
		),
		// Re-grade the code-bearing plan at `code-grade`; the route lives one hop
		// later on `code-demote` (the twin of the plan gate's split) so the
		// duty-demotion write-back lands before this fold. `code-grade` is now a
		// simple always-hop edge to `code-demote`; the route body below is verbatim.
		"code-grade": "code-demote",
		// Pass ⇒ implement. A fresh confirm-worthy blocking verdict ⇒ code-confirm (the plan
		// gate's confirm contract, on the code-verdicts channel); a confirmed
		// blocker or cite-floor-only failure ⇒ code-fix. Routes to `code-fix`, NOT
		// back to `code`: the gate fails on plan-text defects (edit anchors, line
		// citations, naming) that a per-phase code rewrite cannot reach, so the
		// surgical arm is the one with authority over them. Route logic unchanged —
		// merely shifted one hop later. Bounded by the runner's maxBackwardJumps
		// (default 3) under the absolute per-stage maxLaps ceiling (default 8;
		// both budgets fresh per invocation — a resume re-opens the loop).
		"code-demote": codeDemoteRoute,
		"code-confirm": defineRoute(
			["implement", "code-snapshot"],
			({ state }) => (codeGatePasses(state) ? "implement" : "code-snapshot"),
			{ readsData: false },
		),
		// The code-gate twin of `plan-snapshot → plan-fix`.
		"code-snapshot": "code-fix",
		"code-fix": "code-cite-check",
		implement: "implement-scope-check",
		// Lane-level scope floor gate — tiered, see scopeFloorGate: pass AND
		// tracked excess ⇒ reconcile (excess findings ride the verdict channel and
		// validate adjudicates them via the --scope thread — the citation floor's
		// demote-and-adjudicate precedent); untracked-only ⇒ the deterministic
		// scope-quarantine arm; a missing/corrupt verdict ⇒ STOP (integrity
		// clause). The excess pick attaches the pass-through note naming validate
		// (the recap's routingNotes surface the deferral). Sourced from the
		// scope-check's published verdict channel (the
		// stage key for an outcome-less `produces.script`, per
		// `resolvePublishName`); `readsData: false` suppresses the outputSchema lint.
		"implement-scope-check": scopeFloorGate({ deferredTo: "validate" }),
		// Deterministic re-entry after the quarantine arm: a plain string edge
		// (non-counted, mirroring validate-fix's hop) with guaranteed progress —
		// quarantined paths leave the dirty set, so the re-check either passes or
		// reveals tracked drift. At most one quarantine hop per gate entry; no new
		// loop budget.
		"scope-quarantine": "implement-scope-check",
		// Reconciliation gate. Pass ⇒ validate; a `fail` (malformed directive /
		// absent find / non-test target — all plan-TEXT defects) ⇒ the
		// reconcile-fix amend arm; a missing verdict ⇒ STOP (integrity clause).
		// Safe by construction: the sole path onward to validate is an explicit
		// `verdict: "pass"`.
		reconcile: reconcileGate(),
		// Deterministic re-entry after the amend arm: reconcile re-parses the
		// repaired directives and applies them (a plain string edge — the
		// counted decision is the gate's reconcile-fix pick).
		"reconcile-fix": "reconcile",
		// Gate commit on validate's own verdict — see `validateGate`. `pass` ⇒
		// commit; a `fail` WITH remediable handles (a `pass: false` risk ruling or a
		// structured `blockers:` entry) ⇒ validate-fix, which re-enters at
		// implement-scope-check to re-reconcile + re-validate — bounded by the
		// per-destination backward-jump budget; a `fail` with NO handle ⇒ STOP with
		// a route note (the repair arm cannot act on prose-only failures — looping
		// it re-validated an unchanged tree until the guard halted the run).
		// A missing/unexpected verdict stays terminal STOP, so un-anticipated data
		// can never route INTO commit OR the repair arm. Safe by construction: the
		// sole path to commit is an explicit pass. No fix-round cap — the runner's
		// backward-jump guard is build's remediation budget.
		validate: validateGate(),
		// Re-entry after the repair arm: remediate's code-mutation is followed by a
		// fresh scope check → reconcile → validate pass, so a fix is re-verified
		// end-to-end before the gate re-folds. Now a decision edge (`validateFixGate`
		// folds the `remediation` channel's deterministic digest verdict): a
		// remediation that changed nothing STOPs here — progress is verified, not
		// assumed — while a real fix proceeds into the loop body.
		"validate-fix": validateFixGate(),
		commit: "stop",
	},
});

export { buildWorkflow };
