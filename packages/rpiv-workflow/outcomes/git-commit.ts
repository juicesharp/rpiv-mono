/**
 * Git commit outcome + pre-stage git HEAD snapshot.
 *
 * Split along the ENUMERATE/INTERPRET seam: the collector owns ALL git I/O
 * (HEAD detection plus subject/files-changed interrogation, recorded on the
 * artifact's `meta`); the parser is PURE — it validates the `meta` shape and
 * projects it into `GitCommitData`, never re-shelling git at parse time
 * (parse may re-run during validation retries, when the working tree has
 * already moved on).
 *
 * Failure posture follows the package-wide "nothing found" convention
 * (`CollectResult` doc, output-spec.ts) — with ONE documented exception:
 * this collector always emits a single sentinel artifact (even on no-op)
 * carrying the complete fact in `meta`, so the parser stays pure and total.
 * The three cases:
 *   - not a git repo / git unavailable at snapshot time → no-op data
 *     (`baselineMissing`), the workflow keeps moving;
 *   - HEAD unchanged after the stage → honest no-op data;
 *   - git WORKED at snapshot time but fails after the stage → `fatal` (the
 *     environment broke mid-stage; fabricating `noOp: true` here would let
 *     `gate` route on invented data).
 *
 * Shells out asynchronously via `execFile` so a slow `git` invocation
 * (network-backed working tree, hung FS, large `--shortstat`) can't
 * pin the event loop.
 */

import { type Artifact, opaque } from "../handle.js";
import type { Output } from "../output.js";
import type { ArtifactCollector, ArtifactParser, CollectCtx, Outcome, ParseCtx, SnapshotCtx } from "../output-spec.js";
import { execFileAsync, GIT_EXEC_TIMEOUT_MS } from "./exec.js";

/**
 * Output data shape produced by `gitCommitParser` — co-located with the
 * outcome that emits it, as is the `GitCommitOutput` narrowing alias below
 * (G6: the core envelope module never enumerates a concrete outcome).
 */
export interface GitCommitData {
	sha: string;
	prevSha: string;
	subject: string;
	filesChanged: number;
	noOp?: boolean;
}

/** Tagged-union narrowing alias: `output.kind === "git-commit"` ⇒ `data: GitCommitData`. */
export type GitCommitOutput = Output<"git-commit", GitCommitData>;

/** Snapshot captured before the stage runs. */
export interface GitHeadSnapshot {
	baselineSha: string;
}

/**
 * The complete fact the collector records on its artifact's `meta` — the
 * parser's ONLY input (it never shells git). `subject`/`filesChanged` are
 * interrogated at collect time, while the SHAs still resolve.
 */
export interface GitCommitArtifactMeta {
	baselineSha: string;
	headSha: string;
	/** Snapshot found no baseline — not a git repo / git unavailable before the stage. */
	baselineMissing: boolean;
	/** HEAD did not move (or no baseline existed) — `subject`/`filesChanged` are empty/zero. */
	noOp: boolean;
	subject: string;
	filesChanged: number;
}

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
 * FS, hung mount, contended index). Fail-soft: returns undefined on any
 * failure (not a git repo, git missing, non-zero exit, timeout).
 * `gitCommitCollector` handles `undefined` snapshot gracefully by
 * emitting an artifact carrying a `noOp: true` payload.
 */
