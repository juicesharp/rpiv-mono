/**
 * Workflow orchestration entry points. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; `resumeWorkflow` rebuilds state from a past
 * run's JSONL trail and re-enters the chain at the right seam. Per-stage
 * work (sessions, extraction, validation, audit row writes) lives in
 * sessions.ts + audit.ts; this directory owns graph traversal, per-stage
 * prerequisites, and routing; imports point strictly downward — the walk's
 * mutual recursion is composed by injection in run-stage.ts, never as a
 * module cycle.
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
import type { ModelSelection, WorkflowHost, WorkflowHostContext } from "../host.js";
import { nowIso } from "../internal-utils.js";
import {
	MSG_HEADER_WRITE_FAILED,
	MSG_NAME_COLLISION,
	MSG_NAME_INDEX_WRITE_FAILED,
	MSG_NAME_INVALID,
} from "../messages.js";
import { pruneOrphanedChildSessions } from "../sessions/index.js";
import {
	type ClaimResult,
	claimName,
	generateRunId,
	readAllStages,
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

	// Run settled — every child torn down, every row persisted. Sweep child-session
	// files no row references (chiefly a `continue` fork whose stage threw before its
	// first row write — the failure row pins session:null, orphaning the fork). Safe:
	// resume only reattaches/forks files a persisted row references. Best-effort.
	pruneOrphanedChildSessions(run.cwd, run.runId, referencedSessionIds(run));

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

/**
 * The keep-set for the run-end orphan sweep. Failed/aborted rows that carry a
 * session are reattach targets on resume, so every row's `session.id` is read
 * from the durable trail (success OR failure) and unioned with `lastSession`
 * (the live predecessor a resumed `continue` would fork). Anything NOT here is
 * a child-session file no row points at — safe to delete.
 */
function referencedSessionIds(run: RunContext): Set<string> {
	const ids = new Set<string>();
	for (const row of readAllStages(run.cwd, run.runId)) {
		if (row.session) ids.add(row.session.id);
	}
	if (run.state.lastSession) ids.add(run.state.lastSession.id);
	return ids;
}

/** What `detachExecutor` resolves: the executor ctx to run against, the
 *  per-stage model resolver + abort signal to thread onto `RunContext`, and the
 *  teardown the caller invokes in `finally`. */
interface DetachedExecutor {
	execCtx: WorkflowHostContext;
	resolveModel?: (id: { stage: string; skill: string }) => ModelSelection | undefined;
	signal?: AbortSignal;
	dispose?: () => void;
}

/**
 * Detach to the executor host — the SHARED detach BOTH entry points run through,
 * so a resumed stage's `spawnChild` / reattach / fork runs against the SAME real
 * executor as a live run. Building the host HERE for both paths keeps resume
 * off the bare launcher ctx (a `WorkflowLauncherContext` with no
 * `spawnChild`/`maxConcurrency`) — the only place such a gap could hide is a
 * test injecting a `spawnChild` directly.
 *
 * Threads the provider's `resolveModel` + abort `signal` too, so resumed children
 * get per-stage models and cooperative cancellation exactly like live. The
 * `childSessionsDir` is keyed by `runId`, so a resume reuses the SAME run-scoped
 * dir the original run persisted its children into — what reattach/fork resolve
 * against.
 *
 * No provider ⇒ execute on the live `ctx` (graceful degrade for non-Pi embedders
 * / tests — the caller is contracted to pass an executor-capable ctx there).
 * `dispose` unsubscribes the keystroke tap; the caller MUST call it in `finally`.
 */
