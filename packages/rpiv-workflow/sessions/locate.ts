/**
 * Child-session file layout — the two operations keyed off `childSessionsDir`:
 * LOCATE one session by id (session-backed resume) and PRUNE the orphans (the
 * run-end sweep). `SessionRef.file` is a HINT captured at activation time —
 * sessions move (Pi renames on label change), get cleaned up, or live on another
 * machine. `locateSessionFile` resolves id → on-disk path with a three-rung
 * fallback; `null` means "fall back to cold re-run" (the caller's ladder
 * notifies). `pruneOrphanedChildSessions` removes files no persisted row points
 * at.
 *
 * `node:fs` only — no Pi import; unit-testable with temp dirs. Fail-soft
 * throughout: any fs error degrades to the next rung, never throws.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
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

/**
 * Orphan sweep — delete every persisted child-session file under the run's
 * `childSessionsDir` whose session id NO entry in `referenced` carries. Run ONCE
 * at run end (`executeRun`), after every child is torn down and every row is
 * written, so the keep-set is complete.
 *
 * The orphan source today is a `continue` fork whose stage threw between
 * `SessionManager.forkFrom` (which wrote the fork file) and its first audit-row
 * write: `recordEntryThrow` pins `session: null` on the failure row, so no row
 * references the fork (an aborted fresh child is the same shape). Deleting it is
 * SAFE because resume only ever reattaches/forks a file some persisted row
 * references — or `lastSession`, itself a referenced session — so an unreferenced
 * file is never consulted; removing it cannot strand a resumable session.
 *
 * CONSERVATIVE by construction: a file is removed ONLY when its header id is
 * positively read AND absent from `referenced`. An unreadable header keeps the
 * file (a leftover orphan is the harmless status quo; deleting a referenced file
 * is not). Best-effort — a missing dir or an unlink race never throws.
 */
export function pruneOrphanedChildSessions(cwd: string, runId: string, referenced: ReadonlySet<string>): void {
	const dir = childSessionsDir(cwd, runId);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // no child-sessions dir (no detached child ran) — nothing to sweep
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(dir, entry);
		const id = headerIdOf(path);
		if (id === undefined || referenced.has(id)) continue; // unidentifiable / referenced → keep
		try {
			rmSync(path);
		} catch {
			// best-effort — an already-removed file / concurrent reader is fine
		}
	}
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
