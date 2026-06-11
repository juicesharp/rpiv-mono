/**
 * Loop-resume dispatch. When a resumed run's trail trailer is a loop-unit
 * row (`row.parent` set), `resumeWorkflow` routes here. The fold already
 * verified EVERY unit row (full-row drift guard) and reconstructed the
 * driver's own `LoopCursor`, so re-entry is: derive the frozen entry arg,
 * announce iff work is pending, hand the cursor back to `runLoop`.
 *
 * All four assess pending paths fall out of `pullNext` with the
 * reconstructed cursor — pending judge (grade without re-running the
 * producer), pending produce with a recovered verdict (feedForward, no
 * re-grade), done-verdict fast advance, and round-0 re-run — zero special
 * cases here.
 *
 * The finished-loop resume is a pinned SILENT no-op: no onStageStart /
 * onLoopStart re-fire, no toast (the driver's `ranThisInvocation` rule keeps
 * the banner off; `hasPendingUnit` keeps the announce off). The iterate
 * probe pull is the documented harmless deterministic double-pull.
 */

import { auditCtxFor, failedArgs, recordTerminalFailure } from "../audit.js";
import { resolveSkill } from "../chain-state.js";
import { effectiveLoopOf } from "../control-flow.js";
import { announceLoopStart, type LoopDeps, runLoop } from "../loop.js";
import { type LoopEntry, loopStrategyOf } from "../loop-kinds.js";
import { ERR_MISSING_ARTIFACT, MSG_MISSING_ARTIFACT, MSG_RESUME_LOOP_MISMATCH } from "../messages.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import type { LoopResumePoint } from "./resume.js";

export async function resumeLoopStage(
	ctx: WorkflowHostContext,
	point: LoopResumePoint,
	idx: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const def = run.workflow.stages[point.parent]!; // fold verified the parent carries a loop (or verify)
	const loop = effectiveLoopOf(def)!;
	const skill = resolveSkill(def, point.parent);

	// Round-0 producer arg (assess-kind only), FROZEN by the fold at generation
	// open — never re-derived from post-fold state, so neither a trailing judge
	// row's transient roll nor the generation's own named appends can leak into
	// it. `undefined` means the trail no longer carries the rows that published
	// this stage's inputs — recorded refusal with the forward preflight's
	// messages (today's posture, now covering `reads` projections too). A
	// prompt-dispatch stage never refuses here: the authority freezes `""` (no
	// skill args exist) and the driver re-resolves the stage's own `prompt` at
	// round-0 dispatch.
	let entryArgs = "";
	if (loop.kind === "assess") {
		if (point.entryArgs === undefined) {
			await recordMissingArtifactFailure(ctx, run, point.parent, skill, idx);
			return;
		}
		entryArgs = point.entryArgs;
	}

	const entry: LoopEntry = {
		stageIdx: idx,
		name: point.parent,
		skill,
		def,
		loop,
		entryArtifact: point.entryArtifact,
		entryArgs,
		entryPair: point.entryPair,
		units: point.units, // fanout: the fold's recomputed-and-verified list — no second compute
	};

	// Pending-work probe (strategy table) gates the announce only — a
	// finished-loop resume stays a pinned SILENT no-op.
	if (await loopStrategyOf(loop.kind).hasPending(loop, point, run)) await announceLoopStart(ctx, run, entry);

	await runLoop(ctx, entry, point.cursor, run, deps);
}

/** Recorded refusal for a corrupted/truncated trail (reuses the forward preflight's messages). */
function recordMissingArtifactFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
	idx: number,
): Promise<void> {
	return recordTerminalFailure(
		ctx,
		auditCtxFor(run, parent, skill),
		failedArgs(MSG_MISSING_ARTIFACT(skill), ERR_MISSING_ARTIFACT(skill, idx + 1)),
	);
}

/**
 * Recorded terminal failure for a fold-detected drift (or a generator throw
 * during the fold). Parent-attributed failed row, zero dispatch — used as
 * the resume ENTRY thunk so lifecycle bracketing (onWorkflowStart/End)
 * matches every other resume outcome.
 */
export function recordLoopDriftFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	errMsg: string,
): Promise<void> {
	const skill = resolveSkill(run.workflow.stages[parent]!, parent);
	return recordTerminalFailure(
		ctx,
		auditCtxFor(run, parent, skill),
		failedArgs(MSG_RESUME_LOOP_MISMATCH(parent), errMsg),
	);
}
