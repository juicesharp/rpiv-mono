#!/usr/bin/env node
/**
 * Pre-flight lint for `#### Reconciliation` directives — the deterministic
 * `reconcile` gate's own parser (reconcile-directives.mjs, the same module
 * extensions/rpiv-core/built-ins/reconcile.ts imports) run in check-only mode,
 * so a directive that lints clean here parses and applies cleanly at the gate.
 * The implement skill runs this after recording a directive and before printing
 * its closing block: every finding caught here is one `/skill:amend` repair
 * session plus a gate re-entry that never happens.
 *
 * Usage: node reconcile-lint.mjs <plan.md> [--phase <N>] [--root <dir>]
 *
 *   <plan.md>     the plan artifact carrying the `#### Reconciliation` section(s)
 *   --phase <N>   lint only the `## Phase N:` section's directives (an implement
 *                 phase checks its OWN directives without tripping over a
 *                 sibling's); the declared write-set is still read from the
 *                 whole plan
 *   --root <dir>  repo root the targets resolve against (default: cwd)
 *
 * Checks per directive, mirroring the gate's failure classes: grammar
 * (malformed attempts), containment (target must resolve inside the root),
 * eligibility (target must be in the plan's declared write-set — the union of
 * every phase's `files:`, twin-expanded; best-effort frontmatter scan, the
 * gate holds the authoritative YAML parse), and find-presence against the
 * target's CURRENT bytes — with the gate's already-applied /
 * deletion-satisfied tolerances, so a legitimately-applied directive never
 * false-fails. Language-agnostic: eligibility derives from the plan's own
 * declarations, never from a filename convention. Read-only: never writes.
 *
 * Exit codes: 0 = clean; 1 = findings (each printed on its own line);
 * 2 = usage / unreadable plan.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	classifyApplication,
	declaredWriteSet,
	phaseSection,
	reconciliationRecords,
} from "../../extensions/rpiv-core/built-ins/reconcile-directives.mjs";

const usage = () => {
	console.error("usage: node reconcile-lint.mjs <plan.md> [--phase <N>] [--root <dir>]");
	process.exit(2);
};

const args = process.argv.slice(2);
let planPath;
let phase;
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--phase") {
		phase = args[++i];
		if (phase === undefined) usage();
	} else if (args[i] === "--root") {
		root = args[++i];
		if (root === undefined) usage();
	} else if (planPath === undefined) {
		planPath = args[i];
	} else {
		usage();
	}
}
if (planPath === undefined) usage();

let planBody;
try {
	planBody = readFileSync(resolve(root, planPath), "utf-8");
} catch (err) {
	console.error(`reconcile-lint: cannot read ${planPath} — ${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
}
const declared = declaredWriteSet(planBody);
let scanBody = planBody;
if (phase !== undefined) {
	const section = phaseSection(planBody, phase);
	if (section === undefined) {
		console.error(`reconcile-lint: no "## Phase ${phase}:" section in ${planPath}`);
		process.exit(2);
	}
	scanBody = section;
}

const { directives, malformed } = reconciliationRecords(scanBody);
const findings = [];
for (const m of malformed) {
	findings.push(
		"malformed directive — use one list item: - `<target>`: replace `<find>` → `<replace>` — <rationale> " +
			"(no inner backticks in the spans), or the fenced form (- `<target>`: replace — <rationale>, then a find: " +
			`line + fenced block, then a replace: line + fenced block) for content with backticks — offending item: ${m}`,
	);
}
for (const d of directives) {
	const abs = resolve(root, d.target);
	const rel = relative(root, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		findings.push(`target ${d.target} resolves outside the working tree — use a repo-root-relative target`);
		continue;
	}
	if (!declared.has(d.target)) {
		findings.push(
			`target ${d.target} is not in the plan's declared write-set (the union of every phase's 'files:', twin-expanded) — the gate rejects undeclared targets; declare the file in the owning phase's 'files:' or route the edit through validate's remediation arm`,
		);
		continue;
	}
	let content;
	try {
		content = readFileSync(abs, "utf-8");
	} catch {
		findings.push(`target ${d.target} is unreadable — the gate will fail this directive; check the path`);
		continue;
	}
	if (classifyApplication(d, content) === "missing") {
		findings.push(
			`find substring not present in ${d.target} (and the replacement is absent) — Read the file and copy the find bytes verbatim; if the text carries backticks, use the fenced form`,
		);
	}
}

if (findings.length > 0) {
	for (const f of findings) console.log(`reconcile-lint: ${f}`);
	console.log(`reconcile-lint: FAIL — ${findings.length} finding(s) across ${directives.length} directive(s)`);
	process.exit(1);
}
console.log(`reconcile-lint: OK — ${directives.length} directive(s), 0 findings`);
