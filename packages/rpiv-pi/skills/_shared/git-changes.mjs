// Pre-bake the "what's changed" snapshot for the commit skill.
//
// Prints:
//   in_repo: yes|no
//   ---status---
//   <version-control status --short>  (capped at 200 lines + footer)
//   ---diffstat---
//   <diff --stat against the parent>  | fallback for no-HEAD / jj
//
// Full diffs are deliberately NOT included — large diffs would push the
// 50KB / 2000-line tail-truncation budget. The commit skill issues
// `git diff <file>` via the Bash tool when it needs per-file detail.
//
// Always exits 0 — non-repo cwd or no-HEAD initial repo collapses to safe
// fallback strings so the skill body never receives a `[Shell error: ...]`.
import { readFileSync } from "node:fs";
import { detect, read, statusEntries } from "./vcs.mjs";

const LINE_CAP = 200;

// The run-start snapshot of paths that were ALREADY dirty before the workflow
// touched anything, passed as `--baseline <path>` by the workflow's commit
// dispatch (the goal stage writes a per-run timestamped snapshot — there is no
// fixed rendezvous file, so concurrent/repeat runs never read each other's).
// A workflow must commit only the work IT did, so files in this baseline are
// surfaced under a separate "do NOT commit" section and kept out of the
// in-scope status. Standalone use (no flag) has no baseline and fences nothing.
const baselineFlagIdx = process.argv.indexOf("--baseline");
const BASELINE_PATH = baselineFlagIdx >= 0 ? process.argv[baselineFlagIdx + 1] : undefined;

// Pre-existing-dirty paths recorded at run start (empty when no --baseline flag /
// unreadable / malformed — the script then behaves exactly as a baseline-less run).
const readBaseline = () => {
	if (!BASELINE_PATH) return new Set();
	try {
		const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
		return new Set(Array.isArray(parsed?.paths) ? parsed.paths.filter((p) => typeof p === "string") : []);
	} catch {
		return new Set();
	}
};

// Emit `raw` line-capped at LINE_CAP, with a truncation footer when over-limit.
// Empty input → `emptyLabel`. Both the status and diffstat sections are
// line-per-file in shape, so the "more files truncated" footer matches the
// convention in code-review/_helpers/review-range.mjs.
const emitCapped = (raw, emptyLabel) => {
	const lines = raw.split("\n");
	const trailingEmpty = lines.length > 0 && lines.at(-1) === "";
	const real = trailingEmpty ? lines.slice(0, -1) : lines;
	if (real.length === 0 || (real.length === 1 && real[0] === "")) {
		process.stdout.write(`${emptyLabel}\n`);
	} else if (real.length > LINE_CAP) {
		process.stdout.write(real.slice(0, LINE_CAP).join("\n"));
		process.stdout.write(`\n(... ${real.length - LINE_CAP} more files truncated ...)\n`);
	} else {
		process.stdout.write(`${real.join("\n")}\n`);
	}
};

const { backend, root } = detect();

process.stdout.write(`in_repo: ${root ? "yes" : "no"}\n`);

if (!root) {
	process.exit(0);
}

const baseline = readBaseline();
const inScope = [];
const preExisting = [];
for (const entry of statusEntries(root, backend)) {
	(baseline.has(entry.path) ? preExisting : inScope).push(`${entry.xy} ${entry.path}`);
}

process.stdout.write("---status---\n");
emitCapped(inScope.join("\n"), "(working tree clean)");

// Pre-existing changes are surfaced but fenced OFF — the commit skill must not
// stage them (a workflow commits only its own work). Emitted only when the
// baseline actually caught something, so a baseline-less run's output is
// unchanged.
if (preExisting.length > 0) {
	process.stdout.write("---pre-existing (do NOT commit — dirty before this run)---\n");
	emitCapped(preExisting.join("\n"), "(none)");
}

// jj has no HEAD and no index: `jj diff` compares the working copy against its
// parent commit, so the "no HEAD yet" branch does not exist there.
process.stdout.write("---diffstat---\n");
if (backend === "jj") {
	emitCapped(read("jj", ["--no-pager", "diff", "--stat"], "", root), "(no changes against @-)");
} else {
	const hasHead = read("git", ["rev-parse", "--verify", "--quiet", "HEAD"], "", root) !== "";
	if (!hasHead) {
		process.stdout.write("(no HEAD yet — initial commit; status above lists all files to be added)\n");
	} else {
		emitCapped(read("git", ["diff", "HEAD", "--stat", "--ignore-submodules=all"], "", root), "(no changes against HEAD)");
	}
}
