/**
 * Per-stage execution pipeline + the chain walk's COMPOSITION SITE.
 *
 * `dispatchStage` resolves the stage once (`resolveStage` — mode + dispatch
 * derived in one place) and switches on `mode`:
 *   - `"loop"`   — the unit-loop driver (loop.ts), one session per unit;
 *   - `"script"` — `def.run` called directly (script-stage.ts);
 *   - `"prompt"`/`"skill"` — preflights → prompt prep → input validation →
 *     snapshot → one Pi session.
 *
 * The chain walk is mutually recursive (dispatchStage → session continuation →
 * advanceChain → next dispatchStage); the recursion is composed HERE via
 * injection — `advanceChain` receives `ChainDeps.runNext`, the loop driver
 * receives `LoopDeps`, the script stage receives `advance` — so every other
 * engine module's imports point strictly downward (zero value-import
 * cycles; the LoopDeps precedent applied to the whole walk).
 *
 * `dispatchStageOrRecordFailure` is the walk's single catch site: a throw from
 * anywhere in the pipeline (preflights, user fns, machinery) lands a uniform
 * JSONL failure row via failure.ts.
 */

import type { StageDef, Unit } from "../api.js";
import { auditCtxFor, failedArgs, notifyPartialArtifacts, recordFatalFailure, runIdentityOf } from "../audit.js";
import { currentPrimaryArtifact, resolveStagePrompt, stageEntryArgs } from "../chain-state.js";
import { lifecycleCtxFor, skillStageRef } from "../events.js";
import { failureMemoSuffix } from "../failure-memos.js";
import { formatError } from "../internal-utils.js";
import { announceLoopStart, runLoop } from "../loop.js";
import { freezesEntryArgsOf } from "../loop-constructors.js";
import { buildLoopEntry, freshCursor, type LoopDeps, type LoopEntry } from "../loop-kinds.js";
import { ensureUnitDeps } from "../loop-waves.js";
import {
	FAIL_LOOP_CAP_HALT,
	FAIL_VALIDATE_GATE_SKIPPED,
	FAIL_VERIFY_FAILED,
	MSG_CONTINUE_FALLBACK,
	MSG_RESUME_SESSION_FALLBACK,
	MSG_SNAPSHOT_FAILED,
} from "../messages.js";
import {
	continueStageSession,
	executeStageSession,
	locateSessionFile,
	reattachStageSession,
} from "../sessions/index.js";
import { forkChildSession, reattachChildSession } from "../sessions/spawn.js";
import type { SkillContractMap } from "../skill-contract.js";
import { effectiveOutputSchemaOf } from "../stage-identity.js";
import type { WorkflowStage } from "../state/index.js";
import type { RunContext, RunState, StageSessionContext, WorkflowHostContext } from "../types.js";
import { resolveDigest } from "../worktree-digest.js";
import { advanceChain, type ChainDeps } from "./chain-advance.js";
import { type ChainOutcome, haltChain, recordAbortedAtSeam, recordEntryThrow, withStageEntryGuard } from "./failure.js";
import { ensureContractInputValid, ensureInputValid } from "./input-validation.js";
import { ensureLoopNotContinue, runLoopPreflights, runSingleStagePreflights } from "./preflight.js";
import { type ResolvedStage, resolveStage } from "./resolve-stage.js";
import { runScript } from "./script-stage.js";

// Re-exported for the package barrel + existing consumers; the class itself
// lives in the leaf errors.ts so preflight/input-validation can throw it
// without importing this module back.
export { StagePreflightError } from "./errors.js";
export type { ResolvedStage } from "./resolve-stage.js";

// ---------------------------------------------------------------------------
// Walk composition — the ONE place the mutual recursion is wired
// ---------------------------------------------------------------------------

const CHAIN_DEPS: ChainDeps = {
	runNext: (hostCtx, name, idx, run) => dispatchStageOrRecordFailure(hostCtx, name, idx, run),
};

/**
 * Advance the chain after `completedName` finished at `completedIdx` — the
 * composed `advanceChain` every continuation calls (session onSuccess, loop
 * driver advance, script stage, resume route-onward).
 */
export function advance(
	hostCtx: WorkflowHostContext,
	completedName: string,
	completedIdx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	return advanceChain(hostCtx, completedName, completedIdx, run, CHAIN_DEPS);
}

