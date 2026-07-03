// review-range.mjs — scope resolution helper for the code-review skill.
//
// LLM-invoked (not render-time substituted). The LLM derives the scope spec
// from `$ARGUMENTS` (or `ask_user_question` clarification) and runs:
//
//   node "${SKILL_DIR}/_helpers/review-range.mjs" "<scope-spec>"
//
// Accepted <scope-spec> values:
//   auto                — empty-scope-default: feature branch vs default branch, first-parent
//   commit              — review the most recent commit (working-tree-style, HEAD)
//   staged              — files staged for commit (git diff --cached)
//   working             — files with unstaged changes only (git diff)
//   modified            — every tracked file differing from HEAD (git diff HEAD; staged + unstaged, no untracked)
//   --folder <path>     — review all tracked files in <path> as complete entities (no git history)
//   --file <paths>      — review one or more specific tracked files as complete entities
//                         (comma-separate multiple paths; literal commas in paths are not supported)
//   folder:<path>       — legacy alias for --folder <path>
//   file:<paths>        — legacy alias for --file <paths>
//   <hash>              — single commit (~7+ hex chars)
//   <A>..<B>            — range; A is verified ancestor of B, swapped if reversed
//   <h1>,<h2>,<h3>      — comma- or whitespace-separated commit list; helper finds endpoints
//   <branch-name>       — assumed PR branch checked out at HEAD
//
// Output (labeled key/value lines, then `---changed-files---` block):
//
//   default_branch: <name>|(unresolved)
//   strategy:       first-parent|working-tree|explicit-range|tree|unrecognised
//   oldest:         <hash>|(n/a)
//   newest:         <hash>|(n/a)
//   base:           <hash>|(n/a)
//   tip:            <hash>|(n/a)
//   range:          <base>..<tip>|(n/a)
//   fp_flag:        --first-parent|(empty)
//   patch_path:     <worktree-safe path for the diff tempfile>
//   null_tree:      <empty tree hash>   (only when strategy=tree)
//   note:           <reason>          (only when strategy=unrecognised)
//   ---changed-files---
//   <deduplicated file list, capped at 2000 entries OR 40 KB whichever first>
//
// ChangedFiles cap: 2000 lines OR 40 KB. Footer `(... N more files truncated ...)`
// when hit. Per R-1, helper output is sized for the Pi-bash-tool consumer; this
// helper is LLM-invoked so the 50 KB rpiv-args tail-truncation budget does not
// apply, but the cap keeps output manageable in context.
//
// Load-bearing comments preserved from the original code-review skill:
//   - For first-parent strategies (empty/PR-branch), OLDEST is ALREADY the
//     parent-of-first-feature-commit (computed via git merge-base), so BASE=OLDEST.
//     Do NOT compute BASE=OLDEST^ — that would skip a commit.
//   - For explicit-range strategies (single hash, A..B), BASE=OLDEST^ to include
//     OLDEST's own changes (standard `A..B` excludes A).
//   - --first-parent is orthogonal to --no-merges: the former prunes second-parent
//     subtrees from reachability; the latter drops merge commits themselves from
//     the log. Both flags are independently controllable in the consumer's git log.
//   - Always exit 0 (R-8) — unrecognised scope returns strategy=unrecognised with
//     `note:` so the LLM can ask the user via ask_user_question rather than fail.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CHANGED_FILES_LINE_CAP = 2000;
const CHANGED_FILES_BYTE_CAP = 40 * 1024;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return fb;
	}
};

const isAncestor = (a, b) => {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", a, b], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
};

const refExists = (ref) => {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
};

