/**
 * Manifest types — the inter-stage data channel. A manifest is produced
 * by an outcome's `extract` (not authored by the agent), flows through
 * RunState, and is persisted to the JSONL audit log.
 *
 * Audience: predicate authors and downstream-node authors reading
 * `manifest.data`. The outcome authoring surface (the API a custom
 * `Outcome` implements) lives in `outcome-types.ts`.
 */

import type { ExtractPayload } from "./outcome-types.js";
import type { GitCommitData } from "./outcomes/git-commit.js";

// ---------------------------------------------------------------------------
// Manifest envelope
// ---------------------------------------------------------------------------

export interface ManifestMeta {
	skill: string;
	/** 1-based; matches `WorkflowStage.stageNumber`. */
	stageNumber: number;
	/** ISO-8601. */
	ts: string;
	/** Duplicated from header for ergonomic JSONL reads. */
	runId: string;
}

export interface Manifest<K extends string = string, D = unknown> {
	kind: K;
	/** Present when the stage produced a file consumable by downstream stages. */
	artifact_path?: string;
	data: D;
	meta: ManifestMeta;
}

// ---------------------------------------------------------------------------
// Built-in manifest kinds
//
// Aliases enable consumer-side tagged-union narrowing on `manifest.kind` —
// the value of the abstraction is the narrowing pattern, not the count of
// current importers. Data shapes live with their producing outcomes;
// `GitCommitData` is sourced from `outcomes/git-commit.ts` (type-only
// import — no runtime cycle).
// ---------------------------------------------------------------------------

export type ArtifactMdManifest = Manifest<"artifact-md", Record<string, unknown>>;
export type SideEffectManifest = Manifest<"side-effect", Record<string, never>>;
export type GitCommitManifest = Manifest<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// Outcome types — re-exported here so consumers can `import { Outcome,
// ExtractCtx, ... } from "../manifest.js"` without rewriting every site.
// The canonical definitions live in `outcome-types.ts`; new code can
// import from there directly.
// ---------------------------------------------------------------------------

export type {
	BaselineCtx,
	BaselineFn,
	ExtractCtx,
	ExtractFn,
	ExtractPayload,
	ExtractResult,
	Outcome,
} from "./outcome-types.js";

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

/** Single source of manifest metadata authorship. */
export function finalizeManifest(payload: ExtractPayload, meta: ManifestMeta): Manifest {
	return {
		kind: payload.kind,
		artifact_path: payload.artifact_path,
		data: payload.data,
		meta,
	};
}
