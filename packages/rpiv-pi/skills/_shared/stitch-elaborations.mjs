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
// preamble before the first phase (`## Synthesis Notes`, etc.). The trailing
// `## Whole-Plan Verification` section is preserved as well: an authored block
// is re-appended verbatim after the last phase (the swap of an elaborated last
// phase would otherwise drop it, heading to EOF); with no authored block but a
// Synthesis-Notes reference to one, a block is derived from the per-phase
// `Automated Verification:` items — never invented otherwise. Phase boundaries
// are detected fence-aware (a `## ` inside a Find/Replace code block is NOT a
// boundary) and each phase owns everything up to the next `## Phase N:` heading,
// so the swap is idempotent — re-stitching can't accumulate duplicate per-phase
// trailers (Success Criteria / Notes / Deferred). An elaboration is refused
// when a fence it opens never closes (the leak would swallow the next phase's
// heading) or when it carries other than one out-of-fence `## Phase N:`
// heading, and the stitched body is refused before writing if its heading
// count drifted, so the downstream `phase_count == '## Phase N:' headings`
// derive-check stays valid.
//
// Always exits 0 on a normal run (a plan phase with no elaboration is left as-is
// and reported — partial runs are allowed). Exits 1 on a refused elaboration or a wiring/path error:
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

// A fence-shaped line: optional leading whitespace then 3+ backticks or 3+
// tildes (the CommonMark fence delimiters). Deliberate mirror of the same-char
// twins packages/rpiv-pi/extensions/rpiv-core/built-ins/markdown-fence.ts and
// packages/rpiv-pi/extensions/rpiv-core/built-ins/reconcile-directives.mjs —
// importing them is impossible here: this script runs as a bare `node` CLI
// spawned by the workflow host
// (packages/rpiv-pi/extensions/rpiv-core/workflows/build.ts), with no
// loader that resolves package-root TypeScript. The close predicate below is
// deliberately LOOSER than those twins (length-only, NOT same-char): a
// backtick-opened fence closed by a bare `~~~` line is accepted. Closing that
// gap is a behavior change, not a cleanup — it would strand the walk inside
// the fence and swallow the next real `## Phase N:` heading, recreating the
// 8534cb3c failure class (boundaries missed by a mis-tracked fence walk).
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

/** Advance the fence-walk state `{ inFence, fenceLen }` (mutated in place)
 *  across one line. Returns true for any fence-shaped line — an opener, a
 *  closer, or a fence line that does not close the open fence — so the caller
 *  can skip heading work and apply its own offset policy. The close test is
 *  length-only on purpose (see FENCE_LINE_RE above): the delimiter run must
 *  be at least as long as the opener's and alone on the line. */
const fenceStep = (state, line) => {
	const fence = line.match(FENCE_LINE_RE);
	if (!fence) return false;
	const len = fence[1].length;
	if (!state.inFence) {
		state.inFence = true;
		state.fenceLen = len;
	} else if (len >= state.fenceLen && line.trim().length === len) {
		state.inFence = false;
		state.fenceLen = 0;
	}
	return true;
};

/** Split a document into [frontmatter, body]; frontmatter ("" when absent) is kept verbatim. */
const splitFrontmatter = (content) => {
	const m = content.match(FRONTMATTER_RE);
	return m ? [m[0], content.slice(m[0].length)] : ["", content];
};

/** 1-based line of a fence opener that never closes, or undefined when balanced. */
const openFenceLine = (text) => {
	const fenceState = { inFence: false, fenceLen: 0 };
	let opened;
	text.split("\n").forEach((line, i) => {
		const was = fenceState.inFence;
		if (fenceStep(fenceState, line) && !was) opened = i + 1;
	});
	return fenceState.inFence ? opened : undefined;
};

