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

const STATUS_LINE_CAP = 200;

const safe = (args, fb) => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return fb;
	}
};

const root = safe(["rev-parse", "--show-toplevel"], "").trim();
const inRepo = root ? "yes" : "no";

process.stdout.write(`in_repo: ${inRepo}\n`);

if (!root) {
	process.exit(0);
}

const statusRaw = safe(["status", "--short"], "");
const statusLines = statusRaw.split("\n");
const trailingEmpty = statusLines.length > 0 && statusLines.at(-1) === "";
const realLines = trailingEmpty ? statusLines.slice(0, -1) : statusLines;
process.stdout.write("---status---\n");
if (realLines.length === 0) {
	process.stdout.write("(working tree clean)\n");
} else if (realLines.length > STATUS_LINE_CAP) {
	process.stdout.write(realLines.slice(0, STATUS_LINE_CAP).join("\n"));
	process.stdout.write(`\n(... ${realLines.length - STATUS_LINE_CAP} more files truncated ...)\n`);
} else {
	process.stdout.write(`${realLines.join("\n")}\n`);
}

// `git diff HEAD --stat` errors on a fresh repo with no commits — substitute
// a fallback marker so the LLM knows the status block above already covers
// what would land in the initial commit.
const hasHead = safe(["rev-parse", "--verify", "--quiet", "HEAD"], "").trim() !== "";
process.stdout.write("---diffstat---\n");
if (!hasHead) {
	process.stdout.write("(no HEAD yet — initial commit; status above lists all files to be added)\n");
} else {
	const diffstat = safe(["diff", "HEAD", "--stat", "--ignore-submodules=all"], "");
	process.stdout.write(diffstat || "(no changes against HEAD)\n");
}
