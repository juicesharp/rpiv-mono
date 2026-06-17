/**
 * Session-file location for session-backed resume. `SessionRef.file` is a
 * HINT captured at activation time — sessions move (Pi renames on label
 * change), get cleaned up, or live on another machine. `locateSessionFile`
 * resolves id → on-disk path with a three-rung fallback; `null` means
 * "fall back to cold re-run" (the caller's ladder notifies).
 *
 * `node:fs` only — no Pi import; unit-testable with temp dirs. Fail-soft
 * throughout: any fs error degrades to the next rung, never throws.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionRef } from "../state/index.js";
import { childSessionsDir } from "../state/paths.js";

/**
 * id → on-disk session file. Fail-soft: `null` means "fall back to cold
 * re-run".
 *
 *   0. When a `runId`+`cwd` are known, try the run-scoped child dir by id
 *      FIRST (`childSessionsDir(cwd, runId)/<id>.jsonl`, O(1)) — detached
 *      children persist there keyed by `SessionRef.id`.
 *   1. `ref.file` exists on disk → use it (fast path).
 *   2. Else search `dirname(ref.file)` for `*_<id>.jsonl` (Pi's filename
 *      convention embeds the session id).
 *   3. Else scan each `.jsonl` header line in that dir for `id === ref.id`
 *      (robust against filename-convention drift).
 *   4. Else `null`.
 *
 * No `file` hint at all (in-memory session) → `null` immediately AFTER the
 * id-first rung: without the hint there is no directory to search.
 */
export function locateSessionFile(ref: SessionRef, runId?: string, cwd?: string): string | null {
	if (runId && cwd) {
		const candidate = join(childSessionsDir(cwd, runId), `${ref.id}.jsonl`);
		if (isFile(candidate)) return candidate;
	}
	if (!ref.file) return null;
	try {
		if (existsSync(ref.file) && statSync(ref.file).isFile()) return ref.file;
	} catch {
		// fall through to the directory rungs
	}

	const dir = dirname(ref.file);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}

	// Rung 2: Pi's filename embeds the id (`<timestamp>_<id>.jsonl`).
	for (const entry of entries) {
		if (!entry.endsWith(`_${ref.id}.jsonl`)) continue;
		const path = join(dir, entry);
		if (isFile(path)) return path;
	}

	// Rung 3: header scan — first JSONL line carries the session `id`.
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(dir, entry);
		if (isFile(path) && headerIdOf(path) === ref.id) return path;
	}
	return null;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Bounded prefix read — session files run to tens of MB; the header is line one. */
const HEADER_PREFIX_BYTES = 8192;

/** First-line `id` of a Pi session file, or undefined on any read/parse miss. */
function headerIdOf(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(HEADER_PREFIX_BYTES);
		const bytes = readSync(fd, buf, 0, HEADER_PREFIX_BYTES, 0);
		const firstLine = buf.toString("utf-8", 0, bytes).split("\n", 1)[0];
		if (!firstLine) return undefined;
		const parsed: unknown = JSON.parse(firstLine);
		const id = (parsed as { id?: unknown } | null)?.id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
