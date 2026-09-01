/**
 * Built-in workflows shipped with rpiv-pi. Each workflow's `stages`
 * insertion order IS its linear stage order — `Object.keys(stages)` gives
 * the natural read order for previews and traversal alike.
 *
 * Route edges use `gate(...)` from `@juicesharp/rpiv-workflow`, which
 * attaches `.targets` metadata so reachability checks and graph
 * introspectors can enumerate possible branches without probing.
 *
 * These workflows name skills bundled by rpiv-pi (research, design, plan,
 * implement, validate, code-review, revise, commit). Installing
 * rpiv-workflow without rpiv-pi means these workflows aren't loaded —
 * users author their own over their own skills.
 */

import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	acts,
	defineRoute,
	defineWorkflow,
	directoryPathCollector,
	type EdgeFn,
	eq,
	fanin,
	gate,
	gitCommitOutcome,
	gt,
	handleToString,
	jsonBodyParser,
	match,
	type PromptFn,
	produces,
	type RunView,
	setRouteNote,
	type Workflow,
} from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "./artifact-collector.js";
import {
	allDimensionsPass,
	anchorNitsOnly,
	CODE_CONFIRM_FANOUT,
	CODE_DIMENSION_FANOUT,
	COMMIT_BASELINE_PROMPT,
	captureGoal,
	captureReviewScope,
	codeDemote,
	codeGatePasses,
	codeSnapshot,
	confirmDue,
	FRONTMATTER_PHASE_FANOUT,
	freshVerdicts,
	haltPreflight,
	IMPLEMENT_DAG_FANOUT,
	IMPLEMENT_PLANS_FANOUT,
	implementScopeCheck,
	implementScopeCheckVet,
	latestArtifactPath,
	latestFsArtifact,
	latestPlans,
	latestVerdictPerDimension,
	PLAN_CONFIRM_FANOUT,
	PLAN_DIMENSION_FANOUT,
	PLAN_DIMENSIONS,
	planAuthoredRisks,
	planCitationCheck,
	planDemote,
	planGatePasses,
	planSnapshot,
	REVIEW_PHASE_ITERATE,
	reconcile,
	remediationOutcome,
	rulingEffectivePass,
	SHIP_DIMENSION_FANOUT,
	SHIP_DIMENSIONS,
	SLICE_DESIGN_FANOUT,
	SLICE_DIMENSION_FANOUT,
	SYNTH_CLUSTER_FANOUT,
	scopeQuarantine,
	shipGatePasses,
	shipVerdictOutcome,
	sliceGatePasses,
	sliceStructureCheck,
	subplanCoverageCheck,
	subplanGatePasses,
	VALIDATE_GOAL_PROMPT,
	verdictRiskRulings,
} from "./built-ins/index.js";

// The code-review stage's output schema is no longer declared here — every
// code-review stage sources it from the skill's contract `produces.data`
// (`blockers_count` required), validated by the runtime output loop via
// `effectiveOutputSchema`. One source of truth, in the skill, not copy-pasted
// per workflow. Every workflow with a `code-review` stage — polish AND vet —
// routes on the same numeric gate: `gate("blockers_count", { <fix>: gt(0), commit: eq(0) }, "commit")`.

// ===========================================================================
// polish — architecture-review → blueprint (iterate, per review phase) →
//          implement → validate → code-review → (blueprint loop) | commit
//          For a large architecture review that can't be planned in one pass:
//          plan each review phase sequentially, each plan building on the
//          ones before it, then implement/validate/review the lot.
// ===========================================================================

/**
 * Hand the single validate session EVERY plan from the latest blueprint pass
 * (`latestPlans`). The runner's default rolling-primary — and a plain
 * `reads: ["plans"]`, which only reads `.at(-1)` — would point validate at the
 * LAST plan alone, leaving earlier phases unvalidated. A `prompt` stage owns
 * its whole message, so the `/skill:validate` prefix is explicit.
 */
const VALIDATE_PLANS_PROMPT: PromptFn = ({ state, cwd }) => {
	const paths = latestPlans(state, cwd)
		.flatMap((o) => o.artifacts)
		.filter((a) => a.handle.kind === "fs")
		.map((a) => handleToString(a.handle));
	return `/skill:validate ${paths.join(" ")}`;
};