/** Extract the `## Phase N:` section (heading to EOF) from an elaboration body. */
const phaseSection = (body) => {
	const idx = body.search(/^## Phase \d+:/m);
	return idx === -1 ? null : body.slice(idx).trim();
};

// --- Whole-Plan Verification ----------------------------------------------
//
// The trailing `## Whole-Plan Verification` section is owned by the stitch,
// not by any elaboration lane: swapping an elaborated last phase drops the
// whole original span (heading to EOF), which would silently drop the block
// that carries the whole-tree gates. Authored-first, never invented:
//
//   1. An AUTHORED block — a section in the ORIGINAL last-phase span whose
//      first body line is not the derived provenance marker — is re-appended
//      verbatim after the last rebuilt phase; the Synthesis Notes are never
//      consulted when one exists (authored wins over a concurrent reference).
//   2. Only when nothing authored was extracted AND the preamble references a
//      whole-plan verification block (the canonical phrase, fence-aware) is a
//      block DERIVED from the final post-swap sections' per-phase
//      `#### Automated Verification:` checkbox items: heading, provenance
//      marker, one intro line, deduped items in plan order. A derived block
//      found in the original span is a prior stitch's own emission — dropped
//      and re-derived, never treated as authored.
//   3. Otherwise nothing is emitted.
//
// The append is guarded by one fence-aware scan of the post-strip composition:
// a block already present anywhere in the preamble or a kept section (a
// degenerate mid-document occurrence) suppresses it, so every output carries
// at most one section.

/** The whole-plan verification heading: column-0, canonical prefix,
 *  suffix-tolerant (`## Whole-Plan Verification (owned by validate)` is the
 *  same section). */
const WPV_HEADING_RE = /^## Whole-Plan Verification\b/;

/** The provenance marker emitted as a derived block's first body line — the
 *  byte-stable discriminator between authored content and a prior stitch's
 *  own derived emission. */
const DERIVED_MARKER =
	"<!-- derived by stitch-elaborations from per-phase Automated Verification items; re-derived on every stitch -->";

/** The Synthesis-Notes promise probe: the canonical phrase only. A promise
 *  phrased solely as the skills' shorthand is deliberately not detected —
 *  widening the probe would fire the derived fallback on non-promises. */
const NOTES_REFERENCE_RE = /whole-plan verification/i;

/** The plan template's exact `#### Automated Verification:` heading —
 *  preserved verbatim by every elaborate lane's Success Criteria section. */
const AV_HEADING_RE = /^#### Automated Verification:$/;

/** The one intro line of a derived block. */
const WPV_INTRO =
	"Collected from each phase's `Automated Verification:` blocks in plan order; run on the merged tree once every phase has landed.";

/** Call `fn(line)` for each line of `text` OUTSIDE fenced code blocks — the
 *  same fence rules as the phase-boundary walk, both consuming the shared
 *  `fenceStep` over the module-level `FENCE_LINE_RE` (an elaboration's fenced
 *  Find/Replace blocks may legitimately contain heading- and bullet-shaped
 *  lines). Shared on purpose: the scope-note lift's re-land will consume this
 *  same walk. */
const eachOutsideFence = (text, fn) => {
	const fenceState = { inFence: false, fenceLen: 0 };
	for (const line of text.split("\n")) {
		if (fenceStep(fenceState, line)) continue;
		if (!fenceState.inFence) fn(line);
	}
};

/** Char offsets of column-0 `re`-matching lines OUTSIDE fenced code blocks —
 *  the main flow's own boundary-walk accumulation pattern (fence toggling via
 *  `fenceStep` over the module-level `FENCE_LINE_RE`, `+line.length+1`),
 *  factored out for reuse. The unconditional offset advance is load-bearing:
 *  the offsets feed `slice()` spans, so fence lines must advance the cursor
 *  like any other line. */
const headingOffsets = (text, re) => {
	const offsets = [];
	const fenceState = { inFence: false, fenceLen: 0 };
	let offset = 0;
	for (const line of text.split("\n")) {
		if (!fenceStep(fenceState, line) && !fenceState.inFence && re.test(line)) offsets.push(offset);
		offset += line.length + 1;
	}
	return offsets;
};

/** The whole-plan verification section of a phase span: from the first WPV
 *  heading to the next column-0 `## ` heading or end-of-span. `derived` is
 *  true when the block's first body line is exactly `DERIVED_MARKER` (a prior
 *  stitch's emission, not authored content). Null when the span carries no
 *  such section. */
const extractTrailingWpv = (span) => {
	const at = headingOffsets(span, WPV_HEADING_RE)[0];
	if (at === undefined) return null;
	const end = headingOffsets(span, /^## /).find((o) => o > at) ?? span.length;
	const text = span.slice(at, end).trimEnd();
	let derived = false;
	for (const line of text.split("\n").slice(1)) {
		const content = line.trim();
		if (content === "") continue;
		derived = content === DERIVED_MARKER;
		break;
	}
	return { offset: at, text, derived };
};

/** True when the preamble — kept verbatim, where the Synthesis Notes live —
 *  promises a whole-plan verification block via the canonical phrase,
 *  fence-aware. */
const notesReferenceWpv = (preamble) => {
	let found = false;
	eachOutsideFence(preamble, (line) => {
		if (NOTES_REFERENCE_RE.test(line)) found = true;
	});
	return found;
};

/** Per-phase `#### Automated Verification:` checkbox lines from the FINAL
 *  post-swap sections: collected after the heading, stopping at the next
 *  heading of any level, fence-aware; deduped by exact trimmed-line equality,
 *  in plan order. */
const collectAvItems = (sections) => {
	const items = [];
	const seen = new Set();
	for (const section of sections) {
		let inAv = false;
		eachOutsideFence(section, (line) => {
			if (AV_HEADING_RE.test(line)) {
				inAv = true;
				return;
			}
			if (/^#{1,6}\s/.test(line)) {
				inAv = false;
				return;
			}
			if (!inAv) return;
			const item = line.trim();
			if (/^- \[[ x]\]/.test(item) && !seen.has(item)) {
				seen.add(item);
				items.push(item);
			}
		});
	}
	return items;
};

/** The canonical derived block: heading + provenance marker + one intro line
 *  + the collected item lines verbatim. */
const deriveWpvBlock = (items) =>
	["## Whole-Plan Verification", "", DERIVED_MARKER, WPV_INTRO, ...items].join("\n");

/** Resolve the whole-plan verification tail. Pure — mutates nothing; the
 *  strip of a kept-original last phase is expressed by the caller's `rebuilt`
 *  construction, and this orchestrator re-reads the ORIGINAL pre-swap body.
 *  `note` carries the fail-open reasons ("notes reference but no verification
 *  items", "block already present") for the summary. */
const wholePlanVerification = ({ preamble, starts, body, rebuilt }) => {
	const last = starts.at(-1);
	const extracted = last ? extractTrailingWpv(body.slice(last.offset)) : null;
	let candidate;
	let mode = "none";
	if (extracted && !extracted.derived) {
		candidate = extracted.text;
		mode = "authored";
	} else if (notesReferenceWpv(preamble)) {
		const items = collectAvItems(rebuilt);
		if (items.length === 0) return { text: null, mode: "none", note: "notes reference but no verification items" };
		candidate = deriveWpvBlock(items);
		mode = "derived";
	} else {
		return { text: null, mode: "none" };
	}
	const alreadyPresent = [preamble, ...rebuilt].some((part) => headingOffsets(part, WPV_HEADING_RE).length > 0);
	if (alreadyPresent) return { text: null, mode: "none", note: "block already present" };
	return { text: candidate, mode };
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
		const raw = readFileSync(resolve(elaborationsDir, name), "utf-8");
		const [, body] = splitFrontmatter(raw);
		const section = phaseSection(body);
		if (!section) continue;
		const open = openFenceLine(raw);
		if (open !== undefined) {
			console.error(
				`stitch-elaborations: ${name} refused — the fence opened at line ${open} never closes ` +
					"(a bare ``` inside a ``` block closes it; open and close the outer block with four backticks)",
			);
			process.exit(1);
		}
		const headings = headingOffsets(section, PHASE_HEADING_RE).length;
		if (headings !== 1) {
			console.error(
				`stitch-elaborations: ${name} refused — ${headings} '## Phase N:' headings outside fences, expected exactly 1`,
			);
			process.exit(1);
		}
		elaborations.set(Number.parseInt(m[1], 10), section);
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
// format has no post-phase appendix; trailing matter belongs to the elaboration
// — EXCEPT the whole-plan verification section, which the stitch strips from
// the last phase and re-emits itself (see the whole-plan verification section
// above).
const lines = body.split("\n");
const starts = []; // { offset, n }
// Fence state for the shared fenceStep walk — FENCE_LINE_RE is matched
// inside fenceStep, never inlined in any walker.
const fenceState = { inFence: false, fenceLen: 0 };
let offset = 0;
for (const line of lines) {
	if (!fenceStep(fenceState, line) && !fenceState.inFence) {
		const m = line.match(PHASE_HEADING_RE);
		if (m) starts.push({ offset, n: Number.parseInt(m[1], 10) });
	}
	offset += line.length + 1; // +1 for the stripped "\n"
}

const preamble = starts.length ? body.slice(0, starts[0].offset) : body;

// Whole-plan verification extraction runs off the ORIGINAL last-phase span
// BEFORE the rebuilt map: a kept-original last phase is stripped at the
// extracted offset below (an elaborated one drops the whole span via the swap),
// and the emitter re-appends the resolved tail after the rebuilt sections —
// authored verbatim, derived when only the Synthesis Notes reference a block,
// never invented.
const lastStart = starts.at(-1);
const wpvExtracted = lastStart ? extractTrailingWpv(body.slice(lastStart.offset)) : null;

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
	if (wpvExtracted && i === starts.length - 1) return original.slice(0, wpvExtracted.offset).trim();
	return original.trim();
});

const wpv = wholePlanVerification({ preamble, starts, body, rebuilt });

// The WPV tail joins the body as a peer top-level element, NOT as part of
// `rebuilt` — it is no phase's section content, and folding it into one would
// feed the block's own AV-shaped checkbox lines back into the next derivation.
const newBody = [preamble.trim(), ...rebuilt, ...(wpv.text ? [wpv.text] : [])]
	.filter((s) => s.length > 0)
	.join("\n\n");
const after = headingOffsets(newBody, PHASE_HEADING_RE).length;
if (after !== starts.length) {
	console.error(
		`stitch-elaborations: refusing to write ${basename(planPath)} — '## Phase N:' headings would drift from ${starts.length} to ${after}`,
	);
	process.exit(1);
}
writeFileSync(planPath, `${frontmatter.trimEnd()}\n\n${newBody}\n`);

let summary = `stitch-elaborations: stitched ${stitched}/${total} phases into ${basename(planPath)}`;
if (missing.length) summary += ` — no elaboration for phase(s) ${missing.sort((a, b) => a - b).join(", ")}`;
summary += ` — whole-plan verification: ${wpv.mode}${wpv.note ? ` (${wpv.note})` : ""}`;
console.log(summary);
