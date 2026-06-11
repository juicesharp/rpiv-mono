/**
 * Per-stage execution pipeline + the chain walk's COMPOSITION SITE.
 *
 * `runStage` resolves the stage once (`resolveStage` — mode + dispatch
 * derived in one place) and switches on `mode`:
 *   - `"loop"`   — the unit-loop driver (loop.ts), one session per unit;
 *   - `"script"` — `def.run` called directly (script-stage.ts);
 *   - `"prompt"`/`"skill"` — preflights → prompt prep → input validation →
 *     snapshot → one Pi session.
 *
 * The chain walk is mutually recursive (runStage → session continuation →
 * advanceChain → next runStage); the recursion is composed HERE via
 * injection — `advanceChain` receives `ChainDeps.runNext`, the loop driver
 * receives `LoopDeps`, the script stage receives `advance` — so every other
 * engine module's imports point strictly downward (zero value-import
 * cycles; the LoopDeps precedent applied to the whole walk).
 *
 * `runStageOrRecordFailure` is the walk's single catch site: a throw from
 * anywhere in the pipeline (preflights, user fns, machinery) lands a uniform
 * JSONL failure row via failure.ts.
 */

import type { StageDef, Unit } from "../api.js";
import { failedArgs, notifyPartialArtifacts, runIdentityOf } from "../audit.js";
import { currentPrimaryArtifact, resolveStagePrompt, stageEntryArgs } from "../chain-state.js";
import { formatError } from "../internal-utils.js";
import { lifecycleCtxFor, skillStageRef } from "../lifecycle.js";
import { announceLoopStart, type LoopDeps, runLoop } from "../loop.js";
import { freshCursor, type LoopEntry } from "../loop-kinds.js";
import { FAIL_LOOP_CAP_HALT, FAIL_VERIFY_FAILED, MSG_SNAPSHOT_FAILED, STATUS_KEY, STATUS_STAGE } from "../messages.js";
import { runStageSession } from "../sessions/index.js";
import { readBranch } from "../transcript.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { advanceChain, type ChainDeps } from "./chain-advance.js";
import { type ChainOutcome, haltChain, recordAbortedAtSeam, recordEntryThrow } from "./failure.js";
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
	runNext: (curCtx, name, idx, run) => runStageOrRecordFailure(curCtx, name, idx, run),
};

/**
 * Advance the chain after `completedName` finished at `completedIdx` — the
 * composed `advanceChain` every continuation calls (session onSuccess, loop
 * driver advance, script stage, resume route-onward).
 */
export function advance(
	curCtx: WorkflowHostContext,
	completedName: string,
	completedIdx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	return advanceChain(curCtx, completedName, completedIdx, run, CHAIN_DEPS);
}

/**
 * Wraps `runStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by `runWorkflow` (start stage), `advanceChain` (next stage, via
 * `ChainDeps`), and the resume entries, so there's exactly one place that
 * translates "stage threw" → `state.termination.error` + JSONL row.
 *
 * Also the cooperative-cancellation seam: checked before the start stage and
 * before every routed next stage, so an aborted signal stops the chain at
 * the next stage boundary without interrupting a stage already streaming
 * (Pi owns the live session).
 */
export async function runStageOrRecordFailure(
	curCtx: WorkflowHostContext,
	name: string,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	if (run.signal?.aborted) return recordAbortedAtSeam(curCtx, name, run);
	try {
		return await runStage(curCtx, name, idx, run);
	} catch (e) {
		return recordEntryThrow(curCtx, name, run, e);
	}
}

// ---------------------------------------------------------------------------
// Per-stage pipeline
// ---------------------------------------------------------------------------