async function detachExecutor(
	ctx: WorkflowHostContext,
	cwd: string,
	runId: string,
	options: {
		resolveModel?: (id: { stage: string; skill: string }) => ModelSelection | undefined;
		signal?: AbortSignal;
		name?: string; // lane display name (run --name ?? workflow name)
		/** Workflow name (the dock's dim `workflow:` tag); threaded from workflow.name / header.workflow. */
		workflow?: string;
		/** The run's original input (user prompt); threaded from options.input / header.input. */
		input?: string;
	},
): Promise<DetachedExecutor> {
	const provider = getWorkflowExecutionProvider();
	if (!provider) return { execCtx: ctx, resolveModel: options.resolveModel, signal: options.signal };
	// Resolve the run-scoped session dir here (internal layout helper) and hand the
	// provider a concrete string; rpiv-pi never imports childSessionsDir.
	const exec = await provider.createHost(ctx, {
		runId,
		childSessionsDir: childSessionsDir(cwd, runId),
		name: options.name, // rpiv-pi records the lane under this name
		workflow: options.workflow, // dock tag (the workflow name)
		input: options.input, // dock descriptor (the user prompt)
	});
	return {
		execCtx: exec.host,
		dispose: exec.dispose,
		resolveModel: options.resolveModel ?? provider.resolveModel,
		signal: options.signal ?? exec.signal, // provider-owned abort handle
	};
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

	// Detach to the executor host (the executor relays UI back to the live session).
	const { execCtx, resolveModel, signal, dispose } = await detachExecutor(ctx, cwd, runId, {
		...options,
		name: options.name ?? workflow.name,
		workflow: workflow.name,
		input: options.input,
	});

	// `buildRunContext` is INSIDE the try so a throw there (e.g. countReachableStages
	// on a malformed EdgeFn that bypassed load-time validation) still runs `dispose`
	// — otherwise the onTerminalInput tap leaks, accumulating one per failed run.
	try {
		const run = buildRunContext(
			cwd,
			workflow,
			{ ...options, resolveModel, signal },
			{
				runId,
				state: freshRunState(options.input),
				visited: new Set(),
				trigger,
			},
		);
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
	/** Per-destination decision-edge re-entry cap. Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/** Run-wide safety cap on loop units (all kinds). Defaults to MAX_ITERATIONS. */
	maxIterations?: number;
	/** The user's `@<ref>` — surfaced in trigger.meta + refusal messages. */
	ref: string;
	/** Per-call lifecycle listener bundle. */
	lifecycle?: LifecycleListeners;
	/** Cooperative cancellation — see `RunWorkflowOptions.signal`. */
	signal?: AbortSignal;
	/**
	 * Per-stage model-override resolver — see `RunWorkflowOptions.resolveModel`.
	 * Resumed stages resolve per-child models exactly like live; when omitted the
	 * detached executor's own `provider.resolveModel` is used (so a resume from the
	 * Pi launcher still honors per-skill overrides without the caller re-threading
	 * it). Undefined + no provider ⇒ host default for every resumed stage.
	 */
	resolveModel?: (id: { stage: string; skill: string }) => ModelSelection | undefined;
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

	// Detach to the executor host — the SAME wiring as live (L4-01). After the
	// reconstruct refusal so a refused resume builds no host, but BEFORE
	// `buildRunContext`/`executeRun` so every resumed stage (single-stage reattach,
	// pending-fanout re-dispatch, or a cold-routed continue fork) runs against the
	// real executor, not the bare launcher ctx. Same run id ⇒ same childSessionsDir,
	// so reattach/fork resolve the original run's persisted child sessions.
	const { execCtx, resolveModel, signal, dispose } = await detachExecutor(ctx, cwd, header.runId, {
		...options,
		name: header.name ?? header.workflow,
		workflow: header.workflow,
		input: header.input,
	});

	// `buildRunContext` + `selectResumeEntry` are INSIDE the try so a throw in either
	// still runs `dispose` (tap-leak parity with `runWorkflow`).
	try {
		const run = buildRunContext(
			cwd,
			workflow,
			{ ...options, resolveModel, signal },
			{
				runId: header.runId, // SAME run — new rows append to the same file
				state: recon.state,
				visited: recon.visited,
				trigger: { kind: "command", name: "wf", meta: { resumedFrom: options.ref } },
			},
		);
		return await executeRun(execCtx, run, selectResumeEntry(execCtx, recon, run));
	} finally {
		dispose?.(); // unsubscribe the onTerminalInput tap — parity with runWorkflow
	}
}
