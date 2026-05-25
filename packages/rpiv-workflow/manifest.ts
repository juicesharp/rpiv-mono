/**
 * Manifest envelope — the inter-stage data channel a stage's collector +
 * parser produce on settlement. Flows through `RunState`, persists to
 * the JSONL audit log, and is read by downstream predicates / stages.
 *
 * Audience: predicate authors and downstream-stage authors reading
 * `manifest.artifacts` (the storage references) and `manifest.data`
 * (the typed channel a parser shaped). The producer-side surface
 * (`ArtifactCollector` / `ArtifactParser` / `OutputSpec`) lives in
 * `outcome-types.ts`.
 */

import type { Artifact } from "./handle.js";
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

/**
 * One stage's contribution to the chain. `artifacts` is always present
 * (possibly empty for side-effect stages); `data` is whatever the parser
 * shaped (or the artifact list itself when no parser is wired).
 *
 * `kind` discriminates the data shape so downstream consumers narrow
 * via `manifest.kind === "git-commit"` etc. The literal `"artifacts"`
 * is the default parser-less shape.
 */
export interface Manifest<K extends string = string, D = unknown> {
	kind: K;
	artifacts: readonly Artifact[];
	data: D;
	meta: ManifestMeta;
}

// ---------------------------------------------------------------------------
// Built-in manifest kind aliases
//
// Tagged-union narrowing convenience for consumers. Data shapes live
// with their producing outcomes; `GitCommitData` is type-only imported
// from `outcomes/git-commit.ts` (no runtime cycle).
// ---------------------------------------------------------------------------

export type ArtifactsManifest = Manifest<"artifacts", readonly Artifact[]>;
export type SideEffectManifest = Manifest<"side-effect", Record<string, never>>;
export type GitCommitManifest = Manifest<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// OutputSpec types — re-exported so consumers can `import { OutputSpec,
// CollectCtx, ... } from "../manifest.js"` without rewriting every
// site. Canonical definitions live in `outcome-types.ts`.
// ---------------------------------------------------------------------------

export type {
	ArtifactCollector,
	ArtifactParser,
	CollectCtx,
	CollectResult,
	OutputSpec,
	ParseCtx,
	ParseResult,
	SnapshotCtx,
	SnapshotFn,
} from "./outcome-types.js";

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

/**
 * Single source of manifest metadata authorship. The runner calls this
 * after a stage's collector returned `artifacts` and the parser (or
 * parser-less default) returned `{ kind, data }`.
 */
export function finalizeManifest<K extends string, D>(
	args: { kind: K; artifacts: readonly Artifact[]; data: D },
	meta: ManifestMeta,
): Manifest<K, D> {
	return {
		kind: args.kind,
		artifacts: args.artifacts,
		data: args.data,
		meta,
	};
}
