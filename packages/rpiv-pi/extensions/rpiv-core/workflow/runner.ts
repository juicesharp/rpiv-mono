/**
 * Workflow orchestration. `runWorkflow` walks a `Workflow`'s edge graph
 * stage-by-stage. Per-stage work (sessions, extraction, validation, audit
 * row writes) lives in sessions.ts + audit.ts; this file owns graph
 * traversal, per-stage prerequisites, and routing.
 *
 * Ctx lifecycle: every level only touches the ctx it was handed.
 * - `newSession({cancelled: false})` invalidates the outer ctx; all
 *   further work runs on `freshCtx` inside `withSession`, and the
 *   outer function simply unwinds.
 * - `cancelled: true` means no replacement happened — outer ctx remains valid.
 * - Continue policy has no newSession — same ctx throughout.
 *
 * Vocabulary: "stage" = one node activation in this run; "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NodeDef, Workflow } from "./api.js";
import { notifyPartialArtifacts, nowIso, recordStage } from "./audit.js";
import { clearChildSession, markChildSession } from "./child-session.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import {
	ERR_BACKWARD_JUMP_EXHAUSTED,
	ERR_INPUT_VALIDATION_FAILED,
	ERR_MISSING_ARTIFACT,
	MAX_BACKWARD_JUMPS,
	MSG_BACKWARD_JUMP_EXHAUSTED,
	MSG_INPUT_VALIDATION_FAILED,
	MSG_MISSING_ARTIFACT,
	MSG_WORKFLOW_COMPLETE,
	STATUS_KEY,
	STATUS_STAGE,
} from "./messages.js";
import { edgeIsDecision, nextNode } from "./routing.js";
import { runPhaseSession, runStageSession } from "./sessions.js";
import { appendRoutingDecision, generateRunId, writeHeader } from "./state.js";
import { readBranch } from "./transcript.js";
import type { ChainCtx, RunContext, RunState } from "./types.js";
import { validateManifestData } from "./validation.js";

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
	stagesCompleted: number;
	success: boolean;
	lastArtifact?: string;
	error?: string;
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

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = countReachableNodes(workflow);

	writeHeader(cwd, {
		runId,
		preset: workflow.name,
		input: options.input,
		ts: nowIso(),
	});

	const state: RunState = {
		originalInput: options.input,
		artifactPath: undefined,
		manifest: undefined,
		stagesCompleted: 0,
		lastStageNumber: 0,
		success: false,
		error: undefined,
		backwardJumps: 0,
	};

	const maxBackwardJumps = options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS;

	markChildSession();
	try {
		await runStage(ctx, workflow.start, 0, {
			cwd,
			runId,
			workflow,
			totalStages,
			state,
			visited: new Set(),
			pi: options.pi,
			maxBackwardJumps,
		});
	} finally {
		clearChildSession();
	}
	return {
		stagesCompleted: state.stagesCompleted,
		success: state.success,
		lastArtifact: state.artifactPath,
		error: state.error,
	};
}

/**
 * Upper bound for the status-line denominator — BFS reach from `workflow.start`.
 *
 * Relies on every `EdgeFn` carrying `.targets`. `validate.ts` enforces this at
 * load time, so by the time the runner sees a workflow the contract holds; if
 * a workflow with a `.targets`-less EdgeFn somehow reaches the runner anyway
 * (e.g. a test bypassed validation), we fall back to counting all declared
 * nodes — a strict upper bound that keeps the status line monotonic instead
 * of producing "5/3" garbage.
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
			// `.targets`-less EdgeFn slipped past validation — fall back to the
			// declared-nodes total so the status-line denominator stays a valid
			// upper bound (never undercounts).
			return Object.keys(workflow.nodes).length;
		}
	}
	return seen.size;
}

// ---------------------------------------------------------------------------
// runStage — per-stage orchestration
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
 * Top level reads as the stage lifecycle. Each named helper either does its
 * side effect and returns, or returns `false` to signal a halt — the caller
 * then short-circuits.
 */
