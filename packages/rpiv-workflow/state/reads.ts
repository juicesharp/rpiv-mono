/**
 * Fail-soft JSONL readers. Shape-filtered, never positional — the same
 * file can carry a header, stage rows, and routing rows, and readers
 * pluck whichever rows match their predicate.
 *
 * Per-line parse: each `JSON.parse` runs in its own try/catch — a single
 * truncated trailing line (process killed mid-append, ENOSPC, network
 * FS hiccup) MUST NOT erase prior rows.
 *
 * Public surface:
 *
 *   - Per-row readers (`readLastStage`, `readAllStages`,
 *     `readRoutingDecisions`) — open ONE run's JSONL and project rows
 *     of the matching shape.
 *   - Past-runs API (`readHeader`, `listRuns`, `listArtifacts`) —
 *     header-only or projection-only reads sized for inspect UIs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Artifact } from "../handle.js";
import { stateFilePath, workflowsDir } from "./paths.js";
import type { RoutingDecision, RunSummary, WorkflowHeader, WorkflowStage } from "./state.js";

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
		const filePath = stateFilePath(cwd, runId);
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

const isRoutingDecision = (row: unknown): row is RoutingDecision =>
	!!row && (row as { type?: unknown }).type === "routing";

const isWorkflowHeader = (row: unknown): row is WorkflowHeader =>
	!!row &&
	typeof (row as { runId?: unknown }).runId === "string" &&
	typeof (row as { workflow?: unknown }).workflow === "string" &&
	typeof (row as { input?: unknown }).input === "string" &&
	typeof (row as { ts?: unknown }).ts === "string";

// ---------------------------------------------------------------------------
// Per-run readers
// ---------------------------------------------------------------------------

export function readLastStage(cwd: string, runId: string): WorkflowStage | undefined {
	const stages = readJsonlRows(cwd, runId, isWorkflowStage);
	return stages.length ? stages[stages.length - 1] : undefined;
}

export function readAllStages(cwd: string, runId: string): WorkflowStage[] {
	return readJsonlRows(cwd, runId, isWorkflowStage);
}

export function readRoutingDecisions(cwd: string, runId: string): RoutingDecision[] {
	return readJsonlRows(cwd, runId, isRoutingDecision);
}

/**
 * Project a run's stage rows to the (skill, artifact) pairs that
 * actually carried at least one artifact. One entry per artifact —
 * stages with multi-artifact resolvers expand to N entries. Used by
 * `notifyPartialArtifacts` for the failure recap and by past-runs UIs
 * (the `listRuns` API) for run summaries.
 *
 * Reads from `output.artifacts` (single source); rows without an
 * output, or with an empty artifacts list, contribute nothing.
 */
export function listArtifacts(cwd: string, runId: string): Array<{ skill: string; artifact: Artifact }> {
	const out: Array<{ skill: string; artifact: Artifact }> = [];
	for (const s of readAllStages(cwd, runId)) {
		const artifacts = s.output?.artifacts;
		if (!artifacts) continue;
		for (const artifact of artifacts) out.push({ skill: s.skill, artifact });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Past-runs enumeration (header-only)
// ---------------------------------------------------------------------------

/**
 * Read only the first JSONL line and parse it as a `WorkflowHeader`. Used
 * by `listRuns` so enumerating N past runs reads N first-lines instead
 * of fully parsing every row in every file. Returns undefined when the
 * file is missing, empty, or the first line doesn't match the header
 * shape.
 *
 * Fail-soft like every other reader — never throws.
 */
export function readHeader(cwd: string, runId: string): WorkflowHeader | undefined {
	try {
		const filePath = stateFilePath(cwd, runId);
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const firstLine = content.split("\n", 1)[0] ?? "";
		if (!firstLine) return undefined;
		const parsed = JSON.parse(firstLine);
		return isWorkflowHeader(parsed) ? parsed : undefined;
	} catch {
		// Malformed JSON or I/O error — caller treats as "header unreadable".
		return undefined;
	}
}

/**
 * Enumerate every `<cwd>/.rpiv/workflows/<run-id>.jsonl` and return its
 * header projected as a `RunSummary`. Empty array when the workflows
 * directory doesn't exist (no runs yet). Files without a valid header
 * are skipped silently (corrupt / mid-write).
 *
 * Header-only reads — full stage rows aren't parsed (see `readHeader`'s
 * doc). Past-runs UIs page through the summary; opening a specific run
 * for inspection still calls `readAllStages` / `listArtifacts`.
 *
 * Sort is filesystem-order — callers that want chronological order can
 * sort by `ts` (run-id slug already encodes time, so a string sort on
 * `runId` is monotonic for runs created on the same host).
 */
export function listRuns(cwd: string): RunSummary[] {
	const dir = workflowsDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Directory doesn't exist (no runs yet) or unreadable — treat as empty.
		return [];
	}
	const summaries: RunSummary[] = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const runId = name.slice(0, -".jsonl".length);
		const header = readHeader(cwd, runId);
		if (header)
			summaries.push({ runId: header.runId, workflow: header.workflow, input: header.input, ts: header.ts });
	}
	return summaries;
}
