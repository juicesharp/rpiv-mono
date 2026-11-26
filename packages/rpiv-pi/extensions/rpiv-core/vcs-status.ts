/**
 * The rpiv-core VCS seam: one backend detection and one working-copy status
 * reader for every built-in that inspects the tree. `rpiv-workflow` carries its
 * own copy (`vcs-probe.ts`) because the two packages cannot import each other;
 * both assert against the shared fixture in `@juicesharp/rpiv-test-utils/vcs`,
 * so a parser drift fails a test instead of shipping two status universes.
 *
 * Every reader removes bookkeeping paths (`.rpiv/`, `thoughts/`) before it
 * answers: the run writes those trees for itself, so they are never
 * pre-existing user work, never a scope violation and never a digest input.
 */
import { execFileSync } from "node:child_process";
import { GIT_EXEC_TIMEOUT_MS } from "./constants.ts";
import { isBookkeepingPath, stripBookkeepingHunks, unquoteGitPath } from "./vcs-path.ts";

export type VcsBackend = "jj" | "git" | "none";

/** One working-copy entry in the git `XY` vocabulary. jj's `A` maps to `??`. */
export interface VcsStatusEntry {
	xy: string;
	path: string;
}

/** Raw stdout, or `fb` when the command fails or prints nothing. Raw, NOT
 *  trimmed: a porcelain status line's `XY` code can START with a space
 *  (` M path`), and trimming would eat the first line's status letter. */
const readVcs = (bin: string, args: string[], fb: string, cwd: string): string => {
	try {
		const out = execFileSync(bin, args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_EXEC_TIMEOUT_MS,
		});
		return out.trim() === "" ? fb : out;
	} catch {
		return fb;
	}
};

/** `jj` when `jj root` answers, else `git` on a toplevel, else `none`. */
export const detectVcs = (cwd: string): VcsBackend => {
	if (readVcs("jj", ["root"], "", cwd)) return "jj";
	if (readVcs("git", ["rev-parse", "--show-toplevel"], "", cwd)) return "git";
	return "none";
};

const JJ_CODES: Readonly<Record<string, string>> = { M: " M", A: "??", D: " D", R: " R", C: "??", T: " M" };

/** jj renders a rename as `R dir/{old.ts => new.ts}`; the path is the new side. */
const jjRenamePath = (rest: string): string => rest.replace(/\{(.*?) => (.*?)\}/, "$2").trim();

/** `jj diff --summary` in git's `XY <path>` grammar. */
export const jjSummaryToEntries = (raw: string): VcsStatusEntry[] =>
	raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => ({ xy: JJ_CODES[line[0] ?? ""] ?? " M", path: jjRenamePath(line.slice(1)) }));

const parsePorcelain = (out: string): VcsStatusEntry[] =>
	out
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const rest = l.slice(3).trim();
			const arrow = rest.indexOf(" -> ");
			return { xy: l.slice(0, 2), path: unquoteGitPath(arrow >= 0 ? rest.slice(arrow + 4).trim() : rest) };
		});

/**
 * Working-copy entries under either backend; `[]` when no backend answers.
 *
 * git passes `--untracked-files=all`: a collapsed `dir/` entry can never match
 * a declared `files:` path, and the baseline and both scope checks must read
 * the same universe. jj already enumerates every path.
 *
 * `backend` is optional so a caller that already probed can pass the answer and
 * skip a second `detectVcs` subprocess.
 */
export const vcsStatusEntries = (cwd: string, backend: VcsBackend = detectVcs(cwd)): VcsStatusEntry[] => {
	const entries =
		backend === "jj"
			? jjSummaryToEntries(readVcs("jj", ["--no-pager", "diff", "--summary"], "", cwd))
			: backend === "git"
				? parsePorcelain(readVcs("git", ["status", "--porcelain", "--untracked-files=all"], "", cwd))
				: [];
	return entries.filter((e) => !isBookkeepingPath(e.path));
};

/**
 * Working-copy change text in git patch format, or `""` when unavailable.
 * Bookkeeping hunks are removed for the same reason the status reader removes
 * the entries: a validation report the run wrote must never flip a digest.
 */
export const vcsDiffText = (cwd: string, backend: VcsBackend = detectVcs(cwd)): string => {
	const raw =
		backend === "jj"
			? readVcs("jj", ["--no-pager", "diff", "--git"], "", cwd)
			: backend === "git"
				? readVcs("git", ["diff", "HEAD"], "", cwd)
				: "";
	return raw === "" ? "" : stripBookkeepingHunks(raw);
};

/**
 * Paths the run committed since `since` — the WIP guard's "the work is safe in
 * history" read.
 *
 * Under jj `since` is the run-start `@-` commit id and the answer is the net
 * diff from it to the current `@-`: every path the run's own commits touched.
 * Under git `since` is the run-start HEAD and the answer is every path named by
 * a commit in `since..HEAD`. `[]` when no backend answers, when `since` is
 * empty, or when the read fails — the caller treats an empty set as "nothing
 * was committed", which is the pre-existing behaviour.
 */
export const vcsCommittedPaths = (cwd: string, since: string, backend: VcsBackend = detectVcs(cwd)): string[] => {
	if (!since) return [];
	if (backend === "jj") {
		const raw = readVcs("jj", ["--no-pager", "diff", "--summary", "--from", since, "--to", "@-"], "", cwd);
		return jjSummaryToEntries(raw).map((e) => e.path);
	}
	if (backend === "git") {
		const raw = readVcs("git", ["log", "--name-only", "--pretty=format:", `${since}..HEAD`], "", cwd);
		return raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "")
			.map(unquoteGitPath);
	}
	return [];
};
