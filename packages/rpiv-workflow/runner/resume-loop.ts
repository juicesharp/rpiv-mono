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

import type { LoopDef } from "../api.js";
import { auditCtxFor, recordTerminalFailure } from "../audit.js";
import { effectiveLoopOf } from "../control-flow.js";
import { resolveSkill } from "../internal-utils.js";
import { skillStageRef } from "../lifecycle.js";
import { type LoopDeps, type LoopEntry, runLoop } from "../loop.js";
import { ERR_MISSING_ARTIFACT, MSG_MISSING_ARTIFACT, MSG_RESUME_LOOP_MISMATCH } from "../messages.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import type { LoopResumePoint } from "./resume.js";
import { lifecycleCtxFor } from "./runner.js";

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

	if (await hasPendingUnit(loop, point, run)) {
		const ref = skillStageRef(point.parent, idx + 1, skill);
		await run.lifecycle.fire(ctx, "onStageStart", ref, lifecycleCtxFor(run));
		await run.lifecycle.fire(
			ctx,
			"onLoopStart",
			ref,
			{ kind: def.verify ? ("verify" as const) : loop.kind, ...(point.units ? { units: point.units } : {}) },
			lifecycleCtxFor(run),
		);
	}

	await runLoop(ctx, entry, point.cursor, run, deps);
}

/**
 * Pending-work probe — never dispatches; gates the announce only. The
 * iterate arm re-pulls `next()` at the cursor (the driver pulls the same
 * index again right after) — the harmless double-pull is safe because the
 * resume contract requires generators to be deterministic.
 */
async function hasPendingUnit(loop: LoopDef, point: LoopResumePoint, run: RunContext): Promise<boolean> {
	if (loop.kind === "fanout") return point.cursor.index < (point.units?.length ?? 0);
	if (loop.kind === "iterate") {
		const u = await loop.next({
			cwd: run.cwd,
			artifact: point.entryArtifact,
			state: run.state,
			accumulated: point.cursor.accumulated,
			index: point.cursor.index,
		});
		return u !== null && u !== undefined;
	}
	// assess: a pending judge always runs; a pending produce runs unless the
	// recovered verdict is done (the driver's fast-advance path).
	if (point.cursor.phase === "judge") return true;
	return !(point.cursor.lastVerdict !== undefined && loop.done(point.cursor.lastVerdict));
}

/** Recorded refusal for a corrupted/truncated trail (reuses the forward preflight's messages). */
function recordMissingArtifactFailure(
	ctx: WorkflowHostContext,
	run: RunContext,
	parent: string,
	skill: string,
	idx: number,
): Promise<void> {
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_MISSING_ARTIFACT(skill),
		notifyLevel: "error",
		errMsg: ERR_MISSING_ARTIFACT(skill, idx + 1),
	});
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
	return recordTerminalFailure(ctx, auditCtxFor(run, parent, skill), {
		status: "failed",
		notifyMsg: MSG_RESUME_LOOP_MISMATCH(parent),
		notifyLevel: "error",
		errMsg,
	});
}
