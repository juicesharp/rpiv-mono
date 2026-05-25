/**
 * Workflow orchestration entry point. `runWorkflow` walks a `Workflow`'s
 * edge graph stage-by-stage; per-stage work (sessions, extraction,
 * validation, audit row writes) lives in sessions.ts + audit.ts. This
 * directory owns graph traversal, per-stage prerequisites, and routing.
 *
 * Modules:
 *  - runner.ts          — runWorkflow + countReachableNodes +
 *                         runStageOrRecordFailure + finalizeWorkflow.
 *  - stage-lifecycle.ts — runStage + StagePreflightError + preflight
 *                         pipeline + outcome.baseline hook.
 *  - chain-advance.ts   — advanceChain + routing audit + backward-jump
 *                         guard + halt-on-error.
 *
 * Ctx lifecycle: every level only touches the ctx it was handed.
 * - `newSession({cancelled: false})` invalidates the outer ctx; all
 *   further work runs on `freshCtx` inside `withSession`, and the
 *   outer function simply unwinds.
 * - `cancelled: true` means no replacement happened — outer ctx remains
 *   valid.
 * - Continue policy has no newSession — same ctx throughout.
 *
 * Vocabulary: "stage" = one node activation in this run; "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../api.js";
import { notifyPartialArtifacts, nowIso, recordTerminalFailure } from "../audit.js";
import { currentArtifactPath } from "../internal-utils.js";
import { MSG_STAGE_THREW, MSG_WORKFLOW_COMPLETE, STATUS_KEY } from "../messages.js";
import { generateRunId, writeHeader } from "../state/index.js";
import type { RunContext, RunnerCtx, RunState } from "../types.js";
import { runStage, StagePreflightError } from "./stage-lifecycle.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Per-loop cap on decision-edge retries. A "backward jump" is a *decision*
 * resolving to an already-visited node — i.e. the user's predicate chose to
 * retry. Deterministic edges through a cycle (the loop body) are NOT
 * counted; the budget is per retry iteration, not per hop. A decision
 * escaping the loop (target not visited) resets the counter so each
 * independent loop in the workflow gets its own fresh budget. With 2: the
 * loop runs once unconditionally and may retry up to 2 more times.
 */
export const MAX_BACKWARD_JUMPS = 2;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
	/** Workflow to execute — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Passed to the start node as its argument. */
	input: string;
	/** Required for "continue"-policy stages (pi.sendUserMessage). */
	pi?: ExtensionAPI;
	/** Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
}

export interface RunWorkflowResult {
	/**
	 * The run's identity on disk — the `<run-id>` portion of
	 * `<cwd>/.rpiv/workflows/<run-id>.jsonl`. Live consumers can hand
	 * this to `readLastStage` / `listArtifacts` / future inspect-past-run
	 * helpers without recomputing the slug.
	 *
	 * Undefined ONLY for pre-flight rejections (start node not declared,
	 * continue-policy nodes without pi) where no JSONL file was created.
	 */
	runId?: string;
	stagesCompleted: number;
	success: boolean;
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
	droppedRoutingRows?: Array<{ fromStage: number; fromNode: string; decision: string }>;
}

// ---------------------------------------------------------------------------
// runWorkflow — workflow entry point
// ---------------------------------------------------------------------------