const polishWorkflow = defineWorkflow({
	name: "polish",
	description:
		"Architecture-review-driven polish: review → per-phase blueprint (sequential, accumulating) → implement → validate → code-review → commit. Best when a large architecture review can't be planned in one pass and each phase's plan must build on the ones before it.",
	start: "architecture-review",
	stages: {
		"architecture-review": produces(),
		blueprint: produces({ loop: REVIEW_PHASE_ITERATE }),
		implement: acts({ loop: IMPLEMENT_PLANS_FANOUT, reads: ["plans"] }),
		validate: produces({ prompt: VALIDATE_PLANS_PROMPT }),
		"code-review": produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		"architecture-review": "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		// Backward edge: code-review → blueprint re-plans (implement needs a plan).
		// The iterate stage re-runs over every review phase; bounded by the
		// runner's default maxBackwardJumps (3 → up to 4 review iterations).
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		commit: "stop",
	},
});

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
 * ship's research front-load — a LEANER grounding than build's `/skill:research`
 * pass, tiered to the brief's pre-chewedness. Bypasses the research skill: a
 * pre-chewed brief (root cause, files to touch, or fix already named) gets
 * VERIFICATION, not re-derivation — at most ONE verify-only `codebase-analyzer`
 * dispatch confirming each named anchor, or none at all when the anchors are
 * plain file paths the stage child reads itself; a symptom-only brief keeps at
 * most TWO targeted `codebase-analyzer` dispatches (sequentially — never
 * parallel, never `run_in_background`) mapping only what a lightweight
 * single-phase plan needs to be correct. The agent then `Write`s a grounding
 * doc under `.rpiv/artifacts/research/` (the prompt names the directory only —
 * a full example path would prime the collector's pre-write path-echo hazard),
 * where the research bucket collector harvests it — the grade panel's
 * architecture-fit dimension threads it as `--context` exactly as build's
 * research artifact does. A prompt stage (no skill), so the stage name
 * `research` drives outcome derivation (research contract → `research`
 * bucket), exactly as build's `RESEARCH_BRIEF_PROMPT` stage does — the prompt
 * text, not dispatch, is what differs. The prompt also pins a progress-marker
 * protocol — a `[Classified]:` first line naming the chosen tier,
 * `[Dispatch N/M]:` / `[Dispatch N/M returned]:` echo lines around each
 * grounding dispatch (plus the `[Dispatch]: none` zero-dispatch escape) — so
 * the lane console's live tail narrates the otherwise-silent batch window;
 * markers are transcript text only and never carry an artifacts path before
 * the write.
 */
const SHIP_RESEARCH_PROMPT: PromptFn = ({ state }) =>
	[
		"Ground this brief for a lightweight ship plan.",
		"Do NOT dispatch /skill:research — size the grounding to what the brief already carries.",
		"Classify the brief first, then follow ONLY the matching tier:",
		"- Tier A (pre-chewed — the brief names the root cause, the files to touch, or the fix): VERIFY, don't re-derive. Dispatch at most ONE codebase-analyzer subagent (sequentially — never parallel, never run_in_background) in verify-only mode, confirming or denying each named anchor against the actual code and reporting drift with the corrected file:line. If the anchors are plain file paths, dispatch nothing — Read/Grep them yourself.",
		"- Tier B (symptom only — the brief names none of the three: no root cause, no files, no fix): dispatch at most TWO targeted codebase-analyzer subagents (sequentially — never parallel, never run_in_background) to map only what a single-phase plan needs to be correct: entry points, the relevant module's shape, and the conventions the implement lane must match.",
		"Progress markers — echo your status as you go: the first line of your reply, before anything else, is [Classified]: Tier A — verify-only or [Classified]: Tier B — map ground truth (the tier you classified the brief into). Before each dispatch, emit [Dispatch N/M]: <purpose phrase>; once it lands, emit [Dispatch N/M returned]: <outcome phrase> (M is the tier's dispatch ceiling: 1 for Tier A, 2 for Tier B). For Tier A's zero-dispatch escape, emit [Dispatch]: none — reading the named anchors directly. Markers are transcript text only, never artifact content, and must NEVER contain a .rpiv/artifacts/ path before the file is written.",
		"",
		`Brief: ${state.originalInput}`,
		"",
		"Then Write the grounding doc under .rpiv/artifacts/research/ (timestamped filename, under 150 lines) carrying the findings with verifiable file:line citations — Code References, Integration Points, the relevant module's shape, and the conventions the implement lane must match — announce the written file's path in your final message, and stop.",
	].join("\n");

/**
 * Verdict channels — grade writes JSON to `.rpiv/artifacts/verdicts/`, so these
 * use the JSON directory collector + `jsonBodyParser` (NOT the md
 * `rpivBucketOutcome`). The slice gate and plan gate publish to DISTINCT named
 * channels (same dir, different artifact basenames) so their verdicts never
 * collide and `plan-fix`/`code-fix` can pick each via the `-verdicts` suffix convention.
 */
const verdictOutcome = (name: string) => ({
	name,
	collector: directoryPathCollector({ dir: ".rpiv/artifacts/verdicts", ext: "json" }),
	parser: jsonBodyParser,
});
const sliceVerdictOutcome = verdictOutcome("slice-verdicts");
const planVerdictOutcome = verdictOutcome("plan-verdicts");
// The post-splice code gate re-grades the now code-bearing plan on its own
// channel, so its verdicts never mix with the pre-elaborate plan gate's. Named
// for the object under judgment — the code the gate grades — completing the
// slice-verdicts / plan-verdicts / code-verdicts parallel.
const codeVerdictOutcome = verdictOutcome("code-verdicts");

/**
 * Absolute path to rpiv-pi's bundled deterministic stitch script. Resolved off
 * this module's own URL so it points inside the installed package at runtime
 * (built-in-workflows lives in extensions/rpiv-core; the script in skills/_shared).
 */
const STITCH_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills",
	"_shared",
	"stitch-elaborations.mjs",
);

// ===========================================================================
// vet — goal → code-review → (blueprint → implement → implement-scope-check
//       → validate → loop) | commit. Examine existing changes; capture the
//       brief as a goal artifact, review, and if not approved blueprint a fix
//       plan, implement it, scope-check it, validate, and re-review. Loops
//       until approved. NOTE: defined here (after captureGoal /
//       implementScopeCheckVet) rather than beside polish because its graph
//       references those later-declared `const`s — the same precedent
//       buildWorkflow follows (defined after its deps).
// ===========================================================================

/**
 * Scope-floor gate factory — build and vet wire IDENTICAL tiered routes; a
 * factory (not one shared EdgeFn) so each workflow's route-note symbol never
 * aliases the other's. Branches on the floor's tiered `ScopeVerdict`:
 * "pass" AND tracked "excess" continue to `reconcile` — the floor demotes
 * tracked excess to downstream adjudication (build threads the verdict to
 * validate via `--scope`; vet's review loop sees the whole diff) instead of
 * halting, the citation-floor precedent (demote where a remedy or adjudicator
 * exists). "untracked-only" takes the deterministic `scope-quarantine` arm.
 * Anything else — a missing or corrupt verdict — terminates ("stop" with a
 * route note): the integrity clause every de-halting change has preserved.
 * A `match` cannot send two enum values to one target, hence `defineRoute`;
 * `readsData: false` — the route consults the stage's published channel, not
 * its projected output (matching the other deterministic-floor routes).
 */
const scopeFloorGate = (): EdgeFn => {
	const route: EdgeFn = defineRoute(
		["reconcile", "scope-quarantine", "stop"],
		({ state }) => {
			const verdict = (state.named["implement-scope-check"]?.at(-1)?.data as { verdict?: unknown } | undefined)
				?.verdict;
			if (verdict === "untracked-only") return "scope-quarantine";
			if (verdict === "pass" || verdict === "excess") return "reconcile";
			setRouteNote(
				route,
				`implement-scope-check verdict ${JSON.stringify(verdict ?? null)} is not a ScopeVerdict — terminated (integrity stop)`,
			);
			return "stop";
		},
		{ readsData: false },
	);
	return route;
};