/**
 * Wraps `dispatchStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by `runWorkflow` (start stage), `advanceChain` (next stage, via
 * `ChainDeps`), and the resume entries — the walk's single catch site.
 * Delegates the classify-then-record policy (cooperative-abort seam +
 * mid-stage `WorkflowAbortError` vs terminal entry-throw) to
 * `withStageEntryGuard` (failure.ts).
 */
export async function dispatchStageOrRecordFailure(
	hostCtx: WorkflowHostContext,
	name: string,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	return withStageEntryGuard(hostCtx, name, run, () => dispatchStage(hostCtx, name, idx, run));
}

// ---------------------------------------------------------------------------
// Per-stage pipeline
// ---------------------------------------------------------------------------

/**
 * Builds the `/skill:<name> <args>` line sent into the session. The audit
 * label is read off `stage.skill` by the caller — single source.
 */
function buildPrompt(skill: string, inputForStage: string): string {
	return `/skill:${skill} ${inputForStage}`;
}

/**
 * The arg string the stage's `/skill:<name> <args>` prompt carries — a thin
 * wrapper over the `stageEntryArgs` authority (chain-state.ts), which the
 * resume fold also consumes at loop-generation open so live and resume can't
 * drift. The preflights (`ensureUpstreamArtifact` / `ensureNamedReads`)
 * guarantee every projection input on this path, so the authority's
 * `undefined` arm is unreachable here; the `!` is safe.
 */
export function inputForStage(stage: ResolvedStage, run: RunContext): string {
	return stageEntryArgs(stage.def, stage.name, run.workflow.start, run.state)!;
}

/** One stage activation — dispatch on the mode derived once by `resolveStage`. */
export async function dispatchStage(
	hostCtx: WorkflowHostContext,
	currentName: string,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	const stage = resolveStage(currentName, idx, run);
	switch (stage.mode) {
		case "loop":
			return runLoopStage(hostCtx, stage, idx, run);
		case "script":
			// Script stages skip the skill pipeline — no `/skill:` prompt, no
			// registry check, no session, no collector snapshot. Input-schema
			// validation still applies; the script runner owns its own status
			// line + lifecycle fires.
			await ensureInputValid(stage, run);
			return runScript(hostCtx, stage, idx, run, advance);
		case "prompt":
		case "skill":
			return runSingleStage(hostCtx, stage, idx, run);
	}
}

/**
 * The shared single-stage preparation steps — preflights → prompt prep →
 * input validation → snapshot — extracted so the live path
 * (`runSingleStage`) and session-backed resume (`resumeStageWithSession`)
 * can't drift (the `buildLoopDeps` precedent applied to single stages).
 * The branch offset is NOT prepared here: live derives it from the current
 * branch (`computeBranchOffset`), resume takes it from the persisted row.
 */
async function prepareSingleStage(
	hostCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
): Promise<{ prompt: string; snapshot: unknown }> {
	runSingleStagePreflights(stage, run);

	const prompt =
		stage.dispatch === "prompt"
			? await resolveStagePrompt(stage.def.prompt!, run.cwd, run.state)
			: buildPrompt(stage.skill, inputForStage(stage, run));

	await ensureInputValid(stage, run);
	await ensureContractInputValid(stage, run);

	const snapshot = await captureStageSnapshot(hostCtx, stage.name, stage.def, idx, run);
	return { prompt, snapshot };
}

/**
 * The `StageSessionContext` both single-stage entries build — live and resume use
 * the SAME continuation pair (`onSuccess` → `advance`, `onFailure` →
 * partial-artifact recap), so a promoted/reattached stage chains onward
 * exactly like a live one.
 */
function buildSingleStageSession(
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
	prep: { prompt: string; snapshot: unknown },
	branchOffset: number | undefined,
): StageSessionContext {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt: prep.prompt + failureMemoSuffix(run.state),
		stageName: stage.name,
		skill: stage.skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: stage.def,
		skillContracts: run.skillContracts,
		stageIndex: idx,
		snapshot: prep.snapshot,
		model: run.resolveModel?.({ stage: stage.name, skill: stage.skill }),
		signal: run.signal,
		readSessionBranch: run.readSessionBranch,
		worktreeDigest: run.worktreeDigest,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, run.cwd, run.runId),
		onSuccess: (freshCtx) => advance(freshCtx, stage.name, idx, run),
	};
}

