// Print labeled lines summarising the current cwd's version-control state.
// Always exits 0 — every failure path collapses to a stable fallback so the
// skill body never receives a `[Shell error: ...]` substitution.
//
//   vcs:    git|jj|none
//   branch: <name>|no-branch
//   commit: <short-id>|no-commit
//   repo:   <basename of toplevel>|unknown
//   root:   <absolute toplevel path>|(empty)
//   in_repo: yes|no
//   author: <user.name>|unknown
import { basename } from "node:path";
import { detect, read } from "./vcs.mjs";

const { backend, root } = detect();

const firstLine = (text, fb) => text.split("\n").find((line) => line.trim() !== "") ?? fb;

// A jj working-copy commit usually carries no bookmark, so "branch" means the
// nearest bookmarked ancestor.
const jjBranch = () => {
	const own = read("jj", ["--no-pager", "log", "-r", "@", "--no-graph", "-T", 'bookmarks ++ "\n"'], "", root);
	if (firstLine(own, "").trim()) return firstLine(own, "no-branch").split(/\s+/)[0];
	const nearest = read(
		"jj",
		["--no-pager", "log", "-r", "heads(::@ & bookmarks())", "--no-graph", "-T", 'bookmarks ++ "\n"'],
		"",
		root,
	);
	return firstLine(nearest, "no-branch").split(/\s+/)[0];
};

const state =
	backend === "jj"
		? {
				branch: jjBranch(),
				commit: read("jj", ["--no-pager", "log", "-r", "@", "--no-graph", "-T", "commit_id.short()"], "no-commit", root),
				author: read("jj", ["config", "get", "user.name"], "", root) || process.env.USER || "unknown",
			}
		: backend === "git"
			? {
					branch: read("git", ["branch", "--show-current"], "no-branch", root),
					commit: read("git", ["rev-parse", "--short", "HEAD"], "no-commit", root),
					// The git arm resolves the author the same way the jj arm and the
					// extension-side reader do: config, then the environment, then "unknown".
					author: read("git", ["config", "user.name"], "", root) || process.env.USER || "unknown",
				}
			: { branch: "no-branch", commit: "no-commit", author: "unknown" };

process.stdout.write(
	[
		`vcs: ${backend}`,
		`branch: ${state.branch}`,
		`commit: ${state.commit}`,
		`repo: ${root ? basename(root) : "unknown"}`,
		`root: ${root}`,
		`in_repo: ${root ? "yes" : "no"}`,
		`author: ${state.author}`,
		"",
	].join("\n"),
);
