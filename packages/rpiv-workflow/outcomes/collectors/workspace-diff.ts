/**
 * Workspace-diff collector — emits one Artifact per file the stage
 * touched in the working tree.
 *
 * Discovery model: capture `git status --porcelain` pre-stage as
 * snapshot, then take the diff post-stage. Newly-untracked files and
 * files whose status changed both count. Pure git — no transcript
 * scanning, no tool-use observation, no agent narration involved.
 *
 * "Nothing found" posture (see `CollectResult`'s convention doc): a snapshot
 * that found no working git (not a repo, git not on PATH) degrades — the
 * collector returns `ok []` and the workflow keeps moving (same posture as
 * `gitCommitCollector`'s `baselineMissing`). But when git WORKED at snapshot
 * time and fails after the stage, that's an environment break mid-stage —
 * the collector returns `fatal` with the cause instead of conflating it
 * with "no changes."
 *
 * Optional `filter(path)` narrows the set — useful for "only `.ts`
 * files," "only files under `src/`," etc. Authors who want more
 * structural narrowing (per-file role tags, per-file metadata) write
 * a custom collector — `workspaceDiffCollector` deliberately stays the
 * thin diff primitive.
 */

import { type Artifact, fs as fsHandle } from "../../handle.js";
import type { ArtifactCollector, CollectContext, CollectResult, SnapshotContext } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";
import { execFileAsync, GIT_EXEC_TIMEOUT_MS } from "../exec.js";

export interface WorkspaceDiffSnapshot {
	/** Post-stage diff compares against this set of (path, statusCode) pairs captured pre-stage. */
	statusByPath: ReadonlyMap<string, string>;
}

export interface WorkspaceDiffCollectorOpts {
	/**
	 * Optional path predicate. Return true to include the file in the
	 * collected artifacts, false to drop it. Receives the cwd-relative
	 * path that `git status --porcelain` emitted.
	 */
	filter?: (path: string) => boolean;
}

export const workspaceDiffCollector = (
	opts: WorkspaceDiffCollectorOpts = {},
): ArtifactCollector<WorkspaceDiffSnapshot | undefined> =>
	defineCollector<WorkspaceDiffSnapshot | undefined>({
		snapshot: capturePorcelainSnapshot,
		collect: (ctx) => collectDiffArtifacts(ctx, opts.filter),
	});

// ---------------------------------------------------------------------------
// Snapshot + diff implementation
// ---------------------------------------------------------------------------

async function capturePorcelainSnapshot(ctx: SnapshotContext): Promise<WorkspaceDiffSnapshot | undefined> {
	const status = await runGitStatus(ctx.cwd);
	if (status === undefined) return undefined;
	return { statusByPath: parsePorcelain(status) };
}

async function collectDiffArtifacts(
	ctx: CollectContext<WorkspaceDiffSnapshot | undefined>,
	filter: ((path: string) => boolean) | undefined,
): Promise<CollectResult> {
	const snapshot = ctx.snapshot;
	// No baseline = the stage ran outside a (working) git repo — documented
	// degrade, not an error (see the module header).
	if (!snapshot) return { kind: "ok", artifacts: [] };

	const status = await runGitStatus(ctx.cwd);
	if (status === undefined) {
		// git worked at snapshot time and fails now — an environment break,
		// not "no changes." `ok []` here would route downstream logic on
		// fabricated nothing-happened data.
		return {
			kind: "fatal",
			message: `${ctx.skill}: git status worked at snapshot time but failed after the stage — cannot diff the workspace`,
		};
	}
	const post = parsePorcelain(status);

	const artifacts: Artifact[] = [];
	for (const [path, code] of post) {
		// Skip files whose status is unchanged from the snapshot — they
		// weren't touched DURING this stage.
		if (snapshot.statusByPath.get(path) === code) continue;
		if (filter && !filter(path)) continue;
		artifacts.push({ handle: fsHandle(path), role: "changed", meta: { gitStatus: code } });
	}
	return { kind: "ok", artifacts };
}

async function runGitStatus(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf-8",
			timeout: GIT_EXEC_TIMEOUT_MS,
		});
		return stdout;
	} catch {
		return undefined;
	}
}

/**
 * `git status --porcelain` line grammar — one record per line:
 *
 *   <XY><space><path>
 *
 *   <XY>     — two-character status code (either half may be a space;
 *              ` M` is a worktree-only modification)
 *   <space>  — the one-space separator after the status code
 *   <path>   — cwd-relative path; renames render as `old -> new`; the
 *              path is double-quote wrapped when git cquote-escapes it
 */
const PORCELAIN_STATUS_CODE_WIDTH = 2;
const PORCELAIN_PATH_OFFSET = PORCELAIN_STATUS_CODE_WIDTH + 1;
const PORCELAIN_MIN_LINE_WIDTH = PORCELAIN_PATH_OFFSET + 1;
const PORCELAIN_RENAME_ARROW = " -> ";
const PORCELAIN_RENAME_ARROW_WIDTH = PORCELAIN_RENAME_ARROW.length;
const PORCELAIN_QUOTE = '"';

/**
 * Parse `git status --porcelain` output: each line is `XY <path>` where
 * XY is the two-character status code. We key by path and keep the
 * full XY so post-stage diff sees status transitions (e.g. ` M` → `MM`).
 *
 * Renames (`R  old -> new`) are normalised to just the new path —
 * downstream collectors / parsers don't usually care about the prior
 * name and including both halves doubles the artifact count.
 */
export function parsePorcelain(out: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of out.split("\n")) {
		if (line.length < PORCELAIN_MIN_LINE_WIDTH) continue;
		const code = line.slice(0, PORCELAIN_STATUS_CODE_WIDTH);
		let path = line.slice(PORCELAIN_PATH_OFFSET).trim();
		// Rename: `R  old -> new` — take the new name.
		const arrow = path.indexOf(PORCELAIN_RENAME_ARROW);
		if (arrow !== -1) path = path.slice(arrow + PORCELAIN_RENAME_ARROW_WIDTH);
		// Strip wrapping quotes (paths git cquote-escapes).
		if (path.startsWith(PORCELAIN_QUOTE) && path.endsWith(PORCELAIN_QUOTE)) {
			path = path.slice(PORCELAIN_QUOTE.length, -PORCELAIN_QUOTE.length);
		}
		map.set(path, code);
	}
	return map;
}
