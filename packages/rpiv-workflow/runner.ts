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
import { countPhases, runImplementPhases } from "./implement-phases.js";
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
		artifactPath: undefined,
		manifest: undefined,
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		success: false,
		error: undefined,
		backwardJumps: 0,
		droppedRoutingRows: [],
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
		success: state.success,
		lastArtifact: state.artifactPath,
		error: state.error,
		...(state.droppedRoutingRows.length > 0 ? { droppedRoutingRows: state.droppedRoutingRows } : {}),
	};
}

/**
 * Upper bound for the status-line denominator — BFS reach from `workflow.start`.
 *
 * Relies on every `EdgeFn` carrying `.targets`. `validate-workflow.ts` enforces this at
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
/**
 * Wraps `runStage` so a thrown stage records a JSONL failure row attributed
 * to the stage that actually threw — not to the prior stage in the chain.
 * Used by both `runWorkflow` (start node) and `advanceChain` (next node) so
 * there's exactly one place that translates "stage threw" → state.error +
 * JSONL row. Without this, the start-stage call leaves a header-only file
 * and `advanceChain`'s own catch mis-attributes the failure to the prior
 * stage (`currentName` is still bound to the iteration that just succeeded).
 *
 * `runStage` only throws for invariant/machinery failures (e.g.
 * `enforceSessionInvariants`); expected failures are recorded inside via
 * `recordStage` + `state.error` and return normally.
 */
async function runStageOrRecordFailure(curCtx: RunnerCtx, name: string, idx: number, run: RunContext): Promise<void> {
	try {
		await runStage(curCtx, name, idx, run);
	} catch (e) {
		const { cwd, runId, state } = run;
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		const reason = e instanceof Error ? e.message : String(e);
		recordStage(cwd, runId, { skill: name, status: "failed", ts: nowIso() }, state);
		curCtx.ui.notify(MSG_STAGE_THREW(name, reason), "error");
		state.error = reason;
	}
}

async function runStage(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const stage = resolveStageNode(currentName, idx, run);

	if (await tryPhaseFanout(curCtx, stage, idx, run)) return;
	if (!ensureUpstreamArtifact(curCtx, stage, currentName, run)) return;
	// Invariants (authoring-time-knowable, throw) fire before the registry
	// check (runtime-state, fail-soft halt). Ordering matters: an
	// implement+continue node should surface its structural violation
	// regardless of whether the runtime skill registry happens to recognise
	// the name.
	enforceSessionInvariants(stage, currentName, run);
	if (!ensureSkillRegistered(curCtx, stage, run)) return;

	const isStart = currentName === run.workflow.start;
	const inputForStage = isStart ? run.state.originalInput : run.state.artifactPath!;
	const prompt = buildPrompt(stage.skill, inputForStage);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));
	const branchOffset = computeBranchOffset(curCtx, stage.node);

	if (!ensureInputValid(curCtx, stage, run)) return;

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

