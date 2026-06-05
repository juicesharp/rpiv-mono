/**
 * Workflow orchestration entry point. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; per-stage work (sessions, extraction,
 * validation, audit row writes) lives in sessions.ts + audit.ts. This
 * directory owns graph traversal, per-stage prerequisites, and routing.
 *
 * Modules:
 *  - runner.ts          — runWorkflow + resumeWorkflow + executeRun (shared
 *                         tail) + countReachableStages +
 *                         runStageOrRecordFailure + finalizeWorkflow.
 *  - stage-lifecycle.ts — runStage + StagePreflightError + preflight
 *                         pipeline + outcome.collector.snapshot hook.
 *  - chain-advance.ts   — advanceChain + routing audit + backward-jump
 *                         guard + halt-on-error.
 *  - resume.ts          — reconstructState: pure RunState rebuild from a
 *                         past run's JSONL trail (consumed by resumeWorkflow).
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
import { auditCtxFor, notifyPartialArtifacts, nowIso, recordTerminalFailure } from "../audit.js";
import type { FanoutDeps } from "../fanout.js";
import { handleToString } from "../handle.js";
import type { WorkflowHost, WorkflowHostContext } from "../host.js";
import { currentPrimaryArtifact } from "../internal-utils.js";
import type { IterateDeps } from "../iterate.js";
import { buildLifecycleContext, LifecycleDispatcher, type LifecycleListeners } from "../lifecycle.js";
import {
	ERR_RESUME_NO_ROWS,
	ERR_RESUME_STAGE_GONE,
	ERR_WORKFLOW_ABORTED,
	MSG_NAME_COLLISION,
	MSG_NAME_INDEX_WRITE_FAILED,
	MSG_NAME_INVALID,
	MSG_STAGE_THREW,
	MSG_WORKFLOW_ABORTED,
	MSG_WORKFLOW_COMPLETE,
	STATUS_KEY,
} from "../messages.js";
import { runFanoutSession, runStageSession } from "../sessions/index.js";
import { type ClaimResult, claimName, generateRunId, writeHeader } from "../state/index.js";
import type { WorkflowHeader } from "../state/state.js";
import { DEFAULT_TRIGGER, type RunTrigger } from "../triggers.js";
import type { RunContext, RunState } from "../types.js";
import { advanceChain } from "./chain-advance.js";
import {
	fanoutStageNames,
	iterateStageNames,
	matchFanoutParent,
	type ReconstructResult,
	reconstructState,
} from "./resume.js";
import { resumeFanoutStage } from "./resume-fanout.js";
import { resumeIterateStage } from "./resume-iterate.js";
import { captureStageSnapshot, haltIterations, runStage, StagePreflightError } from "./stage-lifecycle.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Per-loop cap on decision-edge retries. A "backward jump" is a *decision*
 * resolving to an already-visited stage — i.e. the user's predicate chose to
 * retry. Deterministic edges through a cycle (the loop body) are NOT
 * counted; the budget is per retry iteration, not per hop. A decision
 * escaping the loop (target not visited) resets the counter so each
 * independent loop in the workflow gets its own fresh budget. With 2: the
 * loop runs once unconditionally and may retry up to 2 more times.
 */
export const MAX_BACKWARD_JUMPS = 2;

/**
 * Run-wide safety cap on `iterate`-stage units — the backstop for a generator
 * that never returns `null`. Mirrors rpiv-pi's `MAX_PHASES` (the convention
 * cap a fanout author would self-impose); 32 is comfortably above any
 * realistic per-stage unit count while still halting a runaway loop.
 */
