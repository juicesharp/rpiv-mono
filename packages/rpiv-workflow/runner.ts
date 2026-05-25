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
import { notifyPartialArtifacts, nowIso, recordTerminalFailure } from "./audit.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import { currentArtifactPath } from "./internal-utils.js";
import {
	ERR_BACKWARD_JUMP_EXHAUSTED,
	ERR_INPUT_VALIDATION_FAILED,
	ERR_MISSING_ARTIFACT,
	ERR_SKILL_NOT_REGISTERED,
	MSG_BACKWARD_JUMP_EXHAUSTED,
	MSG_CHAIN_ADVANCE_FAILED,
	MSG_INPUT_VALIDATION_FAILED,
	MSG_MISSING_ARTIFACT,
	MSG_ROUTING_AUDIT_DROPPED,
	MSG_SKILL_NOT_REGISTERED,
	MSG_STAGE_THREW,
	MSG_WORKFLOW_COMPLETE,
	STATUS_KEY,
	STATUS_STAGE,
} from "./messages.js";
import { edgeIsDecision, nextNode } from "./routing.js";
import { runPhaseSession, runStageSession } from "./sessions.js";
import { appendRoutingDecision, generateRunId, writeHeader } from "./state.js";
import { readBranch } from "./transcript.js";
import type { RunContext, RunnerCtx, RunState } from "./types.js";
import { validateManifestData } from "./validate-manifest.js";

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
/**
 * Wraps `runStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by both `runWorkflow` (start node) and `advanceChain` (next node) so
 * there's exactly one place that translates "stage threw" → state.termination.error +
 * JSONL row. Without this, the start-stage call leaves a header-only file
 * and `advanceChain`'s own catch mis-attributes the failure to the prior
 * stage (`currentName` is still bound to the iteration that just succeeded).
 *
 * Two flavours of throw are caught here:
 *
 * - `StagePreflightError` — a known preflight failure carrying its own
 *   attribution + messages. Recorded with the carried payload exactly.
 * - Any other `Error` — unexpected machinery failure; recorded with the
 *   generic `MSG_STAGE_THREW` shape attributed to the node id.
 */
async function runStageOrRecordFailure(curCtx: RunnerCtx, name: string, idx: number, run: RunContext): Promise<void> {
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

/**
 * Slot ordering (load-bearing):
 *
 *   1. tryPhaseFanout            — shortcut: implement-skill expansion handled
 *                                  the stage; subsequent slots skipped.
 *   2. PRE_PROMPT_CHECKS         — preflights that don't need prompt prep.
 *      a. ensureUpstreamArtifact — halt: missing inherited artifact.
 *      b. enforceSessionInvariants — invariant: authoring-time-knowable
 *         throws (precede the registry check so the structural violation
 *         surfaces regardless of the runtime registry).
 *      c. ensureSkillRegistered  — halt: skill not registered in Pi.
 *   3. prompt + status + branchOffset prep.
 *   4. POST_PROMPT_CHECKS        — preflights gated on prompt-prep state.
 *      a. ensureInputValid       — halt: upstream manifest fails inputSchema.
 *   5. captureStageSnapshot      — extractor.before hook (must run before
 *                                  the Pi session so post-stage diffs work).
 *
 * Each `PreflightCheck` throws `StagePreflightError` on failure;
 * `runStageOrRecordFailure` catches and records the JSONL row.
 */
async function runStage(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const stage = resolveStageNode(currentName, idx, run);

	if (await tryPhaseFanout(curCtx, stage, idx, run)) return;
	for (const check of PRE_PROMPT_CHECKS) check.run(stage, run);

	const isStart = currentName === run.workflow.start;
	const inputForStage = isStart ? run.state.originalInput : currentArtifactPath(run.state)!;
	const prompt = buildPrompt(stage.skill, inputForStage);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));
	const branchOffset = computeBranchOffset(curCtx, stage.node);

	for (const check of POST_PROMPT_CHECKS) check.run(stage, run);

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

/**
 * Thrown by a `PreflightCheck` on failure; carries the recorded-row
 * attribution + notify/err messages so `runStageOrRecordFailure` can land
 * a uniform JSONL row regardless of which slot tripped.
 *
 * `kind` annotates the violation class for diagnostics only — control
 * flow at the catch site is uniform:
 *   - `"halt"`     — runtime-state failure (skill not registered, missing
 *                    upstream artifact, schema mismatch).
 *   - `"invariant"` — authoring-time-knowable violation that
 *                    `validateWorkflow` should reject at load. A throw
 *                    here means validation was bypassed or the rule lives
 *                    only in the runner (continue-without-pi).
 */
class StagePreflightError extends Error {
	constructor(
		public readonly kind: "halt" | "invariant",
		public readonly skill: string,
		public readonly notifyMsg: string,
		public readonly errMsg: string,
		public readonly notifyPartial: boolean,
	) {
		super(errMsg);
		this.name = "StagePreflightError";
	}
}