/**
 * Each subsequent `newSession()` is invoked on the freshCtx returned by the
 * previous withSession — never on a captured outer ctx (which Pi invalidates
 * as soon as the session is replaced).
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
	const { workflow } = options;
	if (!workflow.nodes[workflow.start]) {
		return {
			stagesCompleted: 0,
			success: false,
			error: `Workflow "${workflow.name}" start node "${workflow.start}" is not declared`,
		};
	}

	// Continue-policy stages thread the prior session via Pi's ExtensionAPI; if no
	// pi was passed, enforceSessionInvariants would throw at the first such stage.
	// Reject at workflow entry so embedders get a clean envelope instead of a throw.
	if (options.pi === undefined && Object.values(workflow.nodes).some((n) => n.sessionPolicy === "continue")) {
		return {
			stagesCompleted: 0,
			success: false,
			error: "workflow contains continue-policy nodes which require pi (ExtensionAPI)",
		};
	}

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = countReachableNodes(workflow);

	writeHeader(cwd, {
		runId,
		workflow: workflow.name,
		input: options.input,
		ts: nowIso(),
	});

	const state: RunState = {
		originalInput: options.input,
		fallbackArtifactPath: undefined,
		manifest: undefined,
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: {
			backwardJumps: 0,
			droppedRoutingRows: [],
		},
		termination: {
			success: false,
			error: undefined,
		},
	};

	const maxBackwardJumps = options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS;

	// runStageOrRecordFailure (not bare runStage) so a throw out of the start node —
	// notably enforceSessionInvariants violations — records a JSONL failure
	// row keyed on the failing stage rather than leaving a header-only file
	// that every shape-filtered reader skips. Same wrapper used by
	// advanceChain for downstream stages.
	await runStageOrRecordFailure(ctx, workflow.start, 0, {
		cwd,
		runId,
		workflow,
		totalStages,
		state,
		visited: new Set(),
		pi: options.pi,
		maxBackwardJumps,
	});
	return {
		runId,
		stagesCompleted: state.stagesCompleted,
		success: state.termination.success,
		lastArtifact: currentArtifactPath(state),
		error: state.termination.error,
		...(state.telemetry.droppedRoutingRows.length > 0
			? { droppedRoutingRows: state.telemetry.droppedRoutingRows }
			: {}),
	};
}

/**
 * Upper bound for the status-line denominator — BFS reach from `workflow.start`.
 *
 * Relies on every `EdgeFn` carrying `.targets`. `validate-workflow.ts` enforces
 * this at load time, so by the time the runner sees a workflow the contract
 * holds. A `.targets`-less EdgeFn here means validation was bypassed (test
 * fixture or programmatic embedder) — surface loudly instead of silently
 * counting all declared nodes.
 */
function countReachableNodes(workflow: Workflow): number {
	const seen = new Set<string>();
	const frontier: string[] = [workflow.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		const edge = workflow.edges[cur];
		if (edge === undefined || edge === "stop") continue;
		if (typeof edge === "string") {
			if (workflow.nodes[edge] && !seen.has(edge)) frontier.push(edge);
		} else if (Array.isArray(edge.targets)) {
			for (const t of edge.targets) {
				if (t !== "stop" && workflow.nodes[t] && !seen.has(t)) frontier.push(t);
			}
		} else {
			throw new Error(
				`countReachableNodes: edge from "${cur}" is an EdgeFn without .targets — validateWorkflow should have rejected this workflow`,
			);
		}
	}
	return seen.size;
}

/**
 * Wraps `runStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by both `runWorkflow` (start node) and `advanceChain` (next node)
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
 *   generic `MSG_STAGE_THREW` shape attributed to the node id.
 */
export async function runStageOrRecordFailure(
	curCtx: RunnerCtx,
	name: string,
	idx: number,
	run: RunContext,
): Promise<void> {
	try {
		await runStage(curCtx, name, idx, run);
	} catch (e) {
		if (e instanceof StagePreflightError) {
			recordTerminalFailure(
				curCtx,
				{ cwd: run.cwd, runId: run.runId, state: run.state, skill: e.skill },
				{ status: "failed", notifyMsg: e.notifyMsg, notifyLevel: "error", errMsg: e.errMsg },
				e.notifyPartial ? (ctx) => notifyPartialArtifacts(ctx, run.cwd, run.runId) : undefined,
			);
			return;
		}
		const reason = e instanceof Error ? e.message : String(e);
		recordTerminalFailure(
			curCtx,
			{ cwd: run.cwd, runId: run.runId, state: run.state, skill: name },
			{ status: "failed", notifyMsg: MSG_STAGE_THREW(name, reason), notifyLevel: "error", errMsg: reason },
		);
	}
}

export function finalizeWorkflow(curCtx: RunnerCtx, run: RunContext): void {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	run.state.termination.success = true;
}
