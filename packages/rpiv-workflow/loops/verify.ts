/**
 * Verify — the per-stage post-condition desugared to a degenerate assess loop.
 * `verify()` builds the `VerifySpec` a stage carries on its `verify` field;
 * `synthesizeVerifyLoop` is the desugar the runner consults (via
 * `effectiveLoopOf`). Runner-free — safe on `registration`.
 */

import type { AssessLoop, VerifySpec } from "../api.js";
import { assertShape } from "../judge.js";
import { judgeSlotShapeIssues, VERIFY_LOOP_DEFAULTS } from "./constructors.js";

/**
 * Per-stage post-condition judge: after each attempt of the stage completes,
 * `judge` grades it and `done(verdict)` gates advancement — true → advance
 * with the attempt's producer pair; false → fresh retry attempt (prompt arg
 * from `feedForward`) up to `max` attempts (default 1 = gate-only), then a
 * terminal "verification failed" halt. Requires `kind: "produces"` + an
 * `outcome` with a `name` (workflow-level, checked at load). Composes with
 * `reads` and with `prompt` dispatch (attempt 0 sends the stage's resolved
 * prompt; retries send `feedForward`'s output raw); mutually exclusive with
 * `loop`/`run`/continue.
 *
 * The runner desugars the spec into a degenerate assess loop
 * (`synthesizeVerifyLoop`) run by the ONE driver — verify rides the tested
 * pair-restore / per-attempt-snapshot / resume machinery rather than forking it.
 */
export function verify(spec: VerifySpec): VerifySpec {
	assertShape("verify", verifyShapeIssues(spec));
	return spec;
}

/**
 * Single rule source for the verify shape. Returns human-readable violations
 * (empty array = valid). `verify()` throws on the first; `validateWorkflow`
 * maps each to a load issue for hand-rolled literals that bypassed the
 * factory (jiti-loaded configs erase TS types). Same pattern as
 * `judgeShapeIssues` / `judge()`.
 */
export function verifyShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a verify object is required"];
	const v = candidate as Partial<VerifySpec>;
	// The judge slot is an `AnyJudge` — route the panel-vs-single shape dispatch
	// through the shared `judgeSlotShapeIssues` (one rule source per shape).
	const judgeIssues = judgeSlotShapeIssues(v.judge);
	const issues: string[] = [...judgeIssues];
	if (typeof v.done !== "function") {
		issues.push("verify requires `done` to be a function deciding pass/fail from the verdict");
	}
	if (v.max !== undefined && (!Number.isInteger(v.max) || v.max < 1)) {
		issues.push(`verify.max: ${v.max} — must be an integer >= 1 (run.maxIterations caps the upper bound)`);
	}
	if (v.feedForward !== undefined && typeof v.feedForward !== "function") {
		issues.push("verify `feedForward` must be a function building the next attempt's prompt arg");
	}
	if ((v.max ?? 1) > 1 && v.feedForward === undefined) {
		issues.push(
			"verify.max > 1 requires `feedForward` — without it the retried prompt would be byte-identical to the original",
		);
	}
	return issues;
}

/**
 * Unreachable by construction: the driver's cap check precedes the
 * feedForward call (loop.ts pullNext), so a gate-only verify (`max` 1, the
 * only shape allowed to omit `feedForward`) caps before a second attempt
 * could ever ask for an arg. A throw here means that invariant broke
 * — fail loudly (propagates to the runner's single catch) rather than
 * silently dispatching an empty-arg prompt.
 */
const NEVER_FEED_FORWARD = (): string => {
	throw new Error("verify: feedForward invoked on a gate-only verify (max 1) — driver invariant violated");
};

/**
 * The desugar: a `VerifySpec` as a degenerate assess loop — the shared
 * `JudgedRepetition` fields flow straight through (`max` defaulted to 1 for
 * the gate-only shape); the cap policy is always `"halt"`
 * (a failing final verdict = "verification failed"; `done` wins over the cap
 * so a pass on the final attempt is a normal completion), and `result:
 * "last"` restores the last attempt's producer pair at loop advance.
 * Allocates per call — callers cache (LoopEntry live; OpenGeneration on the
 * fold), and nothing compares loop identity.
 *
 * NOT re-exported from registration.ts — runtime plumbing, not authoring
 * surface (precedent: `judgeStageDef`).
 */
export function synthesizeVerifyLoop(v: VerifySpec): AssessLoop {
	const d = VERIFY_LOOP_DEFAULTS;
	return {
		kind: "assess",
		judge: v.judge,
		done: v.done,
		feedForward: v.feedForward ?? NEVER_FEED_FORWARD,
		max: v.max ?? d.max,
		onCap: d.onCap,
		result: d.result,
	};
}