export async function gitHeadSnapshot(ctx: SnapshotCtx): Promise<GitHeadSnapshot | undefined> {
	try {
		const sha = await git(ctx.cwd, "rev-parse", "HEAD");
		return sha ? { baselineSha: sha } : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Collector — detect "did HEAD move during this stage?" + interrogate the fact
// ---------------------------------------------------------------------------

/**
 * Collector emits exactly one artifact on every non-fatal path — no-op (HEAD
 * unchanged) and git-unavailable-at-snapshot included — with the COMPLETE
 * `GitCommitArtifactMeta` fact attached, so the parser stays pure. Fatal only
 * when git worked at snapshot time and then failed after the stage: that's an
 * environment break, not a no-op, and routing must not see fabricated data.
 */
export const gitCommitCollector: ArtifactCollector<GitHeadSnapshot | undefined> = {
	snapshot: gitHeadSnapshot,
	async collect(ctx: CollectCtx<GitHeadSnapshot | undefined>) {
		const baselineSha = ctx.snapshot?.baselineSha;
		if (!baselineSha) {
			// Deliberate degrade: the stage ran outside a (working) git repo.
			return ok(noOpMeta("", "", { baselineMissing: true }));
		}
		let headSha: string;
		try {
			headSha = await git(ctx.cwd, "rev-parse", "HEAD");
		} catch (e) {
			return fatal(ctx.skill, `git rev-parse HEAD failed after the stage: ${describeError(e)}`);
		}
		if (!headSha || headSha === baselineSha) {
			// Honest no-op — HEAD genuinely did not move.
			return ok(noOpMeta(baselineSha, headSha));
		}
		try {
			const [subject, filesChanged] = await Promise.all([
				git(ctx.cwd, "log", "-1", "--format=%s", headSha),
				countFilesChanged(ctx.cwd, baselineSha, headSha),
			]);
			return ok({ baselineSha, headSha, baselineMissing: false, noOp: false, subject, filesChanged });
		} catch (e) {
			// A commit LANDED but its interrogation failed — fabricating noOp
			// would route `gate` on invented data; halt with the real cause.
			return fatal(ctx.skill, `commit ${headSha} landed but interrogating it failed: ${describeError(e)}`);
		}
	},
};

const ok = (meta: GitCommitArtifactMeta): { kind: "ok"; artifacts: readonly Artifact[] } => ({
	kind: "ok",
	artifacts: [{ handle: opaque(meta.headSha || meta.baselineSha), role: "commit", meta: { ...meta } }],
});

const fatal = (skill: string, reason: string): { kind: "fatal"; message: string } => ({
	kind: "fatal",
	message: `${skill}: ${reason}`,
});

const noOpMeta = (
	baselineSha: string,
	headSha: string,
	opts?: { baselineMissing?: boolean },
): GitCommitArtifactMeta => ({
	baselineSha,
	headSha,
	baselineMissing: opts?.baselineMissing ?? false,
	noOp: true,
	subject: "",
	filesChanged: 0,
});

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parse `git diff --shortstat` output for the "N files changed" count. */
async function countFilesChanged(cwd: string, baselineSha: string, headSha: string): Promise<number> {
	const diffStat = await git(cwd, "diff", "--shortstat", baselineSha, headSha);
	const match = diffStat.match(/^(\d+) files? changed/);
	return match ? parseInt(match[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// Parser — PURE projection of the collected meta into typed GitCommitData
// ---------------------------------------------------------------------------

/** Structural guard for the collector-emitted meta — the parser's input contract. */
function isGitCommitMeta(meta: unknown): meta is GitCommitArtifactMeta {
	const m = meta as Partial<GitCommitArtifactMeta> | undefined;
	return (
		typeof m?.baselineSha === "string" &&
		typeof m.headSha === "string" &&
		typeof m.baselineMissing === "boolean" &&
		typeof m.noOp === "boolean" &&
		typeof m.subject === "string" &&
		typeof m.filesChanged === "number"
	);
}

/**
 * Pure: validates the artifact's `meta` shape (fatal on mismatch — a blind
 * cast here would coerce a foreign collector's artifact into fabricated
 * commit data) and projects it into `GitCommitData`. No I/O.
 */
export const gitCommitParser: ArtifactParser<GitHeadSnapshot | undefined, "git-commit", GitCommitData> = {
	parse(ctx: ParseCtx<GitHeadSnapshot | undefined>) {
		const artifact = ctx.artifacts[0];
		const meta = artifact?.meta;
		if (!isGitCommitMeta(meta)) {
			return {
				kind: "fatal",
				message:
					`${ctx.skill}: gitCommitParser requires the meta gitCommitCollector emits ` +
					`(baselineSha/headSha/baselineMissing/noOp/subject/filesChanged) — ` +
					(artifact ? "got an artifact with a foreign meta shape" : "got no artifact") +
					"; compose it with gitCommitCollector",
			};
		}
		const data: GitCommitData = meta.noOp
			? { sha: meta.headSha, prevSha: meta.baselineSha, subject: "", filesChanged: 0, noOp: true }
			: { sha: meta.headSha, prevSha: meta.baselineSha, subject: meta.subject, filesChanged: meta.filesChanged };
		return { kind: "ok", payload: { kind: "git-commit", data } };
	},
};

// ---------------------------------------------------------------------------
// Outcome — the wired-up pair
// ---------------------------------------------------------------------------

/**
 * Git commit outcome — composes `gitCommitCollector` (which carries the
 * `gitHeadSnapshot` snapshot internally) with `gitCommitParser`.
 *
 * Concrete generics: snapshot is `GitHeadSnapshot | undefined`
 * (undefined when not in a git repo), output kind is `"git-commit"`,
 * data is `GitCommitData`.
 */
export const gitCommitOutcome: Outcome<GitHeadSnapshot | undefined, "git-commit", GitCommitData> = {
	collector: gitCommitCollector,
	parser: gitCommitParser,
};
