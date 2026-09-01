/**
 * Resume entry selection — translate a reconstructed trail (`resume.ts`)
 * into the chain re-entry thunk `resumeWorkflow` hands to `executeRun`, plus
 * the refusal-reason rendering for a reconstruct that declined. Companion to
 * `resume-loop.ts` (which owns the loop-trailer arm's dispatch).
 */

import type { Workflow } from "../api.js";
import {
	ERR_RESUME_MALFORMED_ROW,
	ERR_RESUME_NO_ROWS,
	ERR_RESUME_STAGE_GONE,
	ERR_RESUME_VERSION_MISMATCH,
} from "../messages.js";
import { STOP } from "../routing-dsl.js";
import { STATE_SCHEMA_VERSION } from "../state/index.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { recordEntryThrow } from "./failure.js";
import type { ReconstructResult } from "./resume.js";
import { recordLoopDriftFailure, resumeLoopStage } from "./resume-loop.js";
import { advance, buildLoopDeps, dispatchStageOrRecordFailure, resumeStageWithSession } from "./run-stage.js";

/**
 * Pick the chain re-entry thunk from the trail trailer. Dispatch keys on the
 * STRUCTURED `parent` field — no string matching, no per-primitive arms:
 *   - fold-detected drift → record the parent-attributed terminal failure
 *     (zero dispatch; lifecycle bracketing identical to every other entry);
 *   - trailing unit row → re-enter the loop with the fold's cursor;
 *   - completed normal trailer → route onward (finished run hits stop ⇒ no-op);
 *   - gate-stop halt on a side-effect stage → dispatch the gate's sole
 *     non-stop target, or re-route (idempotent re-stop) when the target is
 *     ambiguous — NEVER replay the arm (see the arm's comment);
 *   - failed/aborted trailer → session-backed rows try promotion/reattach
 *     (`resumeStageWithSession`); sessionless rows re-run cold (today's
 *     behavior). Dispatch keys on the STRUCTURED `session` field, mirroring
 *     the `parent !== undefined` arm. A gate-stop halt on a produces stage
 *     lands here deliberately: its halt row is sessionless by construction
 *     (`auditCtxFor`), so the gate stage re-runs cold — the re-measure.
 */
