/**
 * Session execution — one Pi session per workflow stage / loop unit.
 * `executeStageSession` is the only public entry (loop units run through it too,
 * threading their identity via `StageSessionContext.unit`).
 *
 * Every stage runs in its own detached child session (`spawnChildAndRun`,
 * spawn.ts); the only surviving policy divergence is the branch offset
 * (`branchOffsetFor`). Everything in this file — post-processing, halt routing,
 * success persistence, outcome reading — is policy-agnostic.
 *
 * Companion modules:
 *   - extraction.ts      — produceAndValidateOutput + retry loop +
 *                          outcome helpers (collector → parser pipeline).
 *   - spawn.ts           — the child-spawn primitives (`spawnChildAndRun`,
 *                          `reattachChildSession`, `resendIntoChild`) + `branchOffsetFor`.
 *   - halt-routing.ts    — the halt pipeline (`haltStageOrSoftHalt` gate +
 *                          the per-arm halt helpers + `auditFor`); consumed by
 *                          `postStage` below and `reattach.ts`.
 *   - success-persist.ts — `recordStageSuccess` + `unitEventOf`; consumed by
 *                          `postStage` below and `reattach.ts`.
 *   - reattach.ts        — session-backed resume (promotion + reattach); reuses
 *                          postStage / recordStageSuccess / the halt helpers
 *                          exported below instead of duplicating them.
 */

import { WorkflowAbortError } from "../internal-utils.js";
import { type BranchEntry, classifyStop, readBranch, readSessionRef, type StopSignal } from "../transcript.js";
import type { StageSessionContext, WorkflowHostContext, WorkflowSessionContext } from "../types.js";
import { bashStrikesRemaining, bashTimeoutSteeringMessage, consumeBashStrike } from "./bash-strikes.js";
import { produceAndValidateOutput } from "./extraction.js";
import { haltStageOrSoftHalt } from "./halt-routing.js";
import { branchOffsetFor, resendIntoChild, spawnChildAndRun } from "./spawn.js";
import { recordStageSuccess } from "./success-persist.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage (or loop unit) in its own detached child session. */
export async function executeStageSession(ctx: WorkflowHostContext, s: StageSessionContext): Promise<void> {
	await spawnChildAndRun(ctx, s, (child) => postStage(ctx, child, s));
}

/**
 * Continue body — runs inside a FORKED child (`forkChildSession`, spawn.ts)
 * carrying the predecessor's full transcript. Re-derive the inherited-prefix
 * offset from the actual forked branch BEFORE the continuation turn is sent
 * (the boundary past which only this stage's own output lives), send the turn
 * via `resendIntoChild` (`/skill:` and templates expand through the rpiv-args
 * input hook exactly as a fresh prompt would), then run the standard `postStage`
 * scoped by that offset. From there the flow is byte-identical to a fresh stage —
 * stop classification, extraction, persistence — only sliced past the prefix.
 *
 * The re-derived offset (not a launcher-branch read) flows into `postStage` →
 * `readSessionRef`, so the continue stage's own row records the offset its forked
 * branch ran under; resume re-applies that persisted value verbatim.
 */