/**
 * The reconciliation gate — pass ⇒ validate; fail ⇒ the `reconcile-fix` repair
 * arm; missing/corrupt verdict ⇒ STOP (integrity clause, exactly the `match` it
 * replaces). The arm exists because every reconcile failure class — a malformed
 * directive, a stale `find`, a non-test target — is a defect in the PLAN's
 * directive text, which is `amend`'s exact authority ("fix the artifact, never
 * the repo"); the old no-arm route stopped the run on a fail that hand-repairing
 * the TREE could never clear (run 2026-08-31_15-21-14-57d0: a multi-line
 * directive re-failed every resume because the defect lived in the plan
 * artifact, which nothing in the pipeline could edit). Reconcile itself stays
 * the sole test-file writer — the arm only repairs directives; the loop
 * re-enters reconcile to apply them.
 *
 * A factory for the validateGate/scopeFloorGate reason — each workflow's
 * route-note symbol must never alias the other's. `maxFixRounds` caps the
 * amend hops a fail may buy, counted from the `reconcile-fix` channel — the
 * channel ONLY the arm itself writes (its outcome publishes there, not on
 * `plans`), mirroring validateGate's `remediation`-channel cap. It must NOT
 * count reconcile-channel entries: reconcile re-executes on paths that spend
 * no amend hop — ship's validate-fix loop re-enters through
 * implement-scope-check → reconcile, and a resume replays entries — so an
 * entry-count budget let the validate-fix loop spend the arm's only round
 * before the arm ever ran, with a stop-note claiming a fix round that never
 * happened (review 2026-08-31 I1; the fourth instance of the cap-must-read-a-
 * channel-the-arm-writes lesson). Build/vet pass no cap (the runner's
 * per-destination backward-jump budget on `reconcile-fix` is theirs, the
 * plan-fix precedent); ship caps at ONE — the same single bounded hop its
 * stop-on-fail identity concedes at the validate gate.
 */
const reconcileGate = (opts?: { maxFixRounds?: number }): EdgeFn => {
	const maxFixRounds = opts?.maxFixRounds ?? Number.POSITIVE_INFINITY;
	const route: EdgeFn = defineRoute(
		["validate", "reconcile-fix", "stop"],
		({ state }) => {
			const verdict = (state.named.reconcile?.at(-1)?.data as { verdict?: unknown } | undefined)?.verdict;
			if (verdict === "pass") return "validate";
			if (verdict !== "fail") {
				setRouteNote(
					route,
					`reconcile verdict ${JSON.stringify(verdict ?? null)} matched no branch — terminated (no fallback)`,
				);
				return "stop";
			}
			const roundsSpent = state.named["reconcile-fix"]?.length ?? 0;
			if (roundsSpent >= maxFixRounds) {
				setRouteNote(
					route,
					`reconcile still fails after ${roundsSpent} amend round${roundsSpent === 1 ? "" : "s"} — repair the #### Reconciliation directives in the PLAN artifact by hand (the failure lives in the plan text, not the tree), then resume`,
				);
				return "stop";
			}
			return "reconcile-fix";
		},
		{ readsData: false },
	);
	return route;
};

/**
 * The `reconcile-fix` arm's dispatch — `/skill:amend` over the latest plan and
 * the reconcile verdict. A PROMPT stage (owning its whole message, the
 * VALIDATE_PLANS_PROMPT precedent) because amend's generic flag parser keys
 * verdict inputs on the `-verdicts` name suffix, and reconcile's script stage
 * publishes on its stage-key channel `reconcile` — a `reads: ["reconcile"]`
 * skill stage would thread `--reconcile <path>`, which amend reads as a SECOND
 * artifact flag and refuses. The explicit `--reconcile-verdicts` spelling
 * parses as exactly one artifact (`--plans`) + one verdicts flag. The gate only
 * dispatches this arm on a fail verdict, so both channel reads are present by
 * construction; a torn state degrades to amend's own front-door refusal
 * (exactly-one-artifact + at-least-one-verdicts), never a silent guess.
 */
const RECONCILE_FIX_PROMPT: PromptFn = ({ state }) => {
	const parts = ["/skill:amend"];
	const plan = latestFsArtifact(state, "plans");
	if (plan) parts.push("--plans", handleToString(plan.handle));
	const verdict = state.named.reconcile?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");
	if (verdict) parts.push("--reconcile-verdicts", handleToString(verdict.handle));
	return parts.join(" ");
};

/**
 * The arm's outcome — the plans-bucket collector publishing on the arm's OWN
 * `reconcile-fix` channel. Amend re-emits the plan IN PLACE (same path, its
 * hard rule), so the `plans` channel's latest entry stays correct without a
 * republish; what the channel choice buys is the round counter ONLY the arm
 * increments, which `reconcileGate`'s cap reads (the validateGate/
 * `remediation` pattern — see the gate doc for why counting reconcile
 * executions instead let the validate-fix loop spend the budget).
 */
const RECONCILE_FIX_OUTCOME = { ...rpivBucketOutcome("plans"), name: "reconcile-fix" };

