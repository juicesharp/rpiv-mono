/**
 * Shared types for the /rpiv workflow modules.
 *
 * Lives separately from `runner.ts` and `implement-phases.ts` so both
 * modules can reference the same canonical shapes without creating a
 * runtime import cycle (implement-phases.ts is a value-dependency of
 * runner.ts; type-only references back via this module are cycle-free).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DagNode, SessionPolicy, WorkflowDag } from "./dag.js";
import type { Manifest } from "./manifest.js";

/**
 * A ctx that can spawn the next session. Either the original handler ctx or
 * a `freshCtx` from `withSession` — both extend `ExtensionCommandContext`,
 * which is all we need (`ui.notify` + `newSession`).
 * `ReplacedSessionContext` is not publicly exported from `pi-coding-agent`,
 * so we lean on the base type.
 */
export type ChainCtx = ExtensionCommandContext;

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	/** Frozen — the user's `/rpiv` argument. */
	originalInput: string;
	/** Last `.rpiv/artifacts/...` path emitted by any stage so far.
	 * @deprecated Mirror of `manifest.artifact_path` retained for legacy callers
	 *   (prompt construction, countPhases). Prefer `state.manifest?.artifact_path`. */
	artifactPath: string | undefined;
	/** Last successfully validated manifest. Mirrors the JSONL manifest field. */
	manifest: Manifest | undefined;
	/** Successful-stage counter (success only — not failed/skipped). */
	stagesCompleted: number;
	/** Last successfully-written JSONL stage number (for contiguous numbering). */
	jsonlStage: number;
	/** Whether the chain finished cleanly. Set by the terminal stage of `runStage`. */
	success: boolean;
	/** Set when a stage halts the chain — surfaces in `RunWorkflowResult`. */
	error: string | undefined;
}

/** Per-run context that the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	/** The DAG being executed — used to look up per-node metadata at dispatch time. */
	dag: WorkflowDag;
	/** Linear sequence of node ids resolved from `dag.presets[preset]`. */
	stageIds: string[];
	totalStages: number;
	state: RunState;
	/** ExtensionAPI instance — needed for "continue" stages that call pi.sendUserMessage(). */
	pi?: ExtensionAPI;
}

/**
 * Parameters for one session spawn — fully captures the asymmetries between
 * `runStage` and `runImplementPhases` so the spawn body itself can live in
 * one place (`executeSession` in runner.ts).
 */
export interface ExecuteSessionParams {
	cwd: string;
	runId: string;
	state: RunState;
	/** The `/skill:<name> <args>` line to send into the fresh session. */
	prompt: string;
	/** Base skill name — used for the JSONL "skill" field on failed and skipped rows. */
	skill: string;
	/** Optional override applied only to the *successful* JSONL row's "skill" field. */
	successSkill?: string;
	/** Message stored in state.error when the session yields no assistant message. */
	errorMessage: string;
	/** Whether to emit `MSG_STAGE_COMPLETE(skill)` on success (stages yes; phases hold until all phases done). */
	emitCompleteOnSuccess: boolean;
	/** Optional hook invoked inside withSession after the failed row is recorded — used for the partial-artifacts recap. */
	onFailure?: (freshCtx: ChainCtx) => void;
	/** Invoked inside withSession after success bookkeeping. `freshCtx` is the valid ctx for further chaining. */
	onSuccess: (freshCtx: ChainCtx, artifact: string | undefined) => Promise<void>;
	/** Session policy for this stage. "fresh" creates a new session; "continue" reuses the prior session. */
	sessionPolicy?: SessionPolicy;
	/** ExtensionAPI — required when sessionPolicy is "continue". */
	pi?: ExtensionAPI;
	/** Branch offset — entries before this index belong to prior stages. Only set for "continue" stages. */
	branchOffset?: number;
	/** Pre-stage snapshot result (if node declared a snapshot). Passed to the extractor. */
	snapshot?: unknown;
	/** DAG node for this stage — used by manifest extractor resolution. */
	node?: DagNode;
	/** 0-based stage index — propagated into ExtractorCtx.stageIndex. */
	stageIndex: number;
}
