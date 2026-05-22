/**
 * Iterative session runner for the /rpiv workflow command.
 *
 * One `ctx.newSession()` per DAG node (one "stage" in the preset sequence).
 * Inside `withSession`, sends a single `freshCtx.sendUserMessage()` which
 * awaits the full agent loop. Extracts the artifact path from the session
 * branch after completion. The next stage's `newSession()` is then invoked
 * **on freshCtx** — never on the outer ctx, which is invalidated by Pi the
 * moment a session is replaced.
 *
 * Each level of the chain only ever touches the ctx it was handed:
 *   - On `cancelled === true` no replacement happened — the level's curCtx
 *     is still valid for the final notify/append.
 *   - On `cancelled === false` curCtx is stale after newSession returns; all
 *     further work was already performed inside the withSession callback on
 *     freshCtx, and the function simply unwinds.
 *
 * The session-spawn body itself lives in `executeSession` — runStage and
 * runImplementPhases are thin shells that build the prompt + labels for it.
 *
 * Vocabulary:
 *   - "stage" = one position in a preset's node sequence (a DAG node).
 *   - "phase" = one `## Phase N:` subdivision *inside an implement plan
 *     artifact* — only meaningful for the `implement` stage.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearChildSession, markChildSession } from "./child-session.js";
import type { DagNode, WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import { appendStage, generateRunId, readAllStages, type WorkflowStage, writeHeader } from "./state.js";
import { type BranchEntry, extractArtifactPath, hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";
import type { ChainCtx, ExecuteSessionParams, RunContext } from "./types.js";

// Re-export so existing imports of `extractArtifactPath` and `countPhases`
// from "./runner.js" keep working — production callers and tests both rely
// on this surface.
export { countPhases } from "./implement-phases.js";
export { extractArtifactPath } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface RunWorkflowOptions {
	/** Preset name (resolved to a linear sequence). */
	preset: string;
	/** User's input text — passed as argument to the first skill. */
	input: string;
	/** The DAG to traverse. Defaults to WORKFLOW_DAG. */
	dag?: WorkflowDag;
}

/** Result of a completed workflow run. */
export interface RunWorkflowResult {
	/** Total number of stages completed. */
	stagesCompleted: number;
	/** Whether the workflow completed all stages successfully. */
	success: boolean;
	/** The last artifact path produced, if any. */
	lastArtifact?: string;
	/** Error message if the workflow stopped due to failure. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

// Persistent status-line state — written via ctx.ui.setStatus, cleared at the
// end of every workflow regardless of outcome. Pi's `notify` is a one-shot
// channel that the `newSession` transition repaints away (see
// session-hooks.ts:120/127 for the canonical setStatus pattern in rpiv-core).
const STATUS_KEY = "rpiv-workflow";

const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

// One-shot announcements via `ui.notify` — best-effort visibility; some may be
// repainted by Pi's session transition, but the persistent status line above
// guarantees the user always knows where the workflow currently is.
const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;

const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;

const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;

const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;

const MSG_STAGE_NO_ARTIFACT = (skill: string) => `✗ ${skill} produced no artifact — stopping workflow`;

const ERR_STAGE_NO_ARTIFACT = (skill: string) =>
	`${skill} finished without producing a .rpiv/artifacts/... path — workflow stages must write an artifact for the chain to continue. ` +
	`Most likely the agent asked a plain-text clarifying question (use the ask_user_question tool instead) or stopped before reaching the artifact-write step.`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/**
 * Run a workflow: iterate through a preset's skill sequence, creating a new
 * session for each stage, extracting artifact paths, and advancing.
 *
 * The chain is structured so that each subsequent `newSession()` is invoked
 * on the freshCtx returned from the previous withSession — never on a captured
 * outer ctx (which Pi invalidates as soon as the session is replaced).
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

	// Mutable state closed-over by the chain. Per-level closures update these
	// while their ctx is still valid; the top-level await returns the snapshot.
	// `originalInput` is frozen — the user's `/rpiv` argument. `artifactPath`
	// starts undefined and only takes a value once a stage actually produces a
	// `.rpiv/artifacts/...` path, so `countPhases` is never handed raw user
	// text masquerading as a file path.
	const state = {
		originalInput: options.input,
		artifactPath: undefined as string | undefined,
		stagesCompleted: 0,
		jsonlStage: 0,
		success: false,
		error: undefined as string | undefined,
	};

	// Mark every session_start fired by an inner stage as a "child" of this
	// workflow so handlers in rpiv-core and rpiv-advisor can suppress the
	// cosmetic banner that the parent session already printed. Cleared in a
	// finally so a thrown stage doesn't strand the flag.
	markChildSession();
	try {
		await runStage(ctx, 0, { cwd, runId, dag, stageIds, totalStages, state });
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
 * Record a stage on disk and bump the in-memory counter only on a successful
 * write — keeps stage numbers in the JSONL file contiguous even if a write
 * silently fails (see `appendStage`'s boolean return).
 */
function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunContext["state"],
): void {
	const nextStageNumber = state.jsonlStage + 1;
	if (appendStage(cwd, runId, { stageNumber: nextStageNumber, ...stage })) {
		state.jsonlStage = nextStageNumber;
	}
}

