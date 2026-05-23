/**
 * Git commit extractor + pre-stage git HEAD snapshot.
 *
 * The extractor compares pre/post stage HEAD SHAs to detect commits made
 * by the agent during the stage. Uses execFileSync (sync) for post-stage
 * reads since extraction happens synchronously after executeSession.
 */

import { execFileSync } from "node:child_process";
import type { ExtractorCtx, ExtractorPayload, ExtractorResult, GitCommitData, SnapshotCtx } from "../manifest.js";

/** Baseline snapshot captured before the stage runs. */
export interface GitHeadSnapshot {
	baselineSha: string;
}

/** Per git command. 5 s is generous for `rev-parse` / `log -1` / `diff --shortstat` on local repos. */
const GIT_EXEC_TIMEOUT_MS = 5_000;

const GIT_EXEC_OPTS = {
	encoding: "utf-8" as const,
	stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
	timeout: GIT_EXEC_TIMEOUT_MS,
};

/** Run a git command from `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { ...GIT_EXEC_OPTS, cwd }).trim();
}

/**
 * Pre-stage snapshot: capture the current HEAD SHA.
 *
 * Synchronous — `ExtensionAPI` does not expose a public `exec`/process surface,
 * so the snapshot shells out via `node:child_process.execFileSync` exactly like
 * the post-stage extractor. Sync is fine: the snapshot is a single sub-5ms
 * git call that runs before the agent loop starts, on the runner's thread.
 *
 * Fail-soft: returns undefined on any failure (not a git repo, git missing,
 * non-zero exit). `gitCommitExtractor` handles `undefined` snapshot gracefully
 * by emitting a `noOp: true` manifest.
 */
export function gitHeadSnapshot(ctx: SnapshotCtx): GitHeadSnapshot | undefined {
	try {
		const sha = git(ctx.cwd, "rev-parse", "HEAD");
		return sha ? { baselineSha: sha } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Post-stage extractor: compare HEAD to baseline and extract commit metadata.
 * Always succeeds — git errors surface as a `noOp: true` payload (defensive).
 */
export function gitCommitExtractor(ctx: ExtractorCtx): ExtractorResult {
	const snapshot = ctx.snapshot as GitHeadSnapshot | undefined;
	if (!snapshot?.baselineSha) return { payload: wrap(ctx, noOpData("")) };

	const data = collectCommitData(ctx.cwd, snapshot.baselineSha) ?? noOpData(snapshot.baselineSha);
	return { payload: wrap(ctx, data) };
}

// ---------------------------------------------------------------------------
// Commit-data collection
// ---------------------------------------------------------------------------

/**
 * Read HEAD and produce `GitCommitData` for the commit (or no-op if HEAD
 * didn't move). Returns `null` if any git call throws — caller substitutes a
 * baseline-aware no-op payload so the workflow keeps moving.
 */
function collectCommitData(cwd: string, baselineSha: string): GitCommitData | null {
	try {
		const headSha = git(cwd, "rev-parse", "HEAD");
		if (headSha === baselineSha) return noOpData(baselineSha, headSha);

		return {
			sha: headSha,
			prevSha: baselineSha,
			subject: git(cwd, "log", "-1", "--format=%s", headSha),
			filesChanged: countFilesChanged(cwd, baselineSha, headSha),
		};
	} catch {
		return null;
	}
}

/** Parse `git diff --shortstat` output for the "N files changed" count. */
function countFilesChanged(cwd: string, baselineSha: string, headSha: string): number {
	const diffStat = git(cwd, "diff", "--shortstat", baselineSha, headSha);
	const match = diffStat.match(/^(\d+) files? changed/);
	return match ? parseInt(match[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// Payload shaping
// ---------------------------------------------------------------------------

/** Wrap GitCommitData in a payload, inheriting the chain's current artifact_path. */
function wrap(ctx: ExtractorCtx, data: GitCommitData): ExtractorPayload<"git-commit", GitCommitData> {
	return {
		kind: "git-commit",
		artifact_path: ctx.state.artifactPath,
		data,
	};
}

const noOpData = (prevSha: string, sha = ""): GitCommitData => ({
	sha,
	prevSha,
	subject: "",
	filesChanged: 0,
	noOp: true,
});
