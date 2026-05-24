/**
 * Public authoring surface for rpiv workflows.
 *
 * A `Workflow` is a typed graph: a named entry point, a node table, and an
 * edge table that maps each node to either another node name, the sentinel
 * `"stop"`, or an `EdgeFn` that picks at runtime. Edges live INSIDE each
 * workflow — there is no parallel preset/edge split.
 *
 * Factories are pure passthroughs that apply sane defaults. Same idiom as
 * `defineConfig` in Vite/Astro/Tailwind: zero runtime cost, exists solely
 * for type inference + uniform shape at the call site.
 *
 * Phase 1 of the TS-native workflow migration — see
 * `thoughts/shared/designs/2026-05-23-ts-native-workflows.md`. This file
 * adds the new surface alongside the existing DAG. Later phases collapse
 * the old paths onto it.
 */

import type { TSchema } from "typebox";
import type { ExtractorCtx, ExtractorResult, SnapshotCtx } from "./manifest.js";
import { type EdgePredicate, predicateThreshold } from "./predicates.js";
import type { RunState } from "./types.js";

// ===========================================================================
// Types
// ===========================================================================

/**
 * Runtime context handed to an `EdgeFn`. Same shape as the existing
 * `PredicateContext` — re-exported under the public name for new authors.
 */
export interface EdgeContext {
	manifest: import("./manifest.js").Manifest | undefined;
	state: Readonly<RunState>;
}

/** A function that picks the next node name given current state + manifest. */
export type EdgeFn = EdgePredicate;

/**
 * What an `edges` entry resolves to: another node name (auto-edge), the
 * terminal sentinel `"stop"`, or a function chosen at run-time.
 */
export type EdgeTarget = string | EdgeFn;

/**
 * Extractors bundle the pre-stage capture (`before`) with the post-stage
 * read (`extract`). Today the only `before` user is `gitCommitExtractor`
 * — it records `HEAD` so `extract` can identify the new commit. Co-locating
 * the pair makes the relationship structural rather than convention.
 */
export interface Extractor {
	/** Called BEFORE the stage spawns. Return value flows into `ctx.snapshot`. */
	before?: (ctx: SnapshotCtx) => Promise<unknown> | unknown;
	/** Called AFTER the agent loop settles. Receives `ctx.snapshot` if `before` ran. */
	extract: (ctx: ExtractorCtx) => Promise<ExtractorResult> | ExtractorResult;
}

/**
 * A node in the workflow graph. `skill` is resolved by Pi at run-time —
 * no allowlist gate. If Pi can't load the skill, the runner halts with a
 * clear error pointing at this node.
 */
export interface NodeDef {
	name: string;
	skill: string;
	completionStrategy: "artifact-emit" | "agent-end";
	sessionPolicy: "fresh" | "continue";
	extractor?: Extractor;
	outputSchema?: TSchema;
	inputSchema?: TSchema;
	onValidationFailure?: "retry" | "halt";
	maxValidationRetries?: number;
	validationRetryTimeoutMs?: number;
}

/**
 * A complete workflow. `name` is what users type as `/rpiv <name>`; `start`
 * is the entry node; `nodes` is the lexicon; `edges` is the wiring. Every
 * key in `edges` must exist in `nodes`; every string value must exist in
 * `nodes` or be `"stop"`. Validated at load time by `validate.ts`.
 */
export interface Workflow {
	name: string;
	description?: string;
	start: string;
	nodes: Record<string, NodeDef>;
	edges: Record<string, EdgeTarget>;
}

// ===========================================================================
// Factories — passthroughs with defaults
// ===========================================================================

/** Identity passthrough; reserved for future normalization / metadata hooks. */
export function defineWorkflow(spec: Workflow): Workflow {
	return spec;
}

/** Protocol skill: writes `.rpiv/artifacts/<bucket>/<file>.md`. Defaults to fresh-session. */
export function skill(name: string, overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		name,
		skill: name,
		completionStrategy: "artifact-emit",
		sessionPolicy: "fresh",
		...overrides,
	};
}

/** Action skill: side effect IS the work (commit, implement). Defaults to fresh-session. */
export function action(name: string, overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		name,
		skill: name,
		completionStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	};
}

/**
 * Explicit-everything node — for skills whose name differs from their node
 * name, or for cases where `skill`/`action` defaults don't fit. Identity
 * passthrough; provides the shape entry point for users.
 */
export function custom(spec: NodeDef): NodeDef {
	return spec;
}

// ===========================================================================
// Predicate builders — common patterns
// ===========================================================================

/**
 * `ifAbove` when `Number(manifest.data[field] ?? 0) > threshold`, else `ifBelow`.
 * Thin alias over `predicateThreshold` so user-facing imports stay under one name.
 */
export const threshold = predicateThreshold;
