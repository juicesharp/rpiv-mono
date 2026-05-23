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

const GIT_EXEC_OPTS = {
	encoding: "utf-8" as const,
	stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
	timeout: 5000,
};

/** Run a git command from `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { ...GIT_EXEC_OPTS, cwd }).trim();
}

/** Build a git-commit payload with the supplied `data`, inheriting `artifact_path`. */
function gitCommitPayload(ctx: ExtractorCtx, data: GitCommitData): ExtractorPayload<"git-commit", GitCommitData> {
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
 *
 * Uses execFileSync (sync) for post-stage reads. Fail-soft on git errors:
 * returns a payload with `noOp: true` if git commands fail (defensive).
 */
export function gitCommitExtractor(ctx: ExtractorCtx): ExtractorResult {
	const snapshot = ctx.snapshot as GitHeadSnapshot | undefined;

	if (!snapshot?.baselineSha) {
		return { payload: gitCommitPayload(ctx, noOpData("")) };
	}

	try {
		const headSha = git(ctx.cwd, "rev-parse", "HEAD");

		if (headSha === snapshot.baselineSha) {
			return { payload: gitCommitPayload(ctx, noOpData(snapshot.baselineSha, headSha)) };
		}

		const subject = git(ctx.cwd, "log", "-1", "--format=%s", headSha);
		const diffStat = git(ctx.cwd, "diff", "--shortstat", snapshot.baselineSha, headSha);
		const filesChangedMatch = diffStat.match(/^(\d+) files? changed/);
		const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1]!, 10) : 0;

		return {
			payload: gitCommitPayload(ctx, {
				sha: headSha,
				prevSha: snapshot.baselineSha,
				subject,
				filesChanged,
			}),
		};
	} catch {
		return { payload: gitCommitPayload(ctx, noOpData(snapshot.baselineSha)) };
	}
}
