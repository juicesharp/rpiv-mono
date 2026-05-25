/**
 * JSONL state at `.rpiv/workflows/<run-id>.jsonl`. Append-only audit
 * trail; every line is a self-contained JSON object. All I/O is
 * fail-soft (logs via console.warn with `[rpiv-workflow]` prefix, never
 * throws).
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StageStatus = "completed" | "failed" | "skipped" | "aborted";

/**
 * Audit files are debug artifacts — no migration provided. Readers
 * shape-filter on `stageNumber`, so any rows that don't satisfy the
 * current shape are silently skipped.
 */
export interface WorkflowStage {
	stageNumber: number;
	skill: string;
	artifact?: string;
	status: StageStatus;
	ts: string;
	manifest?: Manifest;
}

/** First line of the JSONL file. */
export interface WorkflowHeader {
	runId: string;
	workflow: string;
	input: string;
	ts: string;
}

export interface RoutingDecision {
	type: "routing";
	fromStage: number;
	fromNode: string;
	decision: string;
	ts: string;
}

// ---------------------------------------------------------------------------
// Run-id generation (mirrors skills/_shared/now.mjs slug pattern)
// ---------------------------------------------------------------------------

/** 2 bytes → 4 hex chars; prevents sub-second `/wf` collisions. */
const RUN_ID_SUFFIX_BYTES = 2;
const SLUG_FIELD_WIDTH = 2;
/** "YYYY-MM-DDTHH:MM:SS" — strips fractional + timezone tail of toISOString. */
const ISO_DATETIME_LENGTH = 19;

/** Format: `YYYY-MM-DD_HH-MM-SS-<4hex>`. `suffix` overridable for tests. */
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

export function resolveWorkflowsDir(cwd: string): string {
	return join(cwd, ".rpiv", "workflows");
}

export function resolveStateFile(cwd: string, runId: string): string {
	return join(resolveWorkflowsDir(cwd), `${runId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Write operations (fail-soft)
// ---------------------------------------------------------------------------

/**
 * Shared append primitive: ensure the workflows directory exists, then
 * append one JSON-serialised row + newline. Returns true on success;
 * on any throw, warns to stderr and returns false. The three public
 * append helpers below are thin wrappers — `writeHeader` discards the
 * return (best-effort), the others gate counters / telemetry on it.
 */
function tryAppendJsonl(cwd: string, runId: string, row: unknown): boolean {
	try {
		const dir = resolveWorkflowsDir(cwd);
		mkdirSync(dir, { recursive: true });
		const filePath = resolveStateFile(cwd, runId);
		appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf-8");
		return true;
	} catch (e) {
		console.warn(`[rpiv-workflow] workflow state: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

export function writeHeader(cwd: string, header: WorkflowHeader): void {
	tryAppendJsonl(cwd, header.runId, header);
}

/** Returns true on successful write — callers gate counters on this. */
export function appendStage(cwd: string, runId: string, stage: WorkflowStage): boolean {
	return tryAppendJsonl(cwd, runId, stage);
}

// ---------------------------------------------------------------------------
// Read operations (fail-soft)
// ---------------------------------------------------------------------------

/**
 * Reads every line, filters by shape (not position). Header has no
 * `stageNumber`; routing rows carry `type: "routing"`; stage rows have
 * `stageNumber: number` and no `type`. Starting at line 0 keeps the first
 * stage row recoverable even if a transient writeHeader failure left the
 * file without its header.
 *
 * Each line's `JSON.parse` runs in its own try/catch — a truncated trailing
 * line (process killed mid-`appendFileSync`, ENOSPC, network FS hiccup)
 * MUST NOT erase prior rows. Malformed lines emit a one-shot warn and are
 * skipped; readers see every well-formed row that landed on disk.
 */
function readJsonlRows<T>(cwd: string, runId: string, match: (row: unknown) => row is T): T[] {
	let lines: string[];
	try {
		const filePath = resolveStateFile(cwd, runId);
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		lines = content.split("\n");
	} catch (e) {
		console.warn(`[rpiv-workflow] workflow state: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}

	const rows: T[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			console.warn(
				`[rpiv-workflow] workflow state: skipping malformed JSONL row — ${e instanceof Error ? e.message : String(e)}`,
			);
			continue;
		}
		if (match(parsed)) rows.push(parsed);
	}
	return rows;
}

const isWorkflowStage = (row: unknown): row is WorkflowStage =>
	!!row && typeof (row as { stageNumber?: unknown }).stageNumber === "number";

export function readLastStage(cwd: string, runId: string): WorkflowStage | undefined {
	const stages = readJsonlRows(cwd, runId, isWorkflowStage);
	return stages.length ? stages[stages.length - 1] : undefined;
}

export function readAllStages(cwd: string, runId: string): WorkflowStage[] {
	return readJsonlRows(cwd, runId, isWorkflowStage);
}

// ---------------------------------------------------------------------------
// Routing audit rows
// ---------------------------------------------------------------------------

/**
 * Returns true on successful write — callers surface the failure to the user
 * (warning notification + result-envelope flag) so an absent row is not silently
 * conflated with "deterministic edge, no decision recorded." Unlike `appendStage`,
 * a dropped routing row does NOT halt the chain: the routing decision has
 * already been made in memory (see runner.ts `nextNode`), and no in-memory
 * state mirrors routing rows the way it mirrors stage rows — routing is
 * write-only telemetry. Halting on telemetry failure would punish the user
 * for transient disk weather without preserving any invariant.
 */
export function appendRoutingDecision(cwd: string, runId: string, row: RoutingDecision): boolean {
	return tryAppendJsonl(cwd, runId, row);
}

const isRoutingDecision = (row: unknown): row is RoutingDecision =>
	!!row && (row as { type?: unknown }).type === "routing";

export function readRoutingDecisions(cwd: string, runId: string): RoutingDecision[] {
	return readJsonlRows(cwd, runId, isRoutingDecision);
}
