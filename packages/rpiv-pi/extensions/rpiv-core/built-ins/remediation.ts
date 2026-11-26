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
 * Backend-blind — every component reads through the `vcs-status.ts` seam, so
 * git and jj produce the same digest grammar — deliberately NOT the runner's
 * `computeWorktreeDigest`, which also hashes `.rpiv/artifacts/`: remediate is
 * contractually forbidden from writing artifacts, and validate writes a new
 * timestamped report every lap, so the artifacts component would flip the
 * verdict on churn that is not a code fix. The change-text component is the
 * working copy against its base (`git diff HEAD`; jj has no index, so
 * `jj diff --git` against `@-`). The third component hashes every new-file
 * (`??`-class) path's content: a status line lists a NEW path but never a byte
 * mutation inside an already-untracked file, so a repair confined to files
 * that were already untracked would read as a no-op and re-enter the
 * identical-lap loop. Everything under `.rpiv/` and `thoughts/` is excluded from
 * every component by the seam's own predicate (`isBookkeepingPath`), never by a
 * gitignore trust: those trees are engine-owned pipeline bookkeeping (reports,
 * run trails, scratch), never the code under repair.
 *
 * Degrade posture mirrors worktree-digest.ts: an `undefined` digest on either
 * side (non-repo / git missing / timeout) reports `changed: true` — a missing
 * signal is NEVER a reason to stop the run.
 */

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
import { detectVcs, vcsDiffText, vcsStatusEntries } from "../vcs-status.ts";

/**
 * Content hash over the given working-copy paths, sorted so enumeration order
 * never feeds the hash. Each path is hashed verbatim in repo-relative form —
 * never `join()`-reconstructed. An unreadable file (raced delete) hashes the
 * stable `"<unreadable>"` token; the helper never throws. An empty surviving
 * set hashes to the sha256 of nothing — a stable constant.
 */
const hashNewFiles = (cwd: string, paths: readonly string[]): string => {
	const hash = createHash("sha256");
	const kept = paths.filter((p) => p !== "").sort();
	for (const path of kept) {
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
 * Content fingerprint of `cwd`'s working tree under either backend; `undefined`
 * when no backend answers and on ANY failure, so callers degrade to "proceed",
 * never "stop". The timeout lives in the seam (`vcs-status.ts`), which kills a
 * wedged backend process at the stage seam; on expiry the throw degrades to
 * `undefined` (proceed).
 */
export const gitTreeDigest = (cwd: string): string | undefined => {
	// One probe for the whole digest: both readers take the captured backend, so
	// a remediate outcome costs one `detectVcs` instead of up to six.
	const backend = detectVcs(cwd);
	// No backend answers: there is no signal to compare. Hashing an empty status
	// would return a stable digest and read as "unchanged", which is the opposite
	// of the contract `remediation.test.ts` pins for a non-repo cwd.
	if (backend === "none") return undefined;
	try {
		// The seam already removes `.rpiv/` and `thoughts/` from BOTH readers, so
		// every component below is bookkeeping-free without a local filter.
		const entries = vcsStatusEntries(cwd, backend);
		const status = entries.map((e) => `${e.xy} ${e.path}`).join("\n");
		const newPaths = entries.filter((e) => e.xy === "??").map((e) => e.path);
		return createHash("sha256")
			.update(status)
			.update("\0")
			.update(vcsDiffText(cwd, backend))
			.update("\0")
			.update(hashNewFiles(cwd, newPaths))
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
