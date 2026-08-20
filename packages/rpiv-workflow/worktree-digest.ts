/**
 * Worktree digest — fail-soft content fingerprint of `cwd`'s working tree.
 *
 * Used by the validation-retry gate to detect whether a stage's fix
 * actually mutated anything observable between a failed validate and the retry
 * (mechanism-1, captured around `askAgentToFix` in sessions/extraction.ts) or
 * across a re-dispatch of an already-run `produces` stage (mechanism-2, at
 * `runSingleStage` dispatch in runner/run-stage.ts). An UNCHANGED digest ⇒ the
 * agent asked to fix changed nothing observable ⇒ the retry is skipped
 * (fail fast) instead of re-running the same failing validation.
 *
 * Two components concatenated then hashed (a tracked-only digest
 * misses a fix that touches ONLY a gitignored file under `.rpiv/artifacts/`,
 * which `.gitignore` ignores, and would false-skip the gate):
 *   1. the default git recipe — `git status --porcelain` + `git diff` (the same
 *      `execFileSync("git", [...], { stdio: ["ignore","pipe","ignore"] })`
 *      posture built-ins/goal-baseline.ts's `writeCommitBaseline` uses);
 *   2. `hashArtifactsTree(cwd)` — a recursive walk of `<cwd>/.rpiv/artifacts/`
 *      hashing each file's relative path + contents so a gitignored-only
 *      artifact revision DOES change the digest.
 *
 * The whole `computeWorktreeDigest` is wrapped in try/catch → `undefined`
 * (non-repo / git missing / unreadable tree), so BOTH gates degrade to
 * "always proceed" on a missing signal — never skip on a missing signal.
 *
 * Leaf module: imports only `node:child_process` + `node:fs` + `node:crypto` +
 * `node:path` (no back-edges), so the value-import DAG stays acyclic.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Wall-clock ceiling per git subprocess. The digest runs SYNCHRONOUSLY on the
 *  validation-retry critical path and the bash watchdog cannot cover it (not a
 *  tool call, and `execFileSync` blocks the event loop) — so a wedged git (e.g.
 *  a contended `index.lock` from a concurrent commit) must be killed here. On
 *  expiry `execFileSync` throws → the digest degrades to `undefined` → both
 *  gates proceed, the documented missing-signal behavior. */
const GIT_DIGEST_TIMEOUT_MS = 10_000;

/** Subtree of `.rpiv/artifacts/` excluded from the digest: death-scene sidecars
 *  are FORENSIC output of failures, not a fix an agent applied. In a concurrent
 *  collect-all fanout a sibling unit's failure writes here mid-window; hashing
 *  it would flip another unit's unchanged-digest verdict and defeat the
 *  fail-fast gate with a spurious "tree changed". */
const DIGEST_EXCLUDED_ARTIFACT_DIRS: ReadonlySet<string> = new Set(["failures"]);

/**
 * Walk `<cwd>/.rpiv/artifacts/` recursively, hashing each file's relative
 * path + contents so a revision to ANY artifact (incl. a gitignored-only one)
 * changes the digest. Absent / empty / unreadable tree contributes nothing
 * (fail-soft) — the digest then equals the git-only digest. Symlinks are NOT
 * followed (a `Dirent.isDirectory()` is false for a symlink-to-dir) so a
 * looping symlink cannot recurse unboundedly; an unreadable / broken-link
 * target contributes a stable `<unreadable>` token.
 */
function hashArtifactsTree(cwd: string): string {
	const artifactsRoot = join(cwd, ".rpiv", "artifacts");
	const entries = readdirRecursively(artifactsRoot, DIGEST_EXCLUDED_ARTIFACT_DIRS);
	const hash = createHash("sha256");
	for (const abs of entries.sort()) {
		hash.update(relative(artifactsRoot, abs));
		hash.update("\0");
		try {
			hash.update(readFileSync(abs));
		} catch {
			hash.update("<unreadable>");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Recursive `readdir` returning absolute file paths under `root` (symlinks not
 *  followed). `excludedTopDirs` names TOP-LEVEL subdirectories of `root` that are
 *  skipped entirely (deeper same-named dirs are not affected). */
function readdirRecursively(root: string, excludedTopDirs?: ReadonlySet<string>): string[] {
	const out: string[] = [];
	const walk = (dir: string, isRoot: boolean): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // absent / unreadable dir — contributes nothing
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (isRoot && excludedTopDirs?.has(entry.name)) continue;
				walk(abs, false);
			} else out.push(abs); // files + symlinks (target read fail-soft, below)
		}
	};
	walk(root, true);
	return out;
}

/**
 * Content fingerprint of `cwd`'s working tree — `git status --porcelain` +
 * `git diff` concatenated with `hashArtifactsTree(cwd)`, then SHA-256 hashed.
 * Mirrors built-ins/goal-baseline.ts's `writeCommitBaseline` git posture
 * (`execFileSync` with stderr ignored so a non-repo cwd degrades silently).
 *
 * Returns `undefined` on ANY failure (non-repo / git missing / unreadable
 * tree) so callers degrade to "proceed" rather than "skip" — a missing digest
 * is NEVER a signal to gate.
 */
export function computeWorktreeDigest(cwd: string): string | undefined {
	try {
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_DIGEST_TIMEOUT_MS,
		});
		// `diff HEAD` (not bare `diff`) so STAGED content changes the digest too — a fix
		// that edits-and-stages leaves the porcelain status line and the unstaged diff
		// both unchanged between two different staged states. In a repo with no commits
		// yet, `HEAD` is unresolvable and the throw degrades to `undefined` (proceed).
		const diff = execFileSync("git", ["diff", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_DIGEST_TIMEOUT_MS,
		});
		const artifacts = hashArtifactsTree(cwd);
		return createHash("sha256").update(status).update("\0").update(diff).update("\0").update(artifacts).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Resolve the digest for a session — the per-session override (`s.worktreeDigest`,
 * injected by tests / programmatic embedders) wins WHENEVER PRESENT, including
 * when it returns `undefined` (an override simulating a non-repo must not fall
 * through to the real computation). No override ⇒ the default
 * `computeWorktreeDigest`. Exposed so the two gate sites share one
 * override-vs-default resolution instead of re-spelling it.
 */
export function resolveDigest(
	computer: ((cwd: string) => string | undefined) | undefined,
	cwd: string,
): string | undefined {
	return computer ? computer(cwd) : computeWorktreeDigest(cwd);
}
