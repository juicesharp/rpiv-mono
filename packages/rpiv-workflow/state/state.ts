/**
 * JSONL state at `.rpiv/workflows/<run-id>.jsonl`. Append-only audit
 * trail; every line is a self-contained JSON object. All I/O is
 * fail-soft (logs via console.warn with `[rpiv-workflow]` prefix, never
 * throws).
 *
 * Internally split into three modules:
 *   - paths.ts  — workflowsDir + stateFilePath + generateRunId
 *   - writes.ts — tryAppendJsonl + writeHeader + appendStage +
 *                 appendRoutingDecision
 *   - reads.ts  — readLastStage + readAllStages + readRoutingDecisions +
 *                 listArtifacts + readHeader + listRuns
 *
 * This file owns the row shapes + types + the public barrel; everything
 * else lives in a focused module.
 */

import type { Output } from "../output.js";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type StageStatus = "completed" | "failed" | "skipped" | "aborted";

/**
 * Audit files are debug artifacts — no migration provided. Readers
 * shape-filter on `stageNumber`, so any rows that don't satisfy the
 * current shape are silently skipped.
 *
 * The row no longer carries a top-level `artifact` field — discovery
 * moved into the collector, and the canonical artifact list lives on
 * `output.artifacts`. Readers project from there via `listArtifacts`.
 */
export interface WorkflowStage {
	stageNumber: number;
	skill: string;
	status: StageStatus;
	ts: string;
	output?: Output;
}

/** First line of the JSONL file. */
export interface WorkflowHeader {
	runId: string;
	workflow: string;
	input: string;
	ts: string;
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

export { generateRunId, stateFilePath, workflowsDir } from "./paths.js";
export {
	listArtifacts,
	listRuns,
	readAllStages,
	readHeader,
	readLastStage,
	readRoutingDecisions,
} from "./reads.js";
export { appendRoutingDecision, appendStage, writeHeader } from "./writes.js";
