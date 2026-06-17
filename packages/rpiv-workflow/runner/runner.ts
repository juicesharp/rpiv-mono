/**
 * Workflow orchestration entry points. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; `resumeWorkflow` rebuilds state from a past
 * run's JSONL trail and re-enters the chain at the right seam. Per-stage
 * work (sessions, extraction, validation, audit row writes) lives in
 * sessions.ts + audit.ts; this directory owns graph traversal, per-stage
 * prerequisites, and routing.
 *
 * Modules (imports point strictly downward — the walk's mutual recursion is
 * composed by injection in run-stage.ts, never as a module cycle):
 *  - runner.ts          — runWorkflow + resumeWorkflow + executeRun (shared
 *                         tail).
 *  - run-stage.ts — runStage (mode dispatch) + runStageOrRecordFailure
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
 *  - resume-entry.ts    — trail trailer → chain re-entry thunk + refusal text.
 *  - resume-loop.ts     — loop-trailer re-entry + drift refusals.
 *
 * Ctx lifecycle: the launcher ctx threaded into `runWorkflow`/`resumeWorkflow`
 * STAYS VALID for the whole run — it is never swapped. Every stage runs in its
 * own detached child session opened via `ctx.spawnChild({ withSession })`; the
 * parent ctx only observes (progress, status). Continue policy spawns a child
 * like any other stage — its only divergence is the preserved branch offset.
 *
 * Vocabulary: "stage" = one stage activation in this run; "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { Workflow } from "../api.js";
import { currentPrimaryArtifact } from "../chain-state.js";
import { type LifecycleListeners, lifecycleCtxFor } from "../events.js";
import { getWorkflowExecutionProvider } from "../execution-host.js";
import { handleToString } from "../handle.js";
import type { WorkflowHost, WorkflowHostContext } from "../host.js";
import { nowIso } from "../internal-utils.js";
import {
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
import { childSessionsDir } from "../state/paths.js";
import { DEFAULT_TRIGGER } from "../triggers.js";
import type { RunContext, RunWorkflowOptions, RunWorkflowResult } from "../types.js";
import { reconstructState } from "./resume.js";
import { resumeRefusalError, selectResumeEntry } from "./resume-entry.js";
import { buildRunContext, freshRunState } from "./run-context.js";
import { runStageOrRecordFailure } from "./run-stage.js";

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
 * Walks the workflow's edge graph from `workflow.start`. The launcher `ctx`
 * stays valid throughout — each stage opens (and disposes) its own detached
 * child session via `spawnChild`, so the outer ctx is never swapped.
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

	// Detach: build the executor host from the live ctx; thread it for execution
	// (it relays UI to the live session). No provider ⇒ execute on the live ctx
	// (graceful degrade for non-Pi embedders / tests — the caller is contracted
	// to pass an executor-capable ctx there). The provider also supplies
	// run.signal (from onTerminalInput) + a dispose that unsubscribes the
	// keystroke tap; both absent in headless mode.
	const provider = getWorkflowExecutionProvider();
	let execCtx: WorkflowHostContext = ctx;
	let runOptions = options;
	let dispose: (() => void) | undefined;
	if (provider) {
		// Resolve the run-scoped session dir here (internal layout helper) and
		// hand the provider a concrete string; rpiv-pi never imports childSessionsDir.
		const exec = await provider.createHost(ctx, { runId, childSessionsDir: childSessionsDir(cwd, runId) });
		execCtx = exec.host;
		dispose = exec.dispose;
		runOptions = {
			...options,
			resolveModel: options.resolveModel ?? provider.resolveModel,
			signal: options.signal ?? exec.signal, // provider-owned abort handle
		};
	}

	const run = buildRunContext(cwd, workflow, runOptions, {
		runId,
		state: freshRunState(options.input),
		visited: new Set(),
		trigger,
	});

	try {
		return await executeRun(execCtx, run, () => runStageOrRecordFailure(execCtx, workflow.start, 0, run));
	} finally {
		dispose?.(); // unsubscribe the onTerminalInput tap — leaks accumulate on the TUI otherwise
	}
}

export interface ResumeWorkflowOptions {
	/** Workflow whose run is being resumed — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Header of the run to resume — caller resolves via `resolveRun`. */
	header: WorkflowHeader;
	/** Registry-level host — enumerated once for the skill-registration snapshot. */
	host?: WorkflowHost;
	/** Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/** Run-wide safety cap on loop units (all kinds). Defaults to MAX_ITERATIONS. */
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

	const run = buildRunContext(cwd, workflow, options, {
		runId: header.runId, // SAME run — new rows append to the same file
		state: recon.state,
		visited: recon.visited,
		trigger: { kind: "command", name: "wf", meta: { resumedFrom: options.ref } },
	});

	return executeRun(ctx, run, selectResumeEntry(ctx, recon, run));
}
