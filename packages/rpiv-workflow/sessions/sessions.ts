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
import type { SessionRef } from "../state/index.js";
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
	// Abort classification and strike recovery are owned by a single helper that
	// returns "continue" when it has handled the turn (strike retry or soft-halt).
	// It consults the watchdog verdict for EVERY non-clean stop — a mid-tool abort
	// surfaces as "error"/"toolUse", not "aborted" — so the stop/halt arms below
	// only ever see turns with no live watchdog verdict.
	if ((await classifyAndHandleAbort(observerCtx, child, s, outcome, session, offset)) === "continue") return;
	// Every halt below routes through the single `haltStageOrSoftHalt` gate: a
	// fanout unit marked `collectAll` records a NON-terminal failed row + a sentinel
	// slot instead of halting the run — EXCEPT an infra-death stop (error/noResponse/
	// toolUse), which hard-fails even there so resume re-dispatches the dead unit
	// (see `isInfraDeath`, halt-routing.ts); everything else takes the arm's fail-fast
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
// ABORT CLASSIFIER — postStage's single abort dispatch + its predicates
// ===========================================================================

/** An `aborted` stop classification (the SDK resolves `prompt()` with `stopReason:"aborted"`). */
const isAbortedStop = (outcome: SessionOutcome): boolean => outcome.stop === "aborted";

/**
 * The watchdog tool-timeout verdict, if any. Read ONCE and returned so the
 * `reason` threads through without a second read (the strike arm clears the
 * verdict, so a re-read would see `undefined`).
 */
const watchdogTimeoutOf = (child: WorkflowSessionContext): { reason: string } | undefined => child.toolTimeout?.();

/**
 * Classify and route an abort. Abort surfaces as a STOP CLASSIFICATION, not a
 * promise rejection — but NOT always as `stopReason:"aborted"`. An abort landing
 * between turns resolves `prompt()` with an `"aborted"` message; one landing
 * MID-TOOL instead yields an error toolResult ("Command aborted") followed by an
 * EMPTY assistant entry with `stopReason:"error"` (the strangled follow-up API
 * request), or a transcript truncated on the tool request (`"toolUse"`). So the
 * watchdog VERDICT (`toolTimeout()`), not the stop shape, is the authoritative
 * witness that the watchdog aborted this child — it is read for every non-clean
 * stop, BEFORE the aborted-stop shape test. Gating the verdict behind
 * `stop === "aborted"` sent a mid-`npm test` watchdog abort to the caller's stop
 * arm, where `"error"` reads as infra death and hard-failed the unit (run
 * 2026-08-20_14-54-40-4cc2, implement phase-1).
 *
 * A genuine abort throws BEFORE haltStage/softHaltUnit/any row write so: (a) no
 * `collected:true` row is written (else the resume fold marks the unit "don't
 * re-dispatch" → permanent work loss), (b) the parallel fold's `isAbortError`
 * branch leaves the slot unfilled, and (c) resume re-dispatches the unit cleanly.
 *
 * Returns `"continue"` once the turn is owned (strike retry or soft-halt),
 * telling the caller to stop; returns `void` (no abort) so the caller proceeds
 * to the happy-path switch.
 *
 * Exported ONLY for the co-located direct tests (`sessions/sessions.test.ts` —
 * a non-exported member cannot be imported there; the `extraction.ts` retry
 * hooks set the precedent). Absent from the `sessions/index.ts` barrel, so the
 * package surface is unchanged.
 */
export async function classifyAndHandleAbort(
	observerCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSessionContext,
	outcome: SessionOutcome,
	session: SessionRef | null,
	offset: number | undefined,
): Promise<"continue" | undefined> {
	// Level 1 — genuine run/user abort: the signal fired, so always re-dispatch on resume.
	if (s.signal?.aborted) throw new WorkflowAbortError();
	// Level 2 — clean completion: hand back to the caller's happy-path switch. A delivered
	// turn outranks any stale watchdog verdict (the abort raced the completion).
	if (outcome.stop === "stop") return;
	// Level 3 — the watchdog verdict, read for EVERY non-clean stop (see the header: a
	// mid-tool abort surfaces as "error"/"toolUse", not "aborted").
	const timeout = watchdogTimeoutOf(child);
	if (timeout) {
		// A watchdog tool-timeout is recoverable: consume a strike and retry, or route
		// exhaustion through the soft-halt gate (collect-all survives; else terminal).
		if (consumeBashStrike(s, timeout.reason)) {
			await retryStageAfterBashStrike(observerCtx, child, s, offset, timeout.reason);
		} else {
			await haltStageOrSoftHalt(observerCtx, s, { kind: "timeout", reason: timeout.reason }, session);
		}
		return "continue";
	}
	// Level 4 — an aborted stop with the signal cold and no watchdog is a genuine abort
	// (e.g. ESC): throw so no row lands and resume re-dispatches the unit cleanly.
	if (isAbortedStop(outcome)) throw new WorkflowAbortError();
	// Level 5 — a non-clean, non-abort stop with no verdict: the caller's stop arm owns it.
}

// ===========================================================================
// STRIKE-ARM RECOVERY — single-caller helper for the abort classifier's watchdog arm
// ===========================================================================

/**
 * Strike-arm recovery: re-arm the watchdog, re-prompt the SAME child with
 * operator-grade steering, then tail-recurse `postStage` (offset threaded
 * verbatim — the exact shape the continue body uses). Called ONLY when
 * `consumeBashStrike(s, reason)` returned true, so this helper performs the
 * reset → re-prompt → tail-recurse sequence byte-identically to the inline arm
 * it replaces; strike exhaustion stays routed by the caller (`classifyAndHandleAbort`) to
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
