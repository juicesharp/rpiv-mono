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

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Extractor } from "./manifest.js";
import { type EdgePredicate, predicateThreshold } from "./predicates.js";
import type { RunState } from "./types.js";

export type { Extractor } from "./manifest.js";

/**
 * Schema attached to a node's `outputSchema` / `inputSchema`. Structurally
 * a Standard Schema v1 (the converged interface implemented by Zod, Valibot,
 * ArkType, TypeBox, et al.) — re-exported under a name that doesn't leak the
 * spec version into our public surface. When the spec versions, this alias
 * picks the right one in a single line.
 */
export type NodeSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

// ===========================================================================
// Node-shape primitives
// ===========================================================================

/**
 * - `"artifact-emit"` — protocol skills that write `.rpiv/artifacts/<bucket>/<file>.md`.
 *   The runner halts the chain if the path doesn't appear in the transcript.
 * - `"agent-end"` — action skills (commit, implement) where the side effect IS
 *   the work; the chain inherits the prior `state.artifactPath`.
 */
export type CompletionStrategy = "artifact-emit" | "agent-end";

/**
 * - `"fresh"` — wraps the stage in `ctx.newSession({ withSession })`.
 * - `"continue"` — reuses the prior session via `pi.sendUserMessage()` +
 *   `ctx.waitForIdle()`; branch sliced by `branchOffset`.
 */
export type SessionPolicy = "fresh" | "continue";

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

/**
 * A function that picks the next node name given current state + manifest.
 * Optional `targets` field lets graph introspectors enumerate possible
 * returns — `threshold` and other built-in predicate builders populate it.
 */
export type EdgeFn = EdgePredicate & { targets?: readonly string[] };

/**
 * What an `edges` entry resolves to: another node name (auto-edge), the
 * terminal sentinel `"stop"`, or a function chosen at run-time.
 */
export type EdgeTarget = string | EdgeFn;

/**
 * A node in the workflow graph. The node's identity is the surrounding
 * `Workflow.nodes` record key. `skill` is the Pi skill body to invoke —
 * defaulted to the record key by the runner when omitted, so the
 * authoring-time call site usually doesn't restate the name. Set `skill`
 * explicitly only when the node id and the Pi skill differ (aliased
 * nodes like `implement-after-revise` invoking the `implement` skill).
 *
 * Pi resolves the skill at run time; there's no allowlist gate. If Pi
 * can't load the skill, the runner halts with a clear error pointing
 * at this node.
 */
export interface NodeDef {
	skill?: string;
	completionStrategy: CompletionStrategy;
	sessionPolicy: SessionPolicy;
	extractor?: Extractor;
	outputSchema?: NodeSchema;
	inputSchema?: NodeSchema;
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

/**
 * Artifact-emitting node: invokes a Pi skill that writes
 * `.rpiv/artifacts/<bucket>/<file>.md`. Defaults to fresh-session. The
 * skill body defaults to the surrounding `nodes` record key — override
 * via `{ skill: "<other>" }` only when the node id and the Pi skill
 * differ (e.g. `code-review-large` aliasing the `code-review` skill).
 */
export function artifact(overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		completionStrategy: "artifact-emit",
		sessionPolicy: "fresh",
		...overrides,
	};
}

/**
 * Action node: invokes a Pi skill whose side effect IS the work
 * (commit, implement). No artifact-emission check. Defaults to fresh-session.
 * Like `artifact`, the skill body defaults to the record key.
 */
export function action(overrides: Partial<NodeDef> = {}): NodeDef {
	return {
		completionStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	};
}

// ===========================================================================
// Predicate builders — common patterns
// ===========================================================================

/**
 * Internal marker attached by predicate factories that read from
 * `manifest.data` (e.g. `threshold`). `validate.ts:checkPredicateSchemas`
 * scopes its `outputSchema`-missing warning to predicates carrying this
 * marker, so hand-rolled predicates that only consult `state` or
 * `manifest.meta` don't trip false positives.
 *
 * Exported as a `Symbol.for` so it survives `import` boundaries cleanly.
 */
export const READS_FRONTMATTER: unique symbol = Symbol.for("rpiv.workflow.readsFrontmatter");

/**
 * Promote a hand-rolled `EdgePredicate` to an `EdgeFn` by structurally
 * attaching the set of possible returns. `validate.ts` requires every
 * EdgeFn to carry `.targets` so reachability and load-time edge-target
 * checks see every branch; this factory is the only blessed way to author
 * a multi-branch predicate.
 *
 * Throws if `targets` is empty — a predicate that can't return anything
 * declared is by definition a bug.
 */
export function definePredicate(targets: readonly string[], fn: EdgePredicate): EdgeFn {
	if (targets.length === 0) {
		throw new Error("definePredicate: targets must declare at least one possible return value");
	}
	const wrapped = fn as EdgeFn;
	wrapped.targets = [...targets];
	return wrapped;
}

/**
 * `ifAbove` when `Number(manifest.data[field] ?? 0) > threshold`, else `ifBelow`.
 * Built on `definePredicate` so the contract is enforced structurally.
 * Marks the returned EdgeFn with `READS_FRONTMATTER` so the predicate-schema
 * lint can warn when the source node has no `outputSchema`.
 */
export function threshold(field: string, n: number, ifAbove: string, ifBelow: string): EdgeFn {
	const fn = definePredicate([ifAbove, ifBelow], predicateThreshold(field, n, ifAbove, ifBelow));
	(fn as unknown as Record<symbol, boolean>)[READS_FRONTMATTER] = true;
	return fn;
}