/**
 * The single-stage entry announcement — `onStageStart`. ONE helper for the
 * live entry (`runSingleStage`) and the session-backed resume re-entry
 * (`resumeWithSessionLadder`) — the fire stays aligned by sharing this one
 * helper. Mirrors `announceLoopStart`
 * (loop.ts) — the loop path's one-helper-for-live-and-resume exemplar.
 */
function announceSingleStageStart(
	hostCtx: WorkflowHostContext,
	run: RunContext,
	stage: Pick<ResolvedStage, "name" | "stageNumber" | "skill">,
): Promise<void> {
	return run.lifecycle.fire(
		hostCtx,
		"onStageStart",
		skillStageRef(stage.name, stage.stageNumber, stage.skill),
		lifecycleCtxFor(run),
	);
}

/** A `produces` stage carrying an effective output schema — the gate's
 *  qualifying predicate. Spelled through the shared `effectiveOutputSchemaOf`
 *  so the gate and the extraction retry loop agree on "schema-validated". */
const isSchemaValidatedProducesStage = (stage: ResolvedStage, skillContracts: SkillContractMap | undefined): boolean =>
	stage.def.kind === "produces" && !!effectiveOutputSchemaOf(stage.def, stage.name, skillContracts);

/** The worktree digest and progress point match the last gated baseline for
 *  THIS stage — no observable fix ran between the two dispatches. The
 *  `digest !== undefined` term narrows the digest compare inside the body. */
const isUnchangedTreeRedispatch = (
	baseline: { stage: string; digest: string; stagesCompleted: number } | undefined,
	stage: ResolvedStage,
	digest: string | undefined,
	stagesCompleted: number,
): boolean =>
	baseline !== undefined &&
	baseline.stage === stage.name &&
	digest !== undefined &&
	digest === baseline.digest &&
	stagesCompleted === baseline.stagesCompleted;

/** Records this dispatch's worktree digest + progress point as the gate
 *  baseline, so the NEXT dispatch of this stage compares against it. */
const recordGatedDispatchBaseline = (state: RunState, stage: ResolvedStage, digest: string): void => {
	state.lastGatedDispatch = { stage: stage.name, digest, stagesCompleted: state.stagesCompleted };
};

/**
 * Validation-retry mechanism-2: fail-fast a re-dispatch of a schema-validated
 * produces stage against an UNCHANGED worktree (no observable fix since the last
 * validation failure at the same progress point) — WITHOUT dispatching the
 * session or running preflights. Returns `true` when the stage is halted (the
 * caller short-circuits with `return "halted"`); `false` to proceed.
 *
 * Operator resume is excluded: session-backed resume never reaches
 * `runSingleStage`, and a cold re-run under `trigger.meta.resumedFrom` is
 * bypassed by `isOperatorResume`. The terminal skip carries the failure memo
 * for free through the shared `recordFatalFailure` writer
 * (`packages/rpiv-workflow/audit.ts:122`). An `undefined` digest (non-repo / git
 * missing) ALWAYS proceeds — degrade on a missing signal, never skip.
 *
 * The qualifying predicate — "a produces stage with an effective output schema"
 * — is the shared `effectiveOutputSchemaOf`
 * (`packages/rpiv-workflow/stage-identity.ts`): the single RUNTIME spelling also
 * consumed by the extraction retry loop (`sessions/extraction.ts`), so the gate
 * and the retry loop agree on what "schema-validated" means and can no longer
 * drift on the precedence order or the contract key.
 */
export async function gateValidationRedispatch(
	hostCtx: WorkflowHostContext,
	stage: ResolvedStage,
	run: RunContext,
): Promise<boolean> {
	const isOperatorResume = run.trigger.meta?.resumedFrom !== undefined;
	// Qualify → read guard → write. An operator-resume run and a stage with no
	// effective output schema both fall through, leaving `lastGatedDispatch` alone.
	if (isOperatorResume || !isSchemaValidatedProducesStage(stage, run.skillContracts)) return false;
	const digest = resolveDigest(run.worktreeDigest, run.cwd);
	if (isUnchangedTreeRedispatch(run.state.lastGatedDispatch, stage, digest, run.state.stagesCompleted)) {
		await recordFatalFailure(
			hostCtx,
			auditCtxFor(run, stage.name, stage.skill),
			failedArgs(FAIL_VALIDATE_GATE_SKIPPED(stage.skill)),
		);
		return true;
	}
	// Overwrite the baseline on every qualifying dispatch with a defined
	// digest, so the NEXT dispatch of this stage compares against the most
	// recent state (the "tree changed" / "fix ran" proceed arms both land
	// here after the non-matching halt check above).
	if (digest !== undefined) recordGatedDispatchBaseline(run.state, stage, digest);
	return false;
}

