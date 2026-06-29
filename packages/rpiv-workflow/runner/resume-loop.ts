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
import { announceLoopStart, pendingFanoutIndices, runFanoutResume, runLoop } from "../loop.js";
import { effectiveLoopOf, freezesEntryArgsOf } from "../loop-constructors.js";
import { buildLoopEntry, type LoopDeps, sequentialStrategyOf } from "../loop-kinds.js";
import { validateUnitDeps } from "../loop-waves.js";
import { FAIL_MISSING_ARTIFACT, type FailureText, MSG_RESUME_LOOP_MISMATCH } from "../messages.js";
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
	if (freezesEntryArgsOf(loop)) {
		if (point.entryArgs === undefined) {
			await recordMissingArtifactFailure(ctx, run, point.parent, skill, idx);
			return;
		}
		entryArgs = point.entryArgs;
	}

	const entry = buildLoopEntry(
		{ stageIdx: idx, name: point.parent, skill, def, loop },
		{
			entryArtifact: point.entryArtifact,
			entryArgs,
			entryPair: point.entryPair,
			units: point.units, // fanout: the fold's recomputed-and-verified list — no second compute
		},
	);

	// Fanout resume re-dispatches ONLY the still-unfilled indices in bounded
	// parallel (folding each at its declared slot) — never a cold whole-loop
	// re-entry, so already-completed/collected units keep their place. The
	// announce fires iff at least one unit is pending.
	if (loop.kind === "fanout") {
		// Re-validate the recomputed DAG: the id-only drift guard PASSES when a user edits
		// only a slice's `deps` (ids/titles unchanged), so a newly-introduced cycle would
		// otherwise reach the dispatcher. guardResumeEntry catches this throw → clean failure.
		validateUnitDeps(point.units!, point.parent);
		const pending = pendingFanoutIndices(point.cursor, point.units!.length); // slots === undefined
		if (pending.length > 0) await announceLoopStart(ctx, run, entry);
		await runFanoutResume(ctx, entry, point.cursor, run, deps, pending);
		return;
	}

	// iterate/assess: pending-work probe (strategy table) gates the announce only —
	// a finished-loop resume stays a pinned SILENT no-op — then cold re-entry.
	if (await sequentialStrategyOf(loop.kind).hasPending(loop, point, run)) await announceLoopStart(ctx, run, entry);

	await runLoop(ctx, entry, point.cursor, run, deps);
}

/**
 * One refusal recorder — the shared 3-step body for the two resume recorders
 * (`recordMissingArtifactFailure` / `recordLoopDriftFailure`): resolve the
 * terminal args + build the audit ctx + `recordTerminalFailure`. Each caller
 * supplies its own descriptor — a `FailureText` (missing-artifact) or a
 * `[notifyMsg, errMsg]` tuple (loop drift).
 */
function recordResumeRefusal(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
	descriptor: FailureText | [notifyMsg: string, errMsg: string],
): Promise<void> {
	const args = Array.isArray(descriptor) ? failedArgs(descriptor[0], descriptor[1]) : failedArgs(descriptor);
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), args);
}

/** Recorded refusal for a corrupted/truncated trail (reuses the forward preflight's messages). */
function recordMissingArtifactFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
	idx: number,
): Promise<void> {
	return recordResumeRefusal(ctx, run, parent, skill, FAIL_MISSING_ARTIFACT(skill, idx + 1));
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
	return recordResumeRefusal(ctx, run, parent, skill, [MSG_RESUME_LOOP_MISMATCH(parent), errMsg]);
}
