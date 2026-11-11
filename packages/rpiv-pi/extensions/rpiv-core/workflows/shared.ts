/**
 * Cross-workflow layer for the built-in workflows shipped with rpiv-pi: the
 * gate and prompt factories every per-workflow module (./build.js, ./vet.js,
 * ./polish.js, ./ship.js) wires, plus the authoring doctrine they all follow.
 * Each workflow's `stages` insertion order IS its linear stage order —
 * `Object.keys(stages)` gives the natural read order for previews and
 * traversal alike.
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

import {
	defineRoute,
	type EdgeFn,
	eq,
	gate,
	gt,
	handleToString,
	type PromptFn,
	setRouteNote,
} from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "../artifact-collector.ts";
import { latestFsArtifact, verdictRiskRulings } from "../built-ins/index.ts";

// The code-review stage's output schema is no longer declared here — every
// code-review stage sources it from the skill's contract `produces.data`
// (`blockers_count` required), validated by the runtime output loop via
// `effectiveOutputSchema`. One source of truth, in the skill, not copy-pasted
// per workflow. Every workflow with a `code-review` stage — polish AND vet —
// routes on the same numeric gate: `gate("blockers_count", { <fix>: gt(0), commit: eq(0) }, "commit")`.

/**
 * The code-review numeric gate — zero remaining blockers ⇒ commit; any
 * blockers ⇒ the fix loop (blueprint, for both polish and vet). A FACTORY
 * (not one shared EdgeFn) for the scopeFloorGate reason: each workflow's
 * route-note symbol — and the gate's `.targets` metadata — must never alias
 * the other's. The `blockers_count` field is sourced + validated from the
 * code-review skill contract.
 */
const codeReviewGate = (): EdgeFn => gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit");

/**
 * Scope-floor gate factory — build and vet wire IDENTICAL tiered routes; a
 * factory (not one shared EdgeFn) so each workflow's route-note symbol never
 * aliases the other's. Branches on the floor's tiered `ScopeVerdict`:
 * "pass" AND tracked "excess" continue to `reconcile` — the floor demotes
 * tracked excess to downstream adjudication (build threads the verdict to
 * validate via `--scope`; vet's review loop sees the whole diff) instead of
 * halting, the citation-floor precedent (demote where a remedy or adjudicator
 * exists). The excess pick is an HONEST pass-through: it attaches a route note
 * naming the downstream adjudicator (`opts.deferredTo` — validate on build,
 * code-review on vet) so the end-of-run recap's `routingNotes` can surface the
 * deferral; the pass pick attaches no note (a clean pass needs no
 * explanation). "untracked-only" takes the deterministic `scope-quarantine`
 * arm.
 * Anything else — a missing or corrupt verdict — terminates ("stop" with a
 * route note): the integrity clause every de-halting change has preserved.
 * A `match` cannot send two enum values to one target, hence `defineRoute`;
 * `readsData: false` — the route consults the stage's published channel, not
 * its projected output (matching the other deterministic-floor routes).
 */
const scopeFloorGate = (opts: { deferredTo: string }): EdgeFn => {
	const route: EdgeFn = defineRoute(
		["reconcile", "scope-quarantine", "stop"],
		({ state }) => {
			const verdict = (state.named["implement-scope-check"]?.at(-1)?.data as { verdict?: unknown } | undefined)
				?.verdict;
			if (verdict === "untracked-only") return "scope-quarantine";
			if (verdict === "pass") return "reconcile";
			if (verdict === "excess") {
				// Honest pass-through: the floor did not PASS, it DEFERRED — record why
				// on the routing row (the recap's routingNotes) instead of a silent
				// reconcile that reads like a clean pass.
				setRouteNote(route, `pass-through: implement-scope-check defers to ${opts.deferredTo}`);
				return "reconcile";
			}
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
/**
 * The fix-arm note for a dead grade unit — the dimension soft-halted (after
 * its retry budget ran out, when the panel wires one) and left no verdict to
 * fold. Naming it keeps the failure legible and the repair targeted: the fix
 * arm re-enters the panel, `dimensionsToRegrade` still lists the dimension as
 * pending, and a healthy re-dispatch grades it for real.
 */
const unitFailedNote = (dims: readonly string[]): string => `unit-failed: ${dims.join(", ")} produced no verdict`;

export {
	codeReviewGate,
	RECONCILE_FIX_OUTCOME,
	RECONCILE_FIX_PROMPT,
	reconcileGate,
	scopeFloorGate,
	unitFailedNote,
	validateFixGate,
	validateGate,
};