/**
 * The single-session path (prompt + skill dispatch): preflights → prompt
 * prep → input validation → snapshot → session.
 *
 * Dispatch: a `prompt` stage sends author-owned raw text (resolved by the
 * shared `resolveStagePrompt` authority — the loop driver's round-0 producer
 * uses the same resolver); a skill stage sends `/skill:<name>
 * <inputForStage>`. `stage.skill` already equals the record key for a
 * prompt stage (it cannot set an explicit skill — load validation forbids
 * it), so the status/session/audit labels are correct for both without a
 * separate label. A PromptFn throw propagates to
 * `dispatchStageOrRecordFailure`, which records a terminal failure.
 */
async function runSingleStage(
	hostCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	// Validation-retry mechanism-2 lives in `gateValidationRedispatch` (above) —
	// fail-fast an unchanged-tree re-dispatch of a schema-validated produces
	// stage BEFORE preflights or the session open. `true` ⇒ already recorded a
	// terminal failure row; halt here.
	if (await gateValidationRedispatch(hostCtx, stage, run)) return "halted";

	const prep = await prepareSingleStage(hostCtx, stage, idx, run);

	// onStageStart fires after preflight, before the Pi session opens.
	await announceSingleStageStart(hostCtx, run, stage);

	// `continue` forks the predecessor's persisted session (`run.state.lastSession`)
	// into a fresh child carrying its transcript; `continueStageSession` re-derives
	// the branch offset from that forked branch (NOT the launcher's). No predecessor
	// session — start stage, after a loop, or the file is gone — degrades to a fresh
	// dispatch, matching the `prompt-continue-at-start` warning. Fresh stages always
	// pass `branchOffset: undefined`.
	if (stage.def.sessionPolicy === "continue") {
		const file = continueForkFile(run);
		if (file) {
			const s = buildSingleStageSession(stage, idx, run, prep, undefined);
			await forkChildSession(hostCtx, s, file, (child) => continueStageSession(hostCtx, child, s));
			return "dispatched";
		}
		hostCtx.ui.notify(MSG_CONTINUE_FALLBACK(stage.skill), "info");
	}

	await executeStageSession(hostCtx, buildSingleStageSession(stage, idx, run, prep, undefined));
	return "dispatched";
}

/**
 * The predecessor session a `continue` stage forks from, resolved to an on-disk
 * file — or `null` to degrade to a fresh dispatch (no prior session recorded, or
 * its file was cleaned up / moved beyond `locateSessionFile`'s reach).
 */
function continueForkFile(run: RunContext): string | null {
	const ref = run.state.lastSession;
	return ref ? locateSessionFile(ref, run.runId, run.cwd) : null;
}

/**
 * Session-backed resume of a failed/aborted single stage — adopt the
 * interrupted session's branch (promotion) or continue it from its leaf
 * (reattach), instead of re-running cold. Selected by `selectResumeEntry`
 * when the failed trailer carries a `session` (the structured dispatch).
 * Delegates the same classify-then-record policy as the live entry
 * (`dispatchStageOrRecordFailure`) to `withStageEntryGuard` (failure.ts); the
 * fallback ladder itself lives in `resumeWithSessionLadder` below — the
 * resume `inner` still wraps it, so a reattached `postStage`
 * `WorkflowAbortError` or machinery throw is classified (abort vs terminal
 * entry-throw) by the same authority as the live path.
 */
export async function resumeStageWithSession(
	hostCtx: WorkflowHostContext,
	last: WorkflowStage,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	return withStageEntryGuard(hostCtx, last.stage, run, () => resumeWithSessionLadder(hostCtx, last, idx, run));
}

