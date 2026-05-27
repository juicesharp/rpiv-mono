/**
 * Output envelope — the inter-stage data channel a stage's collector +
 * parser produce on settlement. Flows through `RunState`, persists to
 * the JSONL audit log, and is read by downstream predicates / stages.
 *
 * Audience: predicate authors and downstream-stage authors reading
 * `output.artifacts` (the storage references) and `output.data`
 * (the typed channel a parser shaped). The producer-side surface
 * (`ArtifactCollector` / `ArtifactParser` / `OutputSpec`) lives in
 * `output-spec.ts`.
 */

import type { Artifact } from "./handle.js";
import type { GitCommitData } from "./outcomes/git-commit.js";

// ---------------------------------------------------------------------------
// Output envelope
// ---------------------------------------------------------------------------

export interface OutputMeta {
	/** Workflow stage record key — matches `WorkflowStage.stage`. */
	stage: string;
	/** Pi skill body when the producing stage was skill-based; absent for script stages. Matches `WorkflowStage.skill?`. */
	skill?: string;
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
 * via `output.kind === "git-commit"` etc. The literal `"artifacts"`
 * is the default parser-less shape.
 */
export interface Output<K extends string = string, D = unknown> {
	kind: K;
	artifacts: readonly Artifact[];
	data: D;
	meta: OutputMeta;
}

// ---------------------------------------------------------------------------
// Built-in output kind aliases
//
// Tagged-union narrowing convenience for consumers. Data shapes live
// with their producing outcomes; `GitCommitData` is type-only imported
// from `outcomes/git-commit.ts` (no runtime cycle).
// ---------------------------------------------------------------------------

export type ArtifactsOutput = Output<"artifacts", readonly Artifact[]>;
export type SideEffectOutput = Output<"side-effect", Record<string, never>>;
export type GitCommitOutput = Output<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// OutputSpec types — re-exported so consumers can `import { OutputSpec,
// CollectCtx, ... } from "../output.js"` without rewriting every
// site. Canonical definitions live in `output-spec.ts`.
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
} from "./output-spec.js";

// ---------------------------------------------------------------------------
// Output construction
// ---------------------------------------------------------------------------

/**
 * Single source of output metadata authorship. The runner calls this
 * after a stage's collector returned `artifacts` and the parser (or
 * parser-less default) returned `{ kind, data }`.
 */
export function finalizeOutput<K extends string, D>(
	args: { kind: K; artifacts: readonly Artifact[]; data: D },
	meta: OutputMeta,
): Output<K, D> {
	return {
		kind: args.kind,
		artifacts: args.artifacts,
		data: args.data,
		meta,
	};
}
