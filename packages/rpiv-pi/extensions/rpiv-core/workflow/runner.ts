/**
 * Workflow orchestration. `runWorkflow` resolves a preset and recursively
 * drives `runStage` through it. Per-stage work (sessions, extraction,
 * validation, audit row writes) lives in sessions.ts + audit.ts; this
 * file only owns preset traversal, per-stage prerequisites, and routing.
 *
 * Ctx lifecycle: every level only touches the ctx it was handed.
 * - `newSession({cancelled: false})` invalidates the outer ctx; all
 *   further work runs on `freshCtx` inside `withSession`, and the
 *   outer function simply unwinds.
 * - `cancelled: true` means no replacement happened — outer ctx remains valid.
 * - Continue policy has no newSession — same ctx throughout.
 *
 * Vocabulary: "stage" = one preset position (a DAG node); "phase" = one
 * `## Phase N:` subdivision inside an implement plan artifact.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyPartialArtifacts, nowIso, recordStage } from "./audit.js";
import { clearChildSession, markChildSession } from "./child-session.js";
import type { DagNode, WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import type { Manifest } from "./manifest.js";
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
import { resolveNextStageId } from "./routing.js";
import { runPhaseSession, runStageSession } from "./sessions.js";
import { appendRoutingDecision, generateRunId, writeHeader } from "./state.js";
import { readBranch } from "./transcript.js";
import type { ChainCtx, RunContext } from "./types.js";
import { validateManifestData } from "./validation.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
	preset: string;
	/** Passed to the first skill as its argument. */
	input: string;
	dag?: WorkflowDag;
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
	const dag = options.dag ?? WORKFLOW_DAG;
	const stageIds = dag.presets[options.preset];
	if (!stageIds || stageIds.length === 0) {
		return { stagesCompleted: 0, success: false, error: `Unknown preset: ${options.preset}` };
	}

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = stageIds.length;

	writeHeader(cwd, {
		runId,
		preset: options.preset,
		input: options.input,
		ts: nowIso(),
	});

	// Closed-over by the chain; per-level closures mutate while their ctx is
	// still valid. `artifactPath` starts undefined so countPhases is never
	// handed raw user text masquerading as a file path.
	const state = {
		originalInput: options.input,
		artifactPath: undefined as string | undefined,
		manifest: undefined as Manifest | undefined,
		stagesCompleted: 0,
		lastStageNumber: 0,
		success: false,
		error: undefined as string | undefined,
		backwardJumps: 0,
	};

	const maxBackwardJumps = options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS;

	// Inner stages fire session_start; the marker tells session-hooks +
	// advisor to suppress the cosmetic banner. Cleared in `finally` so a
	// thrown stage doesn't strand the flag.
	markChildSession();
	try {
		await runStage(ctx, 0, { cwd, runId, dag, stageIds, totalStages, state, pi: options.pi, maxBackwardJumps });
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

// ---------------------------------------------------------------------------
// runStage — per-stage orchestration
// ---------------------------------------------------------------------------

/**
 * Builds the `/skill:<name> <args>` line sent into the session. The audit
 * label (which used to round-trip through here) is read off `stage.skill`
 * by the caller — single source.
 *
 * Default arm runtime-throws instead of `assertNever(node)` because DagNode
 * is currently a union of one — TS won't narrow to never. Drop the cast +
 * use assertNever once a second variant lands.
 */
function buildPrompt(node: DagNode, inputForStage: string): string {
	switch (node.kind) {
		case "skill":
			return `/skill:${node.skill} ${inputForStage}`;
		default: {
			const unknownKind = (node as { kind?: unknown }).kind;
			throw new Error(`runStage: unsupported node kind: ${String(unknownKind)}`);
		}
	}
}

/**
 * Top level reads as the stage lifecycle. Each named helper either does its
 * side effect and returns, or returns `false` to signal a halt — the caller
 * then short-circuits. Helpers are unit-testable in isolation.
 */
async function runStage(curCtx: ChainCtx, idx: number, run: RunContext): Promise<void> {
	if (idx >= run.stageIds.length) return finalizeWorkflow(curCtx, run);

	const stage = resolveStageNode(idx, run);

	if (await tryPhaseFanout(curCtx, stage.node, idx, run)) return;
	if (!ensureUpstreamArtifact(curCtx, stage, idx, run)) return;

	const inputForStage = idx === 0 ? run.state.originalInput : run.state.artifactPath!;
	const prompt = buildPrompt(stage.node, inputForStage);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));

	enforceSessionInvariants(stage, run);
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
		onSuccess: (freshCtx) => advanceChain(freshCtx, idx, stage.id, run),
	});
}

// ---------------------------------------------------------------------------
// runStage prerequisites — one helper per phase, top of runStage reads as a list
// ---------------------------------------------------------------------------

