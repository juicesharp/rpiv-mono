// ===========================================================================
// vet — goal → code-review → (blueprint → implement → implement-scope-check
//       → validate → loop) | commit. Examine existing changes; capture the
//       brief as a goal artifact, review, and if not approved blueprint a fix
//       plan, implement it, scope-check it, validate, and re-review. Loops
//       until approved. NOTE: the cross-workflow gates it wires
//       (scopeFloorGate, reconcileGate, codeReviewGate, the RECONCILE_FIX_*
//       pair) come from ./shared.js — in the monolith this workflow sat after
//       those later-declared `const`s; imported, no declaration-order
//       constraint remains.
// ===========================================================================

import { acts, defineWorkflow, gitCommitOutcome, produces } from "@juicesharp/rpiv-workflow/registration";
import {
	captureReviewScope,
	IMPLEMENT_DAG_FANOUT,
	implementScopeCheckVet,
	reconcile,
	scopeQuarantine,
} from "../built-ins/index.js";
import {
	codeReviewGate,
	RECONCILE_FIX_OUTCOME,
	RECONCILE_FIX_PROMPT,
	reconcileGate,
	scopeFloorGate,
} from "./shared.js";

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
		"code-review": codeReviewGate(),
		blueprint: "implement",
		// Scope-check inserts BEFORE validate, INSIDE the review-fix loop. Pass →
		// validate; fail/missing terminates (STOP, no fallback). Byte-for-byte
		// build's route.
		implement: "implement-scope-check",
		// Scope-check still gates onward into `reconcile` (not validate): the
		// coherence backstop runs after the write-set is judged. Tiered route —
		// see scopeFloorGate: pass/excess ⇒ reconcile (excess carries the
		// code-review pass-through note), untracked-only ⇒ the quarantine arm,
		// missing/corrupt verdict ⇒ STOP.
		"implement-scope-check": scopeFloorGate({ deferredTo: "code-review" }),
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
		// maxBackwardJumps (3 → at most 4 review iterations) under the absolute
		// per-stage maxLaps ceiling (default 8; both budgets fresh per
		// invocation — a resume re-opens the loop).
		validate: "code-review",
		commit: "stop",
	},
});

export { vetWorkflow };
