/**
 * bash-strikes — the per-activation strike-ceiling policy for in-place
 * bash-overrun recovery. A watchdog tool-timeout is a recoverable tool event
 * INSIDE the live (never-failed) child session: while strikes remain, the
 * runner resets the watchdog verdict and re-prompts the SAME child with
 * operator-grade steering, then tail-recurses `postStage`; once strikes are
 * exhausted, the UNCHANGED `haltStageOrSoftHalt({ kind: "timeout" })` seam
 * fires (so the failure-row writers later phases hook still attach for free).
 *
 * This module owns the POLICY + the per-session accounting (the host/watchdog
 * owns only the per-command ceiling + the verdict). The first `process.env`
 * read in rpiv-workflow production: the no-cross-import boundary forbids
 * value-importing rpiv-pi, so the ceiling override is read here and clamped to
 * `[1,5]` (default 2). Mirrors `resolveBashTimeoutMs` (packages/rpiv-pi/extensions/rpiv-core/bash-timeout.ts:43-48)
 * for the resolve-once-at-module-load pattern.
 *
 * Strike-history observability is satisfied here: each consumed strike appends its
 * reason to the per-session `StrikeBudget` (a module-level WeakMap keyed off
 * session identity), and `bashTimeoutStrikeHistory(s)` surfaces
 * `{ count; reasons }` (or `undefined` at zero strikes) for the completed
 * `WorkflowStage` row to carry — an ADDITIVE optional field, NOT a new row kind
 * (the resume fold's shape-filtered readers ignore it, like errMsg).
 */

import type { StageSessionContext } from "../types.js";

const DEFAULT_BASH_TIMEOUT_STRIKES = 2; // one retry of a hung command is the operator-grade default.
const MIN_BASH_TIMEOUT_STRIKES = 1; // at least one strike before any escalation.
const MAX_BASH_TIMEOUT_STRIKES = 5; // hard cap on in-place retries before a runaway wedges the gate again.

/**
 * The resolved per-activation strike ceiling: the default 2, overridable via
 * `RPIV_BASH_TIMEOUT_STRIKES` and clamped to [1,5]. A non-numeric / non-positive
 * override falls back to the default. Strikes are a COUNT, so the parsed value is
 * truncated to an integer before clamping. Resolved once at module load (env is
 * fixed for a process); tests pin an explicit `s.bashTimeoutStrikes` override
 * instead of mutating env. This is the first `process.env` read in rpiv-workflow
 * production (see the module header above + L3.4-04).
 */
export const BASH_TIMEOUT_STRIKES = resolveBashTimeoutStrikes(process.env.RPIV_BASH_TIMEOUT_STRIKES);

export function resolveBashTimeoutStrikes(raw: string | undefined): number {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BASH_TIMEOUT_STRIKES;
	return Math.min(Math.max(Math.trunc(parsed), MIN_BASH_TIMEOUT_STRIKES), MAX_BASH_TIMEOUT_STRIKES);
}

// --- Steering-message guidance (module-owned prose, composed over the host reason) ---

/** the command is hung, not merely slow — waiting will not help. */
const MSG_HUNG_NOT_SLOW =
	"This command appears to be HUNG, not merely slow — continuing to wait will not make it finish.";

/** do not rerun the offending command verbatim; it will wedge the same way. */
const MSG_DO_NOT_RERUN_VERBATIM = "Do NOT rerun the same command verbatim — it will hang again the same way.";

/** diagnose the blockage or surface it so the workflow can route around it. */
const MSG_DIAGNOSE_OR_REPORT =
	"Diagnose the blockage (inspect the code under test, narrow the command's scope, or use a different verification), or report the blockage explicitly in the stage output.";

/** final-strike warning — one more identical overrun fails this activation. */
const MSG_FINAL_STRIKE =
	"WARNING: rerunning the same command again will consume the FINAL strike and fail this stage/unit.";

/**
 * Compose the steering message resent into the recovering child. The host's
 * operator-grade `reason` (which already carries the killed-command snippet +
 * ceiling seconds via `bashTimeoutReason`) is echoed verbatim, then the
 * diagnostic guidance prose is APPENDED — the guidance is module-owned and
 * never duplicates the snippet/ceiling (those come only from `reason`).
 * `strikesRemaining` is surfaced; the final-strike warning appears
 * ONLY when `isFinalStrike` (i.e. `strikesRemaining === 0`).
 */
export function bashTimeoutSteeringMessage(reason: string, strikesRemaining: number, isFinalStrike: boolean): string {
	const lines = [
		reason,
		`Strikes remaining after this one: ${strikesRemaining}.`,
		MSG_HUNG_NOT_SLOW,
		MSG_DO_NOT_RERUN_VERBATIM,
		MSG_DIAGNOSE_OR_REPORT,
	];
	if (isFinalStrike) lines.push(MSG_FINAL_STRIKE);
	return lines.join("\n\n");
}

// --- Per-session strike accounting (private StrikeBudget, keyed off session identity) ---