const vetWorkflow = defineWorkflow({
	name: "vet",
	description:
		"Examine existing changes for approval; loop a fix cycle if not approved. Best when a diff already exists (yours or a teammate's) and you want a structured review with optional repair. Chain: goal → code-review → (blueprint → implement → implement-scope-check → reconcile → validate → loop) → commit.",
	start: "goal",
	stages: {
		// Capture the user's brief verbatim on its own `goal` channel, and snapshot
		// the run-start pre-existing-dirty paths (role "baseline"). Uses
		// `captureReviewScope` — build's capture minus the garbage-brief floor,
		// because vet's input is a review-scope token ("staged", a hash) that is
		// legitimately shorter than any brief the floor admits — so the scope-check's
		// `reads: ["plans", "goal"]` resolves a baseline to subtract and the goal md
		// rides the channel face. `goal` as start publishes the goal-md as
		// `artifacts[0]`; `code-review` is a plain `produces()` SKILL stage (skill
		// defaults to its stage key "code-review"), so it inherits that goal-md PATH
		// as its rolling primary — the same pattern polish's code-review uses,
		// and the fallback Risk r1's note conceded "likely tolerates a goal-md-path
		// arg." The goal-md's CONTENT is the brief (`captureGoal` writes
		// `state.originalInput` into it), so the skill still reaches it.
		//
		// NOTE: the plan's r1 resolution made code-review PROMPT-dispatched to
		// preserve `state.originalInput` byte-for-byte, but that is REVERSED here: a
		// prompt stage carries NO skill, so the `code-review` contract no longer
		// attaches its `outputSchema` and the `blockers_count` gate would read
		// UNVALIDATED data (NaN-route risk, not just a warning). Keeping it a skill
		// stage keeps `skill="code-review"` → contract schema attaches → validated.
		goal: produces.script({ run: captureReviewScope }),
		"code-review": produces(),
		blueprint: produces(),
		// Dep-gated DAG variant: implement phases now
		// carry `id: phase-<n>` + `deps` derived from each phase's `files:` overlap /
		// authored `depends_on`, so the host cap may fan them out in parallel.
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Deterministic scope floor (no LLM): the lane may write ONLY the union of
		// every plan iteration's declared `files:` (vet's loop pushes DISTINCT
		// non-superseding fix plans, so the declared set is the UNION over the full
		// `plans` history — `implementScopeCheckVet`). The `from` form suppresses
		// the READS_DATA outputSchema lint, so no schema is declared, matching
		// `slice-check`/`plan-cite-check`. Tiered route (scopeFloorGate): pass and
		// tracked excess → reconcile (the review loop adjudicates the recorded
		// findings), untracked-only → scope-quarantine, missing verdict → STOP.
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheckVet }),
		// Deterministic remedy arm for the untracked-only tier: move (never
		// delete) run-created untracked excess under .rpiv/tmp/scope-quarantine/
		// and publish a manifest, then re-enter the floor — see scopeQuarantine.
		"scope-quarantine": produces.script({ reads: ["implement-scope-check"], run: scopeQuarantine }),
		// Deterministic post-implement reconciliation (no LLM) — the SAME `reconcile`
		// run-function as build (no vet twin): applies every `#### Reconciliation`
		// directive (write-restricted to the plan's declared write-set), fail-soft. Pass ⇒ validate;
		// fail ⇒ the reconcile-fix arm (see reconcileGate); missing ⇒ STOP.
		// `reads: ["plans"]` only — no run-start goal baseline.
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		// Repair arm for the reconciliation gate: /skill:amend over the plan's
		// directives from the reconcile verdict (a prompt stage — see
		// RECONCILE_FIX_PROMPT), re-emitting the plan latest-wins, then back
		// through reconcile to apply. Bounded by the runner's per-destination
		// backward-jump budget (the plan-fix precedent).
		"reconcile-fix": produces.prompt({ prompt: RECONCILE_FIX_PROMPT, outcome: RECONCILE_FIX_OUTCOME }),
		validate: produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "code-review",
		// Same numeric gate as polish: zero remaining blockers → commit;
		// any blockers → loop a fix pass through blueprint. The `blockers_count`
		// field is sourced + validated from the code-review contract.
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		blueprint: "implement",
		// Scope-check inserts BEFORE validate, INSIDE the review-fix loop. Pass →
		// validate; fail/missing terminates (STOP, no fallback). Byte-for-byte
		// build's route.
		implement: "implement-scope-check",
		// Scope-check still gates onward into `reconcile` (not validate): the
		// coherence backstop runs after the write-set is judged. Tiered route —
		// see scopeFloorGate: pass/excess ⇒ reconcile, untracked-only ⇒ the
		// quarantine arm, missing/corrupt verdict ⇒ STOP.
		"implement-scope-check": scopeFloorGate(),
		// Deterministic re-entry after the quarantine arm: a plain string edge
		// (non-counted, mirroring build's validate-fix hop) with guaranteed
		// progress — quarantined paths leave the dirty set, so the re-check
		// either passes or reveals tracked drift. At most one quarantine hop per
		// gate entry; no new loop budget.
		"scope-quarantine": "implement-scope-check",
		// Reconciliation gate. Pass ⇒ validate; a `fail` (malformed directive /
		// absent find / non-test target — all plan-TEXT defects) ⇒ the
		// reconcile-fix amend arm; a missing verdict ⇒ STOP (integrity clause).
		reconcile: reconcileGate(),
		// Deterministic re-entry after the amend arm: reconcile re-parses the
		// repaired directives and applies them (a plain string edge — the
		// counted decision is the gate's reconcile-fix pick).
		"reconcile-fix": "reconcile",
		// Backward edge: validate → code-review creates the review-fix loop —
		// UNCHANGED. The scope-check inserts before validate, so a failing scope
		// verdict halts before re-review, and a passing one flows into validate and
		// back to code-review exactly as today. Bounded by the runner's default
		// maxBackwardJumps (3 → at most 4 review iterations).
		validate: "code-review",
		commit: "stop",
	},
});

