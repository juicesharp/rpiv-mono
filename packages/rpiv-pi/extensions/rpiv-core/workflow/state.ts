/**
 * JSONL state management for the /rpiv workflow command.
 *
 * Append-only audit trail at `.rpiv/workflows/<run-id>.jsonl`. Each line is a
 * self-contained JSON object recording a completed or failed workflow stage.
 * All I/O is fail-soft: errors are logged via console.warn, never thrown.
 *
 * Run-id generation reuses the slug pattern from skills/_shared/now.mjs.
 *
 * No ExtensionAPI dependency. Pure functions take explicit paths.
 *
 * appendFileSync + mkdirSync({recursive}) wrapped in try/catch follows the same
 * structural shape as packages/rpiv-voice/audio/error-log.ts, but logs via
 * console.warn with `[rpiv-pi]` prefix (matching session-hooks.ts) instead of
 * silently swallowing — error-log.ts is silent specifically to avoid TUI
 * corruption during voice recording; that hazard does not apply here.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a single workflow stage. */
export type StageStatus = "completed" | "failed" | "skipped" | "aborted";

/**
 * A single entry in the JSONL audit trail.
 *
 * The serialized JSON key for the position field is `stageNumber` — renamed
 * from the legacy `stage` to disambiguate from the broader concept of "stage"
 * (which is a node execution, not an integer index). JSONL files written by
 * older versions of this code used `stage`; readers below filter on
 * `stageNumber` only, so legacy files are silently skipped. Audit files are
 * debugging artifacts; no migration is provided.
 */
export interface WorkflowStage {
	/** 1-based stage index within the workflow. */
	stageNumber: number;
	/** Skill name (must match a DAG node). */
	skill: string;
	/** Path to the artifact produced by this stage (if any). */
	artifact?: string;
	/** Stage outcome. */
	status: StageStatus;
	/** ISO 8601 timestamp. */
	ts: string;
	/** Structured manifest produced by the stage extractor. */
	manifest?: Manifest;
}

/** Header entry — first line of the JSONL file. */
export interface WorkflowHeader {
	/** Unique run identifier (slug format: YYYY-MM-DD_HH-MM-SS). */
	runId: string;
	/** Preset name used for this run. */
	preset: string;
	/** User's original input text (feature description). */
	input: string;
	/** ISO 8601 timestamp of run start. */
	ts: string;
}

/** Routing decision audit row written to JSONL alongside stage rows. */
export interface RoutingAuditRow {
	type: "routing";
	fromStage: number;
	fromNode: string;
	decision: string;
	ts: string;
}

// ---------------------------------------------------------------------------
// Run-id generation (mirrors skills/_shared/now.mjs slug pattern)
// ---------------------------------------------------------------------------

/** 2 bytes → 4 hex chars; collision suffix for sub-second `/rpiv` invocations. */
const RUN_ID_SUFFIX_BYTES = 2;
/** Width of date/time components in the run-id slug: "01", "23", … */
const SLUG_FIELD_WIDTH = 2;
/** Length of "YYYY-MM-DDTHH:MM:SS" — strips the fractional + timezone tail of `toISOString()`. */
const ISO_DATETIME_LENGTH = 19;

/**
 * Generate a run-id slug from the given Date's local time components.
 * Format: YYYY-MM-DD_HH-MM-SS-<4hex> (local timezone + random suffix).
 *
 * The 4-hex suffix prevents collisions between `/rpiv` invocations that land
 * in the same calendar second; without it both would write to the same JSONL
 * file and produce interleaved step numbers.
 *
 * Tests can pin `suffix` for deterministic output.
 */