/**
 * After a stage fails, surface every artifact recorded so far so the user
 * doesn't have to grep the JSONL to see what survived.
 */
function notifyPartialArtifacts(ctx: ChainCtx, cwd: string, runId: string): void {
	const artifactPaths = readAllStages(cwd, runId)
		.filter((s) => s.artifact)
		.map((s) => `  • ${s.skill}: ${s.artifact}`)
		.join("\n");
	if (artifactPaths) {
		ctx.ui.notify(`Artifacts produced before failure:\n${artifactPaths}`, "info");
	}
}

/**
 * Record a stage as terminally failed (status, audit row, status-line clear,
 * user-visible notify, and `state.error`), then optionally invoke `onFailure`
 * for the partial-artifacts recap. The three early-exit branches in
 * `executeSession` (aborted / failed / no-artifact) all share this shape;
 * collapsing them here keeps the bookkeeping consistent and makes it harder
 * to forget a step when adding a new failure mode.
 *
 * Always called inside `withSession` on the fresh ctx — never on the outer
 * ctx, which would be invalid by the time newSession resolves.
 */
function recordTerminalFailure(
	freshCtx: ChainCtx,
	p: ExecuteSessionParams,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
		callOnFailure: boolean;
	},
): void {
	recordStage(p.cwd, p.runId, { skill: p.skill, status: args.status, ts: nowIso() }, p.state);
	freshCtx.ui.setStatus(STATUS_KEY, undefined);
	freshCtx.ui.notify(args.notifyMsg, args.notifyLevel);
	if (args.callOnFailure) p.onFailure?.(freshCtx);
	p.state.error = args.errMsg;
}

/**
 * Spawn one fresh session, send `prompt`, inspect the resulting branch, and
 * fan into either `onSuccess(freshCtx, artifact)` (when the agent responded)
 * or `onFailure?.(freshCtx)` after recording a failed row.
 *
 * All chain recursion happens inside the success path on `freshCtx` — the
 * outer `curCtx` is invalid as soon as newSession resolves.
 */
async function executeSession(curCtx: ChainCtx, p: ExecuteSessionParams): Promise<void> {
	const { cancelled } = await curCtx.newSession({
		withSession: async (freshCtx) => {
			await freshCtx.sendUserMessage(p.prompt);

			const branch = freshCtx.sessionManager.getBranch() as unknown as BranchEntry[];
			const artifact = extractArtifactPath(branch);
			const stopReason = lastAssistantStopReason(branch);

			// User aborted the agent loop mid-stage (typically ESC). Halt the
			// chain explicitly — do NOT call `p.onSuccess`, since the partial
			// assistant response would otherwise satisfy hasAssistantMessage and
			// we'd silently advance to the next stage. Matches the canonical
			// Pi subagent pattern (examples/extensions/subagent/index.ts:537-547).
			if (stopReason === "aborted") {
				recordTerminalFailure(freshCtx, p, {
					status: "aborted",
					notifyMsg: MSG_STAGE_ABORTED(p.skill),
					notifyLevel: "warning",
					errMsg: `${p.skill} aborted by user (ESC)`,
					callOnFailure: false,
				});
				return;
			}

			// No assistant response at all, or the agent ended in an LLM error.
			if (!hasAssistantMessage(branch) || stopReason === "error") {
				recordTerminalFailure(freshCtx, p, {
					status: "failed",
					notifyMsg: MSG_STAGE_FAILED(p.skill),
					notifyLevel: "error",
					errMsg: p.errorMessage,
					callOnFailure: true,
				});
				return;
			}

			// Agent stopped cleanly but the stage's protocol contract wasn't met —
			// no artifact path in the transcript. Halt the chain explicitly rather
			// than silently advancing with stale `state.artifactPath`; see the
			// requireArtifact field doc for the failure mode this guards against.
			if (p.requireArtifact && !artifact) {
				recordTerminalFailure(freshCtx, p, {
					status: "failed",
					notifyMsg: MSG_STAGE_NO_ARTIFACT(p.skill),
					notifyLevel: "error",
					errMsg: ERR_STAGE_NO_ARTIFACT(p.skill),
					callOnFailure: true,
				});
				return;
			}

			if (artifact) p.state.artifactPath = artifact;
			recordStage(
				p.cwd,
				p.runId,
				{ skill: p.successSkill ?? p.skill, artifact, status: "completed", ts: nowIso() },
				p.state,
			);
			if (p.emitCompleteOnSuccess) {
				freshCtx.ui.notify(MSG_STAGE_COMPLETE(p.skill), "info");
			}
			p.state.stagesCompleted++;

			// Chain on freshCtx — outer curCtx is about to be invalidated.
			await p.onSuccess(freshCtx, artifact);
		},
	});

	if (cancelled) {
		recordStage(p.cwd, p.runId, { skill: p.skill, status: "skipped", ts: nowIso() }, p.state);
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		curCtx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
	}
}

