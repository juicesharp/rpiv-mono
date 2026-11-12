// Version-control backend seam for the skill helper scripts under `skills/`.
// Every helper that shells out to a version-control command asks this module
// which backend answers, so one vocabulary decides which command family a
// skill body may use.
//
// Contract for every `_shared/*.mjs` helper:
//   - `node:` builtins only — no package imports.
//   - Nothing throws, nothing exits; every read collapses to a fallback.
//   - jj wins over git in a colocated repository, because a jj workspace keeps
//     its working copy in `.jj` and may have no `.git` above it at all.
import { execFileSync } from "node:child_process";

/** `{ ok, out }` for `bin args...` run in `cwd`. `ok` is false on any failure, so
 *  a caller can tell "the command failed" from "the command printed nothing". */
export const readOk = (bin, args, cwd = process.cwd()) => {
	try {
		return { ok: true, out: execFileSync(bin, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }) };
	} catch {
		return { ok: false, out: "" };
	}
};

/** Raw stdout of `bin args...`; `fb` on failure or empty output. NOT trimmed: a
 *  porcelain status line's `XY` code can START with a space (` M path`), and
 *  trimming would eat the first line's status letter. */
export const readRaw = (bin, args, fb = "", cwd = process.cwd()) => {
	const { out } = readOk(bin, args, cwd);
	return out.trim() === "" ? fb : out;
};

/** Trimmed stdout of `bin args...` run in `cwd`; `fb` on failure or empty output. */
export const read = (bin, args, fb = "", cwd = process.cwd()) => readRaw(bin, args, fb, cwd).trim() || fb;

/** `{ backend, root }` for `cwd`. jj wins when both backends could answer. */
export const detect = (cwd = process.cwd()) => {
	const jjRoot = read("jj", ["root"], "", cwd);
	if (jjRoot) return { backend: "jj", root: jjRoot };
	const gitRoot = read("git", ["rev-parse", "--show-toplevel"], "", cwd);
	if (gitRoot) return { backend: "git", root: gitRoot };
	return { backend: "none", root: "" };
};

// jj renders a rename as `R {old.ts => new.ts}` or `R dir/{a.ts => b.ts}`. The
// committed path is the new side, with the shared prefix left outside the braces.
const jjRenamePath = (rest) => rest.replace(/\{(.*?) => (.*?)\}/, "$2").trim();

// jj status letter -> the `XY` code the skill bodies already read. `A` is `??`:
// the path did not exist in the parent commit, so it cannot have overwritten
// pre-existing work, which is exactly what `??` means to the commit skill.
const JJ_CODES = { M: " M", A: "??", D: " D", R: " R", C: "??", T: " M" };

/** `jj diff --summary` rewritten into git's `XY <path>` grammar. */
export const jjSummaryToStatus = (raw) =>
	raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => `${JJ_CODES[line[0]] ?? " M"} ${jjRenamePath(line.slice(1))}`)
		.join("\n");

/** `git status --short -z` records: NUL-separated `XY <path>` fields, with the
 *  ORIGINAL path as its own following field for a rename/copy. `-z` never
 *  cquote-escapes, so the path is the real on-disk spelling — the same spelling
 *  the baseline records. */
const parseShortZ = (raw) => {
	const fields = raw.split("\0").filter((f) => f !== "");
	const entries = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		const xy = field.slice(0, 2);
		entries.push({ xy, path: field.slice(3) });
		// A rename/copy record is followed by the original path as its own field.
		if (xy[0] === "R" || xy[0] === "C") i += 1;
	}
	return entries;
};

/** Working-copy status as `{ xy, path }` entries under either backend; `[]` when
 *  no backend answers. The git side passes `--untracked-files=all`: the workflow
 *  baseline records file paths, and a collapsed `dir/` entry can never match one. */
export const statusEntries = (cwd = process.cwd(), backend = detect(cwd).backend) => {
	if (backend === "jj") {
		return jjSummaryToStatus(readRaw("jj", ["--no-pager", "diff", "--summary"], "", cwd))
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => ({ xy: line.slice(0, 2), path: line.slice(3) }));
	}
	if (backend === "git") {
		return parseShortZ(readRaw("git", ["status", "--short", "-z", "--untracked-files=all"], "", cwd));
	}
	return [];
};

/** Working-copy status as `XY <path>` lines under either backend; `""` when no
 *  backend answers. Rendered from `statusEntries`, so the git arm keeps the first
 *  line's leading status space and a rename shows only its new side. */
export const statusText = (cwd = process.cwd(), backend = detect(cwd).backend) =>
	statusEntries(cwd, backend)
		.map((e) => `${e.xy} ${e.path}`)
		.join("\n");