/**
 * THE resume fallback ladder (called by `resumeStageWithSession` via
 * `withStageEntryGuard`). Every precondition miss notifies
 * (`MSG_RESUME_SESSION_FALLBACK`) and degrades to today's cold re-run via
 * `dispatchStageOrRecordFailure` — never a refusal, never a throw:
 *
 *   1. resolved mode must be `prompt`/`skill` (loop trailers never reach
 *      this arm — they carry `parent`; script stages are sessionless);
 *   2. `locateSessionFile` must find the file on disk;
 *   3. the same `prepareSingleStage` steps as live (a preflight throw lands
 *      in the same catch as the live entry);
 *   4. `reattachChildSession` spawns a child BOUND to the persisted file (the
 *      host opens it, does NOT replay the prompt) and `reattachStageSession`
 *      (sessions/reattach.ts) runs promotion → reattach inside it, with the
 *      SAME `StageSessionContext` the live path builds — `branchOffset` taken from
 *      the PERSISTED row (continue-policy stages), `undefined` for fresh.
 *
 * (The cooperative-abort pre-check — formerly step 1 here — now lives in
 * `withStageEntryGuard`, which wraps this ladder; a mid-stage
 * `WorkflowAbortError` thrown inside it is classified there too.)
 *
 * Lifecycle: `onStageStart` fires before the child (re)opens (same bracketing
 * as live); promotion then fires `onStageEnd` via `recordStageSuccess` — a
 * fast start→end pair is honest ("the stage's work was adopted"). There is no
 * `{ cancelled }` arm — a detached reattach opens its own child, with no
 * live-session swap for the user to dismiss.
 */
async function resumeWithSessionLadder(
	hostCtx: WorkflowHostContext,
	last: WorkflowStage,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	const ref = last.session!; // dispatch arm guarantees non-null (resume-entry.ts)
	const stage = resolveStage(last.stage, idx, run);

	const fallBackCold = (why: string): Promise<ChainOutcome> => {
		hostCtx.ui.notify(MSG_RESUME_SESSION_FALLBACK(stage.skill, why), "info");
		return dispatchStageOrRecordFailure(hostCtx, last.stage, idx, run);
	};

	// Defensive: a session-backed row for a stage whose def since became a
	// loop/script stage — the session machinery below doesn't apply.
	if (stage.mode !== "prompt" && stage.mode !== "skill") {
		return dispatchStageOrRecordFailure(hostCtx, last.stage, idx, run);
	}
	const file = locateSessionFile(ref, run.runId, run.cwd);
	if (!file) return fallBackCold("session file not found");

	const prep = await prepareSingleStage(hostCtx, stage, idx, run);
	const s = buildSingleStageSession(stage, idx, run, prep, ref.branchOffset);

	// Same bracketing as live: onStageStart before the (re)attached child opens.
	await announceSingleStageStart(hostCtx, run, stage);

	// Detached reattach: spawn a child BOUND to the persisted session file (the
	// host opens it and does NOT replay the prompt); reattachStageSession promotes
	// from the loaded branch or nudges via resendIntoChild. Replaces the deleted
	// live-session swap (`hostCtx.switchSession`).
	await reattachChildSession(hostCtx, s, file, (child) => reattachStageSession(hostCtx, child, s));
	return "dispatched";
}

/**
 * A stage with an effective loop (incl. the verify desugar) expands into one
 * session per unit through the ONE driver. A push loop whose unit source
 * returned an empty list falls through to the single-stage path — that path
 * runs its own preflights, so e.g. a missing named read still halts with the
 * targeted message (today's consumer contract).
 *
 * Push loops compute units FIRST (a throw — incl. a consumer haltPreflight —
 * propagates with its own attribution; empty ⇒ single-stage fall-through);
 * the remaining loop preflights run after (see preflight.ts).
 *
 * Capture semantics (pinned): `entryArtifact`, `entryArgs`, and `entryPair`
 * are frozen HERE, before unit 1; per-unit snapshots are captured by the
 * driver immediately before each unit's session.
 *
 * A `verify`-bearing stage enters here too (the desugar — `effectiveLoopOf`,
 * folded into `resolveStage`); its onLoopStart reports `kind: "verify"` so
 * listeners aren't told it's an assess loop.
 *
 * A prompt-dispatch assess/verify stage also enters here: the skill-registry
 * and upstream-artifact preflights skip non-skill dispatch, and its
 * `entryArgs` freezes to `""` (the `stageEntryArgs` prompt arm) — the round-0
 * message is the stage's own `prompt`, resolved by the driver at dispatch.
 */
