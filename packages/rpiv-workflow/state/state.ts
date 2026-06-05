/**
 * JSONL state at `.rpiv/workflows/runs/<run-id>.jsonl`. Append-only audit
 * trail; every line is a self-contained JSON object. All I/O is
 * fail-soft (logs via console.warn with `[rpiv-workflow]` prefix, never
 * throws).
 *
 * Internally split into three modules:
 *   - paths.ts  — runsDir + stateFilePath + generateRunId
 *   - writes.ts — tryAppendJsonl + writeHeader + appendStage +
 *                 appendRoutingDecision
 *   - reads.ts  — readLastStage + readAllStages + readRoutingDecisions +
 *                 listArtifacts + readHeader + listRuns
 *
 * This file owns the row shapes + types + the public barrel; everything
 * else lives in a focused module.
 */

import type { Output } from "../output.js";
import type { RunTrigger } from "../triggers.js";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type StageStatus = "completed" | "failed" | "skipped" | "aborted";

/**
 * Audit files are debug artifacts — no migration provided. Readers
 * shape-filter on `stageNumber`, so any rows that don't satisfy the
 * current shape are silently skipped.
 *
 * Two identity fields:
 *  - `stage` — the workflow stage's record key. Always present. The
 *    audit row's "which step ran" answer; stable across skill-body
 *    overrides and aliased stages.
 *  - `skill?` — the Pi skill body invoked, when this row records a
 *    skill stage. Absent for script stages (`StageDef.run`); equal to
 *    `stage` in the common case where `produces()` / `acts()` defaults
 *    the skill body to the record key.
 *
 * The row no longer carries a top-level `artifact` field — discovery
 * moved into the collector, and the canonical artifact list lives on
 * `output.artifacts`. Readers project from there via `listArtifacts`.
 */
export interface WorkflowStage {
	stageNumber: number;
	stage: string;
	skill?: string;
	status: StageStatus;
	ts: string;
	output?: Output;
	/**
	 * Reason a terminal-failure row was written — mirrors the
	 * `state.termination.error` set by `recordTerminalFailure`. Present
	 * only on `status: "failed" | "aborted"` rows; absent on completed /
	 * skipped rows. Persisting it here means post-mortems work from
	 * JSONL alone, without depending on a transient `ctx.ui.notify` toast.
	 */
	errMsg?: string;
}

/** First line of the JSONL file. */
export interface WorkflowHeader {
	runId: string;
	workflow: string;
	input: string;
	ts: string;
	/**
	 * What triggered the run. Optional so older JSONL files (written
	 * before the trigger field was added) still parse — readers treat
	 * `undefined` as "trigger unknown."
	 */
	trigger?: RunTrigger;
	/** Human-readable alias assigned at creation via `--name`. Optional so
	 * older JSONL files (written before the name field was added) still parse. */
	name?: string;
}

/**
 * Returned by `listRuns` — projection of a JSONL header for past-run
 * enumeration UIs. Distinct from `WorkflowHeader` only by intent (this
 * is the "what you see in a list" shape); kept structurally compatible
 * so callers that want the raw header can pass `RunSummary` through.
 */
export interface RunSummary {
	runId: string;
	/** Workflow name (matches `Workflow.name` at run-time). */
	workflow: string;
	/** Original `/wf` input the user typed. */
	input: string;
	/** ISO-8601 timestamp the run started at — slug-sortable. */
	ts: string;
	/** Mirrors `WorkflowHeader.trigger`; undefined for legacy rows. */
	trigger?: RunTrigger;
	/** Mirrors `WorkflowHeader.name`; undefined for unnamed runs. */
	name?: string;
}

export interface RoutingDecision {
	type: "routing";
	fromStageIndex: number;
	fromStage: string;
	decision: string;
	ts: string;
}

// ---------------------------------------------------------------------------
// Public barrel — paths + writes + reads
// ---------------------------------------------------------------------------

export {
	addNameToIndex,
	type ClaimResult,
	claimName,
	isValidName,
	type NamesIndex,
	readNamesIndex,
	rebuildIndex,
	VALID_NAME,
} from "./names.js";
export { generateRunId, namesFilePath, runsDir, stateFilePath } from "./paths.js";
export {
	listArtifacts,
	listRuns,
	readAllStages,
	readHeader,
	readLastStage,
	readRoutingDecisions,
	resolveRun,
} from "./reads.js";
export { appendRoutingDecision, appendStage, writeHeader } from "./writes.js";