/**
 * The classifying validate gate — classifies a failing verdict BEFORE routing
 * to the repair arm. `remediate`'s work-list is contractually the report's
 * `pass: false` risk rulings plus its structured `blockers:` entries; a
 * `verdict: fail` carrying NEITHER (run 2026-08-22_12-14-12-64eb: two
 * whole-plan gate failures recorded only in report prose) has no handle the
 * arm may act on, so routing it to `validate-fix` buys a provably futile lap
 * — the arm drift-escapes without an edit and the unchanged tree re-validates
 * to the identical verdict until the backward-jump guard halts the run. Such
 * a fail STOPs at the gate with a route note naming why (the ship-gate
 * `setRouteNote` pattern; a noted decision stop records as a halt). The
 * repair-arm authority rule the slice gate learned the same way: a gate may
 * only loop into an arm whose authority covers the failure class.
 *
 * A factory (not one shared EdgeFn) for the scopeFloorGate reason — each
 * workflow's route-note symbol must never alias the other's. `maxFixRounds`
 * caps the remediation hops a remediable fail may buy: each `validate-fix`
 * pass publishes exactly one digest on the `remediation` channel, so the
 * channel length IS the rounds already spent. Build passes no cap (the
 * runner's backward-jump guard is its budget); ship caps at ONE — the single
 * bounded hop its stop-on-fail identity concedes (run 7299: a docs-gap
 * `fail` at the last stage stranded ~50 min of verified implementation).
 *
 * Reads the `validation` channel (validate's contract-derived publish bucket
 * — a prompt stage owns its message and can't inherit its contract's output
 * schema, so the gate folds the channel, never the raw stage output). A
 * missing/unexpected verdict stays terminal STOP, exactly as the `match` it
 * replaces — un-anticipated data can never route INTO commit OR the repair arm.
 */
const validateGate = (opts?: { maxFixRounds?: number }): EdgeFn => {
	const maxFixRounds = opts?.maxFixRounds ?? Number.POSITIVE_INFINITY;
	const route: EdgeFn = defineRoute(
		["commit", "validate-fix", "stop"],
		({ state }) => {
			const latest = state.named.validation?.at(-1);
			const data = latest?.data as { verdict?: unknown; blockers?: unknown } | undefined;
			if (data?.verdict === "pass") return "commit";
			if (data?.verdict !== "fail") {
				setRouteNote(
					route,
					`validate verdict ${JSON.stringify(data?.verdict ?? null)} matched no branch — terminated (no fallback)`,
				);
				return "stop";
			}
			// Remediable handles: `pass: false` risk rulings (the arm's original
			// work-list) + structured `blockers:` entries (whole-plan gate failures
			// the validate skill attributes with a runnable command + in-delta file).
			const failedRulings = latest ? verdictRiskRulings(latest).filter((r) => !r.pass).length : 0;
			const blockers = Array.isArray(data.blockers) ? data.blockers.length : 0;
			if (failedRulings + blockers === 0) {
				setRouteNote(
					route,
					"validate failed with no remediable handle (no pass:false risk ruling, no blockers entry) — the remediation arm cannot act; fix manually or revise the plan",
				);
				return "stop";
			}
			if ((state.named.remediation?.length ?? 0) >= maxFixRounds) {
				setRouteNote(
					route,
					`validate still fails after ${maxFixRounds} remediation round${maxFixRounds === 1 ? "" : "s"} — fix manually, then resume to re-validate`,
				);
				return "stop";
			}
			return "validate-fix";
		},
		{ readsData: false },
	);
	return route;
};

/**
 * The repair-arm progress gate — the deterministic no-op backstop. The
 * `remediation` channel carries `remediationOutcome`'s `{ changed }` (a
 * git-only tree digest snapshotted around the `validate-fix` stage): an
 * unchanged tree makes the re-validate lap provably futile (validate's
 * verdict is a function of the tree), so it STOPs with a note instead of
 * burning a backward-jump on an identical verdict. Only an explicit
 * `changed: false` stops — a missing signal (non-repo, git failure, absent
 * channel) proceeds, the worktree-digest degrade doctrine. A factory for the
 * same note-symbol-aliasing reason as `validateGate`. NOTE the resume
 * asymmetry this stop relies on: the runner never re-dispatches a halted
 * SIDE-EFFECT gate stage — resume re-enters at this gate's onward target
 * (implement-scope-check), so a hand-fix after this stop re-verifies
 * end-to-end instead of replaying a remediation that would no-op again.
 */
const validateFixGate = (): EdgeFn => {
	const route: EdgeFn = defineRoute(
		["implement-scope-check", "stop"],
		({ state }) => {
			const data = state.named.remediation?.at(-1)?.data as { changed?: unknown } | undefined;
			if (data?.changed !== false) return "implement-scope-check";
			setRouteNote(
				route,
				"remediation left the working tree unchanged — re-validating cannot change the verdict; fix manually or revise the plan",
			);
			return "stop";
		},
		{ readsData: false },
	);
	return route;
};

