/**
 * Manifest types for the /rpiv workflow typed manifest pipeline.
 *
 * A manifest is a structured record of what a stage produced, extracted by
 * the runner (not authored by the agent). It flows through RunState as the
 * inter-stage data channel and is persisted to the JSONL audit log.
 *
 * No ExtensionAPI dependency. Pure type definitions — safe to import from
 * any module without creating circular dependencies.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest envelope
// ---------------------------------------------------------------------------

/** Producer metadata attached to every manifest. */
export interface ManifestMeta {
	/** Skill name that produced this stage's output. */
	skill: string;
	/** 1-based stage index within the workflow run. */
	stage: number;
	/** ISO-8601 timestamp of extraction completion. */
	ts: string;
	/** Duplicated from header for ergonomic JSONL row reads. */
	runId: string;
}

/**
 * A structured record of what a workflow stage produced.
 *
 * Carries a discriminated `kind`, an optional artifact path, schema-validated
 * `data`, and producer metadata. The manifest is written to JSONL via
 * `recordStage()` and mirrored in `RunState.manifest` for inter-stage access.
 *
 * @typeParam K - Manifest kind discriminator (string literal).
 * @typeParam D - Shape of the `data` payload.
 */
export interface Manifest<K extends string = string, D = unknown> {
	/** Discriminator — determines the shape of `data`. */
	kind: K;
	/** Present when the stage produced a file consumable by downstream stages. */
	artifact_path?: string;
	/** Schema-validated payload (skill-specific shape). */
	data: D;
	/** Producer metadata. */
	meta: ManifestMeta;
}

// ---------------------------------------------------------------------------
// Built-in manifest kinds
// ---------------------------------------------------------------------------

/** Manifest for artifact-emit nodes: frontmatter-parsed markdown artifact. */
export type ArtifactMdManifest = Manifest<"artifact-md", Record<string, unknown>>;

/** Manifest for agent-end nodes: no structured data, side-effect only. */
export type SideEffectManifest = Manifest<"side-effect", Record<string, never>>;

/** Manifest for git-commit nodes: commit metadata extracted post-stage. */
export interface GitCommitData {
	sha: string;
	prevSha: string;
	subject: string;
	filesChanged: number;
	noOp?: boolean;
}
export type GitCommitManifest = Manifest<"git-commit", GitCommitData>;

// ---------------------------------------------------------------------------
// Snapshot context + function signature
// ---------------------------------------------------------------------------

/**
 * Context passed to snapshot functions before a stage executes.
 * Provides everything a snapshot needs to capture baseline state.
 */
export interface SnapshotCtx {
	/** Working directory for the workflow run. */
	cwd: string;
	/** Unique run identifier (mirrors RunContext.runId). */
	runId: string;
	/** 0-based stage index. */
	stageIndex: number;
	/** Read-only view of the current run state. */
	state: Readonly<RunState>;
	/** ExtensionAPI — needed for async git access in snapshots. Optional because
	 *  not all snapshots need it and pi may be absent (e.g. tests). */
	pi?: ExtensionAPI;
}

/**
 * A pure function the runner calls before executeSession to capture baseline
 * state (e.g. git HEAD SHA, filesystem snapshot). The result is passed to
 * the paired extractor post-stage.
 *
 * Fail-soft: implementations should catch errors and return `undefined`
 * rather than throwing.
 */
export type SnapshotFn = (ctx: SnapshotCtx) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// Extractor context + function signature
// ---------------------------------------------------------------------------

/**
 * Context passed to extractor functions after a stage completes.
 * Extends SnapshotCtx with the branch transcript, snapshot result, and
 * the DAG node being extracted for.
 */
export interface ExtractorCtx extends SnapshotCtx {
	/** Session transcript (sliced for continue stages). */
	branch: BranchEntry[];
	/** Branch offset — entries before this belong to prior stages. */
	branchOffset?: number;
	/** What SnapshotFn returned (undefined if no snapshot or on failure). */
	snapshot: unknown | undefined;
	/** Skill name for this stage — used in extractor-emitted error messages so
	 *  fatal text reads "<skill> finished without producing …" rather than echoing
	 *  the user's raw /rpiv input. Filled by the runner; extractors must NOT
	 *  set `manifest.meta.skill` themselves (runner overwrites post-extraction). */
	skill: string;
}

/**
 * Payload an extractor returns — the runner wraps it in a full `Manifest`
 * (filling `meta` from `ExtractorCtx`) via `finalizeManifest`.
 *
 * Keeping `meta` out of the extractor contract means extractors can't
 * accidentally claim a wrong `skill` / `runId` / `stage` / `ts`, and the
 * runner owns those four fields in exactly one place.
 */
export interface ExtractorPayload<K extends string = string, D = unknown> {
	kind: K;
	artifact_path?: string;
	data: D;
}

/**
 * Result of manifest extraction.
 *
 * - `payload: undefined` means "no manifest" — the stage is considered
 *   complete but the chain inherits the prior manifest. Used for agent-end
 *   nodes that don't produce artifacts.
 * - `fatal` halts the chain with a structured error — used when extraction
 *   detects a structural failure (e.g. agent announced path that doesn't exist).
 */
export interface ExtractorResult {
	/** Undefined means "no manifest" — stage complete, chain inherits prior. */
	payload: ExtractorPayload | undefined;
	/** When set, runner halts the chain with this message. */
	fatal?: string;
}

/**
 * A pure function the runner calls after executeSession completes (and the
 * agent has stopped) to produce a manifest payload from the stage's observable
 * outputs. The extractor reads the transcript, the filesystem, and/or the
 * snapshot to build the payload; the runner wraps it in a `Manifest` envelope.
 */
export type ExtractorFn = (ctx: ExtractorCtx) => Promise<ExtractorResult> | ExtractorResult;

/**
 * Wrap an extractor payload in a full `Manifest` envelope, sourcing
 * `meta.{skill,stage,ts,runId}` from the extractor context + caller-supplied
 * skill/timestamp. The single place metadata is authored.
 */
export function finalizeManifest(
	payload: ExtractorPayload,
	ctx: { skill: string; stage: number; ts: string; runId: string },
): Manifest {
	return {
		kind: payload.kind,
		artifact_path: payload.artifact_path,
		data: payload.data,
		meta: { skill: ctx.skill, stage: ctx.stage, ts: ctx.ts, runId: ctx.runId },
	};
}