export function selectResumeEntry(
	ctx: WorkflowHostContext,
	recon: Extract<ReconstructResult, { ok: true }>,
	run: RunContext,
): () => Promise<unknown> {
	if (recon.drift) {
		const { parent, errMsg } = recon.drift;
		return () => recordLoopDriftFailure(ctx, run, parent, errMsg);
	}

	// The fold's reconstructed chain index — NOT `stageNumber - 1`: the
	// allocator counts every row including loop units, so past any loop the
	// two diverge (a 10-unit loop would resume showing "stage 14/5").
	const last = recon.rows[recon.rows.length - 1]!;
	const idx = recon.lastChainIndex; // status-line / routing index; JSONL number comes from the allocator

	if (last.parent !== undefined) {
		// `recon.trailing` is set by construction: the fold always produces a
		// trailing point for an open generation, and a unit-row trailer means
		// the generation is open.
		return () =>
			guardResumeEntry(ctx, last.parent!, run, () =>
				resumeLoopStage(ctx, recon.trailing!, idx, run, buildLoopDeps()),
			);
	}
	if (recon.trailing && recon.trailing.parent === last.stage) {
		// Open FANOUT generation whose trailer is its OWN parent-unset abort/halt
		// stage row (a mid-flight abort). The fold keeps the generation open for
		// exactly this case (see resume.ts), so `recon.trailing` carries the
		// completed-unit slots — re-enter the loop to replay them and dispatch
		// only the pending units (finding 7). Without this arm the aborted trailer
		// falls through to the cold stage re-run below and re-dispatches EVERY
		// unit, duplicating the channel and collapsing the downstream fan-in.
		return () =>
			guardResumeEntry(ctx, last.stage, run, () => resumeLoopStage(ctx, recon.trailing!, idx, run, buildLoopDeps()));
	}
	if (last.status === "completed") {
		// c2 no-op path: a fully-completed run routes onward from its last stage,
		// which hits `stop` ⇒ `finalizeWorkflow` ⇒ success. The walk runs the
		// normal lifecycle bracket (onWorkflowStart/onWorkflowEnd) but dispatches
		// no stage session — no stage re-run, no child spawned, zero new JSONL
		// stage rows. This is the safe no-op behind resuming a finished run via
		// @<runId>.
		return () => guardResumeEntry(ctx, last.stage, run, () => advance(ctx, last.stage, idx, run));
	}
	// Gate-stop halt off a SIDE-EFFECT stage: re-running the arm would replay
	// its side effects against a tree the user has since hand-repaired — the
	// observed livelock is a remediation arm that re-runs, changes nothing (the
	// hand-fix already landed), and re-trips the very unchanged-tree gate that
	// halted it. The re-measure path is the gate's own onward target: dispatch
	// its sole non-stop target so the fix loop's verification body re-judges
	// the repaired tree. A gate with several onward targets (none exist today)
	// must NOT fall through to the cold re-dispatch below — that is exactly the
	// replay this arm exists to prevent — so it re-routes instead: `advance`
	// re-fires the edge over the replayed channels, which either picks a live
	// onward branch or re-stops with the same note (an idempotent halt, zero
	// side effects). Only a PRODUCES gate stage takes the re-dispatch below,
	// where re-running IS the re-measure (fresh judgment, route re-folds).
	if (recon.gateStop && run.workflow.stages[last.stage]?.kind === "side-effect") {
		const onward = soleOnwardTarget(run.workflow, last.stage);
		return onward !== undefined
			? () => guardResumeEntry(ctx, onward, run, () => dispatchStageOrRecordFailure(ctx, onward, idx + 1, run))
			: () => guardResumeEntry(ctx, last.stage, run, () => advance(ctx, last.stage, idx, run));
	}
	// failed/aborted trailer — the c2 boundary. Re-attempting this stage is
	// intentional and the core resume retry use case: session-backed rows try
	// promotion/reattach (`resumeStageWithSession`), sessionless rows re-run cold
	// (today's behavior). Deliberately OUTSIDE c2's no-op guarantee — a new stage
	// row IS appended and the stage re-runs (see the completed-vs-failed boundary
	// tests in resume.test.ts).
	return last.session !== null
		? () => resumeStageWithSession(ctx, last, idx, run)
		: () => dispatchStageOrRecordFailure(ctx, last.stage, idx, run);
}

/**
 * The single non-stop target a decision edge can route onward to, or
 * `undefined` when the edge declares none, several, or a target no longer in
 * the workflow. Reads the `.targets` metadata every decision edge carries
 * (`validate-workflow.ts` enforces it at load time), so no predicate is probed.
 */
function soleOnwardTarget(workflow: Workflow, stage: string): string | undefined {
	const edge = workflow.edges[stage];
	if (typeof edge !== "function" || !edge.targets) return undefined;
	const onward = edge.targets.filter((t) => t !== STOP);
	return onward.length === 1 && workflow.stages[onward[0]!] ? onward[0] : undefined;
}

/**
 * Resume-entry counterpart of `dispatchStageOrRecordFailure`'s catch. The live
 * chain reaches user fns (loop `next`/`done`/`feedForward`, judge prompts,
 * route predicates) only under that catch; the resume-loop and route-onward
 * entry thunks call the same fns directly, so a throw would otherwise escape
 * `executeRun` as a raw rejection — `onWorkflowEnd` never fires and the
 * caller loses the result envelope.
 */
async function guardResumeEntry(
	hostCtx: WorkflowHostContext,
	name: string,
	run: RunContext,
	entry: () => Promise<unknown>,
): Promise<void> {
	try {
		await entry();
	} catch (e) {
		await recordEntryThrow(hostCtx, name, run, e);
	}
}

export function resumeRefusalError(recon: Extract<ReconstructResult, { ok: false }>, workflow: string): string {
	switch (recon.reason) {
		case "no-rows":
			return ERR_RESUME_NO_ROWS(recon.detail);
		case "stage-gone":
			return ERR_RESUME_STAGE_GONE(recon.detail, workflow);
		case "malformed-row":
			return ERR_RESUME_MALFORMED_ROW(recon.detail);
		case "version-mismatch":
			return ERR_RESUME_VERSION_MISMATCH(recon.detail, STATE_SCHEMA_VERSION);
	}
}