const resolveDefaultBranch = () => {
	const head = safe(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head) return head.replace(/^origin\//, "");
	if (refExists("main")) return "main";
	if (refExists("master")) return "master";
	return "(unresolved)";
};

const stripOuterQuotes = (s) =>
	s
		.replace(/^['"]/, "")
		.replace(/['"]$/, "")
		.trim();

const dedupChangedFiles = (raw) => {
	const seen = new Set();
	const lines = raw.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) seen.add(trimmed);
	}
	return [...seen];
};

const formatChangedFiles = (files) => {
	let out = "";
	let count = 0;
	for (const f of files) {
		const next = `${f}\n`;
		if (out.length + next.length > CHANGED_FILES_BYTE_CAP) break;
		if (count >= CHANGED_FILES_LINE_CAP) break;
		out += next;
		count += 1;
	}
	if (count < files.length) {
		out += `(... ${files.length - count} more files truncated ...)\n`;
	}
	return out;
};

const result = {
	default_branch: resolveDefaultBranch(),
	strategy: "unrecognised",
	oldest: "(n/a)",
	newest: "(n/a)",
	base: "(n/a)",
	tip: "(n/a)",
	range: "(n/a)",
	fp_flag: "(empty)",
	note: "",
	changedFiles: "",
};

const setUnrecognised = (note) => {
	result.strategy = "unrecognised";
	result.oldest = "(n/a)";
	result.newest = "(n/a)";
	result.base = "(n/a)";
	result.tip = "(n/a)";
	result.range = "(n/a)";
	result.fp_flag = "(empty)";
	result.note = note;
	result.changedFiles = "";
	delete result.tree_path;
	delete result.files_list;
	delete result.null_tree;
};

const argv = process.argv.slice(2).join(" ");
const scope = stripOuterQuotes(argv);
const lower = scope.toLowerCase();
const defaultBranch = result.default_branch;

const setFirstParent = (oldest, newest) => {
	result.strategy = "first-parent";
	result.oldest = oldest;
	result.newest = newest;
	result.base = oldest;
	result.tip = newest;
	result.range = `${oldest}..${newest}`;
	result.fp_flag = "--first-parent";
};

const setExplicitRange = (oldest, newest) => {
	result.strategy = "explicit-range";
	result.oldest = oldest;
	result.newest = newest;
	const parent = safe(["rev-parse", `${oldest}^`]);
	result.base = parent || oldest;
	result.tip = newest;
	result.range = `${result.base}..${newest}`;
	result.fp_flag = "(empty)";
};

const setWorkingTree = (oldest = "(n/a)", newest = "(n/a)") => {
	result.strategy = "working-tree";
	result.oldest = oldest;
	result.newest = newest;
	result.base = "(n/a)";
	result.tip = "(n/a)";
	result.range = "(n/a)";
	result.fp_flag = "(empty)";
};

const setTree = (path) => {
	const raw = safe(["ls-files", "--cached", "--", path]);
	const files = dedupChangedFiles(raw);
	if (files.length === 0) {
		setUnrecognised(`folder scope has no tracked files: ${path}`);
		return;
	}
	result.strategy = "tree";
	result.oldest = "(n/a)";
	result.newest = "(n/a)";
	result.base = "(n/a)";
	result.tip = "(n/a)";
	result.range = "(n/a)";
	result.fp_flag = "(empty)";
	result.tree_path = path;
	result.null_tree = safe(["hash-object", "-t", "tree", "/dev/null"], EMPTY_TREE_HASH);
	// Enumerate tracked files only — git ls-files --cached respects .gitignore
	// and excludes untracked files. The orchestrator diffs the INDEX against
	// the repository's empty-tree object (git diff --cached <null_tree>), so
	// the patch covers exactly this file set — including staged-but-uncommitted
	// files, which a HEAD-based diff would silently drop.
	result.changedFiles = formatChangedFiles(files);
};

const parseFileScopePaths = (paths) => {
	const parts = paths.split(",");
	return dedupChangedFiles(parts.map((p) => stripOuterQuotes(p.trim())).filter(Boolean).join("\n"));
};

const setFiles = (paths) => {
	const pathList = parseFileScopePaths(paths);
	const tracked = [];
	const missing = [];
	const notSingleFiles = [];
	for (const p of pathList) {
		const trackedPath = safe(["ls-files", "--cached", "--error-unmatch", "--", p]);
		const matches = dedupChangedFiles(trackedPath);
		if (matches.length === 1) {
			tracked.push(matches[0]);
		} else if (matches.length > 1) {
			notSingleFiles.push(p);
		} else {
			missing.push(p);
		}
	}
	if (pathList.length === 0) {
		setUnrecognised("file scope did not include any paths");
		return;
	}
	if (missing.length > 0) {
		setUnrecognised(`file scope contains untracked path(s): ${missing.join(", ")}`);
		return;
	}
	if (notSingleFiles.length > 0) {
		setUnrecognised(`file scope path(s) must resolve to exactly one tracked file: ${notSingleFiles.join(", ")}`);
		return;
	}
	result.strategy = "tree";
	result.oldest = "(n/a)";
	result.newest = "(n/a)";
	result.base = "(n/a)";
	result.tip = "(n/a)";
	result.range = "(n/a)";
	result.fp_flag = "(empty)";
	result.null_tree = safe(["hash-object", "-t", "tree", "/dev/null"], EMPTY_TREE_HASH);
	result.files_list = tracked.join(",");
	result.changedFiles = formatChangedFiles(tracked);
};

const flagValue = (s, flag) => {
	if (s === flag) return "";
	if (s.startsWith(`${flag}=`)) return s.slice(flag.length + 1).trim();
	if (s.startsWith(`${flag} `)) return s.slice(flag.length).trim();
	return null;
};

const isFolderScope = (s) => {
	const flagPath = flagValue(s, "--folder");
	if (flagPath !== null) {
		if (flagPath) {
			setTree(flagPath);
		} else {
			setUnrecognised("--folder scope requires a path");
		}
		return true;
	}
	if (s.startsWith("folder:")) {
		const path = s.slice(7).trim();
		if (path) {
			setTree(path);
		} else {
			setUnrecognised("folder scope requires a path");
		}
		return true;
	}
	return false;
};

const isFilesScope = (s) => {
	const flagPaths = flagValue(s, "--file");
	if (flagPaths !== null) {
		if (flagPaths) {
			setFiles(flagPaths);
		} else {
			setUnrecognised("--file scope requires at least one path");
		}
		return true;
	}
	if (s.startsWith("file:")) {
		const paths = s.slice(5).trim();
		if (paths) {
			setFiles(paths);
		} else {
			setUnrecognised("file scope requires at least one path");
		}
		return true;
	}
	return false;
};

const isHexHash = (s) => /^[0-9a-f]{4,40}$/i.test(s);

if (isFolderScope(scope)) {
	// folder strategy already set — skip all other branches.
} else if (isFilesScope(scope)) {
	// file strategy already set — skip all other branches.
} else if (defaultBranch === "(unresolved)" && (lower === "" || lower === "auto")) {
	result.strategy = "unrecognised";
	result.note = "default branch unresolved — pass an explicit scope or run `git remote set-head origin -a`";
} else if (lower === "" || lower === "auto") {
	const oldest = safe(["merge-base", defaultBranch, "HEAD"]);
	if (oldest) setFirstParent(oldest, safe(["rev-parse", "HEAD"]));
	else result.note = `merge-base ${defaultBranch}..HEAD failed`;
} else if (lower === "commit") {
	setWorkingTree(safe(["rev-parse", "HEAD"]), safe(["rev-parse", "HEAD"]));
} else if (lower === "staged" || lower === "working" || lower === "modified") {
	setWorkingTree();
} else if (scope.includes("..") && !scope.includes("...")) {
	const [a, b] = scope.split("..");
	if (refExists(a) && refExists(b)) {
		const aHash = safe(["rev-parse", a]);
		const bHash = safe(["rev-parse", b]);
		if (isAncestor(aHash, bHash)) setExplicitRange(aHash, bHash);
		else if (isAncestor(bHash, aHash)) setExplicitRange(bHash, aHash);
		else result.note = `neither ${a} nor ${b} is an ancestor of the other`;
	} else {
		result.note = `range endpoint(s) do not resolve: ${a}..${b}`;
	}
} else if (/[,\s]/.test(scope)) {
	const hashes = scope.split(/[,\s]+/).filter(Boolean);
	const resolved = hashes.map((h) => safe(["rev-parse", h])).filter(Boolean);
	if (resolved.length < 2) {
		result.note = `commit list under-specified (need ≥2 valid hashes; got ${resolved.length})`;
	} else {
		const topo = safe(["rev-list", "--topo-order", ...resolved]).split("\n");
		const present = new Set(resolved);
		const ordered = topo.filter((h) => present.has(h));
		if (ordered.length < 2) {
			result.note = "commit list not on a single linear ancestry";
		} else {
			setFirstParent(ordered.at(-1), ordered[0]);
		}
	}
} else if (isHexHash(scope) && refExists(scope)) {
	const hash = safe(["rev-parse", scope]);
	setExplicitRange(hash, hash);
} else if (refExists(scope)) {
	const oldest = safe(["merge-base", defaultBranch, "HEAD"]);
	if (oldest) setFirstParent(oldest, safe(["rev-parse", "HEAD"]));
	else result.note = `merge-base ${defaultBranch}..HEAD failed for branch ${scope}`;
} else {
	result.note = `scope spec not recognised: ${scope}`;
}

// ChangedFiles per strategy.
if (result.strategy === "first-parent") {
	const raw = safe(["log", result.range, "--first-parent", "--name-only", "--pretty=format:"]);
	result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
} else if (result.strategy === "explicit-range") {
	const raw = safe(["log", result.range, "--name-only", "--pretty=format:"]);
	result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
} else if (result.strategy === "working-tree") {
	if (lower === "commit") {
		const raw = safe(["show", "HEAD", "--name-only", "--pretty=format:"]);
		result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
	} else if (lower === "staged") {
		const raw = safe(["diff", "--cached", "--name-only"]);
		result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
	} else if (lower === "modified") {
		// modified: every tracked file that differs from HEAD (staged + unstaged,
		// no untracked). Matches `git diff HEAD` semantics — what would be
		// committed by `git add -u && git commit`.
		const raw = safe(["diff", "HEAD", "--name-only"]);
		result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
	} else {
		// working: unstaged only (matches git's "working tree" definition and
		// the skill's `git diff -U30` patch command — both exclude staged).
		const raw = safe(["diff", "--name-only"]);
		result.changedFiles = formatChangedFiles(dedupChangedFiles(raw));
	}
} else if (result.strategy === "tree") {
	// ChangedFiles already populated in setTree() / setFiles().
}

// Worktree-safe tempfile location. In a git worktree (or submodule) `.git` is a
// regular FILE (a gitlink), so a literal `.git/<name>` write fails with ENOTDIR.
// `rev-parse --git-path` resolves to the real per-worktree gitdir; in a plain
// checkout it returns `.git/<name>` unchanged. `rev-parse` returns the path
// relative to CWD — resolve to absolute so the orchestrator and every subagent
// hit the same file regardless of the directory they run from.
const patchPath = resolve(
	safe(["rev-parse", "--git-path", "code-review-patch.diff"], ".git/code-review-patch.diff"),
);

const lines = [
	`default_branch: ${result.default_branch}`,
	`strategy:       ${result.strategy}`,
	`oldest:         ${result.oldest}`,
	`newest:         ${result.newest}`,
	`base:           ${result.base}`,
	`tip:            ${result.tip}`,
	`range:          ${result.range}`,
	`fp_flag:        ${result.fp_flag}`,
	`patch_path:     ${patchPath}`,
];
if (result.strategy === "tree") {
	lines.push(`null_tree:      ${result.null_tree}`);
	if (result.tree_path) {
		lines.push(`tree_path:      ${result.tree_path}`);
	}
	if (result.files_list) {
		lines.push(`files_list:     ${result.files_list}`);
	}
}
if (result.strategy === "unrecognised" && result.note) {
	lines.push(`note:           ${result.note}`);
}
lines.push("---changed-files---");
process.stdout.write(`${lines.join("\n")}\n${result.changedFiles}`);
