// slice-overlap.mjs — deterministic, language-agnostic cross-slice overlap partition
// for the slice-verifier agent.
//
// LLM-invoked at blueprint 6.2 / design per-slice verify, BEFORE dispatching the
// slice-verifier agent:
//
//   node "${SKILL_DIR}/../_shared/slice-overlap.mjs" "<artifact_path>" "<slice_id>"
//
// where <slice_id> is the orchestrator's vocabulary: "Phase N" (blueprint), "Slice N"
// (design), or any "<Keyword> <N>" — the keyword is read from slice_id at runtime, not
// hardcoded. It partitions the LOCKED PRIOR units (same-keyword numbered headings
// preceding the current one) into those that OVERLAP the current unit and those that
// cannot collide, so the agent deep-walks only the overlapping set and the O(M)
// classification reasoning leaves the model.
//
// LANGUAGE-AGNOSTIC by design: it never parses code syntax or keywords (no
// function/class/def/func/fn/export...). Overlap is decided purely from:
//   - shared TARGET FILE (artifact convention: `**File**:` / `#### N. path`), and
//   - shared DISTINCTIVE IDENTIFIER tokens inside code fences — multi-word camelCase,
//     PascalCase, CONST_CASE, or snake_case. Those naming conventions span JS/TS,
//     Python, Go, Rust, Ruby, Java, C, SQL, etc. Generic single lowercase words
//     (`config`, `handler`, `data`) and bare keywords are excluded as non-distinctive.
//
// SAFETY CONTRACT — conservative; NEVER collapses on doubt:
//   - prior unit with no files AND no fence → OVERLAP (can't prove safe)
//   - current unit with no files AND no fence → ALL priors OVERLAP
//   - symbol match is symmetric (shared token), strictly more inclusive than
//     declaration-detection, so a real cross-slice reference is never missed.
//   Errors only ever over-select (extra walking, still correct), never under-select.
//   Proven across all local artifacts by scripts/check-slice-overlap.mjs.
//
// Output (labeled key/value lines, then a `---overlapping-detail---` block):
//
//   slice_id:        Phase 3
//   unit_kind:       Phase
//   current_files:   a/b.ts, c/d.ts | (none)
//   prior_units:     5
//   overlapping:     2 — Phase 1, Phase 4
//   non_overlapping: 3 — Phase 2, Phase 3, Phase 5
//   ---overlapping-detail---
//   Phase 1  file: packages/.../config.ts
//   Phase 4  symbol: loadJsonConfig

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*/g; // generic identifier — any language
const FILE_TOKEN_RE = /[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+/g; // path-ish with extension

function looksLikePath(s) {
	return /\.[A-Za-z0-9]+$/.test(s) && (s.includes("/") || /^[\w.-]+\.[A-Za-z0-9]+$/.test(s));
}

// A token distinctive enough to anchor a REAL cross-slice contract across languages:
// multi-word camelCase/PascalCase, CONST_CASE, or snake_case. Generic single lowercase
// words and bare keywords (any language) are non-distinctive. Same-file collisions are
// caught by file overlap, independent of this filter.
function distinctive(s) {
	return s.length >= 5 && (/[a-z][A-Z]/.test(s) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(s) || /[A-Za-z]_[A-Za-z]/.test(s));
}

// Segment the artifact into ordered units keyed by `<keyword> <number>` headings. The
// numeric ordinal is what distinguishes slice/phase units from prose sections
// (Overview, Requirements, Decisions...) that share the same heading level.
export function parseUnits(text, keyword) {
	const lines = text.split("\n");
	const headRe = new RegExp(`^#{2,4}\\s+${keyword}\\s+(\\d+)\\b`, "i");
	const marks = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(headRe);
		if (m) marks.push({ num: Number(m[1]), line: i, heading: lines[i].trim() });
	}
	return marks.map((mk, idx) => {
		const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
		return { id: `${keyword} ${mk.num}`, num: mk.num, heading: mk.heading, body: lines.slice(mk.line, end).join("\n") };
	});
}

function fencesOf(body) {
	const out = [];
	for (const m of body.matchAll(FENCE_RE)) out.push(m[1]);
	return out;
}

