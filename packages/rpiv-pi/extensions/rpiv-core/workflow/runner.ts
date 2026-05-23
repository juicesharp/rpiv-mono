/**
 * Top-level orchestration for the /rpiv workflow command.
 *
 * `runWorkflow` resolves the preset, opens the JSONL audit file, and recursively
 * drives `runStage` through each node id in the preset. `runStage` resolves the
 * node, fans out into per-phase iteration for the `implement` skill, computes
 * the input/snapshot prerequisites, and hands off to `runStageSession` (from
 * `sessions.ts`) for the actual agent loop. Edge routing after a successful
 * stage is delegated to `resolveNextStageId` (from `routing.ts`).
 *
 * This file owns *workflow-level* concerns only:
 *   - preset traversal + linear advance
 *   - per-node prerequisites (input validation, snapshot, sessionPolicy guards)
 *   - routing decisions + routing-audit rows
 *
 * Session execution, manifest extraction, validation retries, and stage-level
 * audit bookkeeping live in `sessions.ts` and `audit.ts` respectively. This
 * file imports those layers but never inlines their concerns.
 *
 * Each level of the chain only ever touches the ctx it was handed:
 *   - On `cancelled === true` no replacement happened — the level's curCtx
 *     is still valid for the final notify/append.
 *   - On `cancelled === false` curCtx is stale after newSession returns; all
 *     further work was already performed inside the withSession callback on
 *     freshCtx, and the function simply unwinds.
 *   - On "continue" there is no newSession — curCtx remains valid throughout.
 *
 * Vocabulary:
 *   - "stage" = one position in a preset's node sequence (a DAG node).
 *   - "phase" = one `## Phase N:` subdivision *inside an implement plan
 *     artifact* — only meaningful for the `implement` stage.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyPartialArtifacts, nowIso, recordStage } from "./audit.js";
import { clearChildSession, markChildSession } from "./child-session.js";
import type { DagNode, WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import type { Manifest } from "./manifest.js";
import {
	ERR_INPUT_VALIDATION_FAILED,
	MSG_INPUT_VALIDATION_FAILED,
	MSG_WORKFLOW_COMPLETE,
	STATUS_KEY,
	STATUS_STAGE,
} from "./messages.js";
import { resolveNextStageId } from "./routing.js";
import { runPhaseSession, runStageSession } from "./sessions.js";
import { appendRoutingDecision, generateRunId, writeHeader } from "./state.js";
import type { BranchEntry } from "./transcript.js";
import type { ChainCtx, RunContext } from "./types.js";
import { validateManifestData } from "./validation.js";

// Re-export so existing imports of `extractArtifactPath` and `countPhases`
// from "./runner.js" keep working — production callers and tests both rely
// on this surface.
export { countPhases } from "./implement-phases.js";
export { runPhaseSession, runStageSession } from "./sessions.js";
export { extractArtifactPath } from "./transcript.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface RunWorkflowOptions {
	/** Preset name (resolved to a linear sequence). */
	preset: string;
	/** User's input text — passed as argument to the first skill. */
	input: string;
	/** The DAG to traverse. Defaults to WORKFLOW_DAG. */
	dag?: WorkflowDag;
	/** ExtensionAPI — needed for "continue" stages that call pi.sendUserMessage(). */
	pi?: ExtensionAPI;
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
// runWorkflow — workflow entry point
// ---------------------------------------------------------------------------

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
		manifest: undefined as Manifest | undefined,
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
		await runStage(ctx, 0, { cwd, runId, dag, stageIds, totalStages, state, pi: options.pi });
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
 * Build the prompt + status label + audit label for a node based on its kind.
 * Only `kind: "skill"` is supported today; future variants slot in here.
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
	// implement-phases.ts; we inject the session primitives as deps so that
	// module never imports back from runner.ts (cycle-free).
	if (node.kind === "skill" && node.skill === "implement" && state.artifactPath) {
		const phaseCount = countPhases(state.artifactPath, cwd);
		if (phaseCount > 0) {
			await runImplementPhases(curCtx, idx, 1, phaseCount, run, {
				runPhaseSession,
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

	// Block implement + continue — phase fanout assumes per-phase session isolation.
	if (node.kind === "skill" && node.skill === "implement" && node.sessionPolicy === "continue") {
		throw new Error(
			`runStage: implement node "${id}" cannot use sessionPolicy "continue" — ` +
				"phase fanout requires per-phase session isolation",
		);
	}

	// Validate pi is available for continue stages.
	if (node.sessionPolicy === "continue" && !run.pi) {
		throw new Error(
			`runStage: node "${id}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`,
		);
	}

	// Compute branch offset — entries before this index belong to prior stages.
	const branchOffset =
		node.sessionPolicy === "continue"
			? (curCtx.sessionManager.getBranch() as unknown as BranchEntry[]).length
			: undefined;

	// --- Input validation ---
	// `node.skill` is only present on SkillNode; narrow before access. Future
	// node kinds (chat/script) get a placeholder label until they grow real ones.
	const nodeLabel = node.kind === "skill" ? node.skill : id;

	if (node.inputSchema && state.manifest?.data !== undefined) {
		const result = validateManifestData(node.inputSchema, state.manifest.data);
		if (!result.valid) {
			const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
			const prevSkill = state.manifest.meta.skill || "unknown";

			// Inline halt — input validation runs before the session opens, so
			// runStage's locals (curCtx, cwd, runId, state) are still the valid
			// surface; building a StageSession just to call recordTerminalFailure
			// would obscure the early-exit shape.
			recordStage(cwd, runId, { skill: nodeLabel, status: "failed", ts: nowIso() }, state);
			curCtx.ui.setStatus(STATUS_KEY, undefined);
			curCtx.ui.notify(MSG_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill), "error");
			notifyPartialArtifacts(curCtx, cwd, runId);
			state.error = ERR_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill, failureSummary);
			return;
		}
	}

	// Pre-stage snapshot (if node declares one)
	let snapshotResult: unknown;
	if (node.snapshot) {
		try {
			snapshotResult = await node.snapshot({ cwd, runId, stageIndex: idx, state, pi: run.pi });
		} catch {
			// Fail-soft: snapshot failure doesn't prevent stage execution
		}
	}

	await runStageSession(curCtx, {
		cwd,
		runId,
		state,
		prompt,
		skill: skillLabel,
		node,
		stageIndex: idx,
		snapshot: snapshotResult,
		pi: run.pi,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, cwd, runId),
		onSuccess: async (freshCtx) => {
			try {
				const nextId = resolveNextStageId(dag, id, stageIds, idx, state);
				if (!nextId) {
					freshCtx.ui.setStatus(STATUS_KEY, undefined);
					freshCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
					state.success = true;
					return;
				}
				const nextIdx = stageIds.indexOf(nextId);
				if (nextIdx < 0) throw new Error(`resolveNextStageId returned "${nextId}" not in preset`);

				// Log routing decision if different from linear advance
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

				await runStage(freshCtx, nextIdx, run);
			} catch (e) {
				freshCtx.ui.setStatus(STATUS_KEY, undefined);
				state.error = e instanceof Error ? e.message : String(e);
			}
		},
	});
}
