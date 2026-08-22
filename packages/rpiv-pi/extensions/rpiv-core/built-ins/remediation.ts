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
 * Git-only (status --porcelain + diff HEAD) — deliberately NOT the runner's
 * `computeWorktreeDigest`, which also hashes `.rpiv/artifacts/`: remediate is
 * contractually forbidden from writing artifacts, and validate writes a new
 * timestamped report every lap, so the artifacts component would flip the
 * verdict on churn that is not a code fix. `diff HEAD` (not bare `diff`) for
 * the same staged-content reason the runner's digest documents.
 *
 * Degrade posture mirrors worktree-digest.ts: an `undefined` digest on either
 * side (non-repo / git missing / timeout) reports `changed: true` — a missing
 * signal is NEVER a reason to stop the run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
		return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
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
