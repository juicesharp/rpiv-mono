/**
 * Workflow orchestration entry points. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; `resumeWorkflow` rebuilds state from a past
 * run's JSONL trail and re-enters the chain at the right seam. Per-stage
 * work (sessions, extraction, validation, audit row writes) lives in
 * sessions.ts + audit.ts; this directory owns graph traversal, per-stage
 * prerequisites, and routing.
 *
 * Modules (imports point strictly downward — the walk's mutual recursion is
 * composed by injection in stage-lifecycle.ts, never as a module cycle):
 *  - runner.ts          — runWorkflow + resumeWorkflow + executeRun (shared
 *                         tail) + resume-entry selection.
 *  - stage-lifecycle.ts — runStage (mode dispatch) + runStageOrRecordFailure
 *                         (single catch site) + the walk composition.
 *  - chain-advance.ts   — advanceChain + routing audit + backward-jump
 *                         guard + halt-on-error (ChainDeps-injected).
 *  - resolve-stage.ts   — ResolvedStage: mode/dispatch derived once.
 *  - preflight.ts       — runtime preflights (throw StagePreflightError).
 *  - input-validation.ts— schema-backed input preflights.
 *  - script-stage.ts    — skillless TS-stage runtime (no session/collector).
 *  - failure.ts         — ChainOutcome + entry-throw → failure-row + finalize.
 *  - run-context.ts     — RunContext/RunState construction + policy caps.
 *  - errors.ts          — StagePreflightError.
 *  - resume.ts          — reconstructState: pure RunState rebuild from a
 *                         past run's JSONL trail (consumed by resumeWorkflow).
 *  - resume-loop.ts     — loop-trailer re-entry + drift refusals.
 *
 * Ctx lifecycle: every level only touches the ctx it was handed.
 * - `newSession({cancelled: false})` invalidates the outer ctx; all
 *   further work runs on `freshCtx` inside `withSession`, and the
 *   outer function simply unwinds.
 * - `cancelled: true` means no replacement happened — outer ctx remains
 *   valid.
 * - Continue policy has no newSession — same ctx throughout.
 *
 * Vocabulary: "stage" = one stage activation in this run; "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { Workflow } from "../api.js";
import { currentPrimaryArtifact } from "../chain-state.js";
import { handleToString } from "../handle.js";
import type { WorkflowHost, WorkflowHostContext } from "../host.js";
import { nowIso } from "../internal-utils.js";
import { type LifecycleListeners, lifecycleCtxFor } from "../lifecycle.js";
import {
	ERR_RESUME_MALFORMED_ROW,
	ERR_RESUME_NO_ROWS,
	ERR_RESUME_STAGE_GONE,
	ERR_RESUME_VERSION_MISMATCH,
	MSG_HEADER_WRITE_FAILED,
	MSG_NAME_COLLISION,
	MSG_NAME_INDEX_WRITE_FAILED,
	MSG_NAME_INVALID,
} from "../messages.js";
import {
	type ClaimResult,
	claimName,
	generateRunId,
	releaseName,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	writeHeader,
} from "../state/index.js";
import { DEFAULT_TRIGGER } from "../triggers.js";
import type { RunContext, RunWorkflowOptions, RunWorkflowResult } from "../types.js";
import { recordEntryThrow } from "./failure.js";
import { type ReconstructResult, reconstructState } from "./resume.js";
import { recordLoopDriftFailure, resumeLoopStage } from "./resume-loop.js";
import { buildRunContext, freshRunState } from "./run-context.js";
import { advance, buildLoopDeps, runStageOrRecordFailure } from "./stage-lifecycle.js";

// ---------------------------------------------------------------------------
// Shared tail — executeRun
// ---------------------------------------------------------------------------

/**
 * Shared tail: fire `onWorkflowStart`, kick the chain via `entry`,
 * assemble the result envelope, fire `onWorkflowEnd`. Used by both
 * `runWorkflow` (new runs) and `resumeWorkflow` (resumed runs) so
 * lifecycle events, result assembly, and error propagation stay in lockstep.
 */