export const MAX_ITERATIONS = 32;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
	/** Workflow to execute — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Passed to the start stage as its argument. */
	input: string;
	/** Required for "continue"-policy stages (host.sendUserMessage). */
	host?: WorkflowHost;
	/** Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/** Run-wide safety cap on iterate-stage units. Defaults to MAX_ITERATIONS. */
	maxIterations?: number;
	/**
	 * What triggered this run. `/wf` sets `{ kind: "command", name: "wf" }`;
	 * programmatic embedders default to `DEFAULT_TRIGGER`. Recorded in the
	 * JSONL header and surfaced on every lifecycle callback via
	 * `LifecycleContext.trigger`.
	 */
	trigger?: RunTrigger;
	/**
	 * Per-call lifecycle listener bundle. Fires AFTER every globally
	 * registered bundle (see `registerLifecycle`). Listener throws are
	 * caught + logged via `ctx.ui.notify(..., "warning")`; never halt the
	 * run.
	 */
	lifecycle?: LifecycleListeners;
	/**
	 * Cooperative cancellation. When the signal is aborted, the runner stops at
	 * the next between-stage seam — it records an `"aborted"` terminal row for
	 * the stage about to run and returns `{ success: false }` with an aborted
	 * error. It does NOT interrupt a stage already streaming (Pi owns the live
	 * session), so cancellation takes effect at the next stage boundary, not
	 * mid-stage.
	 */
	signal?: AbortSignal;
	/**
	 * Human-readable alias for this run. Stored in the JSONL header and the
	 * sidecar names.json index. Rejected if already in use — the error
	 * identifies the conflicting runId.
	 */
	name?: string;
}

