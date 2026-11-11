// Pre-bake the bail-out checks and reference values for the changelog skill.
//
// Prints:
//   in_repo: yes|no
//   last_tag: <tag>|(no tags)
//   ---changelogs---
//   <one CHANGELOG.md path per line>     (empty if none tracked)
//
// All values are bounded. The unbounded log and diff calls
// remain LLM-issued via Bash (their output can exceed the 50KB tail budget).
//
// Always exits 0 — non-repo cwd collapses to `in_repo: no` and empty sections.
import { detect, read, readOk } from "./vcs.mjs";

const { backend, root } = detect();

process.stdout.write(`in_repo: ${root ? "yes" : "no"}\n`);

if (!root) {
	process.stdout.write("last_tag: (not in a version-control repo)\n");
	process.stdout.write("---changelogs---\n");
	process.exit(0);
}

// jj has no `describe --tags`: ask for the tags on the nearest tagged ancestors
// instead. `git describe --abbrev=0` answers the same question.
const tagRead =
	backend === "jj"
		? readOk("jj", ["--no-pager", "log", "-r", "heads(::@ & tags())", "--no-graph", "-T", 'tags ++ "\n"'], root)
		: readOk("git", ["describe", "--tags", "--abbrev=0"], root);
// Several tags on one commit make the pick arbitrary; sorting keeps it stable.
const firstTag = (out) =>
	(out.split("\n").find((line) => line.trim() !== "") ?? "").split(/\s+/).filter(Boolean).sort()[0] ?? "";
// jj answers an empty list when nothing is tagged, so a failed read there is a
// real failure. git signals "no tags" by exiting non-zero, so its failure IS the
// no-tags answer.
const lastTag = tagRead.ok ? firstTag(tagRead.out) : "";
const label = backend === "jj" && !tagRead.ok ? "(unavailable)" : lastTag || "(no tags)";

process.stdout.write(`last_tag: ${label}\n`);

// `jj file list` covers the working copy (a jj workspace has no index) and needs
// an explicit glob to stay bounded; `ls-files` covers tracked paths only.
const tracked =
	backend === "jj"
		? read("jj", ["file", "list", "--", "glob:**/CHANGELOG.md"], "", root)
		: read("git", ["ls-files", "CHANGELOG.md", "**/CHANGELOG.md"], "", root);
process.stdout.write("---changelogs---\n");
process.stdout.write(`${tracked}\n`);
