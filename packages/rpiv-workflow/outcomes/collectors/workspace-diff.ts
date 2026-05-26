/**
 * Workspace-diff collector — emits one Artifact per file the stage
 * touched in the working tree.
 *
 * Discovery model: capture `git status --porcelain` pre-stage as
 * snapshot, then take the diff post-stage. Newly-untracked files and
 * files whose status changed both count. Pure git — no transcript
 * scanning, no tool-use observation, no agent narration involved.
 *
 * Fail-soft: cwd is not a git repo OR git isn't on PATH → snapshot is
 * `undefined`, collector returns `ok` with an empty list (the runner's
 * completion-strategy check then decides whether that's a halt). Same
 * posture as `gitCommitCollector`.
 *
 * Optional `filter(path)` narrows the set — useful for "only `.ts`
 * files," "only files under `src/`," etc. Authors who want more
 * structural narrowing (per-file role tags, per-file metadata) write
 * a custom collector — `workspaceDiffCollector` deliberately stays the
 * thin diff primitive.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Artifact, fs as fsHandle } from "../../handle.js";
import type { ArtifactCollector, CollectCtx, SnapshotCtx } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";

const execFileAsync = promisify(execFile);

/** Same budget as gitCommitCollector — generous for local repos, short enough that a hung mount can't pin the stage. */
const GIT_EXEC_TIMEOUT_MS = 5_000;

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

async function capturePorcelainSnapshot(ctx: SnapshotCtx): Promise<WorkspaceDiffSnapshot | undefined> {
	const status = await runGitStatus(ctx.cwd);
	if (status === undefined) return undefined;
	return { statusByPath: parsePorcelain(status) };
}

async function collectDiffArtifacts(
	ctx: CollectCtx<WorkspaceDiffSnapshot | undefined>,
	filter: ((path: string) => boolean) | undefined,
): Promise<{ kind: "ok"; artifacts: readonly Artifact[] }> {
	const snapshot = ctx.snapshot;
	if (!snapshot) return { kind: "ok", artifacts: [] };

	const status = await runGitStatus(ctx.cwd);
	if (status === undefined) return { kind: "ok", artifacts: [] };
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
 * Parse `git status --porcelain` output: each line is `XY <path>` where
 * XY is the two-character status code. We key by path and keep the
 * full XY so post-stage diff sees status transitions (e.g. ` M` → `MM`).
 *
 * Renames (`R  old -> new`) are normalised to just the new path —
 * downstream collectors / parsers don't usually care about the prior
 * name and including both halves doubles the artifact count.
 */
function parsePorcelain(out: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of out.split("\n")) {
		if (line.length < 4) continue;
		const code = line.slice(0, 2);
		let path = line.slice(3).trim();
		// Rename: `R  old -> new` — take the new name.
		const arrow = path.indexOf(" -> ");
		if (arrow !== -1) path = path.slice(arrow + 4);
		// Strip wrapping quotes (paths with whitespace).
		if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
		map.set(path, code);
	}
	return map;
}
