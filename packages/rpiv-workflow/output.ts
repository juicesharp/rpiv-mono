/**
 * Output envelope — the inter-stage data channel a stage's collector +
 * parser produce on settlement. Flows through `RunState`, persists to
 * the JSONL audit log, and is read by downstream predicates / stages.
 *
 * Audience: predicate authors and downstream-stage authors reading
 * `output.artifacts` (the storage references) and `output.data`
 * (the typed channel a parser shaped). The producer-side surface
 * (`ArtifactCollector` / `ArtifactParser` / `Outcome`) lives in
 * `output-spec.ts`.
 */

import type { Artifact } from "./handle.js";

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
// Tagged-union narrowing convenience for consumers. Only the two
// framework-native kinds live here; outcome-specific aliases live with
// their producing outcome (`GitCommitOutput` → outcomes/git-commit.ts) so
// the core envelope module never enumerates concrete plugins (G6).
// ---------------------------------------------------------------------------

export type ArtifactsOutput = Output<"artifacts", readonly Artifact[]>;
export type SideEffectOutput = Output<"side-effect", Record<string, never>>;

/**
 * A judge's graded output — structurally just an `Output` (the verdict is a
 * normal envelope published to the judge's named channel), named so judged
 * signatures (`done(verdict)`, `FeedForwardContext.verdict`) can say what
 * they mean.
 */
export type Verdict = Output;

// ---------------------------------------------------------------------------
// RunView — the user-facing read surface over a live run
// ---------------------------------------------------------------------------

/**
 * Deep-readonly view of a run's data channels — what user-authored functions
 * (edge predicates, script stages, loop unit sources, judges, collectors)
 * receive as `ctx.state`. The runner threads its live mutable `RunState`
 * here (it satisfies this shape structurally); the narrowed type is what
 * keeps a user fn from corrupting an audited run — `Readonly<RunState>` was
 * shallow, so `ctx.state.named["plans"].push(...)` compiled.
 *
 * Deliberately omits runner bookkeeping (`stagesCompleted`,
 * `lastAllocatedStageNumber`, `telemetry`, `termination`, the
 * accessor-guarded `primaryArtifact`) — those are runtime internals, not
 * authoring inputs. Adding a field later is non-breaking; removing one is
 * not, hence the minimal start.
 */
export interface RunView {
	/** The user's original `/wf` argument — frozen for the whole run. */
	readonly originalInput: string;
	/** The most recent completed stage's full `Output` envelope. */
	readonly output: Output | undefined;
	/**
	 * Named publish registry — each `produces` success APPENDS its envelope
	 * onto the slot named by `stage.outcome?.name ?? stage.<record-key>`.
	 * Slots are histories; read the latest via `named[name]?.at(-1)`.
	 */
	readonly named: { readonly [name: string]: readonly Output[] };
}

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
