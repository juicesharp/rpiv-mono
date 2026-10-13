/**
 * ship — the lightweight `/wf` preset's authoring module. The graph and its
 * doc-block live below (verbatim from the monolith); composed into
 * `builtInWorkflows` by the `../built-in-workflows.ts` barrel. Research
 * front-load, stop notes, and the two bespoke stop-named gates precede it.
 */

import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	gitCommitOutcome,
	match,
	type PromptFn,
	produces,
	type RunView,
	setRouteNote,
} from "@juicesharp/rpiv-workflow/registration";
import {
	allDimensionsPass,
	COMMIT_BASELINE_PROMPT,
	captureGoal,
	freshVerdicts,
	IMPLEMENT_DAG_FANOUT,
	implementScopeCheck,
	latestArtifactPath,
	latestVerdictPerDimension,
	planAuthoredRisks,
	planCitationCheck,
	reconcile,
	remediationOutcome,
	rulingEffectivePass,
	SHIP_DIMENSION_FANOUT,
	SHIP_PANEL_PROGRESS,
	shipGatePasses,
	shipRoster,
	shipVerdictOutcome,
	unitFailedDimensions,
	VALIDATE_GOAL_PROMPT,
	type VerdictRecord,
	verdictBlocks,
	verdictRiskRulings,
} from "../built-ins/index.js";
import {
	RECONCILE_FIX_OUTCOME,
	RECONCILE_FIX_PROMPT,
	reconcileGate,
	unitFailedNote,
	validateFixGate,
	validateGate,
} from "./shared.js";

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
 * Reason strings for ship's two bespoke stop picks — persisted on the
 * `RoutingDecision` row via `setRouteNote` so `summarizeRun` can surface
 * "stopped at <gate>: <why>" in the end-of-run recap and toast. `match`/`gate`
 * edges attach their own no-match diagnostics; only these two `defineRoute`
 * gates would otherwise stop silently. Best-effort DIAGNOSTICS, not gates:
 * `allDimensionsPass`/`shipGatePasses` stay the sole routing authorities, and
 * these consult the shared `verdictBlocks` predicate — the same fold those
 * gates route on — only to NAME the blockers.
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
	// A dead grade unit (post-re-dispatch) is the loudest blocker — name it
	// ahead of the severity blockers (ship's arm is stop + hand-repair +
	// resume, so the note IS the repair instruction).
	const unitFailed = unitFailedDimensions(state, "plans", "ship-verdicts", shipRoster(state));
	if (unitFailed.length > 0) return unitFailedNote(unitFailed);
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	if (fresh.length === 0) return "no fresh verdicts for the current plan";
	const risks = planAuthoredRisks(state, "plans");
	const latest = latestVerdictPerDimension(fresh);
	const blockers: string[] = [];
	for (const d of shipRoster(state)) {
		const o = latest.get(d);
		if (!o) continue;
		const v = o.data as VerdictRecord | undefined;
		if (verdictBlocks(v)) blockers.push(`${d} failed (${v?.severity ?? "unrated"})`);
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
			// Whole-lap progress: declared for uniformity — ship's grade gate
			// routes implement or stop, so no edge ever re-enters this stage and
			// the hook never fires.
			progress: SHIP_PANEL_PROGRESS,
			reads: ["plans", "research", "goal", "acceptance"],
		}),
		// Dep-gated DAG implement — build's lane verbatim.
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Lane-level scope floor — build's latest-only variant (vet uses the
		// union variant for its fix loop; ship has no loop, so the latest plan's
		// declared write-set is the whole contract). Pass ⇒ reconcile; fail ⇒ STOP.
		// The shared run function carries the validate-report acceptance: a
		// validate-fix hop's blocker-named writes are accepted as declared scope
		// (fail-closed on missing/older remediation) — ship's single bounded
		// validate-fix hop re-enters here, landing exactly that shape.
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

export { shipWorkflow };
