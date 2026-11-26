// List N most recently modified files in a directory, newest first, one per line.
// Usage: node list-recent.mjs <dir> [count=10]
//   <dir>   — relative paths are resolved against the git root (or cwd if not in a repo).
//   <count> — max entries to print (default 10).
// Empty stdout when the directory does not exist or contains no files.
// Always exits 0 — directory-missing is a recoverable state, not an error.
// The root probe lives in `vcs.mjs`: a jj workspace answers with its workspace
// root (`jj root`) and a git checkout with its toplevel, so a jj workspace with
// no `.git` above it still resolves relative paths.
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { detect } from "./vcs.mjs";

const [rawDir = ".", nStr = "10"] = process.argv.slice(2);
const n = Math.max(1, Number.parseInt(nStr, 10) || 10);

const { root: repoRoot } = detect();
const dir = isAbsolute(rawDir) ? rawDir : resolve(repoRoot || process.cwd(), rawDir);

if (!existsSync(dir)) process.exit(0);

const items = readdirSync(dir, { withFileTypes: true })
	.filter((d) => d.isFile())
	.map((d) => ({ name: d.name, mtime: statSync(join(dir, d.name)).mtimeMs }))
	.sort((a, b) => b.mtime - a.mtime)
	.slice(0, n);

for (const it of items) console.log(it.name);