async function executeRun(
	ctx: WorkflowHostContext,
	run: RunContext,
	entry: () => Promise<unknown>,
): Promise<RunWorkflowResult> {
	await run.lifecycle.fire(ctx, "onWorkflowStart", lifecycleCtxFor(run));

	await entry();

	const { state } = run;
	const result: RunWorkflowResult = {
		runId: run.runId,
		stagesCompleted: state.stagesCompleted,
		success: state.termination.status === "completed",
		lastArtifact: (() => {
			const a = currentPrimaryArtifact(state);
			return a ? handleToString(a.handle) : undefined;
		})(),
		error: state.termination.error,
		termination: state.termination,
		...(state.telemetry.droppedRoutingRows.length > 0
			? { droppedRoutingRows: state.telemetry.droppedRoutingRows }
			: {}),
		...(state.telemetry.droppedFailureRows.length > 0
			? { droppedFailureRows: state.telemetry.droppedFailureRows }
			: {}),
	};

	await run.lifecycle.fire(ctx, "onWorkflowEnd", result, lifecycleCtxFor(run));
	return result;
}

// ---------------------------------------------------------------------------
// runWorkflow — workflow entry point
// ---------------------------------------------------------------------------

/** Map a failed `claimName` outcome to its user-facing message. */
function nameClaimError(name: string, claim: Extract<ClaimResult, { ok: false }>): string {
	switch (claim.reason) {
		case "invalid":
			return MSG_NAME_INVALID(name);
		case "collision":
			return MSG_NAME_COLLISION(name, claim.runId);
		case "write-failed":
			return MSG_NAME_INDEX_WRITE_FAILED(name);
	}
}

/**
 * Each subsequent `newSession()` is invoked on the freshCtx returned by the
 * previous withSession — never on a captured outer ctx (which Pi invalidates
 * as soon as the session is replaced).
 */
export async function runWorkflow(ctx: WorkflowHostContext, options: RunWorkflowOptions): Promise<RunWorkflowResult> {
	const { workflow } = options;
	if (!workflow.stages[workflow.start]) {
		return {
			stagesCompleted: 0,
			success: false,
			error: `Workflow "${workflow.name}" start stage "${workflow.start}" is not declared`,
		};
	}

	const continueGuard = hostMissingForContinueStages(workflow, options.host);
	if (continueGuard) return { stagesCompleted: 0, success: false, error: continueGuard };

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const trigger = options.trigger ?? DEFAULT_TRIGGER;

	// Reserve the name (validate → collision → persist) through the state
	// layer's single door, BEFORE the JSONL header so the collision guard's
	// truth-source can never lag the header. Nothing is written on failure.
	if (options.name) {
		const claim = claimName(cwd, options.name, runId);
		if (!claim.ok) return { stagesCompleted: 0, success: false, error: nameClaimError(options.name, claim) };
	}

	// Nothing has executed yet — the cheapest moment to refuse. A lost header
	// makes the run unlistable and unresumable while its stage rows land, so a
	// failed append rejects the start and rolls back the name claim (the index
	// must not point at a run that never existed).
	const headerWritten = writeHeader(cwd, {
		runId,
		workflow: workflow.name,
		input: options.input,
		ts: nowIso(),
		v: STATE_SCHEMA_VERSION,
		trigger,
		name: options.name,
	});
	if (!headerWritten) {
		if (options.name) releaseName(cwd, options.name, runId);
		return { stagesCompleted: 0, success: false, error: MSG_HEADER_WRITE_FAILED(runId) };
	}

	const run = buildRunContext(cwd, workflow, options, {
		runId,
		state: freshRunState(options.input),
		visited: new Set(),
		trigger,
	});

	return executeRun(ctx, run, () => runStageOrRecordFailure(ctx, workflow.start, 0, run));
}

export interface ResumeWorkflowOptions {
	/** Workflow whose run is being resumed — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Header of the run to resume — caller resolves via `resolveRun`. */
	header: WorkflowHeader;
	/** Required for "continue"-policy stages (host.sendUserMessage). */
	host?: WorkflowHost;
	/** Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/** Run-wide safety cap on iterate-stage units. Defaults to MAX_ITERATIONS. */
	maxIterations?: number;
	/** The user's `@<ref>` — surfaced in trigger.meta + refusal messages. */
	ref: string;
	/** Per-call lifecycle listener bundle. */
	lifecycle?: LifecycleListeners;
	/** Cooperative cancellation — see `RunWorkflowOptions.signal`. */
	signal?: AbortSignal;
}

