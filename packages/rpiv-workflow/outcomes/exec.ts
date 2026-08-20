/**
 * Shared async `execFile` plumbing for the git-backed outcomes
 * (`git-commit.ts`, `collectors/workspace-diff.ts`). One promisified
 * instance + one timeout budget so the two collectors can't drift.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/**
 * Per git command. 5 s is generous for `rev-parse` / `log -1` /
 * `diff --shortstat` / `status --porcelain` on local repos, short enough
 * that a hung network mount can't pin the stage. Mirrors `GIT_EXEC_TIMEOUT_MS`
 * in `packages/rpiv-pi/extensions/rpiv-core/constants.ts` (session-start
 * git-context probe) — same 5 s value, separately owned by design: the
 * five-entry exports map exposes no sanctioned cross-package constant surface,
 * and `sibling-import-graph.test.ts` blocks static sibling edges.
 */
export const GIT_EXEC_TIMEOUT_MS = 5_000;
