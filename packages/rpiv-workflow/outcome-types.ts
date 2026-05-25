/**
 * OutputSpec authoring surface — the contract a stage's data-channel
 * implementation satisfies. Decomposed into two orthogonal halves so
 * authors can mix-and-match:
 *
 *   - `ArtifactCollector<B>`      — ENUMERATE: which artifacts did the
 *                                    stage produce? (text scan, tool-call
 *                                    observation, fs diff, git, custom.)
 *   - `ArtifactParser<B, K, D>`   — INTERPRET: given the artifacts, what
 *                                    typed data does downstream see?
 *
 * `OutputSpec` is the wired-up pair — `{ collector, parser? }` — that
 * stages declare via `StageDef.outcome`. When `parser` is omitted the
 * manifest data IS the artifact list (kind = `"artifacts"`).
 *
 * Companion to `manifest.ts` (the envelope `Manifest<K, D>` that flows
 * to downstream stages, predicates, and the JSONL audit log). The split:
 * output-spec authors implement the producer side here; manifest
 * consumers read the envelope shape there.
 */

import type { Artifact } from "./handle.js";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Snapshot — pre-stage reference capture (shared by collector + parser)
// ---------------------------------------------------------------------------

export interface SnapshotCtx {
	cwd: string;
	runId: string;
	stageIndex: number;
	state: Readonly<RunState>;
}

/** Fail-soft: implementations catch and return undefined rather than throwing. */
export type SnapshotFn<Snapshot = unknown> = (ctx: SnapshotCtx) => Promise<Snapshot> | Snapshot;

// ---------------------------------------------------------------------------
// Collector — discover what the stage produced
// ---------------------------------------------------------------------------

/**
 * Context handed to a collector's `collect`. Includes the full unsliced
 * branch (`branch`) plus a policy-derived `branchOffset` — for
 * continue-policy stages the offset lets the collector ignore prior-stage
 * prefix without re-materialising a slice. `snapshot` is whatever the
 * collector's optional `snapshot` hook returned.
 */
export interface CollectCtx<Snapshot = unknown> extends SnapshotCtx {
	branch: BranchEntry[];
	branchOffset?: number;
	snapshot: Snapshot;
	/** Filled by the runner; collectors MUST NOT set this themselves. */
	skill: string;
}

/**
 * Three-way return from `collect`:
 *
 *   `kind: "ok"` + `artifacts: []`               — stage produced nothing.
 *                                                   For produces stages the runner halts;
 *                                                   for side-effect stages the chain inherits
 *                                                   the upstream artifact list forward.
 *   `kind: "ok"` + `artifacts: [...]`            — N>=1 artifacts; parser (or default) shapes the data.
 *   `kind: "fatal"`                              — collector cannot satisfy its contract;
 *                                                   runner halts with the carried message.
 */
export type CollectResult = { kind: "ok"; artifacts: readonly Artifact[] } | { kind: "fatal"; message: string };

/**
 * The user-supplyable primitive. A collector enumerates artifacts; that's
 * its single job. Authors compose `snapshot?` (pre-stage capture) +
 * `collect` (post-stage enumeration). Side-effect-only stages use a
 * collector that always returns `{ kind: "ok", artifacts: [] }` — see
 * `outcomes/side-effect.ts`.
 *
 * Method shorthand (vs. function-property) so specialised
 * `ArtifactCollector<MySnapshot>` is assignable to the runner's
 * `ArtifactCollector` (default `Snapshot = unknown`) without explicit
 * widening at every call site.
 */
export interface ArtifactCollector<Snapshot = unknown> {
	snapshot?(ctx: SnapshotCtx): Promise<Snapshot> | Snapshot;
	collect(ctx: CollectCtx<Snapshot>): Promise<CollectResult> | CollectResult;
}

// ---------------------------------------------------------------------------
// Parser — interpret collected artifacts into a typed data channel
// ---------------------------------------------------------------------------

/**
 * Context handed to a parser's `parse`. Extends `CollectCtx` with the
 * `artifacts` the matching collector just returned, so parsers can
 * narrow on `artifacts[0].handle.kind` and inspect any `meta` the
 * collector attached. `snapshot` flows through unchanged.
 */
export interface ParseCtx<Snapshot = unknown> extends CollectCtx<Snapshot> {
	artifacts: readonly Artifact[];
}

/**
 * Two-way return from `parse`. `ok` produces the typed data channel
 * downstream stages see on `manifest.data`; `fatal` halts the stage
 * with the carried message — same posture as `CollectResult`.
 */
export type ParseResult<Kind extends string = string, Data = unknown> =
	| { kind: "ok"; payload: { kind: Kind; data: Data } }
	| { kind: "fatal"; message: string };

/**
 * Optional companion to a collector. When omitted, the manifest's
 * `data` is the artifact list itself and `kind` is the literal
 * `"artifacts"` — a stage that only needs to enumerate files doesn't
 * have to write a parser.
 *
 * Method shorthand for the same bivariance reason as `ArtifactCollector`.
 */
export interface ArtifactParser<Snapshot = unknown, Kind extends string = string, Data = unknown> {
	parse(ctx: ParseCtx<Snapshot>): Promise<ParseResult<Kind, Data>> | ParseResult<Kind, Data>;
}

// ---------------------------------------------------------------------------
// OutputSpec — wired-up pair on `StageDef.outcome`
// ---------------------------------------------------------------------------

/**
 * A stage's collector+parser bundle. `parser` is optional; when omitted
 * the manifest emits `kind: "artifacts"` with `data = artifacts`.
 *
 * Generic over `<Snapshot, Kind, Data>` so specialised output specs
 * (`OutputSpec<GitHeadSnapshot, "git-commit", GitCommitData>`) flow types
 * end-to-end from snapshot through collect into the downstream
 * `manifest.data`.
 */
export interface OutputSpec<Snapshot = unknown, Kind extends string = string, Data = unknown> {
	collector: ArtifactCollector<Snapshot>;
	parser?: ArtifactParser<Snapshot, Kind, Data>;
}

// ---------------------------------------------------------------------------
// Author helpers — `define*` shorthands match `defineWorkflow` /
// `definePredicate` / `defineStatePredicate` in api.ts. Pure passthroughs:
// they exist for type inference + uniform shape at the call site.
// ---------------------------------------------------------------------------

/** Identity passthrough; lets authors annotate snapshot-generic collectors without re-stating `<Snapshot>`. */
export function defineCollector<Snapshot = unknown>(spec: ArtifactCollector<Snapshot>): ArtifactCollector<Snapshot> {
	return spec;
}

/** Identity passthrough; same idiom as `defineCollector`. */
export function defineParser<Snapshot = unknown, Kind extends string = string, Data = unknown>(
	spec: ArtifactParser<Snapshot, Kind, Data>,
): ArtifactParser<Snapshot, Kind, Data> {
	return spec;
}
