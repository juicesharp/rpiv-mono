/**
 * Path + run-id helpers for the JSONL audit store. Pure functions —
 * no I/O. Writes and reads import from here so the on-disk layout has
 * one authoritative source.
 *
 *   <cwd>/.rpiv/workflows/runs/<run-id>.jsonl
 *
 * The slug format mirrors `skills/_shared/now.mjs` so audit files
 * sort chronologically by filename.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";

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

export function runsDir(cwd: string): string {
	return join(cwd, ".rpiv", "workflows", "runs");
}

export function namesFilePath(cwd: string): string {
	return join(runsDir(cwd), "names.json");
}

export function stateFilePath(cwd: string, runId: string): string {
	return join(runsDir(cwd), `${runId}.jsonl`);
}