const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Ship, sliced: capture the verbatim brief as a goal artifact (the north star the quality gates' completeness/correctness dimensions and validate anchor against) → research the brief → derive a goal-anchored acceptance inventory (the executable standard of completion, frozen before any plan so it cannot inherit the plan's scope; the completeness gates anchor on it and validate executes its evidence commands) → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → one consolidated developer checkpoint (accept or adjust the proposed interfaces/data types, adjustments applied surgically and cascaded to dependents) → synthesize hierarchically (per-cluster sub-plans → one merged plan) → tier-scaled quality-panel gate (a one-slice, <=2-phase run grades correctness+completeness only; larger or previously-failing runs grade the full completeness/correctness/actionability/pattern-following/architecture-fit roster) where a dimension's fresh HIGH-severity, risk-ruling, or regressed-pass blocking verdict gets one confirming second judgment before it buys a plan-fix round (a first-time medium finding routes straight to the surgical fix) → elaborate code per phase in parallel → splice it into the plan → re-grade the code-bearing plan (same tier + confirm contract) → implement → implement-scope-check → reconcile → validate → commit. Research-led; three automated gates plus one human design checkpoint, before design, before code, and after the splice.",
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
			reads: ["slices", fanin("slice-verdicts"), fanin("slice-check")],
		}),
		// Design every slice in parallel.
		"slice-design": produces({ skill: "design-slice", loop: SLICE_DESIGN_FANOUT }),
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
		// refraction) alongside the cluster sub-plans it fans in.
		plan: produces({ skill: "synthesize", reads: ["research", fanin("subplans")] }),
		// Deterministic citation floor BEFORE the LLM plan gate (twin of `slice-check`):
		// a fabricated `file:line` in the plan fails structurally and routes to `plan-fix`.
		"plan-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("plan-cite-check") }),
		// Quality gate over the plan; verdicts on their own channel.
		"plan-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: planVerdictOutcome,
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
			reads: ["plans", fanin("plan-verdicts"), fanin("plan-cite-check"), "goal", "research", fanin("subplans")],
		}),
		// Snapshot the graded plan BEFORE plan-fix amends it — one deterministic
		// hop inside the existing fix loop (plan-grade/plan-confirm → plan-snapshot
		// → plan-fix). The re-grade reads the prior off the snapshot's OWN channel
		// (`plan-snapshot`) to decide whether the amend was surgical (re-grade only
		// the failing dims) or broad (re-grade the full roster). `produces.script`
		// rides its stage-name channel, so this publishes to `plan-snapshot`, NOT
		// `plans` — `latestFsArtifact(state, "plans")` still resolves to the real
		// (amended) plan.
		"plan-snapshot": produces.script({ reads: ["plans"], run: planSnapshot }),
		// Elaborate implement-ready code into each phase in parallel (fanout),
		// deterministically splice it back into the plan (code-splice), then
		// re-grade the now code-bearing plan — guarding the blind-splice risk.
		code: produces({ skill: "elaborate", loop: FRONTMATTER_PHASE_FANOUT, reads: ["plans"] }),
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
				execFileSync("node", [STITCH_SCRIPT, planPath], { cwd });
			},
		}),
		// Deterministic citation floor over the SPLICED (code-bearing) plan before
		// the LLM code gate — the code-scope twin of `plan-cite-check`.
		"code-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("code-cite-check") }),
		"code-grade": produces({
			skill: "grade",
			loop: CODE_DIMENSION_FANOUT,
			outcome: codeVerdictOutcome,
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
		"code-snapshot": produces.script({ reads: ["plans"], run: codeSnapshot }),
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
		// unchanged map (the `citeDischarged` stamp — see `citeRemedyDischarged`).
		// First pass (no verdict yet) ⇒ not satisfied ⇒ into `slice-grade`.
		"slice-check": defineRoute(
			["slice-design", "slice-grade"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-grade"),
			{ readsData: false },
		),
		// Design-readiness gate BEFORE any design. Structure + design-readiness pass⇒ design; any fails ⇒
		// slice-fix and loop back. Bounded by the runner's maxBackwardJumps (default 3).
		"slice-grade": defineRoute(
			["slice-design", "slice-fix"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-fix"),
			{ readsData: false },
		),
		"slice-fix": "slice-check",
		// Design fanout → consolidated human checkpoint → hierarchical synthesis.
		"slice-design": "design-review",
		"design-review": "subplan",
		// Route the cluster fanout through the deterministic coverage floor before
		// the root merge — the twin of `slice → slice-check`. A pass folds straight
		// to `plan`; a lost/clobbered cluster routes the backward edge to `subplan`,
		// bounded by the runner's maxBackwardJumps.
		subplan: "subplan-check",
		// Subplan coverage gate. Pass ⇒ root merge. A fail (lost cluster, clobbered
		// ordinal, tokenless basename, or a slice design absent from every sources:)
		// routes the backward edge to `subplan` — re-dispatch the cluster fanout,
		// which re-supplies each cluster's '--cluster <k>'. Bounded by the runner's
		// maxBackwardJumps. `readsData: false` — the route consults only the
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
		"plan-demote": defineRoute(
			["code", "plan-confirm", "plan-snapshot"],
			({ state }) =>
				planGatePasses(state)
					? "code"
					: confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS)
						? "plan-confirm"
						: "plan-snapshot",
			{ readsData: false },
		),
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
		// merely shifted one hop later. Bounded by the runner's maxBackwardJumps.
		"code-demote": defineRoute(
			["implement", "code-confirm", "code-snapshot"],
			({ state }) =>
				codeGatePasses(state)
					? "implement"
					: confirmDue(state, "plans", "code-verdicts", PLAN_DIMENSIONS)
						? "code-confirm"
						: "code-snapshot",
			{ readsData: false },
		),
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
		// clause). Sourced from the scope-check's published verdict channel (the
		// stage key for an outcome-less `produces.script`, per
		// `resolvePublishName`); `readsData: false` suppresses the outputSchema lint.
		"implement-scope-check": scopeFloorGate(),
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

/**
 * Reason strings for ship's two bespoke stop picks — persisted on the
 * `RoutingDecision` row via `setRouteNote` so `summarizeRun` can surface
 * "stopped at <gate>: <why>" in the end-of-run recap and toast. `match`/`gate`
 * edges attach their own no-match diagnostics; only these two `defineRoute`
 * gates would otherwise stop silently. Best-effort DIAGNOSTICS, not gates:
 * `allDimensionsPass`/`shipGatePasses` stay the sole routing authorities, and
 * these mirror their severity floor only to NAME the blockers.
 */
const shipCiteStopNote = (state: RunView): string => {
	const data = state.named["plan-cite-check"]?.at(-1)?.data as { findings?: unknown } | undefined;
	// Blocking findings only — the gate passes an advisory-only (severity `low`)
	// verdict, so when this note renders the blockers are what stopped the run.
	const n = Array.isArray(data?.findings)
		? data.findings.filter((f) => (f as { advisory?: boolean } | null)?.advisory !== true).length
		: 0;
	return n > 0 ? `plan citation check failed (${n} finding${n === 1 ? "" : "s"})` : "plan citation check failed";
};
const shipGradeStopNote = (state: RunView): string => {
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	if (fresh.length === 0) return "no fresh verdicts for the current plan";
	const risks = planAuthoredRisks(state, "plans");
	const latest = latestVerdictPerDimension(fresh);
	const blockers: string[] = [];
	for (const d of SHIP_DIMENSIONS) {
		const o = latest.get(d);
		if (!o) continue;
		const v = o.data as { pass?: boolean; severity?: string; findings?: unknown };
		const floored = v.pass === true || v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		if (!floored) blockers.push(`${d} failed (${v.severity ?? "unrated"})`);
		else if (verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id))))
			blockers.push(`${d} risk flag failed`);
	}
	return blockers.length > 0 ? blockers.join(", ") : "gate failed";
};

