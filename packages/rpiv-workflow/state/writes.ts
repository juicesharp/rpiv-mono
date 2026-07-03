/**
 * Fail-soft JSONL appends. Every public helper here is a thin wrapper
 * around `tryAppendJsonl` so the WRITE protocol (mkdirSync + append +
 * stderr warn on throw) lives in one place — changes to append atomicity
 * or checksums touch this file only. This is NOT a full storage-backend
 * seam: `reads.ts`, `raw.ts`, and `names.ts` hit `node:fs` directly, so
 * swapping the backend means touching all of `state/` (a `RunStore` port
 * is a known possible follow-up, deliberately deferred).
 *
 *   writeHeader              — boolean; the runner refuses the run start on failure.
 *   appendStage              — boolean; allocator gates monotonic counters on it.
 *   appendRoutingDecision    — boolean; telemetry-not-state, dropped rows surface up.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { formatError } from "../internal-utils.js";
import { runsDir, stateFilePath } from "./paths.js";
import type { LoopCapRow, RoutingDecision, WorkflowHeader, WorkflowStage } from "./state.js";

/**
 * Shared append primitive: ensure the runs directory exists, then
 * append one JSON-serialised row + newline. Returns true on success;
 * on any throw, warns to stderr and returns false. The public append
 * helpers below are thin wrappers — every caller gates on the boolean.
 */
function tryAppendJsonl(cwd: string, runId: string, row: unknown): boolean {
	try {
		const dir = runsDir(cwd);
		mkdirSync(dir, { recursive: true });
		const filePath = stateFilePath(cwd, runId);
		appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf-8");
		return true;
	} catch (e) {
		console.warn(`[rpiv-workflow] workflow state: ${formatError(e)}`);
		return false;
	}
}

/**
 * Returns true on successful write. A lost header makes the run unlistable
 * (`listRuns` keys on line one) and unresumable (`resolveRun` can't find it)
 * while stage rows still land — so `runWorkflow` refuses the run start on
 * false, before anything has executed.
 */
export function writeHeader(cwd: string, header: WorkflowHeader): boolean {
	return tryAppendJsonl(cwd, header.runId, header);
}

/** Returns true on successful write — callers gate counters on this. */
export function appendStage(cwd: string, runId: string, stage: WorkflowStage): boolean {
	return tryAppendJsonl(cwd, runId, stage);
}

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

/**
 * Append a loop-cap telemetry row (an `onCap: "advance"` trip). Telemetry,
 * not a reconstruction input — a dropped write degrades the trail but never
 * gates the chain (the live soft-stop toast is the user-facing signal).
 */
export function appendLoopCap(cwd: string, runId: string, row: LoopCapRow): boolean {
	return tryAppendJsonl(cwd, runId, row);
}
