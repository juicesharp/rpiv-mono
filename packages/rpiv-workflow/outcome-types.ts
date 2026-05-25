/**
 * Outcome authoring surface — the contract a custom `Outcome` implements.
 * The runner consumes `Outcome` values; downstream nodes read
 * `manifest.data` produced by them.
 *
 * Domain concept: a stage's contribution to the chain's data channel.
 * Some outcomes need a reference point (git diff, schema migration delta,
 * cost report); those declare an optional `baseline` hook that captures
 * pre-stage state. All outcomes produce the typed fact via `extract`.
 *
 * Companion to `manifest.ts` (the envelope `Manifest<K, D>` + the three
 * built-in `*Manifest` aliases). Split out so outcome authors read only
 * what they need; the manifest envelope is the consumer-side surface for
 * predicates / downstream nodes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchEntry } from "./transcript.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Baseline — pre-stage reference capture
// ---------------------------------------------------------------------------

export interface BaselineCtx {
	cwd: string;
	runId: string;
	stageIndex: number;
	state: Readonly<RunState>;
	/** Optional — not all baselines need pi; may be absent in tests. */
	pi?: ExtensionAPI;
}

/** Fail-soft: implementations catch and return undefined rather than throwing. */
export type BaselineFn<Baseline = unknown> = (ctx: BaselineCtx) => Promise<Baseline> | Baseline;

// ---------------------------------------------------------------------------
// Extract — post-stage read
// ---------------------------------------------------------------------------

export interface ExtractCtx<Baseline = unknown> extends BaselineCtx {
	branch: BranchEntry[];
	/** Entries before this index belong to prior stages (continue policies). */
	branchOffset?: number;
	/** Value returned by `Outcome.baseline?` — `undefined` when no baseline hook is declared. */
	baseline: Baseline;
	/** Filled by the runner; outcomes must NOT set `manifest.meta.skill` themselves. */
	skill: string;
}

export interface ExtractPayload<K extends string = string, D = unknown> {
	kind: K;
	artifact_path?: string;
	data: D;
}

/**
 * Three-way return from `extract` — same shape as
 * `sessions.ts:ExtractionOutcome` so the runner's `runExtractor` is a
 * pure pass-through (no translation step).
 *
 *   `kind: "ok"` + `payload: ExtractPayload`  — stage emitted an artifact.
 *   `kind: "ok"` + `payload: undefined`        — agent-end stage; chain inherits prior manifest.
 *   `kind: "fatal"`                            — outcome cannot satisfy its contract; runner halts.
 */
export type ExtractResult<K extends string = string, D = unknown> =
	| { kind: "ok"; payload: ExtractPayload<K, D> | undefined }
	| { kind: "fatal"; message: string };

/**
 * Contract — when must `extract` return `{ kind: "fatal" }`? If the
 * protocol REQUIRES a structural output (artifact-emit nodes that promise
 * an `.rpiv/artifacts/...` path) and that output is absent, the outcome
 * MUST return `{ kind: "fatal", message }`. Agent-end / side-effect
 * outcomes never return `"fatal"` — success follows from `classifyStop`.
 *
 * Every concrete outcome declares which side of the contract it sits on
 * by the `kind` values it can return.
 */
export type ExtractFn<Baseline = unknown, K extends string = string, D = unknown> = (
	ctx: ExtractCtx<Baseline>,
) => Promise<ExtractResult<K, D>> | ExtractResult<K, D>;

/**
 * An outcome bundles the (optional) pre-stage baseline with the required
 * post-stage extract. `baseline` runs once before the agent loop spawns;
 * its return value lands in `ctx.baseline` for `extract`. Co-locating the
 * pair makes the relationship structural: a `baseline` without an
 * `extract` to consume it can't be declared.
 *
 * Generic over `Baseline` (baseline value type), `Kind` (the manifest's
 * `kind` discriminator), and `Data` (the manifest payload). All three
 * default to wide types so existing callers keep type-checking; custom
 * outcomes specialise to flow types end-to-end from `baseline` through
 * `extract` into the downstream `manifest.data`.
 *
 * `baseline` / `extract` use TypeScript method shorthand syntax (vs.
 * `extract: ExtractFn<...>`) so the function parameters are bivariant.
 * That makes specialised `Outcome<GitHeadSnapshot, "git-commit", ...>`
 * assignable to the runner's `Outcome` (default `Baseline = unknown`) —
 * the alternative would force every call site to widen explicitly.
 */
export interface Outcome<Baseline = unknown, Kind extends string = string, Data = unknown> {
	baseline?(ctx: BaselineCtx): Promise<Baseline> | Baseline;
	extract(ctx: ExtractCtx<Baseline>): Promise<ExtractResult<Kind, Data>> | ExtractResult<Kind, Data>;
}
