// Splice per-phase elaboration docs back into a synthesized plan, deterministically.
//
// Usage: node stitch-elaborations.mjs <plan-path>
//   <plan-path> — a plan under .rpiv/artifacts/plans/ (relative paths resolve
//                 against the git root, then cwd).
//
// The fan-in barrier of the elaborate fanout. Each `## Phase N:` section in the
// plan is replaced, one-for-one, by the matching elaboration doc's body. This is
// a pure swap by phase number — NOT a reconcile: `synthesize` already resolved
// the cross-phase seams; this only injects the code each `elaborate` lane wrote.
//
// Elaboration docs live in the sibling bucket .rpiv/artifacts/elaborations/,
// named `<plan-basename-without-ext>__phase-<N>.md` (the `elaborate` skill's
// output contract). Each carries a single `## Phase <N>: <title>` section with
// implement-ready code; its frontmatter is stripped before splicing.
//
// Preserved verbatim: the plan's frontmatter (incl. `phase_count`) and the
// preamble before the first phase (`## Synthesis Notes`, etc.). Phase boundaries
// are detected fence-aware (a `## ` inside a Find/Replace code block is NOT a
// boundary) and each phase owns everything up to the next `## Phase N:` heading,
// so the swap is idempotent — re-stitching can't accumulate duplicate per-phase
// trailers (Success Criteria / Notes / Deferred). The heading count is unchanged
// (1:1 swap), so the downstream `phase_count == '## Phase N:' headings`
// derive-check stays valid.
//
// Always exits 0 on a normal run (a plan phase with no elaboration is left as-is
// and reported — partial runs are allowed). Exits 1 only on a wiring/path error:
// missing argument, missing plan, or zero elaboration docs found.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const [rawPlan] = process.argv.slice(2);
if (!rawPlan) {
	console.error("stitch-elaborations: missing <plan-path>");
	process.exit(1);
}

const gitRoot = (() => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
})();

const planPath = isAbsolute(rawPlan) ? rawPlan : resolve(gitRoot || process.cwd(), rawPlan);
if (!existsSync(planPath)) {
	console.error(`stitch-elaborations: plan not found: ${planPath}`);
	process.exit(1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const planBase = basename(planPath).replace(/\.md$/, "");
// Elaborations are the sibling bucket of plans/: .rpiv/artifacts/elaborations/.
const elaborationsDir = resolve(dirname(planPath), "..", "elaborations");

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const PHASE_HEADING_RE = /^## Phase (\d+):/;

/** Split a document into [frontmatter, body]; frontmatter ("" when absent) is kept verbatim. */
const splitFrontmatter = (content) => {
	const m = content.match(FRONTMATTER_RE);
	return m ? [m[0], content.slice(m[0].length)] : ["", content];
};

/** Extract the `## Phase N:` section (heading to EOF) from an elaboration body. */
const phaseSection = (body) => {
	const idx = body.search(/^## Phase \d+:/m);
	return idx === -1 ? null : body.slice(idx).trim();
};

// Collect elaborations: phase number -> spliced section text, keyed off the
// `<planBase>__phase-<N>.md` filename so the pairing is independent of any
// timestamp slug inside the doc.
const NAME_RE = new RegExp(`^${escapeRe(planBase)}__phase-(\\d+)\\.md$`);
const elaborations = new Map();
if (existsSync(elaborationsDir)) {
	for (const name of readdirSync(elaborationsDir)) {
		const m = name.match(NAME_RE);
		if (!m) continue;
		const [, body] = splitFrontmatter(readFileSync(resolve(elaborationsDir, name), "utf-8"));
		const section = phaseSection(body);
		if (section) elaborations.set(Number.parseInt(m[1], 10), section);
	}
}

if (elaborations.size === 0) {
	console.error(
		`stitch-elaborations: no elaboration docs for "${planBase}" in ${elaborationsDir} ` +
			`(expected ${planBase}__phase-<N>.md) — nothing to stitch`,
	);
	process.exit(1);
}

const [frontmatter, body] = splitFrontmatter(readFileSync(planPath, "utf-8"));

// `## Phase N:` headings at column 0 and OUTSIDE fenced code blocks are the ONLY
// section boundaries: each phase owns everything up to the next phase heading
// (its `### Success Criteria`, `## Notes / Deferred`, and any `## …` that appears
// inside a Find/Replace fence). Two reasons this matters:
//   • Fence-aware — an elaboration's Find/Replace blocks legitimately contain
//     `## ` lines (doc edits); a naive `/^## /m` split shreds them into orphan
//     fragments with dangling Replace-with markers.
//   • Idempotent — replacing a phase subsumes whatever trailing matter a prior
//     stitch left behind, so re-elaborate → re-stitch cycles can't accumulate
//     duplicate Success-Criteria / Notes sections. (A non-idempotent stitch made
//     the carve `stitch-gate → elaborate` loop diverge until the backward-jump
//     guard halted the run.)
// Content before the first phase (Synthesis Notes, etc.) is the preamble, kept
// verbatim. Content after the last phase is absorbed into that phase — the plan
// format has no post-phase appendix; trailing matter belongs to the elaboration.
const lines = body.split("\n");
const starts = []; // { offset, n }
let inFence = false;
let fenceLen = 0;
let offset = 0;
for (const line of lines) {
	const fence = line.match(/^\s*(`{3,}|~{3,})/);
	if (fence) {
		const len = fence[1].length;
		if (!inFence) {
			inFence = true;
			fenceLen = len;
		} else if (len >= fenceLen && line.trim().length === len) {
			inFence = false;
			fenceLen = 0;
		}
	} else if (!inFence) {
		const m = line.match(PHASE_HEADING_RE);
		if (m) starts.push({ offset, n: Number.parseInt(m[1], 10) });
	}
	offset += line.length + 1; // +1 for the stripped "\n"
}

const preamble = starts.length ? body.slice(0, starts[0].offset) : body;

let stitched = 0;
const missing = [];
const total = starts.length;
const rebuilt = starts.map(({ offset: start, n }, i) => {
	const original = body.slice(start, starts[i + 1]?.offset ?? body.length);
	const replacement = elaborations.get(n);
	if (replacement) {
		stitched++;
		return replacement;
	}
	missing.push(n);
	return original.trim();
});

const newBody = [preamble.trim(), ...rebuilt].filter((s) => s.length > 0).join("\n\n");
writeFileSync(planPath, `${frontmatter.trimEnd()}\n\n${newBody}\n`);

let summary = `stitch-elaborations: stitched ${stitched}/${total} phases into ${basename(planPath)}`;
if (missing.length) summary += ` — no elaboration for phase(s) ${missing.sort((a, b) => a - b).join(", ")}`;
console.log(summary);
