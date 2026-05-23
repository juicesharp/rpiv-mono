/**
 * Shared types for the workflow modules. Lives apart from runner.ts /
 * implement-phases.ts so both can reference the same shapes without a
 * runtime import cycle (type-only refs back via this module are cycle-free).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DagNode, WorkflowDag } from "./dag.js";
import type { Manifest } from "./manifest.js";

/**
 * Extends `ExtensionCommandContext` with `isIdle`/`waitForIdle` which the SDK
 * guarantees on every event ctx but doesn't surface on the public base type —
 * call sites use plain method syntax instead of an `as` cast each time.
 */
export type ChainCtx = ExtensionCommandContext & {
	isIdle(): boolean;
	waitForIdle(): Promise<void>;
};

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	/** Frozen — the user's `/rpiv` argument. */
	originalInput: string;
	/**
	 * Denormalised mirror of `manifest.artifact_path` — load-bearing for the
	 * prompt builder and `countPhases`, which need the path at idx 0 before
	 * any manifest exists. Always equal to the most recently set
	 * `manifest.artifact_path` (or the bare path extracted from the transcript
	 * when the manifest is absent).
	 */
	artifactPath: string | undefined;
	manifest: Manifest | undefined;
	/** Stages whose JSONL row landed on disk. */
	stagesCompleted: number;
	/** Most recently allocated stageNumber. Advances on every recordStage call. */
	lastStageNumber: number;
	success: boolean;
	error: string | undefined;
	backwardJumps: number;
}

/** Per-run context the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	dag: WorkflowDag;
	/** Linear node-id sequence resolved from `dag.presets[preset]`. */
	stageIds: string[];
	totalStages: number;
	state: RunState;
	/** Required for "continue"-policy stages. */
	pi?: ExtensionAPI;
	maxBackwardJumps: number;
}

interface SessionContext {
	cwd: string;
	runId: string;
	state: RunState;
	/** `/skill:<name> <args>`. */
	prompt: string;
	/** Status-line + JSONL "skill" label. */
	skill: string;
}

export interface StageSession extends SessionContext {
	node: DagNode;
	/** 0-based index in `RunContext.stageIds`. */
	stageIndex: number;
	/** Pre-stage snapshot result (undefined if node has no snapshot). */
	snapshot: unknown;
	/** Required iff `node.sessionPolicy === "continue"`. */
	pi?: ExtensionAPI;
	/** Only set for continue stages — branch slice offset. */
	branchOffset?: number;
	onFailure?: (ctx: ChainCtx) => void;
	onSuccess: (ctx: ChainCtx, artifact: string | undefined) => Promise<void>;
}

/** One `## Phase N:` iteration of an implement stage. */
export interface PhaseSession extends SessionContext {
	/** 1-based. */
	phaseIndex: number;
	phaseCount: number;
	/** Parent stage's 0-based index. */
	stageIndex: number;
	onSuccess: (ctx: ChainCtx) => Promise<void>;
}