interface ResolvedStage {
	node: DagNode;
	id: string;
	/** 1-based; for status line + audit row. */
	stageNumber: number;
	/**
	 * Value written to the JSONL "skill" field and the status line —
	 * `node.skill` for skill nodes, the node id for kinds that don't carry
	 * a skill. Matches `StageSession.skill` / `PhaseSession.skill`.
	 */
	skill: string;
}

function finalizeWorkflow(curCtx: ChainCtx, run: RunContext): void {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	run.state.success = true;
}

function resolveStageNode(idx: number, run: RunContext): ResolvedStage {
	const id = run.stageIds[idx]!;
	const node = run.dag.nodes[id];
	if (!node) {
		// validateDag should catch this; defensive for tests that bypass validation.
		throw new Error(`runStage: node id "${id}" referenced by preset but missing from dag.nodes`);
	}
	const skill = node.kind === "skill" ? node.skill : id;
	return { node, id, stageNumber: idx + 1, skill };
}

/**
 * An implement skill against a plan with `## Phase N:` headings expands into
 * one session per phase. Keyed on node.skill so aliased implement nodes
 * (implement-after-revise, etc.) fan out too. Returns true iff fanout fired
 * (caller should then return without running the single-stage path).
 */
async function tryPhaseFanout(curCtx: ChainCtx, node: DagNode, idx: number, run: RunContext): Promise<boolean> {
	if (!(node.kind === "skill" && node.skill === "implement" && run.state.artifactPath)) return false;
	const phaseCount = countPhases(run.state.artifactPath, run.cwd);
	if (phaseCount === 0) return false;
	await runImplementPhases(curCtx, idx, node.skill, 1, phaseCount, run, {
		runPhaseSession,
		runNextStage: runStage,
	});
	return true;
}

/**
 * First stage consumes the user's brief; later stages MUST inherit an
 * upstream artifactPath. Falling back to originalInput past idx 0 would
 * silently hand a downstream skill the raw feature description.
 */
function ensureUpstreamArtifact(curCtx: ChainCtx, stage: ResolvedStage, idx: number, run: RunContext): boolean {
	if (idx === 0 || run.state.artifactPath) return true;
	recordStage(run.cwd, run.runId, { skill: stage.skill, status: "failed", ts: nowIso() }, run.state);
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_MISSING_ARTIFACT(stage.skill), "error");
	notifyPartialArtifacts(curCtx, run.cwd, run.runId);
	run.state.error = ERR_MISSING_ARTIFACT(stage.skill, stage.stageNumber);
	return false;
}

function enforceSessionInvariants(stage: ResolvedStage, run: RunContext): void {
	const { node, id } = stage;
	if (node.kind === "skill" && node.skill === "implement" && node.sessionPolicy === "continue") {
		throw new Error(
			`runStage: implement node "${id}" cannot use sessionPolicy "continue" — ` +
				"phase fanout requires per-phase session isolation",
		);
	}
	if (node.sessionPolicy === "continue" && !run.pi) {
		throw new Error(
			`runStage: node "${id}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`,
		);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: ChainCtx, node: DagNode): number | undefined {
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

async function captureStageSnapshot(node: DagNode, idx: number, run: RunContext): Promise<unknown> {
	if (!node.snapshot) return undefined;
	try {
		return await node.snapshot({
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
 * Routing layer after a successful stage: pick the next stage id, audit
 * non-linear decisions, enforce the backward-jump guard, then recurse.
 * Wraps the body in try/catch so an invariant violation (e.g.
 * resolveNextStageId throwing on a predicate misroute) lands in
 * `state.error` rather than bubbling out of withSession.
 */
async function advanceChain(curCtx: ChainCtx, idx: number, id: string, run: RunContext): Promise<void> {
	const { cwd, runId, dag, stageIds, state } = run;
	try {
		const nextId = resolveNextStageId(dag, id, stageIds, idx, state);
		if (!nextId) {
			curCtx.ui.setStatus(STATUS_KEY, undefined);
			curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
			state.success = true;
			return;
		}
		const nextIdx = stageIds.indexOf(nextId);
		if (nextIdx < 0) throw new Error(`resolveNextStageId returned "${nextId}" not in preset`);

		// Audit only non-linear routing decisions.
		const linearNext = stageIds[idx + 1];
		if (nextId !== linearNext) {
			appendRoutingDecision(cwd, runId, {
				type: "routing",
				fromStage: idx + 1,
				fromNode: id,
				decision: nextId,
				ts: nowIso(),
			});
		}

		// Backward-jump guard: stage already recorded "completed"; halt at the
		// routing layer via state.error + absence of subsequent rows.
		if (nextIdx <= idx) {
			state.backwardJumps++;
			if (state.backwardJumps > run.maxBackwardJumps) {
				curCtx.ui.setStatus(STATUS_KEY, undefined);
				curCtx.ui.notify(MSG_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps), "error");
				state.error = ERR_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps);
				return;
			}
		}

		await runStage(curCtx, nextIdx, run);
	} catch (e) {
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		state.error = e instanceof Error ? e.message : String(e);
	}
}
