/**
 * Cached branch + short commit. Injected into the transcript once at
 * session_start; after session_compact it joins the one deferred next-user-turn
 * context message; otherwise emitted only when the cached value changes (e.g.
 * after a mutating git command).
 * Two parallel `git rev-parse` calls — one call can't combine
 * `--abbrev-ref` and `--short` cleanly because the `--abbrev-ref` mode
 * persists to subsequent revs. git itself resolves worktree gitdir
 * redirection, so either form is worktree-safe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_EXEC_TIMEOUT_MS } from "./constants.js";

type GitContext = { branch: string; commit: string; user: string };

// Signature (branch+commit) of the last message pushed into the transcript.
// null = transcript has nothing current and needs re-injection.
let lastInjectedSig: string | null = null;

// undefined = not loaded yet, null = not a git repo / failed, object = valid
let cache: GitContext | null | undefined;

export async function getGitContext(pi: ExtensionAPI): Promise<GitContext | null> {
	if (cache !== undefined) return cache;
	cache = await loadGitContext(pi);
	return cache;
}

export function clearGitContextCache(): void {
	cache = undefined;
}

// Detached HEAD emits literal "HEAD" for --abbrev-ref; remap so frontmatter is meaningful.
async function loadGitContext(pi: ExtensionAPI): Promise<GitContext | null> {
	try {
		const [branchRes, commitRes] = await Promise.all([
			pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: GIT_EXEC_TIMEOUT_MS }),
			pi.exec("git", ["rev-parse", "--short", "HEAD"], { timeout: GIT_EXEC_TIMEOUT_MS }),
		]);
		const rawBranch = branchRes.stdout.trim();
		const commit = commitRes.stdout.trim();
		if (!rawBranch && !commit) return null;
		const branch = rawBranch === "HEAD" ? "detached" : rawBranch;
		let user = "";
		try {
			const r2 = await pi.exec("git", ["config", "user.name"], { timeout: GIT_EXEC_TIMEOUT_MS });
			user = r2.stdout.trim();
		} catch {
			// fall through to env fallback
		}
		if (!user) user = process.env.USER || "unknown";
		return {
			branch: branch || "no-branch",
			commit: commit || "no-commit",
			user,
		};
	} catch {
		return null;
	}
}

export function resetInjectedMarker(): void {
	lastInjectedSig = null;
}

function signature(g: GitContext): string {
	return `${g.branch}\n${g.commit}\n${g.user}`;
}

function formatGitContext(g: GitContext): string {
	return `## Git Context\n- Branch: ${g.branch}\n- Commit: ${g.commit}\n- User: ${g.user}`;
}

/**
 * Force a fresh read for one specifically compacted session. The ordinary cache
 * and signature are process-global, so a concurrent session could otherwise
 * consume the reset marker before the compacted session's next user turn.
 */
export async function refreshGitContextForInjection(pi: ExtensionAPI): Promise<string | null> {
	cache = await loadGitContext(pi);
	if (!cache) return null;
	lastInjectedSig = signature(cache);
	return formatGitContext(cache);
}

// Returns the message content to inject, or null if the transcript is
// already up-to-date or we're not in a git repo. Updates the marker
// whenever it returns non-null.
export async function takeGitContextIfChanged(pi: ExtensionAPI): Promise<string | null> {
	const g = await getGitContext(pi);
	if (!g) return null;
	const sig = signature(g);
	if (sig === lastInjectedSig) return null;
	lastInjectedSig = sig;
	return formatGitContext(g);
}

export function isGitMutatingCommand(cmd: string): boolean {
	return /\bgit\s+(checkout|switch|commit|merge|rebase|pull|reset|revert|cherry-pick|worktree|am|stash)\b/.test(cmd);
}