function finalizeWorkflow(curCtx: RunnerCtx, run: RunContext): void {
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
async function tryPhaseFanout(curCtx: RunnerCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<boolean> {
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
function ensureSkillRegistered(curCtx: RunnerCtx, stage: ResolvedStage, run: RunContext): boolean {
	if (!run.pi) return true;

	const registered = new Set<string>();
	for (const cmd of run.pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		// Pi prefixes skill-source commands with "skill:" (agent-session.js:1699);
		// match args.ts:333's slice so the comparison key is the bare skill name.
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		registered.add(name);
	}
	if (registered.has(stage.skill)) return true;

	recordStage(run.cwd, run.runId, { skill: stage.skill, status: "failed", ts: nowIso() }, run.state);
	curCtx.ui.setStatus(STATUS_KEY, undefined);
	curCtx.ui.notify(MSG_SKILL_NOT_REGISTERED(stage.skill), "error");
	notifyPartialArtifacts(curCtx, run.cwd, run.runId);
	run.state.error = ERR_SKILL_NOT_REGISTERED(stage.skill, stage.stageNumber);
	return false;
}

/**
 * The start node consumes the user's brief; subsequent stages MUST inherit
 * an upstream artifactPath. Falling back to originalInput past the start
 * would silently hand a downstream skill the raw feature description.
 */
function ensureUpstreamArtifact(
	curCtx: RunnerCtx,
	stage: ResolvedStage,
	currentName: string,
	run: RunContext,
): boolean {
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
function computeBranchOffset(curCtx: RunnerCtx, node: NodeDef): number | undefined {
	if (node.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

function ensureInputValid(curCtx: RunnerCtx, stage: ResolvedStage, run: RunContext): boolean {
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
 * Backward-jump semantics: a "backward jump" is a *decision-edge* resolving
 * to an already-visited node — i.e. a deliberate retry choice. Deterministic
 * forward edges that pass through a cycle (the body of a multi-node loop)
 * are NOT counted, because they're consequences of the retry decision rather
 * than independent retry events. Without this distinction the cap would
 * trip mid-loop on any cycle longer than 2 nodes, burning the entire budget
 * on a single retry iteration's deterministic hops.
 *
 * Reset-on-escape: a decision resolving to a NOT-visited node escapes the
 * current cycle (we've moved to fresh territory), so the counter resets.
 * This gives each independent loop in a workflow its own retry budget
 * instead of a single global pool that drains across unrelated loops.
 *
 * Trip attribution targets `nextName` (the stage the guard refused to
 * re-enter), not `currentName` (which already completed successfully).
 * Same lesson as Q12+IB.
 */
async function advanceChain(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
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
		// don't (no decision was made). The decision itself has already been
		// taken by `nextNode` above — a dropped audit row degrades the trail
		// but does NOT invalidate the run, so on write failure we surface the
		// gap (live notify + result-envelope field) and continue. Halting here
		// would discard a correct in-memory decision to recover from transient
		// disk weather — the asymmetry with `recordStage` is deliberate (stage
		// rows are reconstruction inputs; routing rows are pure telemetry).
		if (wasDecision) {
			const fromStage = idx + 1;
			const wrote = appendRoutingDecision(cwd, runId, {
				type: "routing",
				fromStage,
				fromNode: currentName,
				decision: nextName,
				ts: nowIso(),
			});
			if (!wrote) {
				state.droppedRoutingRows.push({ fromStage, fromNode: currentName, decision: nextName });
				curCtx.ui.notify(MSG_ROUTING_AUDIT_DROPPED(currentName, nextName), "warning");
			}
		}

		// Backward-jump guard gated on `wasDecision` (see function docstring).
		// Deterministic edges through a cycle are not counted; the budget
		// applies per *decision* to retry. A decision escaping the cycle
		// (target not visited) resets the counter so each independent loop
		// gets its own budget.
		if (wasDecision) {
			if (run.visited.has(nextName)) {
				state.backwardJumps++;
				if (state.backwardJumps > run.maxBackwardJumps) {
					curCtx.ui.setStatus(STATUS_KEY, undefined);
					curCtx.ui.notify(MSG_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps), "error");
					// Attribute to nextName — the stage the guard refused to
					// re-enter. currentName already completed successfully.
					recordStage(cwd, runId, { skill: nextName, status: "failed", ts: nowIso() }, state);
					state.error = ERR_BACKWARD_JUMP_EXHAUSTED(state.backwardJumps, run.maxBackwardJumps);
					return;
				}
			} else {
				state.backwardJumps = 0;
			}
		}

		// runStageOrRecordFailure owns the catch for throws out of the *next* stage,
		// so the JSONL row records `nextName` (the stage that actually threw)
		// rather than `currentName` (which would mis-attribute the failure to
		// the prior stage that already completed successfully).
		await runStageOrRecordFailure(curCtx, nextName, idx + 1, run);
	} catch (e) {
		// Narrowed scope: only EdgeFn / routing-layer throws land here now —
		// next-stage throws are absorbed by runStageOrRecordFailure above. For this
		// remaining surface `currentName` IS the correct attribution: the
		// thrown predicate / edge function belongs to the just-completed
		// node's outgoing edge.
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		const reason = e instanceof Error ? e.message : String(e);
		recordStage(cwd, runId, { skill: currentName, status: "failed", ts: nowIso() }, state);
		curCtx.ui.notify(MSG_CHAIN_ADVANCE_FAILED(currentName, reason), "error");
		state.error = reason;
	}
}