/**
 * Private per-activation strike budget: the mutable accounting (used counter +
 * reasons accumulator) that previously lived as two fields on `StageSessionContext`.
 * Held in a module-level `WeakMap<StageSessionContext, StrikeBudget>` so the budget
 * survives `postStage`'s tail-recursive recovery self-call
 * (packages/rpiv-workflow/sessions/sessions.ts:134 — same `s` ⇒ same entry ⇒ the
 * incremented counter is visible on the recursive turn) and is fresh on every
 * new `StageSessionContext` for free (no entry ⇒ zero strikes). `ceiling` is resolved
 * ONCE at first consume from the immutable `s.bashTimeoutStrikes ?? BASH_TIMEOUT_STRIKES`
 * override and frozen into the budget.
 */
interface StrikeBudget {
	readonly ceiling: number;
	used: number;
	reasons: string[];
}

// `let` (not `const`): `__resetStrikeBudgets()` reassigns this to a fresh map —
// `WeakMap` exposes no `.clear()`. Keyed by session identity (see StrikeBudget above).
let strikeBudgets: WeakMap<StageSessionContext, StrikeBudget> = new WeakMap();

/**
 * The ONLY creator of a `StrikeBudget`: lazily allocated on the first consume,
 * capturing the ceiling once from the immutable per-activation override.
 * `bashStrikesRemaining` and `bashTimeoutStrikeHistory` use a non-creating
 * `.get()` so a clean completion (no consume) allocates nothing — important
 * because `bashTimeoutStrikeHistory` runs on every successful stage inside
 * `recordStageSuccess` (packages/rpiv-workflow/sessions/success-persist.ts:49).
 */
function budgetForConsume(s: StageSessionContext): StrikeBudget {
	let budget = strikeBudgets.get(s);
	if (!budget) {
		budget = { ceiling: s.bashTimeoutStrikes ?? BASH_TIMEOUT_STRIKES, used: 0, reasons: [] };
		strikeBudgets.set(s, budget);
	}
	return budget;
}

/**
 * Consume one strike if any remain: increment the budget's `used` and append
 * `reason` to `reasons`, then return `true`. Returns `false` (mutating nothing)
 * when the ceiling is exhausted — the caller then takes the unchanged
 * soft-halt/terminal seam (packages/rpiv-workflow/sessions/sessions.ts:136).
 * Consumes-then-increments: with a default-2 ceiling, strikes 1 and 2 recover;
 * strike 3 returns false. Behavior byte-identical to the pre-encapsulation
 * field-on-session implementation; the `reasons` lazy-init collapses to a plain
 * `push` (the budget initializes `reasons: []`).
 */
export function consumeBashStrike(s: StageSessionContext, reason: string): boolean {
	const budget = budgetForConsume(s);
	if (budget.used >= budget.ceiling) return false; // exhausted — mutate nothing; caller escalates.
	budget.used += 1;
	budget.reasons.push(reason);
	return true;
}

/**
 * Strikes remaining AFTER the current consumption (0 on the final-strike resume).
 * Computed from the budget's post-increment counter, so it pairs with
 * `consumeBashStrike` having just run. NON-CREATING `.get()`: a session that
 * never consumed (or has no budget yet) reads its ceiling from the immutable
 * override (the former `bashStrikeCeiling` helper's job — removed — moved into
 * the budget's `ceiling` field + this fallback), allocating nothing.
 */
export function bashStrikesRemaining(s: StageSessionContext): number {
	const budget = strikeBudgets.get(s);
	const ceiling = budget?.ceiling ?? s.bashTimeoutStrikes ?? BASH_TIMEOUT_STRIKES;
	return Math.max(0, ceiling - (budget?.used ?? 0));
}

/**
 * The strike history for the completed `WorkflowStage` row —
 * `{ count; reasons }` when the session consumed ≥1 strike, else `undefined`
 * (so a clean completion omits the field and the row is byte-identical to today).
 * NON-CREATING `.get()`: "no entry" ≡ "zero strikes" ≡ `undefined` holds by
 * construction (invariant 2's 1st layer), not just by the `used <= 0` guard.
 * `reasons` lists each consumed strike's host reason, in consumption order.
 */
export function bashTimeoutStrikeHistory(s: StageSessionContext): { count: number; reasons: string[] } | undefined {
	const budget = strikeBudgets.get(s);
	if (!budget || budget.used <= 0) return undefined;
	return { count: budget.used, reasons: budget.reasons };
}

/**
 * Test-only: reset the module-level `strikeBudgets` WeakMap to a fresh instance.
 * The displaced map becomes unreachable and is GC'd with its entries. Re-exported
 * via `./internal.js` and invoked from `test/setup.ts` `beforeEach` (the
 * module-level-singleton contract; the identity-keyed map cannot leak across
 * tests in practice, but the reset makes the fresh-on-resume guarantee
 * deterministic in the regression test).
 */
export function __resetStrikeBudgets(): void {
	strikeBudgets = new WeakMap();
}