/**
 * Builds the `/skill:<name> <args>` line sent into the session. The audit
 * label (which used to round-trip through here) is read off `stage.skill`
 * by the caller — single source.
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
export async function runStage(
	curCtx: WorkflowHostContext,
	currentName: string,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	const stage = resolveStage(currentName, idx, run);
	switch (stage.mode) {
		case "loop":
			return runLoopStage(curCtx, stage, idx, run);
		case "script":
			// Script stages skip the skill pipeline — no `/skill:` prompt, no
			// registry check, no session, no collector snapshot. Input-schema
			// validation still applies; the script runner owns its own status
			// line + lifecycle fires.
			await ensureInputValid(stage, run);
			return runScript(curCtx, stage, idx, run, advance);
		case "prompt":
		case "skill":
			return runSingleStage(curCtx, stage, idx, run);
	}
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
 * `runStageOrRecordFailure`, which records a terminal failure.
 */
async function runSingleStage(
	curCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
): Promise<ChainOutcome> {
	runSingleStagePreflights(stage, run);

	const prompt =
		stage.dispatch === "prompt"
			? await resolveStagePrompt(stage.def.prompt!, run.cwd, run.state)
			: buildPrompt(stage.skill, inputForStage(stage, run));
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));
	const branchOffset = computeBranchOffset(curCtx, stage.def);

	await ensureInputValid(stage, run);
	await ensureContractInputValid(stage, run);

	const snapshot = await captureStageSnapshot(curCtx, stage.name, stage.def, idx, run);

	// onStageStart fires after preflight, before the Pi session opens.
	await run.lifecycle.fire(
		curCtx,
		"onStageStart",
		skillStageRef(stage.name, stage.stageNumber, stage.skill),
		lifecycleCtxFor(run),
	);

	await runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt,
		stageName: stage.name,
		skill: stage.skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: stage.def,
		skillContracts: run.skillContracts,
		stageIndex: idx,
		snapshot,
		continueHost: run.continueHost,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, run.cwd, run.runId),
		onSuccess: (freshCtx) => advance(freshCtx, stage.name, idx, run),
	});
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
	curCtx: WorkflowHostContext,
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
		if (units.length === 0) return runSingleStage(curCtx, stage, idx, run);
	}

	runLoopPreflights(stage, run);

	const entry: LoopEntry = {
		stageIdx: idx,
		name: stage.name,
		skill: stage.skill,
		def: stage.def,
		loop,
		entryArtifact: currentPrimaryArtifact(run.state),
		entryArgs: loop.kind === "assess" ? inputForStage(stage, run) : "",
		entryPair: { output: run.state.output, primaryArtifact: run.state.primaryArtifact },
		units,
	};

	await announceLoopStart(curCtx, run, entry);
	await runLoop(curCtx, entry, freshCursor(), run, buildLoopDeps());
	return "dispatched";
}

/**
 * THE loop deps bundle — built identically by the live path and resume
 * (`selectResumeEntry`), so the two can't drift (the old per-primitive
 * bundles were rebuilt by hand in both places).
 */
export function buildLoopDeps(): LoopDeps {
	return {
		runStageSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advance(freshCtx, name, completedIdx, ctx),
		captureSnapshot: (ctx, name, def, i, r) => captureStageSnapshot(ctx, name, def, i, r),
		haltLoop,
	};
}

/**
 * Terminal failure when a loop's `onCap: "halt"` trips. Verify stages get
 * the verification-failed wording — the author declared a post-condition,
 * not a loop, so "loop cap exceeded" would misattribute the failure.
 */
export async function haltLoop(
	curCtx: WorkflowHostContext,
	run: RunContext,
	e: Pick<LoopEntry, "name" | "def">,
	count: number,
	cap: number,
): Promise<void> {
	const args = e.def.verify ? failedArgs(FAIL_VERIFY_FAILED(e.name, cap)) : failedArgs(FAIL_LOOP_CAP_HALT(count, cap));
	await haltChain(curCtx, run, e.name, e.name, args);
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: WorkflowHostContext, def: StageDef): number | undefined {
	if (def.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

/** Runs whose snapshot-failure warning already fired — one notify per run, not per stage/unit. */
const snapshotWarnedRuns = new WeakSet<RunContext>();

export async function captureStageSnapshot(
	curCtx: WorkflowHostContext,
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
			curCtx.ui.notify(MSG_SNAPSHOT_FAILED(stageName, formatError(e)), "warning");
		}
		return undefined;
	}
}