/**
 * Resume a failed (or cut-off) workflow run by rebuilding `RunState` from
 * the run's JSONL audit trail and re-entering the chain machinery at the
 * right seam — re-running the failed stage, or routing onward from the
 * last completed one.
 *
 * New rows **append to the same JSONL file** so the trail reads as one
 * story: *ran → failed → resumed → continued*.
 */
export async function resumeWorkflow(
	ctx: WorkflowHostContext,
	options: ResumeWorkflowOptions,
): Promise<RunWorkflowResult> {
	const { workflow, header } = options;
	const cwd = ctx.cwd;

	const recon = await reconstructState(cwd, workflow, header);
	if (!recon.ok) {
		// Pure envelope — no self-notify, mirroring `runWorkflow`'s pre-flight
		// rejections. A reconstruct refusal writes no JSONL, so the caller surfaces
		// it: `command.ts` via the `!result.runId` discriminator, programmatic
		// embedders via `if (!result.success)`. Keeps the run and resume families
		// on one notify contract.
		return { stagesCompleted: 0, success: false, error: resumeRefusalError(recon, header.workflow) };
	}

	const continueGuard = hostMissingForContinueStages(workflow, options.host);
	if (continueGuard) return { stagesCompleted: 0, success: false, error: continueGuard };

	const run = buildRunContext(cwd, workflow, options, {
		runId: header.runId, // SAME run — new rows append to the same file
		state: recon.state,
		visited: recon.visited,
		trigger: { kind: "command", name: "wf", meta: { resumedFrom: options.ref } },
	});

	return executeRun(ctx, run, selectResumeEntry(ctx, recon, run));
}

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

/**
 * Continue-policy stages thread the prior session via the host's
 * `sendUserMessage`; with no host, `enforceSessionInvariants` would throw at
 * the first such stage. Reject at workflow entry so embedders get a clean
 * envelope instead of a throw. Returns the error message, or undefined if the
 * workflow is safe to run.
 */
function hostMissingForContinueStages(workflow: Workflow, host: WorkflowHost | undefined): string | undefined {
	if (host !== undefined) return undefined;
	if (!Object.values(workflow.stages).some((s) => s.sessionPolicy === "continue")) return undefined;
	return "workflow contains continue-policy stages which require a workflow host";
}

/**
 * Pick the chain re-entry thunk from the trail trailer. Dispatch keys on the
 * STRUCTURED `parent` field — no string matching, no per-primitive arms:
 *   - fold-detected drift → record the parent-attributed terminal failure
 *     (zero dispatch; lifecycle bracketing identical to every other entry);
 *   - trailing unit row → re-enter the loop with the fold's cursor;
 *   - completed normal trailer → route onward (finished run hits stop ⇒ no-op);
 *   - failed/aborted trailer → re-run that stage.
 */
function selectResumeEntry(
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
	if (last.status === "completed") {
		// route onward; finished run ⇒ hits stop ⇒ no-op
		return () => guardResumeEntry(ctx, last.stage, run, () => advance(ctx, last.stage, idx, run));
	}
	return () => runStageOrRecordFailure(ctx, last.stage, idx, run); // re-run the failed/aborted stage
}

/**
 * Resume-entry counterpart of `runStageOrRecordFailure`'s catch. The live
 * chain reaches user fns (loop `next`/`done`/`feedForward`, judge prompts,
 * route predicates) only under that catch; the resume-loop and route-onward
 * entry thunks call the same fns directly, so a throw would otherwise escape
 * `executeRun` as a raw rejection — `onWorkflowEnd` never fires and the
 * caller loses the result envelope.
 */
async function guardResumeEntry(
	curCtx: WorkflowHostContext,
	name: string,
	run: RunContext,
	entry: () => Promise<unknown>,
): Promise<void> {
	try {
		await entry();
	} catch (e) {
		await recordEntryThrow(curCtx, name, run, e);
	}
}

function resumeRefusalError(recon: Extract<ReconstructResult, { ok: false }>, workflow: string): string {
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