export async function continueStageSession(
	observerCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSessionContext,
): Promise<void> {
	const offset = readBranch(child).length;
	await resendIntoChild(child, s.prompt);
	await postStage(observerCtx, child, s, offset);
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/**
 * Stage post-processing: classify outcome → produce & validate output →
 * persist → chain. Exported to the `reattach.ts` companion — a reattached
 * session's continuation runs this exact pipeline, byte-identical to live.
 *
 * TWO ctxs (detachment): `observerCtx` is the long-lived LAUNCHER/observer ctx the
 * walk threads — it stays valid across every stage, so the user-facing recording
 * (success/halt rows + notifications + lifecycle) AND the chain continuation
 * (`onSuccess` → advance/step, which spawns the NEXT stage's child) all run on
 * it, NOT on the per-stage child (whose UI is the lane binding — noOp in the
 * background lane — and which is disposed when the stage ends). `child` is the
 * in-session ctx: the agent transcript (`readBranch`/`readSessionRef`) and the
 * validation-retry re-prompt (`produceAndValidateOutput` → `resendIntoChild`)
 * read/write through it. Spawning the next stage off `observerCtx` is what keeps the
 * launcher the single spawner (no nested-child chain).
 *
 * The backing `SessionRef` is captured ONCE at entry — every row this
 * pipeline can write (success, stop-failure, extraction/validation failure)
 * carries the same provenance value.
 */
export async function postStage(
	observerCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSessionContext,
	// Defaults to the policy-derived offset (fresh ⇒ undefined; resume continue ⇒
	// the persisted row's value). The live continue body passes the value it
	// re-derived from the forked branch, which is authoritative there.
	offset: number | undefined = branchOffsetFor(s.stage.sessionPolicy, s.branchOffset),
): Promise<void> {
	const session = readSessionRef(child, offset);
	const outcome = readSessionOutcome(child, offset);
	// Abort surfaces as a STOP CLASSIFICATION, not a promise rejection:
	// `session.abort()` makes the SDK RESOLVE `prompt()` with a
	// `stopReason:"aborted"` transcript message, so an aborted in-flight child runs
	// straight into here. Throw BEFORE haltStage/softHaltUnit/any row write so:
	// (a) no `collected:true` row is written (else the resume fold marks the unit
	// "don't re-dispatch" → permanent work loss), (b) the parallel fold's
	// `isAbortError` branch leaves the slot unfilled, and (c) resume re-dispatches
	// the unit cleanly.
	//
	// A genuine run/user abort (`s.signal` fired) ALWAYS re-dispatches on resume, so it
	// takes the throw unconditionally. An `aborted` stop with the signal cold is examined
	// for a watchdog tool-timeout (`child.toolTimeout`): the host aborted a runaway bash,
	// which must route to the soft-halt gate (collect-all unit survives; else terminal
	// fail) — NOT WorkflowAbortError, which would re-run the same runaway command on resume.
	if (s.signal?.aborted) throw new WorkflowAbortError();
	if (outcome.stop === "aborted") {
		const timeout = child.toolTimeout?.();
		if (timeout) {
			// Strike-based recovery: a watchdog tool-timeout is a recoverable tool
			// event INSIDE the live child. While strikes remain, the single-caller
			// helper resets → re-prompts → tail-recurses postStage (offset threaded
			// verbatim); exhaustion falls through to the UNCHANGED soft-halt/terminal
			// seam below, where the failure-row writers (memo + death-scene) fire for free.
			if (consumeBashStrike(s, timeout.reason)) {
				return retryStageAfterBashStrike(observerCtx, child, s, offset, timeout.reason);
			}
			return haltStageOrSoftHalt(observerCtx, s, { kind: "timeout", reason: timeout.reason }, session);
		}
		throw new WorkflowAbortError();
	}
	// Every halt below routes through the single `haltStageOrSoftHalt` gate: a
	// fanout unit marked `collectAll` records a NON-terminal failed row + a sentinel
	// slot instead of halting the run; everything else takes the arm's fail-fast
	// halt. Recording + the continuation run on observerCtx (the launcher) — the per-stage
	// child is disposed when the stage ends.
	if (outcome.stop !== "stop")
		return haltStageOrSoftHalt(observerCtx, s, { kind: "stop", stop: outcome.stop }, session);

	const result = await produceAndValidateOutput(child, s, outcome.branch, offset);
	if (result.kind === "fatal")
		return haltStageOrSoftHalt(observerCtx, s, { kind: "extraction", message: result.message }, session);
	if (result.kind === "validation-exhausted")
		return haltStageOrSoftHalt(
			observerCtx,
			s,
			{ kind: "validation", failureSummary: result.failureSummary },
			session,
		);

	if (!(await recordStageSuccess(observerCtx, s, result.output, session))) return;
	// The validated Output goes to the continuation directly — loop drivers
	// thread it into accumulated / feedForward without state back-reads. Runs on
	// observerCtx so the next stage's child is spawned off the launcher.
	await s.onSuccess(observerCtx, result.output);
}

// ===========================================================================
// STRIKE-ARM RECOVERY — single-caller helper for postStage's watchdog arm
// ===========================================================================

/**
 * Strike-arm recovery: re-arm the watchdog, re-prompt the SAME child with
 * operator-grade steering, then tail-recurse `postStage` (offset threaded
 * verbatim — the exact shape the continue body uses). Called ONLY when
 * `consumeBashStrike(s, reason)` returned true, so this helper performs the
 * reset → re-prompt → tail-recurse sequence byte-identically to the inline arm
 * it replaces; strike exhaustion stays routed by the caller (`postStage`) to
 * the UNCHANGED `haltStageOrSoftHalt({ kind: "timeout" })` seam, where the
 * failure-row writers (memo + death-scene artifact) fire for free.
 */
async function retryStageAfterBashStrike(
	observerCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSessionContext,
	offset: number | undefined,
	reason: string,
): Promise<void> {
	child.resetToolTimeout?.();
	const remaining = bashStrikesRemaining(s);
	await resendIntoChild(child, bashTimeoutSteeringMessage(reason, remaining, remaining === 0));
	return postStage(observerCtx, child, s, offset);
}

// ===========================================================================
// OUTCOME READER
// ===========================================================================

interface SessionOutcome {
	branch: BranchEntry[];
	stop: StopSignal;
}

/**
 * Always reads the full unsliced branch + applies the policy-derived
 * `branchOffset` to `classifyStop` so the prior-stage prefix is
 * skipped in place. The same offset value flows through to
 * `produceAndValidateOutput` (initial == retry).
 *
 * No longer scans the transcript for an artifact path — discovery is
 * the collector's job, not the runner's.
 */
function readSessionOutcome(ctx: WorkflowHostContext, branchOffset: number | undefined): SessionOutcome {
	const branch = readBranch(ctx);
	return {
		branch,
		stop: classifyStop(branch, branchOffset),
	};
}
