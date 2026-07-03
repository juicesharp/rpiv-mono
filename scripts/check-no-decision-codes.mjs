// check-no-decision-codes.mjs — standing prevention guard against decision-code contamination.
//
//   node scripts/check-no-decision-codes.mjs
//
// Walks the two guarded dirs (recursively, skipping node_modules), reads every *.ts,
// and flags any parenthesized, case-sensitive decision-code citation — the transient
// plan/phase numbering that orphans once its design doc leaves the tree.
//
// RULE
//   Design-doc decision-codes belong in .rpiv/artifacts/, never in committed .ts.
//   Reword the comment to state the contract in place (present-tense rationale,
//   no dangling "see Phase 7.2" referent).
//
// WHY PARENTHESIZED + CASE-SENSITIVE (not a bare-token sweep)
//   Broadening to bare `Phase N` / `Slice N` / `FR#` collides with legitimate plan
//   fixtures that live in *.ts test data: `runner.test.ts` plan-fixture headings,
//   `loop.test.ts` stage-label strings, ISO timestamp fields, artifact-path fixtures.
//   Requiring parens + an uppercase/digit token self-filters every one of those:
//     - `## Phase 1: alpha` fixture headings have no parens
//     - lowercase `phase N/M` stage labels fail the uppercase gate
//     - `(c1)` / `(c2)` / `(c3)` scenario IDs are lowercase
//     - ISO `...T08:00...` timestamps are outside `(T#)`
//     - bare artifact-path strings carry no parens
//
// WHY *.ts-ONLY (no allowlist)
//   Every legit decision-code use is in .md (SKILL.md, docs/workflow-authoring.md
//   (Q1)-(Q4), CHANGELOG.md, README.md). Scoping to *.ts auto-excludes them all — no
//   rotting allowlist to maintain. (.md files are never scanned.)
//
// Exit 0 = clean; exit 1 = violation(s) printed as `path:line: (CODE)`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Canonical detection seam — the parenthesized full-family case-sensitive regex.
// Matches the research's recommended pre-done grep + the A-family (only live site:
// audit.test.ts:174 (A3)). Parens + case-sensitivity are what keep it at exactly the
// contamination shape and reject every plan-fixture false positive (see header).
const DECISION_CODE_RE =
	/\((C[0-9]+|T[0-9]+|D[0-9]+|G[0-9]+|FR[0-9]+|A[0-9]+|M[0-9]+|Slice [0-9]+|Phase [A-Z0-9.]+|Problem [0-9]+|Decision [0-9]+|concern-[A-Z])/;

// Whole scoped tree, *.ts only — mirrors `npm run check`'s whole-tree posture (a
// standing cleanliness invariant that also catches merge-introduced contamination,
// not just staged files).
const GUARDED_DIRS = ["packages/rpiv-workflow", "packages/rpiv-pi/extensions/rpiv-core"];

function walkTs(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === "node_modules") continue;
		const full = join(dir, ent.name);
		if (ent.isDirectory()) walkTs(full, out);
		else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

let scanned = 0;
const violations = [];

for (const dir of GUARDED_DIRS) {
	for (const file of walkTs(dir)) {
		scanned++;
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(DECISION_CODE_RE);
			if (m) violations.push(`${file}:${i + 1}: (${m[1]})`);
		}
	}
}

if (violations.length) {
	console.error(`Found ${violations.length} parenthesized decision-code citation(s) in scoped *.ts:`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(
		"\nDecision-doc decision-codes belong in .rpiv/artifacts/, never in committed .ts.\nReword the comment to state the contract in place.",
	);
	process.exit(1);
}

console.log(
	`OK — no parenthesized decision-code citations in scoped *.ts (scanned ${scanned} file${scanned === 1 ? "" : "s"}).`,
);