// Named (not inline) so the stop branch can self-reference for setRouteNote —
// the same closure-over-own-binding pattern gate()/match() use internally.
// Citation-floor gate. Pass ⇒ grade; fail ⇒ STOP (no fix arm — the lightweight
// preset terminates on any red gate). Only BLOCKING findings fail here: an
// advisory-only verdict rates `low` and rides through `allDimensionsPass`'
// severity floor to grade, where the correctness unit adjudicates it
// (`--cite-check`). The route folds `allDimensionsPass` over
// the stage's OWN published channel, NOT `match("verdict", …)`:
// `writeStructureVerdict` (the floor's envelope) carries no `verdict` field, so
// a verdict match would misread — this mirrors build's `planGatePasses` first
// clause. `readsData: false` — the route consults the deterministic verdict
// channel only.
const shipCiteGate: EdgeFn = defineRoute(
	["grade", "stop"],
	({ state }) => {
		if (allDimensionsPass(state.named["plan-cite-check"])) return "grade";
		setRouteNote(shipCiteGate, shipCiteStopNote(state));
		return "stop";
	},
	{ readsData: false },
);
// Quality gate PRE-implement. `shipGatePasses` (the bespoke fold over
// SHIP_DIMENSIONS + risk flags on the `ship-verdicts` channel) does NOT re-fold
// the citation floor; this edge is the sole gate. Pass ⇒ implement; fail ⇒
// STOP — no confirm/snapshot/fix loop.
const shipGradeGate: EdgeFn = defineRoute(
	["implement", "stop"],
	({ state }) => {
		if (shipGatePasses(state)) return "implement";
		setRouteNote(shipGradeGate, shipGradeStopNote(state));
		return "stop";
	},
	{ readsData: false },
);

/**
 * ship — the lightweight `/wf` preset: the no-ceremony path for small-to-
 * midsize tasks whose approach is obvious. goal → research → acceptance →
 * plan → plan-cite-check → grade → implement → implement-scope-check →
 * reconcile → validate → (validate-fix, once) | commit, stop-on-fail at every gate: a red
 * gate halts the run (the agent hand-repairs and RESUMES — `/wf @<runId>`
 * re-runs the halted gate against the repaired tree, reusing every upstream
 * artifact) instead of looping a fix cycle. The ONE concession to that
 * identity is validate's single bounded remediation hop (run 7299: a
 * remediable docs-gap `fail` at the last stage stranded ~50 min of verified
 * implementation behind a terminal stop). Research stays front-loaded — a
 * brief-sized grounding pass (SHIP_RESEARCH_PROMPT, not a full
 * `/skill:research` run: at most one verify-only dispatch when the brief names
 * root cause, files, or fix — none when its anchors are plain file paths; at
 * most two targeted dispatches otherwise) — because the single PRE-implement
 * grade's architecture-fit dimension needs its artifact as `--context`. That
 * grade is tier-independent: the bespoke SHIP_DIMENSION_FANOUT always grades
 * the full correctness/completeness/architecture-fit roster (no
 * gateTier/gateRoster light-tier drop), and SHIP's gate folds risk flags
 * without re-folding the citation floor (that floor folds at its own edge).
 */
