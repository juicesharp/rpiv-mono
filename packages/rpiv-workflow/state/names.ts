/**
 * Sidecar `names.json` index — maps human-readable run names to runIds for
 * O(1) resolution. Lives in `<cwd>/.rpiv/workflows/runs/names.json`, alongside
 * the JSONL audit files.
 *
 * Internal module — not re-exported from registration.ts. The runner reserves
 * names through `claimName` (the single in-process door: validate →
 * collision-check → persist) BEFORE `writeHeader`. External consumers resolve
 * names through `resolveRun`.
 *
 * Durability: every write goes through `writeNamesIndex` — temp file +
 * `renameSync`, so a crash mid-write can never tear the index. Concurrency:
 * there is NO cross-process lock — two `/wf` processes claiming names
 * simultaneously can race the read-modify-write (lost update / duplicate
 * claim). Accepted for now: the index is recoverable via `rebuildIndex`, and
 * a lock file is deferred (see the trigger-source concurrency note in
 * triggers.ts).
 *
 * Fail-soft like every state-layer module: readers return `undefined` or empty
 * on failure; writers warn via `console.warn` with `[rpiv-workflow]` prefix.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { formatError } from "../internal-utils.js";
import { namesFilePath, runsDir, stateFilePath } from "./paths.js";
import { enumerateRunIds, readFirstJsonlLine } from "./raw.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** name → runId mapping persisted in names.json. */
export type NamesIndex = Record<string, string>;

/** Outcome of `claimName` — a tagged result the caller maps to a UI string. */
export type ClaimResult =
	| { ok: true }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "collision"; runId: string }
	| { ok: false; reason: "write-failed" };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Well-formedness contract for a run name: 1-64 chars, leading letter/underscore. */
export const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function isValidName(name: string): boolean {
	return VALID_NAME.test(name);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read the names index from disk. Returns `undefined` when the file is
 * missing, empty, or contains invalid JSON. Never throws.
 */
export function readNamesIndex(cwd: string): NamesIndex | undefined {
	try {
		const filePath = namesFilePath(cwd);
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return undefined;
		const parsed: unknown = JSON.parse(content);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as NamesIndex;
	} catch (e) {
		console.warn(`[rpiv-workflow] names index: ${formatError(e)}`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * THE single write path for `names.json` — temp file + `renameSync` so a
 * crash mid-write tears the temp file, never the index (rename is atomic on
 * POSIX filesystems). Throws on failure; callers own the fail-soft warn.
 */
function writeNamesIndex(cwd: string, index: NamesIndex): void {
	const dir = runsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const target = namesFilePath(cwd);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(index)}\n`, "utf-8");
	renameSync(tmp, target);
}

/**
 * Add a name → runId mapping to the index and write it back atomically.
 * `current` is the index the caller already read (`claimName` reads it once
 * for the collision check — no second read widening the race window);
 * defaults to a fresh read for direct callers. Returns `true` on success,
 * `false` on failure (warns to stderr).
 *
 * Does NOT check for collisions — `claimName` (the only production caller)
 * handles that first. Deliberately NOT re-exported from the state barrels:
 * writing the index without the claim protocol would bypass the collision
 * guard. The module-level export exists for direct unit tests only.
 */
export function addNameToIndex(cwd: string, name: string, runId: string, current?: NamesIndex): boolean {
	try {
		const index = current ?? readNamesIndex(cwd) ?? {};
		index[name] = runId;
		writeNamesIndex(cwd, index);
		return true;
	} catch (e) {
		console.warn(`[rpiv-workflow] names index: ${formatError(e)}`);
		return false;
	}
}

/**
 * Roll back a claim made by `claimName` — for when the run start fails AFTER
 * the claim (the JSONL header append failed), so the index never points at a
 * run that doesn't exist on disk. Removes the entry only while it still maps
 * to `runId` (never clobbers a re-claim by another run). Fail-soft: a failed
 * rollback warns and leaves a stale entry, recoverable via `rebuildIndex`.
 */
export function releaseName(cwd: string, name: string, runId: string): void {
	try {
		const current = readNamesIndex(cwd);
		if (!current || current[name] !== runId) return;
		delete current[name];
		writeNamesIndex(cwd, current);
	} catch (e) {
		console.warn(`[rpiv-workflow] names index: ${formatError(e)}`);
	}
}

/**
 * Claim a name for a run: validate → collision-check → persist, in that
 * order, against ONE read of the index. The single in-process door for
 * reserving a name; callers must claim BEFORE writing the JSONL header so the
 * collision guard's truth-source (the index) can never lag the header. On any
 * non-`ok` result nothing is written.
 *
 * Not transactional ACROSS processes — see the module header's concurrency
 * note. Within one process the read→check→write sequence is atomic by
 * single-threadedness, and the rename-based write can't tear the file.
 */
export function claimName(cwd: string, name: string, runId: string): ClaimResult {
	if (!isValidName(name)) return { ok: false, reason: "invalid" };
	const current = readNamesIndex(cwd) ?? {};
	const existing = current[name];
	// Collision only when the holder actually exists on disk: a mapping whose
	// run file is gone is a stale entry (failed `releaseName` rollback,
	// hand-deleted run), so the name is re-claimable — `addNameToIndex` simply
	// overwrites it. A concurrent claimant inside its own claim→header window
	// could be misread as stale, but that window is two consecutive
	// synchronous calls and falls under the module header's accepted
	// cross-process race.
	if (existing && existsSync(stateFilePath(cwd, existing))) {
		return { ok: false, reason: "collision", runId: existing };
	}
	if (!addNameToIndex(cwd, name, runId, current)) return { ok: false, reason: "write-failed" };
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Rebuild the names index by scanning all JSONL headers. Overwrites the
 * existing `names.json` unconditionally. Skips runs without a `name` field.
 * Returns the rebuilt index, or `undefined` on failure.
 */
export function rebuildIndex(cwd: string): NamesIndex | undefined {
	try {
		const index: NamesIndex = {};
		for (const runId of enumerateRunIds(cwd)) {
			// Read only the name field off the raw first line (shared `raw.ts`
			// leaf) — the full typed WorkflowHeader isn't needed here.
			const header = readFirstJsonlLine(cwd, runId) as Record<string, unknown> | undefined;
			const name = typeof header?.name === "string" ? header.name : undefined;
			if (name) {
				// readdirSync order is filesystem-dependent — surface duplicate
				// claims instead of silently picking a winner.
				if (index[name] && index[name] !== runId) {
					console.warn(
						`[rpiv-workflow] names index rebuild: duplicate name '${name}' claimed by runs ${index[name]} and ${runId} — keeping ${runId}`,
					);
				}
				index[name] = runId;
			}
		}

		writeNamesIndex(cwd, index);
		return index;
	} catch (e) {
		console.warn(`[rpiv-workflow] names index rebuild: ${formatError(e)}`);
		return undefined;
	}
}
