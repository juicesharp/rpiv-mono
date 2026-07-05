// Pre-bake the "what's changed" snapshot for the commit skill.
//
// Prints:
//   in_repo: yes|no
//   ---status---
//   <git status --short>            (capped at 200 lines + footer)
//   ---diffstat---
//   <git diff HEAD --stat --ignore-submodules=all>  | fallback for no-HEAD
//
// Full `git diff` is deliberately NOT included — large diffs would push the
// 50KB / 2000-line tail-truncation budget. The commit skill issues
// `git diff <file>` via the Bash tool when it needs per-file detail.
//
// Always exits 0 — non-repo cwd or no-HEAD initial repo collapses to safe
// fallback strings so the skill body never receives a `[Shell error: ...]`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LINE_CAP = 200;

// Where the run's start stage records the paths that were ALREADY dirty before
// the workflow touched anything. A workflow must commit only the work IT did, so
// files in this baseline are surfaced under a separate "do NOT commit" section
// and kept out of the in-scope status — the commit skill never sweeps an
// unrelated, pre-existing working-tree change into the run's commit.
const BASELINE_PATH = ".rpiv/artifacts/commit-baseline.json";

// The path a `git status --short` line refers to. Columns 0-2 are the XY status
// code + space; a rename/copy renders `old -> new`, whose committed path is the
// `new` side.
const statusPath = (line) => {
	const rest = line.slice(3).trim();
	const arrow = rest.indexOf(" -> ");
	return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
};

// Pre-existing-dirty paths recorded at run start (empty when no baseline file /
// unreadable / malformed — the script then behaves exactly as before).
const readBaseline = () => {
	try {
		const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
		return new Set(Array.isArray(parsed?.paths) ? parsed.paths.filter((p) => typeof p === "string") : []);
	} catch {
		return new Set();
	}
};

const safe = (args, fb) => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return fb;
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

const root = safe(["rev-parse", "--show-toplevel"], "");
const inRepo = root ? "yes" : "no";

process.stdout.write(`in_repo: ${inRepo}\n`);

if (!root) {
	process.exit(0);
}

const baseline = readBaseline();
const statusLines = safe(["status", "--short"], "")
	.split("\n")
	.filter((l) => l.trim() !== "");
const inScope = [];
const preExisting = [];
for (const line of statusLines) {
	(baseline.has(statusPath(line)) ? preExisting : inScope).push(line);
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

// `git diff HEAD --stat` errors on a fresh repo with no commits — substitute
// a fallback marker so the LLM knows the status block above already covers
// what would land in the initial commit.
const hasHead = safe(["rev-parse", "--verify", "--quiet", "HEAD"], "") !== "";
process.stdout.write("---diffstat---\n");
if (!hasHead) {
	process.stdout.write("(no HEAD yet — initial commit; status above lists all files to be added)\n");
} else {
	emitCapped(safe(["diff", "HEAD", "--stat", "--ignore-submodules=all"], ""), "(no changes against HEAD)");
}
