/**
 * Remediation outcome — the deterministic did-anything-change signal for
 * build's `validate-fix` repair arm.
 *
 * The arm dispatches the `remediate` skill (side-effect, code-mutation). Its
 * printed sentinels ("remediation not localized: …") are prose the router
 * cannot see, so a no-op remediation used to be indistinguishable from a fix
 * and the loop re-validated an unchanged tree until the backward-jump guard
 * halted the run (run 2026-08-22_12-14-12-64eb: four identical validate
 * laps). This outcome closes that gap the way `gitCommitOutcome` reads a
 * commit off git state: snapshot a git-only tree digest before the stage,
 * recompute after, and publish `{ changed }` on the `remediation` channel for
 * the `validate-fix` route to fold.
 *
 * Git-only (status --porcelain + diff HEAD + untracked content) —
 * deliberately NOT the runner's `computeWorktreeDigest`, which also hashes
 * `.rpiv/artifacts/`: remediate is contractually forbidden from writing
 * artifacts, and validate writes a new timestamped report every lap, so the
 * artifacts component would flip the verdict on churn that is not a code
 * fix. `diff HEAD` (not bare `diff`) for the same staged-content reason the
 * runner's digest documents. The third component hashes every untracked,
 * non-ignored file's content: status porcelain lists a NEW untracked path
 * but never a byte mutation inside an already-untracked file, so a repair
 * confined to files that were already untracked would read as a no-op and
 * re-enter the identical-lap loop. Untracked content under `.rpiv/` is
 * excluded from that component deterministically — a whole-prefix filter,
 * never a gitignore trust: that tree root is engine-owned pipeline
 * bookkeeping (reports, run trails, scratch), never the code under repair.
 *
 * Degrade posture mirrors worktree-digest.ts: an `undefined` digest on either
 * side (non-repo / git missing / timeout) reports `changed: true` — a missing
 * signal is NEVER a reason to stop the run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Artifact,
	type CollectContext,
	type Outcome,
	opaque,
	type SnapshotContext,
} from "@juicesharp/rpiv-workflow/registration";

/** Wall-clock ceiling per git subprocess — the digest runs synchronously at
 *  the stage seam, so a wedged git (contended index.lock) must be killed here;
 *  on expiry the throw degrades to `undefined` (proceed). */
const GIT_DIGEST_TIMEOUT_MS = 10_000;

/** Engine-owned tree root — everything under `.rpiv/` is pipeline bookkeeping
 *  (validation reports, run trails, scratch), never the code under repair.
 *  Excluded from the untracked component deterministically via this
 *  whole-prefix filter, NOT via gitignore trust: a repo's ignore file is user
 *  state the digest must never depend on. */
const UNTRACKED_EXCLUDED_PREFIX = ".rpiv/";

/**
 * Content hash over the untracked, non-ignored, non-excluded tree. `rawZ` is
 * `git ls-files --others --exclude-standard -z` output: NUL-separated
 * repo-relative forward-slash paths. Surviving paths are sorted (JS code-unit
 * sort, mirroring the artifacts walker) so enumeration order never feeds the
 * hash, and each path is hashed verbatim in git's repo-relative form — never
 * `join()`-reconstructed. An unreadable file (raced delete) hashes the stable
 * `"<unreadable>"` token; the helper never throws. An empty surviving set
 * hashes to the sha256 of nothing — a stable constant.
 */
const hashUntrackedTree = (cwd: string, rawZ: string): string => {
	const hash = createHash("sha256");
	const paths = rawZ
		.split("\0")
		.filter((p) => p !== "" && !p.startsWith(UNTRACKED_EXCLUDED_PREFIX))
		.sort();
	for (const path of paths) {
		hash.update(path);
		hash.update("\0");
		try {
			hash.update(readFileSync(join(cwd, path)));
		} catch {
			hash.update("<unreadable>");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
};

/**
 * Git-only content fingerprint of `cwd`'s working tree. Returns `undefined`
 * on ANY failure so callers degrade to "proceed", never "stop".
 */
export const gitTreeDigest = (cwd: string): string | undefined => {
	try {
		const opts = {
			cwd,
			encoding: "utf-8" as const,
			stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
			timeout: GIT_DIGEST_TIMEOUT_MS,
		};
		const status = execFileSync("git", ["status", "--porcelain"], opts);
		const diff = execFileSync("git", ["diff", "HEAD"], opts);
		const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], opts);
		return createHash("sha256")
			.update(status)
			.update("\0")
			.update(diff)
			.update("\0")
			.update(hashUntrackedTree(cwd, untracked))
			.digest("hex");
	} catch {
		return undefined;
	}
};

/** The `remediation` channel's data: did the repair arm mutate the tree? */
export interface RemediationData {
	changed: boolean;
}

/**
 * Snapshot the digest pre-stage, recompute post-stage, publish `{ changed }`.
 * One sentinel opaque artifact carries the verdict in `meta` (the
 * `gitCommitOutcome` shape) so the parser stays total.
 */
export const remediationOutcome: Outcome<string | undefined, "remediation", RemediationData> = {
	name: "remediation",
	collector: {
		snapshot: ({ cwd }: SnapshotContext) => gitTreeDigest(cwd),
		collect(ctx: CollectContext<string | undefined>) {
			const after = gitTreeDigest(ctx.cwd);
			// A missing digest on either side is a missing signal — report changed
			// (proceed), never a fabricated "nothing happened".
			const changed = ctx.snapshot === undefined || after === undefined || ctx.snapshot !== after;
			const artifact: Artifact = {
				handle: opaque(changed ? "remediation-changed" : "remediation-unchanged"),
				role: "remediation",
				meta: { changed },
			};
			return { kind: "ok", artifacts: [artifact] };
		},
	},
	parser: {
		parse(ctx) {
			const changed = (ctx.artifacts[0]?.meta as { changed?: unknown } | undefined)?.changed;
			// Only an explicit `false` reports unchanged — same degrade posture.
			return { kind: "ok", payload: { kind: "remediation", data: { changed: changed !== false } } };
		},
	},
};