export function generateRunId(
	now: Date = new Date(),
	suffix: string = randomBytes(RUN_ID_SUFFIX_BYTES).toString("hex"),
): string {
	const pad = (n: number) => String(n).padStart(SLUG_FIELD_WIDTH, "0");
	const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	const slug = iso.slice(0, ISO_DATETIME_LENGTH).replaceAll(":", "-").replace("T", "_");
	return `${slug}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/** Resolve the workflows directory relative to cwd. */
export function resolveWorkflowsDir(cwd: string): string {
	return join(cwd, ".rpiv", "workflows");
}

/** Resolve the JSONL file path for a given run-id. */
export function resolveStateFile(cwd: string, runId: string): string {
	return join(resolveWorkflowsDir(cwd), `${runId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Write operations (fail-soft)
// ---------------------------------------------------------------------------

/**
 * Write the header (first line) of a workflow state file.
 * Creates the `.rpiv/workflows/` directory if needed.
 * Fail-soft: errors logged via console.warn, never thrown.
 */
export function writeHeader(cwd: string, header: WorkflowHeader): void {
	try {
		const dir = resolveWorkflowsDir(cwd);
		mkdirSync(dir, { recursive: true });
		const filePath = resolveStateFile(cwd, header.runId);
		const line = `${JSON.stringify(header)}\n`;
		appendFileSync(filePath, line, "utf-8");
	} catch (e) {
		console.warn(`[rpiv-pi] workflow state: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Append a completed or failed stage to the workflow state file.
 * Fail-soft: errors logged via console.warn, never thrown.
 *
 * Returns true on successful write, false if the underlying I/O failed.
 * Callers use the return value to keep in-memory stage counters aligned with
 * what actually landed on disk.
 */
export function appendStage(cwd: string, runId: string, stage: WorkflowStage): boolean {
	try {
		const dir = resolveWorkflowsDir(cwd);
		mkdirSync(dir, { recursive: true });
		const filePath = resolveStateFile(cwd, runId);
		const line = `${JSON.stringify(stage)}\n`;
		appendFileSync(filePath, line, "utf-8");
		return true;
	} catch (e) {
		console.warn(`[rpiv-pi] workflow state: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Read operations (fail-soft)
// ---------------------------------------------------------------------------

/**
 * Read all data lines (skipping the header at line 0) from the JSONL file,
 * filtering with the supplied type-narrowing predicate. Fail-soft: missing
 * file → empty array, parse/IO errors logged + empty array.
 */
function readJsonlRows<T>(cwd: string, runId: string, match: (row: unknown) => row is T): T[] {
	try {
		const filePath = resolveStateFile(cwd, runId);
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		const lines = content.split("\n");
		const rows: T[] = [];
		for (let i = 1; i < lines.length; i++) {
			const parsed = JSON.parse(lines[i]!);
			if (match(parsed)) rows.push(parsed);
		}
		return rows;
	} catch (e) {
		console.warn(`[rpiv-pi] workflow state: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
}

const isWorkflowStage = (row: unknown): row is WorkflowStage =>
	!!row && typeof (row as { stageNumber?: unknown }).stageNumber === "number";

/**
 * Read the last stage from the workflow state file.
 * Returns undefined if the file doesn't exist or has no stage entries.
 * The header line is skipped — only WorkflowStage entries are considered.
 */
export function readLastStage(cwd: string, runId: string): WorkflowStage | undefined {
	const stages = readJsonlRows(cwd, runId, isWorkflowStage);
	return stages.length ? stages[stages.length - 1] : undefined;
}

/**
 * Read all stages from the workflow state file (excluding header).
 * Returns empty array if file doesn't exist or has no stages.
 */
export function readAllStages(cwd: string, runId: string): WorkflowStage[] {
	return readJsonlRows(cwd, runId, isWorkflowStage);
}

// ---------------------------------------------------------------------------
// Routing audit rows
// ---------------------------------------------------------------------------

/**
 * Append a routing decision to the workflow JSONL.
 * Uses same file but with a non-stageNumber shape so readAllStages ignores it
 * (readAllStages filters on `typeof parsed.stageNumber === "number"` — routing
 * rows lack stageNumber and pass through harmlessly).
 */
export function appendRoutingDecision(cwd: string, runId: string, row: RoutingAuditRow): void {
	try {
		const dir = resolveWorkflowsDir(cwd);
		mkdirSync(dir, { recursive: true });
		const filePath = resolveStateFile(cwd, runId);
		appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf-8");
	} catch (e) {
		console.warn(`[rpiv-pi] workflow state: ${e instanceof Error ? e.message : String(e)}`);
	}
}

const isRoutingRow = (row: unknown): row is RoutingAuditRow => !!row && (row as { type?: unknown }).type === "routing";

/**
 * Read all routing decision rows from the workflow JSONL.
 * Filters for rows with type: "routing". Fail-soft per the file's conventions.
 */
export function readRoutingDecisions(cwd: string, runId: string): RoutingAuditRow[] {
	return readJsonlRows(cwd, runId, isRoutingRow);
}