export interface RunWorkflowResult {
	/**
	 * The run's identity on disk — the `<run-id>` portion of
	 * `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl`. Live consumers can hand
	 * this to `readLastStage` / `listArtifacts` / future inspect-past-run
	 * helpers without recomputing the slug.
	 *
	 * Undefined ONLY for pre-flight rejections (start stage not declared,
	 * continue-policy stages without pi) where no JSONL file was created.
	 */
	runId?: string;
	stagesCompleted: number;
	success: boolean;
	/**
	 * Primary artifact at run termination, serialised to its handle's
	 * canonical string form (fs → path, url → href, opaque → id). Undefined
	 * if no produces stage produced one. Callers that need the full
	 * structured handle read `output.artifacts[0]` off the run's last
	 * recorded stage (via `readLastStage`).
	 */
	lastArtifact?: string;
	error?: string;
	/**
	 * Routing decisions made in memory but whose JSONL audit row failed to
	 * persist. Empty in the common case. Surfaced so consumers reading the
	 * run's JSONL can disambiguate a missing routing row ("deterministic
	 * edge — never written") from a dropped one ("decision was made, write
	 * failed"). The run still succeeds — routing rows are telemetry, not
	 * reconstruction inputs.
	 */
	droppedRoutingRows?: Array<{ fromStageIndex: number; fromStage: string; decision: string }>;
}

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
	entry: () => Promise<void>,
): Promise<RunWorkflowResult> {
	await run.lifecycle.fire(ctx, "onWorkflowStart", lifecycleCtxFor(run));

	await entry();

	const { state } = run;
	const result: RunWorkflowResult = {
		runId: run.runId,
		stagesCompleted: state.stagesCompleted,
		success: state.termination.success,
		lastArtifact: (() => {
			const a = currentPrimaryArtifact(state);
			return a ? handleToString(a.handle) : undefined;
		})(),
		error: state.termination.error,
		...(state.telemetry.droppedRoutingRows.length > 0
			? { droppedRoutingRows: state.telemetry.droppedRoutingRows }
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

	writeHeader(cwd, {
		runId,
		workflow: workflow.name,
		input: options.input,
		ts: nowIso(),
		trigger,
		name: options.name,
	});

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

	const recon = reconstructState(cwd, workflow, header);
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

	return executeRun(ctx, run, selectResumeEntry(ctx, workflow, recon, run));
}

// ---------------------------------------------------------------------------
// Run-construction helpers (shared by runWorkflow + resumeWorkflow)
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

/** A pristine `RunState` for a brand-new run (resumes rebuild theirs via `reconstructState`). */
function freshRunState(originalInput: string): RunState {
	return {
		originalInput,
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [] },
		termination: { success: false, error: undefined },
	};
}

/**
 * Assemble the `RunContext` shared by both entry points. `identity` carries the
 * four fields that differ between a new run (fresh id/state/visited, caller
 * trigger) and a resume (same run id, reconstructed state/visited, resume
 * trigger); everything else derives identically from `options`.
 *
 * The skill-registry snapshot happens here, BEFORE any stage opens a fresh
 * session — Pi invalidates the `WorkflowHost` handle on the first
 * `ctx.newSession()`, so this is the only safe moment to enumerate. After this
 * the runner reads `run.registeredSkills`; `options.host` survives only on
 * `run.continueHost` for the continue-policy session handler.
 */
function buildRunContext(
	cwd: string,
	workflow: Workflow,
	options: {
		host?: WorkflowHost;
		maxBackwardJumps?: number;
		maxIterations?: number;
		lifecycle?: LifecycleListeners;
		signal?: AbortSignal;
	},
	identity: { runId: string; state: RunState; visited: Set<string>; trigger: RunTrigger },
): RunContext {
	return {
		cwd,
		runId: identity.runId,
		workflow,
		totalStages: countReachableStages(workflow),
		state: identity.state,
		visited: identity.visited,
		registeredSkills: options.host ? snapshotRegisteredSkills(options.host) : undefined,
		continueHost: options.host,
		maxBackwardJumps: options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS,
		maxIterations: options.maxIterations ?? MAX_ITERATIONS,
		trigger: identity.trigger,
		lifecycle: new LifecycleDispatcher(options.lifecycle),
		signal: options.signal,
	};
}

/**
 * Pick the chain re-entry thunk for a resumed run from its trail trailer:
 *   - decorated fanout-unit trailer → resume the fanout from the next unit
 *     (`resumeFanoutStage`);
 *   - decorated iterate-unit trailer → re-enter the pull loop at the next unit
 *     (`resumeIterateStage`) — catches BOTH a completed and a failed iterate-unit
 *     trailer, since a completed unit may still have remaining units to pull;
 *   - completed normal trailer → route onward (a finished run hits stop ⇒ no-op);
 *   - failed/aborted trailer → re-run that stage.
 *
 * A decorated unit row has a `stage` key absent from `workflow.stages` matching a
 * fanout/iterate parent — meaning the run died inside that stage. The
 * `workflow.stages[last.stage] === undefined` outer guard keeps normal trailers on
 * the binary arms; a normal trailer after a fully-completed fanout/iterate falls
 * through to them.
 */
function selectResumeEntry(
	ctx: WorkflowHostContext,
	workflow: Workflow,
	recon: Extract<ReconstructResult, { ok: true }>,
	run: RunContext,
): () => Promise<void> {
	const last = recon.rows[recon.rows.length - 1]!;
	const idx = last.stageNumber - 1; // status-line / routing index; JSONL number comes from the allocator

	if (workflow.stages[last.stage] === undefined) {
		const fanoutParent = matchFanoutParent(last.stage, fanoutStageNames(workflow));
		if (fanoutParent) {
			const fanoutDeps: FanoutDeps = {
				runFanoutSession,
				advanceAfter: (freshCtx, name, completedIdx, r) => advanceChain(freshCtx, name, completedIdx, r),
			};
			const completed = recon.fanoutProgress.get(fanoutParent) ?? [];
			return () => resumeFanoutStage(ctx, fanoutParent, idx, completed, run, fanoutDeps);
		}
		const iterateParent = matchFanoutParent(last.stage, iterateStageNames(workflow));
		if (iterateParent) {
			const iterateDeps: IterateDeps = {
				runStageSession,
				advanceAfter: (freshCtx, name, completedIdx, r) => advanceChain(freshCtx, name, completedIdx, r),
				captureSnapshot: (d, i, r) => captureStageSnapshot(d, i, r),
				haltIterations,
			};
			const point = recon.iterateProgress.get(iterateParent) ?? { entryArtifact: undefined, accumulated: [] };
			const pendingDecorated = last.status !== "completed" ? last.stage : undefined;
			return () => resumeIterateStage(ctx, iterateParent, idx, point, pendingDecorated, run, iterateDeps);
		}
	}

	if (last.status === "completed") {
		return () => advanceChain(ctx, last.stage, idx, run); // route onward; finished run ⇒ hits stop ⇒ no-op
	}
	return () => runStageOrRecordFailure(ctx, last.stage, idx, run); // re-run the failed/aborted stage
}

function resumeRefusalError(recon: Extract<ReconstructResult, { ok: false }>, workflow: string): string {
	switch (recon.reason) {
		case "no-rows":
			return ERR_RESUME_NO_ROWS(recon.detail);
		case "stage-gone":
			return ERR_RESUME_STAGE_GONE(recon.detail, workflow);
	}
}

/** Build a `LifecycleContext` from the current `RunContext`. Captured per fire so listeners always see the latest `state` snapshot. */
export function lifecycleCtxFor(run: RunContext) {
	return buildLifecycleContext({
		cwd: run.cwd,
		runId: run.runId,
		workflow: run.workflow.name,
		totalStages: run.totalStages,
		trigger: run.trigger,
		state: run.state,
	});
}

/**
 * Upper bound for the status-line denominator — BFS reach from `workflow.start`.
 *
 * Relies on every `EdgeFn` carrying `.targets`. `validate-workflow.ts` enforces
 * this at load time, so by the time the runner sees a workflow the contract
 * holds. A `.targets`-less EdgeFn here means validation was bypassed (test
 * fixture or programmatic embedder) — surface loudly instead of silently
 * counting all declared stages.
 */
function countReachableStages(workflow: Workflow): number {
	const seen = new Set<string>();
	const frontier: string[] = [workflow.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		const edge = workflow.edges[cur];
		if (edge === undefined || edge === "stop") continue;
		if (typeof edge === "string") {
			if (workflow.stages[edge] && !seen.has(edge)) frontier.push(edge);
		} else if (Array.isArray(edge.targets)) {
			for (const t of edge.targets) {
				if (t !== "stop" && workflow.stages[t] && !seen.has(t)) frontier.push(t);
			}
		} else {
			throw new Error(
				`countReachableStages: edge from "${cur}" is an EdgeFn without .targets — validateWorkflow should have rejected this workflow`,
			);
		}
	}
	return seen.size;
}

/**
 * Wraps `runStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by both `runWorkflow` (start stage) and `advanceChain` (next stage)
 * so there's exactly one place that translates "stage threw" →
 * `state.termination.error` + JSONL row. Without this, the start-stage call
 * leaves a header-only file and `advanceChain`'s own catch mis-attributes
 * the failure to the prior stage (`currentName` is still bound to the
 * iteration that just succeeded).
 *
 * Two flavours of throw are caught here:
 *
 * - `StagePreflightError` — a known preflight failure carrying its own
 *   attribution + messages. Recorded with the carried payload exactly.
 * - Any other `Error` — unexpected machinery failure; recorded with the
 *   generic `MSG_STAGE_THREW` shape attributed to the stage id.
 */
export async function runStageOrRecordFailure(
	curCtx: WorkflowHostContext,
	name: string,
	idx: number,
	run: RunContext,
): Promise<void> {
	// Cooperative cancellation seam. Checked before the start stage and before
	// every routed next stage (advanceChain funnels through here), so an aborted
	// signal stops the chain at the next stage boundary without interrupting a
	// stage already streaming. Records an "aborted" terminal row + halts.
	if (run.signal?.aborted) {
		await recordTerminalFailure(curCtx, auditCtxFor(run, name, name), {
			status: "aborted",
			notifyMsg: MSG_WORKFLOW_ABORTED,
			notifyLevel: "warning",
			errMsg: ERR_WORKFLOW_ABORTED(name),
		});
		return;
	}
	try {
		await runStage(curCtx, name, idx, run);
	} catch (e) {
		if (e instanceof StagePreflightError) {
			await recordTerminalFailure(
				curCtx,
				auditCtxFor(run, name, e.skill),
				{ status: "failed", notifyMsg: e.notifyMsg, notifyLevel: "error", errMsg: e.errMsg },
				e.notifyPartial ? (ctx) => notifyPartialArtifacts(ctx, run.cwd, run.runId) : undefined,
			);
			return;
		}
		const reason = e instanceof Error ? e.message : String(e);
		await recordTerminalFailure(curCtx, auditCtxFor(run, name, name), {
			status: "failed",
			notifyMsg: MSG_STAGE_THREW(name, reason),
			notifyLevel: "error",
			errMsg: reason,
		});
	}
}

export function finalizeWorkflow(curCtx: WorkflowHostContext, run: RunContext): void {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	run.state.termination.success = true;
}

/**
 * Build the `registeredSkills` snapshot consumed by `ensureSkillRegistered`.
 *
 * Pi prefixes skill-source commands with `"skill:"` (agent-session.js); we
 * strip the prefix so the set keys match `stage.skill` directly. Called
 * exactly once per run, before any `ctx.newSession()` opens (which is when
 * Pi marks the `WorkflowHost` handle stale).
 *
 * Non-skill commands (slash commands registered by extensions) are filtered
 * out — the preflight only cares about skills.
 */
function snapshotRegisteredSkills(host: WorkflowHost): ReadonlySet<string> {
	const skills = new Set<string>();
	for (const cmd of host.getCommands()) {
		if (cmd.source !== "skill") continue;
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		skills.add(name);
	}
	return skills;
}
