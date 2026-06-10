// pr-fetch.mjs — deterministic PR fetcher for the pr-triage skill.
//
// LLM-invoked (not render-time substituted). The skill reduces the already-
// substituted Input to a concrete spec (fuzzy/prose references are disambiguated
// in the skill body via `ask_user_question` BEFORE this helper runs), then:
//
//   node "${SKILL_DIR}/_helpers/pr-fetch.mjs" "<spec>"
//
// Accepted <spec> values (deterministic only):
//   auto | (empty)      — the open PR of the current branch (gh resolves it)
//   <number> | #<number>— a PR number
//   <url>               — a GitHub PR URL (…/pull/<number>)
//
// Side-effect-free except for writing the context doc tempfile. Stack-agnostic:
// shells `gh`, makes no assumption about language, framework, or repo layout.
//
// Output (labelled key/value lines, then a `---changed-files---` block):
//
//   strategy:       resolved | no-pr | no-gh
//   pr_number:      <n>|(n/a)
//   title:          <subject>|(n/a)
//   url:            <url>|(n/a)
//   head_ref:       <branch>|(n/a)
//   head_owner:     <fork owner login>|(n/a)
//   head_label:     <owner>:<branch> for a cross-repo fork, else <branch>|(n/a)
//   base_ref:       <branch>|(n/a)
//   author:         <login>|(n/a)
//   files_changed:  <N>
//   additions:      <N>
//   deletions:      <N>
//   linked_issues:  #a, #b|(none)
//   ci_state:       passing | failing | pending | none | unknown
//   ci_failing:     <comma-list of failing check names>|(none)
//   context_path:   <abs path to the written context doc>|(n/a)
//   patch_path:     <abs path to the raw unified-diff patch file>|(n/a)
//   note:           <reason>            (only when strategy != resolved)
//   ---changed-files---
//   <one path per line, capped>
//
// Two artifacts are written: `context_path` — a markdown doc (metadata +
// description + linked issues + comments + reviews + CI + diff) for the
// prose-reading agents (intent, convention drift); and `patch_path` — the raw
// unified diff alone, which `diff-auditor` walks file-by-file for the security
// scan (its contract needs a real patch, not prose). The skill never pastes the
// raw thread. Diff is capped; truncation is annotated in the context doc.
//
// Always exits 0 (mirrors review-range.mjs R-8): a missing `gh`, an unauthed
// host, or a branch with no PR returns a `strategy:` the skill branches on,
// never a shell error the skill body would receive as a substitution.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHANGED_FILES_LINE_CAP = 2000;
const CHANGED_FILES_BYTE_CAP = 40 * 1024;
const DIFF_BYTE_CAP = 256 * 1024; // diff lives in the context doc, not stdout

const safeGh = (args) => {
	try {
		return {
			ok: true,
			out: execFileSync("gh", args, {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 32 * 1024 * 1024,
			}),
		};
	} catch {
		return { ok: false, out: "" };
	}
};

const safeGit = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return fb;
	}
};