interface PreflightCheck {
	name: string;
	kind: "halt" | "invariant";
	run(stage: ResolvedStage, run: RunContext): void;
}

const PRE_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureUpstreamArtifact", kind: "halt", run: ensureUpstreamArtifact },
	{ name: "enforceSessionInvariants", kind: "invariant", run: enforceSessionInvariants },
	{ name: "ensureSkillRegistered", kind: "halt", run: ensureSkillRegistered },
];

const POST_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureInputValid", kind: "halt", run: ensureInputValid },
];

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

function finalizeWorkflow(curCtx: RunnerCtx, run: RunContext): void {
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(run.state.stagesCompleted), "info");
	run.state.termination.success = true;
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
async function tryPhaseFanout(curCtx: RunnerCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<boolean> {
	const current = currentArtifactPath(run.state);
	if (!(stage.skill === "implement" && current)) return false;
	const phaseCount = countPhases(current, run.cwd);
	if (phaseCount === 0) return false;
	await runImplementPhases(curCtx, idx, stage.name, stage.skill, 1, phaseCount, run, {
		runPhaseSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advanceChain(freshCtx, name, completedIdx, ctx),
	});
	return true;
}

/**
 * Verify `stage.skill` resolves to a Pi-registered skill BEFORE the prompt
 * is dispatched. The workflow runner emits `/skill:<name>` text via
 * `sendUserMessage` (the programmatic path), which goes through
 * `prompt({expandPromptTemplates: false})` — meaning Pi's built-in
 * `_expandSkillCommand` is skipped and `rpiv-args` is the ONLY expander.
 * If the skill isn't registered, `rpiv-args` returns `{action:"continue"}`
 * and the raw `/skill:<name> …` text reaches the LLM as a bare user-message
 * imperative outside the `<skill>...</skill>` contract — silent LLM-prompt
 * corruption with no diagnostic. Catching it here turns that silent failure
 * into a properly-attributed stage halt.
 *
 * `pi` is optional on `RunWorkflowOptions`; when absent we skip the check
 * (we have no command registry to consult). Programmatic callers that opt
 * out of pi opt out of this defense too — same fail-soft posture the rest
 * of the pi-optional surface uses.
 */
function ensureSkillRegistered(stage: ResolvedStage, run: RunContext): void {
	if (!run.pi) return;

	const registered = new Set<string>();
	for (const cmd of run.pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		// Pi prefixes skill-source commands with "skill:" (agent-session.js:1699);
		// match args.ts:333's slice so the comparison key is the bare skill name.
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		registered.add(name);
	}
	if (registered.has(stage.skill)) return;

	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_SKILL_NOT_REGISTERED(stage.skill),
		ERR_SKILL_NOT_REGISTERED(stage.skill, stage.stageNumber),
		true,
	);
}

/**
 * The start node consumes the user's brief; subsequent stages MUST inherit
 * an upstream artifactPath. Falling back to originalInput past the start
 * would silently hand a downstream skill the raw feature description.
 */
function ensureUpstreamArtifact(stage: ResolvedStage, run: RunContext): void {
	if (stage.name === run.workflow.start || currentArtifactPath(run.state)) return;
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_MISSING_ARTIFACT(stage.skill),
		ERR_MISSING_ARTIFACT(stage.skill, stage.stageNumber),
		true,
	);
}