// Target files of a unit, across artifact conventions: `**File**:` (blueprint, single),
// `**Files**:` (design, backticked comma-list), and `#### N. path` change headings.
function filesOf(body) {
	const files = new Set();
	const add = (raw) => {
		const p = raw.replace(/[`*]/g, "").trim();
		if (p && looksLikePath(p)) files.add(p);
	};
	for (const line of body.split("\n")) {
		const fm = line.match(/^\*\*Files?\*\*:\s*(.+)$/);
		if (fm) for (const tok of fm[1].split(/[,\s]+/)) add(tok);
		const hm = line.match(/^#{3,4}\s+\d+\.\s+(\S+)/);
		if (hm) add(hm[1]);
	}
	return files;
}

// Distinctive identifier + path tokens inside a unit's code fences. Symmetric: used for
// both the prior and the current unit — a shared token means they plausibly interact.
export function symbolsOf(fences) {
	const syms = new Set();
	const blob = fences.join("\n");
	for (const m of blob.matchAll(IDENT_RE)) if (distinctive(m[0])) syms.add(m[0]);
	for (const m of blob.matchAll(FILE_TOKEN_RE)) syms.add(m[0]);
	return syms;
}

function intersects(a, b) {
	for (const x of a) if (b.has(x)) return x;
	return null;
}

export function partition(text, sliceId) {
	const keyword = String(sliceId).trim().split(/\s+/)[0] || "Phase";
	const numMatch = String(sliceId).match(/(\d+)/);
	const units = parseUnits(text, keyword);
	const curIdx = numMatch ? units.findIndex((u) => u.num === Number(numMatch[1])) : units.length - 1;
	if (curIdx < 0) {
		return { unitKind: keyword, currentId: sliceId, error: "current unit not found", currentFiles: [], priorCount: units.length, overlapping: units.map((u) => u.id), collapsed: [], detail: units.map((u) => `${u.id}  reason: current-unit-unresolved`) };
	}
	const cur = units[curIdx];
	const priors = units.slice(0, curIdx);
	const curFiles = filesOf(cur.body);
	const curFences = fencesOf(cur.body);
	const curSyms = symbolsOf(curFences);
	const blindCurrent = curFiles.size === 0 && curFences.length === 0;

	const overlapping = [];
	const collapsed = [];
	const detail = [];
	for (const p of priors) {
		const pFiles = filesOf(p.body);
		const pFences = fencesOf(p.body);
		const blindPrior = pFiles.size === 0 && pFences.length === 0;
		let reason = null;
		if (blindCurrent) reason = "current-unit-opaque";
		else if (blindPrior) reason = "prior-unit-opaque";
		else {
			const sharedFile = intersects(pFiles, curFiles);
			if (sharedFile) reason = `file: ${sharedFile}`;
			else {
				const sharedSym = intersects(symbolsOf(pFences), curSyms);
				if (sharedSym) reason = `symbol: ${sharedSym}`;
			}
		}
		if (reason) {
			overlapping.push(p.id);
			detail.push(`${p.id}  ${reason}`);
		} else {
			collapsed.push(p.id);
		}
	}
	return { unitKind: keyword, currentId: cur.id, currentFiles: [...curFiles], priorCount: priors.length, overlapping, collapsed, detail };
}

function renderList(ids) {
	return ids.length ? `${ids.length} — ${ids.join(", ")}` : "0";
}

function main() {
	const [, , artifactPath, sliceId] = process.argv;
	if (!artifactPath || !sliceId) {
		process.stderr.write('usage: slice-overlap.mjs "<artifact_path>" "<slice_id>"\n');
		process.exit(2);
	}
	let text;
	try {
		text = readFileSync(artifactPath, "utf8");
	} catch (e) {
		process.stderr.write(`cannot read artifact: ${e.message}\n`);
		process.exit(2);
	}
	const r = partition(text, sliceId);
	const lines = [
		`slice_id:        ${r.currentId}`,
		`unit_kind:       ${r.unitKind}`,
		`current_files:   ${r.currentFiles.length ? r.currentFiles.join(", ") : "(none)"}`,
		`prior_units:     ${r.priorCount ?? 0}`,
		`overlapping:     ${renderList(r.overlapping)}`,
		`non_overlapping: ${renderList(r.collapsed)}`,
		"---overlapping-detail---",
		...(r.detail.length ? r.detail : ["(none)"]),
	];
	if (r.error) lines.unshift(`note:            ${r.error}`);
	process.stdout.write(lines.join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