async function runStage(curCtx: ChainCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const stage = resolveStageNode(currentName, idx, run);

	if (await tryPhaseFanout(curCtx, stage, idx, run)) return;
	if (!ensureUpstreamArtifact(curCtx, stage, currentName, run)) return;

	const isStart = currentName === run.workflow.start;
	const inputForStage = isStart ? run.state.originalInput : run.state.artifactPath!;
	const prompt = buildPrompt(stage.skill, inputForStage);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));

	enforceSessionInvariants(stage, currentName, run);
	const branchOffset = computeBranchOffset(curCtx, stage.node);

	if (!runStageInputValidation(curCtx, stage, run)) return;

	const snapshot = await captureStageSnapshot(stage.node, idx, run);

	await runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt,
		skill: stage.skill,
		node: stage.node,
		stageIndex: idx,
		snapshot,
		pi: run.pi,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, run.cwd, run.runId),
		onSuccess: (freshCtx) => advanceChain(freshCtx, currentName, idx, run),
	});
}

// ---------------------------------------------------------------------------
// runStage prerequisites
// ---------------------------------------------------------------------------

interface ResolvedStage {
	node: NodeDef;
	name: string;
	/** 1-based; for status line + audit row. */
	stageNumber: number;
	/** Label written to JSONL + the status line. */
	skill: string;
}

function finalizeWorkflow(curCtx: ChainCtx, run: RunContext): void {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	run.state.success = true;
}

function resolveStageNode(currentName: string, idx: number, run: RunContext): ResolvedStage {
	const node = run.workflow.nodes[currentName];
	if (!node) {
		// validateWorkflow should catch this; defensive for tests bypassing validation.
		throw new Error(`runStage: node "${currentName}" referenced by edges but missing from workflow.nodes`);
	}
	// `skill` defaults to the record key — the common case where node id and
	// Pi skill match doesn't restate the name at the call site.
	return { node, name: currentName, stageNumber: idx + 1, skill: node.skill ?? currentName };
}

/**
 * An implement skill against a plan with `## Phase N:` headings expands
 * into one session per phase. Keyed on the *resolved* skill body so aliased
 * implement nodes (implement-after-revise, etc.) fan out too — the alias
 * sets `node.skill = "implement"` while keeping a distinct node name for
 * routing. Returns true iff fanout fired — caller then returns without
 * running the single-stage path.
 */
async function tryPhaseFanout(curCtx: ChainCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<boolean> {
	if (!(stage.skill === "implement" && run.state.artifactPath)) return false;
	const phaseCount = countPhases(run.state.artifactPath, run.cwd);
	if (phaseCount === 0) return false;
	await runImplementPhases(curCtx, idx, stage.name, stage.skill, 1, phaseCount, run, {
		runPhaseSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advanceChain(freshCtx, name, completedIdx, ctx),
	});
	return true;
}

/**
 * The start node consumes the user's brief; subsequent stages MUST inherit
 * an upstream artifactPath. Falling back to originalInput past the start
 * would silently hand a downstream skill the raw feature description.
 */
function ensureUpstreamArtifact(curCtx: ChainCtx, stage: ResolvedStage, currentName: string, run: RunContext): boolean {
	if (currentName === run.workflow.start || run.state.artifactPath) return true;
	recordStage(run.cwd, run.runId, { skill: stage.skill, status: "failed", ts: nowIso() }, run.state);
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_MISSING_ARTIFACT(stage.skill), "error");
	notifyPartialArtifacts(curCtx, run.cwd, run.runId);
	run.state.error = ERR_MISSING_ARTIFACT(stage.skill, stage.stageNumber);
	return false;
}

