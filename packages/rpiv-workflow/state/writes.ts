/**
 * Fail-soft JSONL appends. Every public helper here is a thin wrapper
 * around `tryAppendJsonl` so the write protocol (mkdirSync + append +
 * stderr warn on throw) lives in one place — changes to atomicity,
 * checksums, or alternative storage backends touch this file and this
 * file only.
 *
 *   writeHeader              — best-effort; discards the return.
 *   appendStage              — boolean; allocator gates monotonic counters on it.
 *   appendRoutingDecision    — boolean; telemetry-not-state, dropped rows surface up.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolveStateFile, resolveWorkflowsDir } from "./paths.js";
import type { RoutingDecision, WorkflowHeader, WorkflowStage } from "./state.js";

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