const shipWorkflow = defineWorkflow({
	name: "ship",
	description:
		"Ship, unsliced: capture the verbatim brief as a goal artifact → ground it with a brief-sized research pass (none or one verify-only codebase-analyzer dispatch when the brief names root cause, files, or fix; at most two targeted dispatches otherwise — no /skill:research) → derive a goal-anchored acceptance inventory (the executable standard of completion, frozen before planning; quick-plan records a per-item disposition, the completeness gate anchors on it, validate executes its evidence commands) → one lightweight quick-plan pass → deterministic citation floor (files: coverage gaps stop; citation-resolution findings are advisory and adjudicated by the grade panel) → single tier-independent quality gate (correctness/completeness/architecture-fit, stop-on-fail) → implement → implement-scope-check → reconcile → validate → commit. Every gate halts the run on fail (hand-repair, then resume with /wf @<runId> to re-run the gate) — except a reconcile fail (a plan-text directive defect), which buys ONE bounded amend hop over the plan's directives, and a validate fail carrying structured remediable handles, which buys ONE bounded remediation hop before halting.",
	start: "goal",
	stages: {
		// build's verbatim goal capture — the brief on its own channel, plus the
		// run-start pre-existing-dirty snapshot the scope-check subtracts.
		goal: produces.script({ run: captureGoal }),
		// The lean grounding pass — SHIP_RESEARCH_PROMPT (a custom prompt, NOT
		// /skill:research), sized to the brief's pre-chewedness: at most one
		// verify-only codebase-analyzer dispatch when the brief names root
		// cause, files, or fix (none when its anchors are plain file paths);
		// at most two targeted dispatches when it names only a symptom; then
		// one grounding doc under .rpiv/artifacts/research/. A prompt stage,
		// so the stage name `research` drives outcome derivation (research
		// contract → `research` bucket) exactly as build's
		// RESEARCH_BRIEF_PROMPT stage does.
		research: produces({ prompt: SHIP_RESEARCH_PROMPT }),
		// The goal-derived acceptance inventory — the executable standard of
		// completion, authored BEFORE any plan exists so it cannot inherit the
		// plan's scope. Items enumerate the verbatim brief's asks (research
		// grounds only the evidence commands, never membership — the skill's
		// hard rule, since research routinely narrows the brief). Downstream:
		// quick-plan addresses-or-defers each item, the grade panel's
		// completeness unit anchors on the inventory (--acceptance), and
		// validate EXECUTES the evidence commands against the finished tree.
		// Outcome derives from the acceptance contract (artifactKind:
		// acceptance → `acceptance` bucket).
		acceptance: produces({ reads: ["goal", "research"] }),
		// The lightweight planner — quick-plan: ONE targeted
		// codebase-pattern-finder dispatch, one `status: ready` plan, no risks
		// frontmatter, no multi-slice decomposition. Derives its `plans` outcome
		// from the quick-plan contract (artifactKind: plan). Reads all three
		// channels explicitly (`--research <path> --goal <path>
		// --acceptance <path>`) — without `goal` the stage falls to the rolling
		// primary and the planner sees only the research doc, whose grounding
		// routinely narrows the brief; the grade panel's completeness dimension
		// anchors on the VERBATIM goal and the acceptance inventory, so the
		// planner must anchor on the same artifacts and record a per-item
		// disposition (implemented or deferred) instead of silently inheriting
		// the drop.
		plan: produces({ skill: "quick-plan", reads: ["research", "goal", "acceptance"] }),
		// Deterministic citation floor BEFORE the LLM gate — build's verifier
		// verbatim. Only a `files:` coverage gap fails structurally and STOPs the
		// run; every citation-resolution finding (unresolved path, ambiguity,
		// drift) is advisory — rates `low`, passes the gate, and reaches the
		// grade panel's correctness unit as `--cite-check` for adjudication.
		"plan-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("plan-cite-check") }),
		// Single PRE-implement grade over the fixed three-dimension roster
		// (SHIP_DIMENSION_FANOUT — tier-independent, no confirm/snapshot arms);
		// verdicts on the `ship-verdicts` channel. `research` is read so the
		// architecture-fit unit threads it as --context; `goal` so
		// completeness/correctness anchor on the verbatim brief; `acceptance` so
		// the completeness unit checks the plan's per-item dispositions against
		// the frozen inventory (--acceptance).
		grade: produces({
			skill: "grade",
			loop: SHIP_DIMENSION_FANOUT,
			outcome: shipVerdictOutcome,
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		// Dep-gated DAG implement — build's lane verbatim.
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Lane-level scope floor — build's latest-only variant (vet uses the
		// union variant for its fix loop; ship has no loop, so the latest plan's
		// declared write-set is the whole contract). Pass ⇒ reconcile; fail ⇒ STOP.
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheck }),
		// Deterministic post-implement reconciliation — build's run-function
		// verbatim. Pass ⇒ validate; fail ⇒ ONE bounded reconcile-fix hop
		// (maxFixRounds: 1 — the validate-gate concession's twin); missing ⇒ STOP.
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		// Repair arm — build's prompt stage verbatim; ship's reconcile gate
		// dispatches it at most ONCE. Kept despite the stop-on-fail identity for
		// the same reason as validate-fix: a reconcile fail is a plan-TEXT defect
		// a hand-repair of the TREE can never clear, so the terminal stop was
		// unresumable without hand-editing the plan artifact.
		"reconcile-fix": produces.prompt({ prompt: RECONCILE_FIX_PROMPT, outcome: RECONCILE_FIX_OUTCOME }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		// Repair arm — build's stage verbatim; ship's validate gate dispatches it
		// at most ONCE (maxFixRounds: 1). Kept because the terminal gate is where
		// a red verdict strands the most verified work over the least defect: the
		// arm acts only on the report's structured handles, and its own progress
		// gate stops a no-op remediation instead of re-validating an unchanged tree.
		"validate-fix": acts({ skill: "remediate", reads: ["plans", "validation"], outcome: remediationOutcome }),
		commit: acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		research: "acceptance",
		acceptance: "plan",
		plan: "plan-cite-check",
		// Both gates are the named EdgeFns above — they attach a stop-reason
		// ROUTE_NOTE the recap surfaces; routing semantics are unchanged.
		"plan-cite-check": shipCiteGate,
		grade: shipGradeGate,
		implement: "implement-scope-check",
		// Scope floor gate — DELIBERATELY NOT build/vet's tiered scopeFloorGate:
		// ship's identity is stop-on-fail with no fix loops, so the sole path
		// onward stays an explicit `verdict: "pass"`. The floor's tiered
		// "untracked-only"/"excess" verdicts (which build quarantines/adjudicates)
		// are terminal here like any other red gate — the match's no-branch note
		// names the value, and the agent hand-repairs and re-invokes. Sourced from
		// the stage's own channel via the `from` form (suppresses the READS_DATA
		// outputSchema lint).
		"implement-scope-check": match("verdict", { reconcile: "pass" }, { from: "implement-scope-check" }),
		// Reconciliation gate — build's route, capped at ONE amend round (the
		// reconcile channel's entry count IS the rounds spent): pass ⇒ validate;
		// first fail ⇒ reconcile-fix; a fail after the spent round, or a missing
		// verdict ⇒ STOP with a route note naming the plan artifact as the
		// repair site.
		reconcile: reconcileGate({ maxFixRounds: 1 }),
		// Re-entry after the amend arm — reconcile re-parses and applies the
		// repaired directives; the spent round now stops any remaining fail.
		"reconcile-fix": "reconcile",
		// Validate gate — build's classifying gate, capped at ONE remediation
		// round: `pass` ⇒ commit; a `fail` WITH structured remediable handles and
		// no remediation spent ⇒ validate-fix; every other fail (prose-only, or
		// the one round already used) ⇒ STOP with a route note. The cap is what
		// keeps ship's stop-on-fail identity: the arm is a single bounded hop,
		// not a loop — the runner's `remediation`-channel length enforces it
		// deterministically. NOT vet's tail: vet's validate routes to
		// code-review, which gates back to blueprint (a bounded backward loop).
		validate: validateGate({ maxFixRounds: 1 }),
		// Re-entry after the repair arm — build's edge: a remediation that
		// changed nothing STOPs (progress is verified, not assumed); a real fix
		// re-enters at implement-scope-check so it is re-verified end-to-end
		// (scope floor → reconcile → validate) before the gate re-folds — where
		// the spent round now stops any remaining fail.
		"validate-fix": validateFixGate(),
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export { SHIP_DIMENSION_FANOUT, SHIP_DIMENSIONS, shipGatePasses, shipVerdictOutcome } from "./built-ins/index.js";

// Position 0 is load-bearing: `build` is the default `/wf` workflow when no
// project/user config sets one (resolve-default.ts resolves
// `Map.keys().next().value`), so it MUST stay first in this array.
export const builtInWorkflows: readonly Workflow[] = [buildWorkflow, vetWorkflow, polishWorkflow, shipWorkflow];