async function runLoopStage(
	hostCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	const loop = stage.loop!;
	ensureLoopNotContinue(stage);

	// Push loops compute units FIRST (pinned ordering — a units() throw beats
	// any other preflight's halt; empty ⇒ single-stage fall-through).
	let units: readonly Unit[] | undefined;
	if (loop.kind === "fanout") {
		units = await loop.units({ cwd: run.cwd, artifact: currentPrimaryArtifact(run.state), state: run.state });
		if (units.length === 0) return runSingleStage(hostCtx, stage, idx, run);
		// deps cycle / dangling-id → clean halt BEFORE any dispatch (the runtime unit
		// list is invisible to the static load gate, so this is the only place it runs).
		ensureUnitDeps(units, stage.name);
	}

	runLoopPreflights(stage, run);

	const entry = buildLoopEntry(
		{ stageIdx: idx, name: stage.name, skill: stage.skill, def: stage.def, loop },
		{
			entryArtifact: currentPrimaryArtifact(run.state),
			entryArgs: freezesEntryArgsOf(loop) ? inputForStage(stage, run) : "",
			entryPair: { output: run.state.output, primaryArtifact: run.state.primaryArtifact },
			units,
		},
	);

	await announceLoopStart(hostCtx, run, entry);
	await runLoop(hostCtx, entry, freshCursor(), run, buildLoopDeps());
	return "dispatched";
}

/**
 * THE loop deps bundle — built identically by the live path and resume
 * (`selectResumeEntry`), so the two can't drift.
 */
export function buildLoopDeps(): LoopDeps {
	return {
		executeStageSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advance(freshCtx, name, completedIdx, ctx),
		captureSnapshot: (ctx, name, def, i, r) => captureStageSnapshot(ctx, name, def, i, r),
		haltLoop,
		// Mid-flight run abort at the loop seam → FAIL_WORKFLOW_ABORTED.
		recordAborted: (hostCtx, name, run) => recordAbortedAtSeam(hostCtx, name, run).then(() => undefined),
		// Unexpected worker rejection → terminal-failure row, no re-throw. The
		// unit's identity rides as a STRUCTURED field (`unit`) on the row — `stage`
		// stays the parent graph identity, not a `name (unit N)` string.
		recordWorkerThrow: (hostCtx, unit, skill, run, err) =>
			recordEntryThrow(hostCtx, unit.parent, run, err, { ref: unit, skill }).then(() => undefined),
	};
}

/**
 * Terminal failure when a loop's `onCap: "halt"` trips. Verify stages get
 * the verification-failed wording — the author declared a post-condition,
 * not a loop, so "loop cap exceeded" would misattribute the failure.
 */
export async function haltLoop(
	hostCtx: WorkflowHostContext,
	run: RunContext,
	e: Pick<LoopEntry, "name" | "def">,
	count: number,
	cap: number,
): Promise<void> {
	const args = e.def.verify ? failedArgs(FAIL_VERIFY_FAILED(e.name, cap)) : failedArgs(FAIL_LOOP_CAP_HALT(count, cap));
	await haltChain(hostCtx, run, e.name, e.name, args);
}

/** Runs whose snapshot-failure warning already fired — one notify per run, not per stage/unit. */
const snapshotWarnedRuns = new WeakSet<RunContext>();

export async function captureStageSnapshot(
	hostCtx: WorkflowHostContext,
	stageName: string,
	def: StageDef,
	idx: number,
	run: RunContext,
): Promise<unknown> {
	const snapshot = def.outcome?.collector.snapshot;
	if (!snapshot) return undefined;
	try {
		return await snapshot({
			cwd: run.cwd,
			runId: run.runId,
			stageIndex: idx,
			state: run.state,
		});
	} catch (e) {
		// Snapshot capture failure doesn't prevent stage execution — but a
		// consistently-throwing custom snapshot must not silently disable
		// diffing for the whole run, so the first failure warns.
		if (!snapshotWarnedRuns.has(run)) {
			snapshotWarnedRuns.add(run);
			hostCtx.ui.notify(MSG_SNAPSHOT_FAILED(stageName, formatError(e)), "warning");
		}
		return undefined;
	}
}
