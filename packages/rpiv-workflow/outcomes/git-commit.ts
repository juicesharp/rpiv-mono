/**
 * Git commit outcome + pre-stage git HEAD snapshot.
 *
 * Compares pre/post stage HEAD SHAs to detect commits made by the agent
 * during the stage. Shells out asynchronously via `execFile` so a slow
 * `git` invocation (network-backed working tree, hung FS, large
 * `--shortstat`) can't pin the event loop — `ExtractFn`'s contract
 * already supports `Promise<ExtractResult>`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentArtifactPath } from "../internal-utils.js";
import type { BaselineCtx, ExtractCtx, ExtractPayload, ExtractResult, Outcome } from "../manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Manifest data shape produced by `gitCommitOutcome` — co-located with
 * the outcome that emits it. The `GitCommitManifest` alias in
 * `manifest.ts` re-imports this type so downstream nodes can narrow on
 * `manifest.kind === "git-commit"` without reaching into per-outcome
 * paths.
 */
export interface GitCommitData {
	sha: string;
	prevSha: string;
	subject: string;
	filesChanged: number;
	noOp?: boolean;
}

/** Baseline snapshot captured before the stage runs. */
export interface GitHeadSnapshot {
	baselineSha: string;
}

/** Per git command. 5 s is generous for `rev-parse` / `log -1` / `diff --shortstat` on local repos. */
const GIT_EXEC_TIMEOUT_MS = 5_000;

/** Run a git command from `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: GIT_EXEC_TIMEOUT_MS,
	});
	return stdout.trim();
}

/**
 * Pre-stage snapshot: capture the current HEAD SHA via async `execFile`.
 *
 * Async — keeps the event loop responsive even if `git` is slow (network
 * FS, hung mount, contended index). `ExtensionAPI` does not expose a
 * public `exec` surface, so we shell out directly here and via the
 * extract method; the `BaselineFn` contract already supports
 * `Promise<unknown>` so the runner awaits without ceremony.
 *
 * Fail-soft: returns undefined on any failure (not a git repo, git
 * missing, non-zero exit, timeout). `gitCommitOutcome` handles
 * `undefined` snapshot gracefully by emitting a `noOp: true` manifest.
 */
export async function gitHeadSnapshot(ctx: BaselineCtx): Promise<GitHeadSnapshot | undefined> {
	try {
		const sha = await git(ctx.cwd, "rev-parse", "HEAD");
		return sha ? { baselineSha: sha } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Post-stage read: compare HEAD to baseline and extract commit metadata.
 * Always succeeds — git errors surface as a `noOp: true` payload (defensive).
 */
async function extractGitCommit(
	ctx: ExtractCtx<GitHeadSnapshot | undefined>,
): Promise<ExtractResult<"git-commit", GitCommitData>> {
	const baseline = ctx.baseline;
	if (!baseline?.baselineSha) return { kind: "ok", payload: wrap(ctx, noOpData("")) };

	const data = (await collectCommitData(ctx.cwd, baseline.baselineSha)) ?? noOpData(baseline.baselineSha);
	return { kind: "ok", payload: wrap(ctx, data) };
}

/**
 * Git commit outcome — bundles `gitHeadSnapshot` (baseline) with
 * `extractGitCommit` (extract). Co-located so the pre-state capture is
 * structurally part of the outcome that consumes it. `gitHeadSnapshot`
 * is exposed via the main package barrel (`@juicesharp/rpiv-workflow`)
 * as a composition building block: wrap it in any custom outcome whose
 * `extract` reads a git baseline (not just commit detection — also "did
 * this stage touch files?", "what changed since the last save?", etc.).
 *
 * Concrete generics: baseline is `GitHeadSnapshot | undefined`
 * (undefined when not in a git repo), manifest kind is `"git-commit"`,
 * data is `GitCommitData`.
 */
export const gitCommitOutcome: Outcome<GitHeadSnapshot | undefined, "git-commit", GitCommitData> = {
	baseline: gitHeadSnapshot,
	extract: extractGitCommit,
};

// ---------------------------------------------------------------------------
// Commit-data collection
// ---------------------------------------------------------------------------

/**
 * Read HEAD and produce `GitCommitData` for the commit (or no-op if HEAD
 * didn't move). Returns `null` if any git call throws — caller substitutes a
 * baseline-aware no-op payload so the workflow keeps moving.
 */
async function collectCommitData(cwd: string, baselineSha: string): Promise<GitCommitData | null> {
	try {
		const headSha = await git(cwd, "rev-parse", "HEAD");
		if (headSha === baselineSha) return noOpData(baselineSha, headSha);

		const [subject, filesChanged] = await Promise.all([
			git(cwd, "log", "-1", "--format=%s", headSha),
			countFilesChanged(cwd, baselineSha, headSha),
		]);
		return { sha: headSha, prevSha: baselineSha, subject, filesChanged };
	} catch {
		return null;
	}
}

/** Parse `git diff --shortstat` output for the "N files changed" count. */
async function countFilesChanged(cwd: string, baselineSha: string, headSha: string): Promise<number> {
	const diffStat = await git(cwd, "diff", "--shortstat", baselineSha, headSha);
	const match = diffStat.match(/^(\d+) files? changed/);
	return match ? parseInt(match[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// Payload shaping
// ---------------------------------------------------------------------------

/** Wrap GitCommitData in a payload, inheriting the chain's current artifact_path. */
function wrap(
	ctx: ExtractCtx<GitHeadSnapshot | undefined>,
	data: GitCommitData,
): ExtractPayload<"git-commit", GitCommitData> {
	return {
		kind: "git-commit",
		artifact_path: currentArtifactPath(ctx.state),
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