const stripOuterQuotes = (s) =>
	s
		.replace(/^['"]/, "")
		.replace(/['"]$/, "")
		.trim();

// Reduce the spec to a PR selector `gh` accepts: a number, or "" for the
// current branch's PR. Returns null when the spec is shaped like neither.
const toSelector = (spec) => {
	if (spec === "" || spec.toLowerCase() === "auto") return "";
	const fromUrl = spec.match(/\/pull\/(\d+)/);
	if (fromUrl) return fromUrl[1];
	const num = spec.replace(/^#/, "");
	if (/^\d+$/.test(num)) return num;
	return null;
};

// Summarise statusCheckRollup into a one-word state AND the list of failing
// check names — so the triage can say WHICH checks failed, not just "failing".
const ciSummary = (rollup) => {
	if (!Array.isArray(rollup) || rollup.length === 0) return { state: "none", failing: [] };
	const FAIL = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];
	const failing = [];
	let pending = false;
	for (const c of rollup) {
		// CheckRun uses `status`/`conclusion` + `name`; StatusContext uses `state` + `context`.
		const concl = String(c.conclusion ?? c.state ?? "").toUpperCase();
		const status = String(c.status ?? "").toUpperCase();
		if (FAIL.includes(concl)) failing.push(c.name ?? c.context ?? "check");
		else if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || concl === "PENDING")
			pending = true;
	}
	const state = failing.length ? "failing" : pending ? "pending" : "passing";
	return { state, failing };
};

const capList = (paths) => {
	let out = "";
	let count = 0;
	for (const p of paths) {
		const next = `${p}\n`;
		if (out.length + next.length > CHANGED_FILES_BYTE_CAP || count >= CHANGED_FILES_LINE_CAP) break;
		out += next;
		count += 1;
	}
	if (count < paths.length) out += `(... ${paths.length - count} more files truncated ...)\n`;
	return out;
};

const result = {
	strategy: "no-pr",
	pr_number: "(n/a)",
	title: "(n/a)",
	url: "(n/a)",
	head_ref: "(n/a)",
	head_owner: "(n/a)",
	head_label: "(n/a)",
	base_ref: "(n/a)",
	author: "(n/a)",
	files_changed: "0",
	additions: "0",
	deletions: "0",
	linked_issues: "(none)",
	ci_state: "unknown",
	ci_failing: "(none)",
	context_path: "(n/a)",
	patch_path: "(n/a)",
	note: "",
	changedFiles: "",
};

const emit = () => {
	const lines = [
		`strategy:       ${result.strategy}`,
		`pr_number:      ${result.pr_number}`,
		`title:          ${result.title}`,
		`url:            ${result.url}`,
		`head_ref:       ${result.head_ref}`,
		`head_owner:     ${result.head_owner}`,
		`head_label:     ${result.head_label}`,
		`base_ref:       ${result.base_ref}`,
		`author:         ${result.author}`,
		`files_changed:  ${result.files_changed}`,
		`additions:      ${result.additions}`,
		`deletions:      ${result.deletions}`,
		`linked_issues:  ${result.linked_issues}`,
		`ci_state:       ${result.ci_state}`,
		`ci_failing:     ${result.ci_failing}`,
		`context_path:   ${result.context_path}`,
		`patch_path:     ${result.patch_path}`,
	];
	if (result.strategy !== "resolved" && result.note) lines.push(`note:           ${result.note}`);
	lines.push("---changed-files---");
	process.stdout.write(`${lines.join("\n")}\n${result.changedFiles}`);
};

// ── 1. gh availability ──────────────────────────────────────────────────────
if (!safeGh(["--version"]).ok) {
	result.strategy = "no-gh";
	result.note = "`gh` CLI not found or not on PATH — install GitHub CLI and run `gh auth login`";
	emit();
	process.exit(0);
}

// ── 2. resolve the selector ─────────────────────────────────────────────────
const spec = stripOuterQuotes(process.argv[2] ?? "");
const selector = toSelector(spec);
if (selector === null) {
	result.note = `spec not a PR number/URL: "${spec}" — disambiguate in the skill before calling the helper`;
	emit();
	process.exit(0);
}

// ── 3. fetch PR metadata as JSON ────────────────────────────────────────────
const FIELDS = [
	"number",
	"title",
	"url",
	"headRefName",
	"headRepositoryOwner",
	"isCrossRepository",
	"baseRefName",
	"author",
	"additions",
	"deletions",
	"changedFiles",
	"files",
	"body",
	"comments",
	"reviews",
	"statusCheckRollup",
	"closingIssuesReferences",
].join(",");

const viewArgs = ["pr", "view", ...(selector ? [selector] : []), "--json", FIELDS];
const viewed = safeGh(viewArgs);
if (!viewed.ok) {
	result.strategy = "no-pr";
	result.note = selector
		? `no PR #${selector} found, or no access (check repo + \`gh auth status\`)`
		: "no open PR for the current branch — pass a PR number or open one first";
	emit();
	process.exit(0);
}

let pr;
try {
	pr = JSON.parse(viewed.out);
} catch {
	result.strategy = "no-pr";
	result.note = "could not parse `gh pr view` JSON";
	emit();
	process.exit(0);
}

// ── 4. populate scalar fields ───────────────────────────────────────────────
result.strategy = "resolved";
result.pr_number = String(pr.number ?? "(n/a)");
result.title = (pr.title ?? "(n/a)").replace(/\s+/g, " ").trim() || "(n/a)";
result.url = pr.url ?? "(n/a)";
result.head_ref = pr.headRefName ?? "(n/a)";
result.head_owner = pr.headRepositoryOwner?.login ?? "(n/a)";
result.base_ref = pr.baseRefName ?? "(n/a)";
result.author = pr.author?.login ?? "(n/a)";
// Disambiguate a same-named fork branch (e.g. a contributor's `main`): qualify
// with the fork owner only when the head is in a DIFFERENT repo than the base.
result.head_label =
	pr.isCrossRepository && result.head_owner !== "(n/a)"
		? `${result.head_owner}:${result.head_ref}`
		: result.head_ref;
result.additions = String(pr.additions ?? 0);
result.deletions = String(pr.deletions ?? 0);

const files = Array.isArray(pr.files) ? pr.files : [];
const filePaths = files.map((f) => f.path).filter(Boolean);
result.files_changed = String(pr.changedFiles ?? filePaths.length);
result.changedFiles = capList(filePaths);

const linked = Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : [];
result.linked_issues = linked.length ? linked.map((i) => `#${i.number}`).join(", ") : "(none)";
const ci = ciSummary(pr.statusCheckRollup);
result.ci_state = ci.state;
result.ci_failing = ci.failing.length ? ci.failing.join(", ") : "(none)";

// ── 5. fetch the diff (capped) ──────────────────────────────────────────────
const diffArgs = ["pr", "diff", ...(selector ? [selector] : [])];
const diffRes = safeGh(diffArgs);
let diff = diffRes.ok ? diffRes.out : "";
let diffTruncated = false;
if (diff.length > DIFF_BYTE_CAP) {
	diff = diff.slice(0, DIFF_BYTE_CAP);
	diffTruncated = true;
}

// ── 6. write the context doc to a worktree-safe tempfile ────────────────────
const docName = `pr-triage-${result.pr_number}-context.md`;
const gitPath = safeGit(["rev-parse", "--git-path", docName], "");
const contextPath = resolve(gitPath || join(tmpdir(), docName));

const fmtComments = (arr, label) =>
	Array.isArray(arr) && arr.length
		? arr
				.map((c) => {
					const who = c.author?.login ?? "unknown";
					const st = c.state ? ` (${c.state})` : "";
					return `### ${label} — @${who}${st}\n\n${(c.body ?? "").trim() || "(empty)"}`;
				})
				.join("\n\n")
		: `_no ${label.toLowerCase()}s_`;

const fmtLinked = linked.length
	? linked.map((i) => `- #${i.number} — ${i.title ?? "(untitled)"}\n\n  ${(i.body ?? "").trim().slice(0, 800)}`).join("\n\n")
	: "_none_";

const doc = `# PR #${result.pr_number} — ${result.title}

- URL: ${result.url}
- Branch: \`${result.head_label}\` → \`${result.base_ref}\`
- Author: @${result.author}
- Size: ${result.files_changed} files, +${result.additions}/-${result.deletions}
- CI: ${result.ci_state}${result.ci_failing !== "(none)" ? ` (${result.ci_failing})` : ""}
- Linked issues: ${result.linked_issues}

## Description

${(pr.body ?? "").trim() || "_no description_"}

## Linked issues

${fmtLinked}

## Review comments

${fmtComments(pr.comments, "Comment")}

## Reviews

${fmtComments(pr.reviews, "Review")}

## Diff${diffTruncated ? ` (truncated at ${Math.round(DIFF_BYTE_CAP / 1024)} KB)` : ""}

\`\`\`diff
${diff || "(diff unavailable)"}
\`\`\`
`;

try {
	writeFileSync(contextPath, doc);
	result.context_path = contextPath;
} catch {
	result.context_path = "(n/a)";
	result.note = "could not write context doc tempfile";
}

// ── 7. write the raw diff to a dedicated patch tempfile ─────────────────────
// `diff-auditor` walks a real unified-diff patch file by file — it cannot use
// the prose context doc. Emit the patch separately so the security agent gets
// the input its contract expects. Same worktree-safe path resolution.
if (diff) {
	const patchName = `pr-triage-${result.pr_number}.diff`;
	const patchGitPath = safeGit(["rev-parse", "--git-path", patchName], "");
	const patchPath = resolve(patchGitPath || join(tmpdir(), patchName));
	try {
		writeFileSync(patchPath, diff);
		result.patch_path = patchPath;
	} catch {
		result.patch_path = "(n/a)";
	}
}

emit();
process.exit(0);
