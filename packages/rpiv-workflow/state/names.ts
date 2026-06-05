/**
 * Sidecar `names.json` index — maps human-readable run names to runIds for
 * O(1) resolution. Lives in `<cwd>/.rpiv/workflows/runs/names.json`, alongside
 * the JSONL audit files.
 *
 * Internal module — not re-exported from registration.ts. The runner calls
 * `readNamesIndex` for collision pre-flight and `addNameToIndex` after
 * `writeHeader`. External consumers resolve names through `resolveRun`.
 *
 * Fail-soft like every state-layer module: readers return `undefined` or empty
 * on failure; writers warn via `console.warn` with `[rpiv-workflow]` prefix.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { namesFilePath, runsDir, stateFilePath } from "./paths.js";

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
		console.warn(`[rpiv-workflow] names index: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Add a name → runId mapping to the index. Reads the current index, adds the
 * entry, and writes back. Creates the file if it doesn't exist. Returns `true`
 * on success, `false` on failure (warns to stderr).
 *
 * Does NOT check for collisions — callers handle that before calling.
 */
export function addNameToIndex(cwd: string, name: string, runId: string): boolean {
	try {
		const current = readNamesIndex(cwd) ?? {};
		current[name] = runId;
		const dir = runsDir(cwd);
		mkdirSync(dir, { recursive: true });
		writeFileSync(namesFilePath(cwd), `${JSON.stringify(current)}\n`, "utf-8");
		return true;
	} catch (e) {
		console.warn(`[rpiv-workflow] names index: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/**
 * Claim a name for a run: validate → collision-check → persist, in that order.
 * The single transactional door for reserving a name; callers must claim
 * BEFORE writing the JSONL header so the collision guard's truth-source (the
 * index) can never lag the header. On any non-`ok` result nothing is written.
 */
export function claimName(cwd: string, name: string, runId: string): ClaimResult {
	if (!isValidName(name)) return { ok: false, reason: "invalid" };
	const existing = readNamesIndex(cwd)?.[name];
	if (existing) return { ok: false, reason: "collision", runId: existing };
	if (!addNameToIndex(cwd, name, runId)) return { ok: false, reason: "write-failed" };
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
		const dir = runsDir(cwd);
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return undefined;
		}

		const index: NamesIndex = {};
		for (const fileName of entries) {
			if (!fileName.endsWith(".jsonl")) continue;
			const runId = fileName.slice(0, -".jsonl".length);
			// Read only the name field from the JSONL header — avoids importing
			// readHeader from reads.ts (which would create a circular dependency
			// since reads.ts imports readNamesIndex from this module).
			const name = readNameFromJsonlHeader(cwd, runId);
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

		mkdirSync(dir, { recursive: true });
		writeFileSync(namesFilePath(cwd), `${JSON.stringify(index)}\n`, "utf-8");
		return index;
	} catch (e) {
		console.warn(`[rpiv-workflow] names index rebuild: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

/**
 * Read only the `name` field from a JSONL run file's header line. Returns
 * `undefined` when the file is missing, the first line isn't valid JSON, or
 * the header has no `name` field. Intentionally does not validate the full
 * header shape — rebuildIndex only needs the name, not the typed WorkflowHeader.
 *
 * Internal helper — not exported. Keeps names.ts acyclic with reads.ts.
 */
function readNameFromJsonlHeader(cwd: string, runId: string): string | undefined {
	try {
		const filePath = stateFilePath(cwd, runId);
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const firstLine = content.split("\n", 1)[0] ?? "";
		if (!firstLine) return undefined;
		const parsed: unknown = JSON.parse(firstLine);
		return typeof (parsed as Record<string, unknown>)?.name === "string"
			? ((parsed as Record<string, unknown>).name as string)
			: undefined;
	} catch {
		return undefined;
	}
}
