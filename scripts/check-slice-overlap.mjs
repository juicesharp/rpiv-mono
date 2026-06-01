// check-slice-overlap.mjs — safety proof for skills/_shared/slice-overlap.mjs.
//
//   node scripts/check-slice-overlap.mjs [artifactsRoot]
//     artifactsRoot defaults to .rpiv/artifacts
//
// For every plan (keyword "Phase") and design (keyword "Slice") artifact, and every
// unit position as the "current" slice, it runs the script's partition() and then —
// using an INDEPENDENT, deliberately broader overlap oracle — verifies that nothing
// the script COLLAPSED actually shares a file or a declared symbol with the current
// unit. Any such case is an UNDER-SELECTION (a dropped collision) and fails the run.
//
// The oracle is intentionally more inclusive than the script (looser symbol capture,
// smaller stoplist): if the script's narrow partition ever disagrees with the broad
// oracle in the unsafe direction, this catches it. Over-selection by the script is
// fine (extra walking, still correct) and is NOT flagged.
//
// Exit 0 = proven no under-selection across all local artifacts; exit 1 = violation(s).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { partition } from "../packages/rpiv-pi/skills/_shared/slice-overlap.mjs";

const ROOT = process.argv[2] || ".rpiv/artifacts";
const SOURCES = [
	{ dir: join(ROOT, "plans"), keyword: "Phase" },
	{ dir: join(ROOT, "designs"), keyword: "Slice" },
];

// ---- independent segmentation + extraction (broader than the script under test) ----

function splitUnits(text, keyword) {
	const lines = text.split("\n");
	const headRe = new RegExp(`^#{2,4}\\s+${keyword}\\s+(\\d+)\\b`, "i");
	const marks = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(headRe);
		if (m) marks.push({ num: Number(m[1]), line: i });
	}
	return marks.map((mk, idx) => {
		const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
		return { id: `${keyword} ${mk.num}`, num: mk.num, body: lines.slice(mk.line, end).join("\n") };
	});
}

function fencesOf(body) {
	const out = [];
	for (const m of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(m[1]);
	return out.join("\n");
}

function filesOf(body) {
	const files = new Set();
	for (const line of body.split("\n")) {
		const fm = line.match(/^\*\*Files?\*\*:\s*(.+)$/);
		if (fm)
			for (const tok of fm[1].split(/[,\s]+/)) {
				const p = tok.replace(/[`*]/g, "");
				if (/\.[A-Za-z0-9]+$/.test(p)) files.add(p);
			}
		const hm = line.match(/^#{3,4}\s+\d+\.\s+([^\s`*]+)/);
		if (hm && /\.[A-Za-z0-9]+$/.test(hm[1])) files.add(hm[1]);
	}
	return files;
}

// language-agnostic: every identifier token in the fences, independently tokenized.
// No keyword lists, no syntax — the distinctiveness gate below decides what counts.
function tokensBroad(fenceBlob) {
	const toks = new Set();
	for (const m of fenceBlob.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) if (m[0].length >= 3) toks.add(m[0]);
	return toks;
}

// independently-coded distinctiveness gate (mirror of the script's contract): a
// shared symbol only counts as a real cross-slice collision if it is multi-word
// camelCase/Pascal, CONST_CASE, or snake_case. File overlaps always count.
function distinctive(s) {
	return (
		s.length >= 5 && (/[a-z][A-Z]/.test(s) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(s) || /[A-Za-z]_[A-Za-z]/.test(s))
	);
}

function firstShared(a, b, gate) {
	for (const x of a) if (b.has(x) && (!gate || gate(x))) return x;
	return null;
}

// ---- run ----

let artifacts = 0;
let cases = 0;
let priorPairs = 0;
let collapsedPairs = 0;
const violations = [];

for (const { dir, keyword } of SOURCES) {
	if (!existsSync(dir)) continue;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		const text = readFileSync(join(dir, name), "utf8");
		const units = splitUnits(text, keyword);
		if (units.length < 2) continue;
		artifacts++;
		const byId = new Map(units.map((u) => [u.id, u]));
		for (let i = 1; i < units.length; i++) {
			const cur = units[i];
			const r = partition(text, cur.id);
			cases++;
			priorPairs += i;
			collapsedPairs += r.collapsed.length;
			const curFiles = filesOf(cur.body);
			const curToks = tokensBroad(fencesOf(cur.body));
			for (const collapsedId of r.collapsed) {
				const prior = byId.get(collapsedId);
				if (!prior) continue;
				const sharedFile = firstShared(filesOf(prior.body), curFiles);
				const sharedSym = sharedFile ? null : firstShared(tokensBroad(fencesOf(prior.body)), curToks, distinctive);
				if (sharedFile || sharedSym) {
					violations.push({
						artifact: name,
						current: cur.id,
						collapsed: collapsedId,
						shared: sharedFile ? `file:${sharedFile}` : `symbol:${sharedSym}`,
					});
				}
			}
		}
	}
}

const pct = priorPairs ? ((collapsedPairs / priorPairs) * 100).toFixed(1) : "0.0";
console.log(`artifacts scanned:   ${artifacts}`);
console.log(`current-slice cases: ${cases}`);
console.log(`prior pairs:         ${priorPairs}`);
console.log(`collapsed (pruned):  ${collapsedPairs}  (${pct}% of walks skipped)`);
console.log(`under-selections:    ${violations.length}`);
if (violations.length) {
	console.log("\nUNDER-SELECTION VIOLATIONS (script collapsed a truly-overlapping unit):");
	for (const v of violations.slice(0, 50))
		console.log(`  ${v.artifact} | current ${v.current} collapsed ${v.collapsed} | shares ${v.shared}`);
	if (violations.length > 50) console.log(`  ... ${violations.length - 50} more`);
	process.exit(1);
}
console.log(
	"\nOK — no under-selection: every collapsed unit provably shares no file or symbol with its current slice.",
);
