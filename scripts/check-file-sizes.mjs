// check-file-sizes.mjs — size-growth ratchet over the guarded source tree.
//
//   node scripts/check-file-sizes.mjs                    check mode
//   node scripts/check-file-sizes.mjs --update-baseline  regenerate the baseline from disk
//
// WHY A RATCHET, NOT FIXED THRESHOLDS
//   A fixed line cap ("no file over N lines") fails the day the repo legitimately
//   grows past it, and the fix is always the same: raise N. A committed baseline
//   inverts the contract — existing files may only grow slowly (max +10% or +50
//   lines, whichever is larger, per regeneration cycle), new files must fit a
//   class cap (1,000 source / 3,000 test), and every raise is a visible,
//   reviewable baseline diff riding the same commit as the growth it blesses.
//   A split cannot silently regrow.
//
// WHY TESTS ARE COUNTED
//   The largest regrowth path observed in this repo was a test-file monolith
//   (9,591 lines) — test files grow by accretion ("just one more describe"), so
//   they get a higher new-file cap, not a free pass.
//
// WHY THESE EXCLUSIONS
//   node_modules and __fixtures__ are installed or fixture trees, not authored
//   surface (skipped anywhere in the walk); declaration twins (.d.ts / .d.mts)
//   are emitted, not hand-written. GUARDED_ROOTS deliberately stays at
//   packages/rpiv-pi — the authoring tier this guard was cut for; widening to
//   the whole repo is a one-constant edit once the other packages have been
//   baselined deliberately.
//
// EXIT CONTRACT
//   Exit 0 = every walked file is within its ratchet: baselined files within
//   baseline + allowance, unregistered files under their class cap (reported
//   as a non-fatal ratchet-them-in notice). Exit 1 = any violation, printed per
//   file with the arithmetic, plus the remediation hint. No top-level throws.
//
// BASELINE CONTRACT
//   scripts/file-size-baseline.json is generated state — never hand-edited
//   except to LOWER an entry (that tightens the ratchet). Keys are repo-root-
//   relative posix paths, sorted, tab-indented with a trailing newline (the
//   scripts/sync-versions.js JSON write convention). Deleted paths drop out at
//   the next --update-baseline; a regen must ride the same commit as the growth
//   it registers, so the diff stays reviewable.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Single tune point — recalibrate here, never inline.
const GUARDED_ROOTS = ["packages/rpiv-pi"];
const COUNTED_EXT = new Set([".ts", ".mjs", ".js"]);
const SKIP_DIRS = new Set(["node_modules", "__fixtures__"]); // skipped anywhere in the walk
const SKIP_EXT = new Set([".d.ts", ".d.mts"]); // suffix-matched: extname() of a declaration twin is ".ts"
const TOLERANCE_PCT = 10; // baselined files may grow this percent per cycle ...
const FLAT_ALLOWANCE = 50; // ... or this many flat lines, whichever is larger
const NEW_FILE_CAP_SOURCE = 1000; // unregistered non-test files
const NEW_FILE_CAP_TEST = 3000; // unregistered *.test.* files
const TEST_BASENAME_RE = /\.test\.[cm]?[jt]s$/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "file-size-baseline.json");

function walk(dir, out = []) {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(ent.name)) continue;
		const full = join(dir, ent.name);
		if (ent.isDirectory()) {
			walk(full, out);
		} else if (
			ent.isFile() &&
			COUNTED_EXT.has(extname(ent.name)) &&
			[...SKIP_EXT].some((suffix) => ent.name.endsWith(suffix)) === false
		) {
			out.push(full);
		}
	}
	return out;
}

// Newline-normalized count: split("\n"), then drop the single trailing empty
// element a newline-terminated file contributes — matches `wc -l` for files
// that end in a newline, and still counts an unterminated last line as a line.
function countLines(content) {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

// Baseline keys (and all reporting) use repo-root-relative posix paths.
function toRepoPosix(fullPath) {
	return relative(REPO_ROOT, fullPath).split(sep).join("/");
}

function walkedFiles() {
	const out = [];
	for (const root of GUARDED_ROOTS) {
		const abs = join(REPO_ROOT, root);
		if (existsSync(abs)) walk(abs, out);
	}
	return out.map(toRepoPosix).sort();
}

function loadBaseline() {
	if (!existsSync(BASELINE_PATH)) {
		console.error("scripts/file-size-baseline.json is missing — generate and commit it:");
		console.error("  node scripts/check-file-sizes.mjs --update-baseline");
		process.exit(1);
	}
	try {
		const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			parsed.files === null ||
			typeof parsed.files !== "object" ||
			Array.isArray(parsed.files)
		) {
			throw new Error('not a baseline document (expected { "files": { ... } })');
		}
		return parsed.files;
	} catch (e) {
		console.error(`scripts/file-size-baseline.json is unreadable (${e.message}) — regenerate it:`);
		console.error("  node scripts/check-file-sizes.mjs --update-baseline");
		process.exit(1);
	}
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--update-baseline")) {
	console.error("usage: node scripts/check-file-sizes.mjs [--update-baseline]");
	process.exit(1);
}

if (args[0] === "--update-baseline") {
	const files = {};
	for (const rel of walkedFiles()) {
		files[rel] = countLines(readFileSync(join(REPO_ROOT, rel), "utf8"));
	}
	const sorted = Object.fromEntries(
		Object.keys(files)
			.sort()
			.map((key) => [key, files[key]]),
	);
	writeFileSync(BASELINE_PATH, `${JSON.stringify({ files: sorted }, null, "\t")}\n`);
	console.log(`baseline updated: scripts/file-size-baseline.json (${Object.keys(sorted).length} entries)`);
	process.exit(0);
}

const baseline = loadBaseline();
const violations = [];
let baselinedCount = 0;
let newUnderCap = 0;
let prunedCount = 0;
const seen = new Set();

for (const rel of walkedFiles()) {
	seen.add(rel);
	const lines = countLines(readFileSync(join(REPO_ROOT, rel), "utf8"));
	const base = baseline[rel];
	if (typeof base === "number") {
		baselinedCount++;
		const allowance = Math.max(Math.round((base * TOLERANCE_PCT) / 100), FLAT_ALLOWANCE);
		if (lines > base + allowance) {
			violations.push(`${rel}: ${lines} lines > baseline ${base} + allowance ${allowance}`);
		}
	} else {
		const cap = TEST_BASENAME_RE.test(rel) ? NEW_FILE_CAP_TEST : NEW_FILE_CAP_SOURCE;
		if (lines > cap) {
			violations.push(`${rel}: ${lines} lines > new-file cap ${cap} (unregistered)`);
		} else {
			newUnderCap++;
		}
	}
}

for (const key of Object.keys(baseline)) {
	if (!seen.has(key)) prunedCount++;
}

if (violations.length > 0) {
	console.error(`Found ${violations.length} file(s) over the size ratchet:`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(
		"\nSplit the file, or bump deliberately: node scripts/check-file-sizes.mjs --update-baseline in the same commit.",
	);
	process.exit(1);
}

console.log(
	`OK — ${baselinedCount + newUnderCap} files within ratchet (${baselinedCount} baselined, ${newUnderCap} new under cap).`,
);
if (newUnderCap > 0) {
	console.log(`note: ${newUnderCap} new files under cap — run --update-baseline to ratchet them in`);
}
if (prunedCount > 0) {
	console.log(`note: ${prunedCount} baseline entries have no on-disk file (pruned at the next --update-baseline)`);
}