function enforceSessionInvariants(stage: ResolvedStage, currentName: string, run: RunContext): void {
	if (stage.skill === "implement" && stage.node.sessionPolicy === "continue") {
		throw new Error(
			`runStage: implement node "${currentName}" cannot use sessionPolicy "continue" — ` +
				"phase fanout requires per-phase session isolation",
		);
	}
	if (stage.node.sessionPolicy === "continue" && !run.pi) {
		throw new Error(
			`runStage: node "${currentName}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`,
		);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: ChainCtx, node: NodeDef): number | undefined {
	if (node.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

function runStageInputValidation(curCtx: ChainCtx, stage: ResolvedStage, run: RunContext): boolean {
	if (!stage.node.inputSchema || run.state.manifest?.data === undefined) return true;
	const result = validateManifestData(stage.node.inputSchema, run.state.manifest.data);
	if (result.valid) return true;

	const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	const prevSkill = run.state.manifest.meta.skill || "unknown";
	recordStage(run.cwd, run.runId, { skill: stage.skill, status: "failed", ts: nowIso() }, run.state);
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_INPUT_VALIDATION_FAILED(stage.skill, prevSkill), "error");
	notifyPartialArtifacts(curCtx, run.cwd, run.runId);
	run.state.error = ERR_INPUT_VALIDATION_FAILED(stage.skill, prevSkill, failureSummary);
	return false;
}

async function captureStageSnapshot(node: NodeDef, idx: number, run: RunContext): Promise<unknown> {
	const before = node.extractor?.before;
	if (!before) return undefined;
	try {
		return await before({
			cwd: run.cwd,
			runId: run.runId,
			stageIndex: idx,
			state: run.state,
			pi: run.pi,
		});
	} catch {
		// Snapshot failure doesn't prevent stage execution.
		return undefined;
	}
}

/**
 * Routing layer after a successful stage: ask the workflow's edge for the
 * next node, audit non-trivial decisions (EdgeFn branches), enforce the
 * backward-jump guard, then recurse. Wraps the body in try/catch so an
 * EdgeFn throwing lands in `state.error` rather than bubbling out of
 * withSession.
 *
 * Backward-jump semantics: a "backward jump" is re-entering a node that
 * has already been executed in this run. Adding `currentName` to `visited`
 * BEFORE consulting `nextNode` means a self-edge (`currentName === nextName`)
 * counts from the first hop — which matches the spirit of "re-entry"; the
 * stage that just finished IS being re-entered.
 */
async function advanceChain(curCtx: ChainCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const { cwd, runId, workflow, state } = run;
	// Mark the just-completed node as visited BEFORE consulting the next edge.
	// A thrown EdgeFn would otherwise leave currentName un-marked, opening a
	// (narrow) window where a recovery path could under-count revisits.
	run.visited.add(currentName);
	try {
		const wasDecision = edgeIsDecision(workflow, currentName);
		const nextName = nextNode(workflow, currentName, { manifest: state.manifest, state });

		if (!nextName) {
			finalizeWorkflow(curCtx, run);
			return;
		}

		// Predicate-mediated transitions get audited; deterministic auto-edges
		// don't (no decision was made).
		if (wasDecision) {
			appendRoutingDecision(cwd, runId, {
				type: "routing",
				fromStage: idx + 1,
				fromNode: currentName,
				decision: nextName,
				ts: nowIso(),
			});
		}

		// Backward-jump guard: a re-entry into an already-executed node is
		// "backward". The revise → implement loop legitimately triggers this;
		// the cap stops unbounded loops.
		if (run.visited.has(nextName)) {
			state.backwardJumps++;
			if (state.backwardJumps > run.maxBackwardJumps) {
				curCtx.ui.setStatus(STATUS_KEY, undefined);
				curCtx.ui.notify(MSG_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps), "error");
				state.error = ERR_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps);
				return;
			}
		}

		await runStage(curCtx, nextName, idx + 1, run);
	} catch (e) {
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		state.error = e instanceof Error ? e.message : String(e);
	}
}