/**
 * Build the prompt + status label + audit label for a node based on its kind.
 * Phase 1 only implements `kind: "skill"`; future variants slot in here.
 *
 * The returned `skillLabel` is what gets surfaced in the status line and the
 * JSONL audit row — for skill-kind nodes that's the underlying skill name
 * (matches pre-refactor labels), for future kinds it'll be a kind-specific
 * label derived from the node body.
 */
function dispatchNode(node: DagNode, inputForStage: string): { prompt: string; skillLabel: string } {
	switch (node.kind) {
		case "skill":
			return {
				prompt: `/skill:${node.skill} ${inputForStage}`,
				skillLabel: node.skill,
			};
		default: {
			// Last-resort guard — validateDag should have rejected unknown
			// kinds at config-load time. With only one variant in `DagNode`
			// today the TypeScript exhaustiveness check via `const x: never =
			// node` can't be expressed without an error; once chat/script
			// kinds land, add their cases and switch this default to
			// `assertNever(node)` to get type-level narrowing.
			const unknownKind = (node as { kind?: unknown }).kind;
			throw new Error(`runStage: unsupported node kind: ${String(unknownKind)}`);
		}
	}
}

/**
 * Run a single workflow stage at index `idx`, then chain into the next stage
 * (or finalize) using whichever ctx is valid inside withSession.
 */
async function runStage(curCtx: ChainCtx, idx: number, run: RunContext): Promise<void> {
	const { cwd, runId, dag, stageIds, totalStages, state } = run;

	if (idx >= stageIds.length) {
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
		state.success = true;
		return;
	}

	const id = stageIds[idx]!;
	const node = dag.nodes[id];
	if (!node) {
		// validateDag should have caught this — defensive throw for runtime
		// guarantee. Bypassing validation (e.g. via test fixture) lands here.
		throw new Error(`runStage: node id "${id}" referenced by preset but missing from dag.nodes`);
	}
	const stageNumber = idx + 1;

	// Multi-phase expand: when an implement *skill* runs against a plan artifact
	// with `## Phase N:` headings, fan out one session per phase. Keyed on the
	// underlying skill name (not the node id) so any skill-node pointing at
	// "implement" gets the same behavior. Phase-iteration logic lives in
	// implement-phases.ts; we inject the runner's primitives as deps so that
	// module never imports back from runner.ts (cycle-free).
	if (node.kind === "skill" && node.skill === "implement" && state.artifactPath) {
		const phaseCount = countPhases(state.artifactPath, cwd);
		if (phaseCount > 0) {
			await runImplementPhases(curCtx, idx, 1, phaseCount, run, {
				executeSession,
				runNextStage: runStage,
			});
			return;
		}
	}

	// First stage has no prior artifact yet — fall back to the original brief
	// so /skill:<name> gets a meaningful argument.
	const inputForStage = state.artifactPath ?? state.originalInput;
	const { prompt, skillLabel } = dispatchNode(node, inputForStage);

	// Update the persistent status line — survives the `newSession` transition
	// in a way `ui.notify` does not.
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stageNumber, totalStages, skillLabel));

	await executeSession(curCtx, {
		cwd,
		runId,
		state,
		prompt,
		skill: skillLabel,
		errorMessage: `${skillLabel} failed`,
		emitCompleteOnSuccess: true,
		// Derived from the node's declared stop strategy: artifact-emit nodes
		// must produce a `.rpiv/artifacts/...` path; agent-end nodes complete
		// on any clean stop reason. See `StopStrategy` doc in dag.ts.
		requireArtifact: node.stopStrategy === "artifact-emit",
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, cwd, runId),
		onSuccess: (freshCtx) => runStage(freshCtx, idx + 1, run),
	});
}