function enforceSessionInvariants(stage: ResolvedStage, run: RunContext): void {
	if (stage.skill === "implement" && stage.node.sessionPolicy === "continue") {
		const reason =
			`runStage: implement node "${stage.name}" cannot use sessionPolicy "continue" — ` +
			"phase fanout requires per-phase session isolation";
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
	if (stage.node.sessionPolicy === "continue" && !run.pi) {
		const reason = `runStage: node "${stage.name}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`;
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: RunnerCtx, node: NodeDef): number | undefined {
	if (node.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

function ensureInputValid(stage: ResolvedStage, run: RunContext): void {
	if (!stage.node.inputSchema || run.state.manifest?.data === undefined) return;
	const result = validateManifestData(stage.node.inputSchema, run.state.manifest.data);
	if (result.valid) return;

	const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	const prevSkill = run.state.manifest.meta.skill || "unknown";
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_INPUT_VALIDATION_FAILED(stage.skill, prevSkill),
		ERR_INPUT_VALIDATION_FAILED(stage.skill, prevSkill, failureSummary),
		true,
	);
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
 * next node, audit non-trivial decisions, enforce the backward-jump guard,
 * then recurse. Switches on the `RoutingResult` kind from `nextNode` —
 * `"err"` routes through `recordTerminalFailure`, `"stop"` finalizes,
 * `"next"` advances.
 *
 * No try/catch wrap: `nextNode` returns errors instead of throwing
 * (post-Phase 5.B), and `runStageOrRecordFailure` owns its own catch for
 * downstream-stage throws.
 *
 * Decomposed into three helpers (L5-05): `auditRoutingDecision`,
 * `checkBackwardJumpGuard`, `haltOnRoutingError`. Each owns one
 * structural concern.
 */
async function advanceChain(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	// Mark the just-completed node as visited BEFORE consulting the next edge.
	// A thrown EdgeFn would otherwise leave currentName un-marked, opening a
	// (narrow) window where a recovery path could under-count revisits.
	run.visited.add(currentName);

	const wasDecision = edgeIsDecision(run.workflow, currentName);
	const result = nextNode(run.workflow, currentName, { manifest: run.state.manifest, state: run.state });

	if (result.kind === "err") {
		haltOnRoutingError(curCtx, run, currentName, result.reason);
		return;
	}
	if (result.kind === "stop") {
		finalizeWorkflow(curCtx, run);
		return;
	}

	const nextName = result.node;
	if (wasDecision) {
		auditRoutingDecision(curCtx, run, idx, currentName, nextName);
		if (!checkBackwardJumpGuard(curCtx, run, nextName)) return;
	}

	// runStageOrRecordFailure owns the catch for throws out of the *next* stage,
	// so the JSONL row records `nextName` (the stage that actually threw)
	// rather than `currentName` (which would mis-attribute the failure to
	// the prior stage that already completed successfully).
	await runStageOrRecordFailure(curCtx, nextName, idx + 1, run);
}

/**
 * Persist a routing-decision audit row for a predicate-mediated transition.
 * Deterministic auto-edges aren't audited (no decision was made).
 *
 * A dropped audit row degrades the trail but does NOT invalidate the run;
 * on write failure we surface the gap (live notify + result-envelope
 * field) and continue. Halting here would discard a correct in-memory
 * decision to recover from transient disk weather — the asymmetry with
 * `recordStage` is deliberate (stage rows are reconstruction inputs;
 * routing rows are pure telemetry).
 */
function auditRoutingDecision(
	curCtx: RunnerCtx,
	run: RunContext,
	idx: number,
	currentName: string,
	nextName: string,
): void {
	const fromStage = idx + 1;
	const wrote = appendRoutingDecision(run.cwd, run.runId, {
		type: "routing",
		fromStage,
		fromNode: currentName,
		decision: nextName,
		ts: nowIso(),
	});
	if (!wrote) {
		run.state.telemetry.droppedRoutingRows.push({ fromStage, fromNode: currentName, decision: nextName });
		curCtx.ui.notify(MSG_ROUTING_AUDIT_DROPPED(currentName, nextName), "warning");
	}
}

/**
 * Per-loop cap on decision-edge retries. Returns `true` when the run may
 * continue, `false` when the cap tripped (and the terminal failure has
 * been recorded).
 *
 * A "backward jump" is a *decision-edge* resolving to an already-visited
 * node — i.e. a deliberate retry choice. Deterministic forward edges that
 * pass through a cycle (the body of a multi-node loop) are NOT counted,
 * because they're consequences of the retry decision rather than
 * independent retry events. Without this distinction the cap would trip
 * mid-loop on any cycle longer than 2 nodes, burning the entire budget
 * on a single retry iteration's deterministic hops.
 *
 * Reset-on-escape: a decision resolving to a NOT-visited node escapes the
 * current cycle (we've moved to fresh territory), so the counter resets.
 * Each independent loop gets its own retry budget instead of a single
 * global pool that drains across unrelated loops.
 *
 * Trip attribution targets `nextName` (the stage the guard refused to
 * re-enter), not the just-completed stage. Same lesson as Q12+IB.
 */
function checkBackwardJumpGuard(curCtx: RunnerCtx, run: RunContext, nextName: string): boolean {
	const { state } = run;
	if (!run.visited.has(nextName)) {
		state.telemetry.backwardJumps = 0;
		return true;
	}
	state.telemetry.backwardJumps++;
	if (state.telemetry.backwardJumps <= run.maxBackwardJumps) return true;
	recordTerminalFailure(
		curCtx,
		{ cwd: run.cwd, runId: run.runId, state, skill: nextName },
		{
			status: "failed",
			notifyMsg: MSG_BACKWARD_JUMP_EXHAUSTED(state.telemetry.backwardJumps, run.maxBackwardJumps),
			notifyLevel: "error",
			errMsg: ERR_BACKWARD_JUMP_EXHAUSTED(state.telemetry.backwardJumps, run.maxBackwardJumps),
		},
	);
	return false;
}

/**
 * Halt the chain on a routing-layer error result (e.g. the EdgeFn returned
 * an undeclared target, or threw and was wrapped). Attribution targets
 * `currentName` (the edge belongs to the just-completed node).
 */
function haltOnRoutingError(curCtx: RunnerCtx, run: RunContext, currentName: string, reason: string): void {
	recordTerminalFailure(
		curCtx,
		{ cwd: run.cwd, runId: run.runId, state: run.state, skill: currentName },
		{
			status: "failed",
			notifyMsg: MSG_CHAIN_ADVANCE_FAILED(currentName, reason),
			notifyLevel: "error",
			errMsg: reason,
		},
	);
}
