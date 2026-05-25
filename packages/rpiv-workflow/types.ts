/**
 * Runtime types. Three nouns flow through the workflow runtime:
 *
 *  - `RunContext` — per-run carry (cwd, runId, workflow, state, visited, host,
 *    maxBackwardJumps). Read by every layer; mutated only by the runner.
 *  - `RunState` — mutable bookkeeping (manifest, counters, telemetry,
 *    termination). Read by every layer; mutated by the runner + the audit
 *    layer. Always read the chain's primary artifact via
 *    `currentPrimaryArtifact(state)` (internal-utils.ts) — it prefers
 *    `manifest.artifacts[0]` and falls back to `fallbackPrimaryArtifact`.
 *  - `RunnerCtx` — Pi command ctx augmented with idle-await guarantees;
 *    threaded from `withSession` callbacks down through stage/phase helpers.
 *
 * Per-stage / per-phase sessions extend a shared `SessionContext` base
 * (cwd, runId, state, prompt, skill). The audit layer pins its dependency
 * on this base structurally via `AuditCtx = Pick<SessionContext, ...>`.
 *
 * Lives apart from runner.ts / sessions.ts so both can reference the same
 * shapes without a runtime import cycle (type-only refs back via this
 * module are cycle-free).
 */

import type { StageDef, Workflow } from "./api.js";
import type { Artifact } from "./handle.js";
import type { WorkflowCommandHost, WorkflowHost } from "./host.js";
import type { Manifest } from "./manifest.js";

/**
 * Per-stage runtime ctx. Alias for `WorkflowCommandHost` (the port) —
 * kept as a domain noun ("the runner's command ctx") so consumers can
 * read stage/phase code without learning the port name. Identical
 * shape; rename-only.
 */
export type RunnerCtx = WorkflowCommandHost;

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	// ── Identity ────────────────────────────────────────────────────────
	/** Frozen — the user's `/wf` argument. */
	originalInput: string;

	// ── Progress (hot paths — runner reads on every stage) ─────────────
	/**
	 * Chain-input artifact — the rolling slot the next stage's prompt
	 * inherits as input. Updated ONLY by produces stages whose
	 * collector returned at least one artifact (the first becomes the new
	 * primary). Side-effect stages (commit, side-effect) record their own
	 * manifest but do not touch this slot — preserves the "commit
	 * inherits the prior chain's artifact" semantic without forcing
	 * side-effect collectors to re-emit the prior list.
	 *
	 * Reads must go through `currentPrimaryArtifact(state)`
	 * (internal-utils.ts); a direct read here is a hint of a missed
	 * accessor.
	 */
	primaryArtifact: Artifact | undefined;
	manifest: Manifest | undefined;
	/** Stages whose JSONL row landed on disk. */
	stagesCompleted: number;
	/** Most recently allocated stageNumber. Advances on every recordStage call. */
	lastAllocatedStageNumber: number;

	// ── Telemetry (post-hoc only; not consulted by chain advancement) ──
	telemetry: {
		backwardJumps: number;
		/**
		 * Routing rows whose JSONL append failed mid-run. The chain advanced
		 * past them (routing rows are write-only telemetry, not
		 * reconstruction inputs), but the final result envelope surfaces this
		 * so post-hoc readers can distinguish "deterministic edge — no row
		 * written by design" from "decision made — write was dropped." Empty
		 * in the common case.
		 */
		droppedRoutingRows: Array<{ fromStageIndex: number; fromStage: string; decision: string }>;
	};

	// ── Termination (set once at end-of-run) ───────────────────────────
	termination: {
		success: boolean;
		error: string | undefined;
	};
}

/** Per-run context the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	workflow: Workflow;
	/**
	 * Upper bound for stage status display — count of stages reachable from
	 * `workflow.start`, computed once at run start. The actual stage count
	 * is path-dependent (a predicate edge may short-circuit), so this is
	 * the denominator users see; the numerator is the live stage index.
	 */
	totalStages: number;
	state: RunState;
	/**
	 * Stage names already executed in this run. The backward-jump guard
	 * increments `state.telemetry.backwardJumps` on every re-entry; revise →
	 * implement loops legitimately revisit stages, but unbounded loops trip
	 * the cap.
	 */
	visited: Set<string>;
	/** Required for "continue"-policy stages. */
	host?: WorkflowHost;
	maxBackwardJumps: number;
}

/**
 * Per-stage / per-unit common base. Extended by `StageSession` and
 * `FanoutSession`; consumed in pick form by `AuditCtx` (audit.ts) so the audit
 * layer pins its dependency on the four-field shape structurally instead of
 * duplicating the field list.
 */
export interface SessionContext {
	cwd: string;
	runId: string;
	state: RunState;
	/** `/skill:<name> <args>`. */
	prompt: string;
	/** Status-line + JSONL "skill" label. */
	skill: string;
}

export interface StageSession extends SessionContext {
	stage: StageDef;
	/** 0-based stage index within this run — for status display + JSONL stage number. */
	stageIndex: number;
	/** Pre-stage snapshot value (undefined if the stage's `outcome` has no `snapshot`). */
	snapshot: unknown;
	/** Required iff `stage.sessionPolicy === "continue"`. */
	host?: WorkflowHost;
	/** Only set for continue stages — branch slice offset. */
	branchOffset?: number;
	onFailure?: (ctx: RunnerCtx) => void;
	onSuccess: (ctx: RunnerCtx, artifact: Artifact | undefined) => Promise<void>;
}

/**
 * One unit of a fanout iteration. `label` is the user-supplied
 * disambiguating tag from `FanoutUnit.label`; it's woven into both the
 * status line (`STATUS_FANOUT_UNIT`) and the JSONL row (`fanoutRowLabel`)
 * so the runner adds no implicit wording.
 */
export interface FanoutSession extends SessionContext {
	/** 1-based position within the run's fanout array — for halt diagnostics. */
	unitIndex: number;
	/** From `FanoutUnit.label` — already disambiguating, e.g. `"phase 2/5"`. */
	label: string;
	/** Parent stage's 0-based index. */
	stageIndex: number;
	onSuccess: (ctx: RunnerCtx) => Promise<void>;
}
