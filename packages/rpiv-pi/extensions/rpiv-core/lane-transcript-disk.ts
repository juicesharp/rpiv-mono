/**
 * lane-transcript-disk — the DURABLE transcript fallback.
 *
 * When a retired lane has neither a live session nor an in-memory `finalBranch`
 * snapshot, the full session jsonl still exists on disk under the run dir. This
 * module re-opens it through the SDK's own `SessionManager.open` — the SAME branch
 * shape the live viewer renders — so the disk path reuses the exact `renderBranch`
 * pipeline (no bespoke jsonl parser). Strictly read-only and fail-soft: any
 * resolution/parse/open error degrades to `undefined`, and the viewer keeps its
 * `(no transcript)` placeholder.
 *
 * Path resolution prefers the lane's recorded `lastSessionFile` (an absolute path
 * captured when the child spawned); failing that it globs the run's session dir
 * — `<cwd>/.rpiv/workflows/runs/<runId>/sessions/*.jsonl` — where `runId` IS the
 * run-dir name (rpiv-workflow state/paths.ts childSessionsDir), newest by mtime.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RenderSource, ToolDefArg, ViewerEntry } from "./lane-transcript.js";

/** A branch loaded from disk plus the render source the transcript pipeline needs. */
export interface DiskBranch {
	entries: ViewerEntry[];
	source: RenderSource;
}

/**
 * Resolve the session file to open: the recorded `lastSessionFile` if it still
 * exists, else the newest `*.jsonl` under the run's session dir. Returns undefined
 * when nothing resolves (the dir is absent or empty). Fail-soft on any fs error.
 */
function resolveSessionFile(runId: string, lastSessionFile: string | undefined, cwd: string): string | undefined {
	try {
		if (lastSessionFile && existsSync(lastSessionFile)) return lastSessionFile;
		// runId IS the run-dir name — childSessionsDir(cwd, runId) layout.
		const dir = join(cwd, ".rpiv", "workflows", "runs", runId, "sessions");
		if (!existsSync(dir)) return undefined;
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		if (files.length === 0) return undefined;
		// Newest by mtime — the most-recent child is the relevant transcript tail.
		let newest: { file: string; mtimeMs: number } | undefined;
		for (const f of files) {
			const full = join(dir, f);
			const mtimeMs = statSync(full).mtimeMs;
			if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
		}
		return newest?.file;
	} catch {
		return undefined;
	}
}

/**
 * Load a run's transcript branch from its on-disk session jsonl. Prefers
 * `lastSessionFile`; falls back to a newest-jsonl glob of the run's session dir
 * (`cwd` defaults to the launcher's working directory). Returns undefined — fail-soft —
 * when the file can't be resolved, opened, or carries no entries.
 *
 * Tool definitions degrade to the built-in fallback renderer (the live `getToolDefinition`
 * is gone once the run ended) — an accepted degrade: text/diffs still render, only
 * per-tool custom renderers fall back. cwd comes from the session header (`getCwd`).
 */
export function loadBranchFromDisk(
	runId: string,
	lastSessionFile?: string,
	cwd: string = process.cwd(),
): DiskBranch | undefined {
	try {
		const file = resolveSessionFile(runId, lastSessionFile, cwd);
		if (!file) return undefined;
		const manager = SessionManager.open(file);
		const entries = (manager.getBranch() as ViewerEntry[] | undefined) ?? [];
		if (entries.length === 0) return undefined;
		const source: RenderSource = {
			cwd: manager.getCwd(),
			// No live session → no per-tool defs; the component falls back to its generic renderer.
			toolDef: (): ToolDefArg => undefined,
		};
		return { entries, source };
	} catch {
		return undefined;
	}
}
