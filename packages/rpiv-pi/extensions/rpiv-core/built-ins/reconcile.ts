/**
 * The post-implement reconciliation backstop: `#### Reconciliation` directive
 * parsing and write-restricted application.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { handleToString, type Output, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import {
	containedPath,
	haltPreflight,
	latestFsArtifact,
	readArtifactFile,
	TEST_PATH_RE,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
} from "./shared.js";

/**
 * One `#### Reconciliation` directive parsed from a plan body: a machine-applicable
 * `find → replace` against a single test-expectation file. The implement lane records
 * these in a phase's OWN section when a correct change invalidates a test that lives
 * in a sibling phase's landed section (which the implementer may NOT edit); `reconcile`
 * applies them write-restricted to `*.test.*` targets.
 */
interface ReconciliationDirective {
	/** Repo-root-relative test target (`*.test.*`). */
	target: string;
	/** Substring to find (replaced exactly once via `String.replace`). */
	find: string;
	/** Replacement string. */
	replace: string;
}

/** Directive grammar: `` - `<target>`: replace `<find>` → `<replace>` — <rationale> ``.
 *  The `→` (U+2192) separates find/replace; the em-dash `—` (U+2014) + rationale is
 *  optional. Find/replace carry no inner backticks. The two spans are intentionally
 *  asymmetric and MUST NOT be symmetrized: `find` is one-or-more `[^`]+` (an empty
 *  find has no anchored target and `String.replace("")` prepends the replacement on
 *  every run, so the parser rejects it at parse time), while `replace` is
 *  zero-or-more `[^`]*` (an empty replace is a legitimate deletion directive). */
const RECONCILE_DIRECTIVE_RE = /^-\s+`([^`]+)`\s*:\s*replace\s+`([^`]+)`\s*→\s*`([^`]*)`\s*(?:—\s+.*)?$/;
/** A directive ATTEMPT — `- `<target>`:` — that does not match the full grammar. Used
 *  to surface a malformed directive as a finding rather than silently dropping it. */
const RECONCILE_DIRECTIVE_ATTEMPT_RE = /^-\s+`[^`]+`\s*:/;

/**
 * Parse every `#### Reconciliation` directive from a plan body. Returns the
 * well-formed directives AND the malformed attempts (lines that carry the
 * `- `<target>`:` shape but not the full `replace … → …` grammar); `reconcile`
 * turns each malformed attempt into a finding so a broken directive is visible,
 * never silently dropped. Prose list items are ignored. Pure: no I/O, no throw.
 * A section opens at a `#### Reconciliation` heading and closes at the next
 * `#{1,4}` heading (so `### Success Criteria` / `## Phase N:` / a sibling
 * `#### Automated Verification:` all end it).
 */
const reconciliationRecords = (
	body: string,
): {
	directives: ReconciliationDirective[];
	malformed: string[];
} => {
	const directives: ReconciliationDirective[] = [];
	const malformed: string[] = [];
	let inSection = false;
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		if (/^####\s+Reconciliation\b/.test(line)) {
			inSection = true;
			continue;
		}
		// Any other heading ends the section (the open-heading branch above `continue`s,
		// so this only fires for non-`#### Reconciliation` headings).
		if (/^#{1,4}\s/.test(line)) {
			inSection = false;
			continue;
		}
		if (!inSection) continue;
		const m = RECONCILE_DIRECTIVE_RE.exec(line);
		if (m) {
			directives.push({ target: m[1]!.trim(), find: m[2]!, replace: m[3]! });
		} else if (RECONCILE_DIRECTIVE_ATTEMPT_RE.test(line)) {
			malformed.push(line.trim());
		}
	}
	return { directives, malformed };
};

const isTestPath = (target: string): boolean => TEST_PATH_RE.test(target);

/**
 * Apply each `#### Reconciliation` directive, write-restricted to test-expectation
 * files (`isTestPath` — reconcile writes ONLY test files; a non-test target is a
 * finding, left untouched, fail-closed). A present `find` is replaced exactly
 * once (`String.replace`, first match); an absent `find` whose `replace` is empty
 * is the idempotent-re-run no-op for a deletion (find-absent is the deletion's
 * success condition — the directive was already applied, no finding, no write); an
 * absent `find` whose non-empty `replace` is ALSO absent is a finding (reconcile
 * does not guess); an absent `find` whose non-empty `replace` is already present is
 * the idempotent-re-run no-op for a substitution (a prior successful apply, no
 * finding, no write). Paths resolve through `cwd` and must stay INSIDE it
 * (`containedPath` — an absolute or `..`-escaping target is a finding, never a
 * read/write; the suffix allowlist alone cannot confine the sink, so containment
 * is checked on the SAME resolved path `readFileSync`/`writeFileSync` use).
 * Fail-soft: a read/apply throw degrades to a finding naming
 * the target, never a terminal throw. Returns findings in DIRECTIVE order and
 * performs the side-effecting writes itself (`reconcile` spreads the return).
 */
const applyReconciliationDirectives = (
	directives: readonly ReconciliationDirective[],
	cwd: string,
): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	// Apply directives, write-restricted to test-expectation files.
	for (const d of directives) {
		if (!isTestPath(d.target)) {
			findings.push({
				detail: `reconcile: directive target ${d.target} is not a test-expectation file (*.test.{ts,tsx,js,jsx}) — reconcile writes only test files; record the directive against a test target or apply the edit in the owning phase`,
				where: d.target,
			});
			continue;
		}
		const abs = containedPath(cwd, d.target);
		if (abs === undefined) {
			findings.push({
				detail: `reconcile: directive target ${d.target} resolves outside the working tree — reconcile reads and writes only inside cwd; record the directive against a repo-root-relative test target`,
				where: d.target,
			});
			continue;
		}
		try {
			const content = readFileSync(abs, "utf-8");
			if (content.includes(d.find)) {
				// `String.replace` with a string pattern replaces the FIRST match exactly once.
				writeFileSync(abs, content.replace(d.find, d.replace), "utf-8");
			} else if (d.replace !== "" && content.includes(d.replace)) {
				// Idempotent re-run: the find is gone but the replacement is present ⇒ the
				// directive was already applied (e.g. a vet review-fix loop re-running
				// reconcile). Treated as satisfied — reconcile must not fail on its own
				// prior successful apply.
			} else if (d.replace === "") {
				// Idempotent re-run of a deletion: the find is gone and the replacement is
				// empty ⇒ find-absent is the deletion's success condition (a prior successful
				// apply removed it). Treated as satisfied — reconcile must not fail on its
				// own prior successful apply (e.g. a validate-fix loop re-running reconcile).
			} else {
				findings.push({
					detail: `reconcile: directive find substring not present in ${d.target} (and the replacement is absent — not already applied) — the expected text to replace is absent; the directive is stale or the test no longer matches`,
					where: d.target,
				});
			}
		} catch (err) {
			findings.push({
				detail: `reconcile: could not apply directive to ${d.target} — ${err instanceof Error ? err.message : String(err)}`,
				where: d.target,
			});
		}
	}
	return findings;
};

/**
 * Deterministic post-implement reconciliation — the coherence backstop the
 * parallel implement lane needs. Sibling phases run concurrently in one tree;
 * each phase's own `#### Automated Verification:` passed in isolation, but a
 * phase's correct change can invalidate a test that lives in a SIBLING phase's
 * landed section (which the implementer may not edit), and the combined tree can
 * break in ways no single phase's checks surface. `reconcile` runs after the
 * scope floor (which proved the write-set) and before `validate`:
 *
 *  1. reads the latest plan (`latestFsArtifact(state, "plans")` — latest-wins);
 *  2. parses every `#### Reconciliation` directive — fail-soft (a malformed
 *     directive / unreadable plan degrades to a finding, never a terminal
 *     `FAIL_SCRIPT_THREW` halt — a `produces.script` that throws becomes one);
 *  3. applies each directive write-restricted to test paths (`isTestPath`); a
 *     present `find` is replaced exactly once (`String.replace`); an absent `find`
 *     whose replacement is ALSO absent is a finding (reconcile does not guess);
 *  4. appends a timestamped `### Reconciliation Log (<iso>)` under the plan's
 *     `## Synthesis Notes` (best-effort bookkeeping write — non-fatal);
 *  5. emits one `{ dimension: "reconcile" }` verdict, basename-keyed off the plan
 *     ⇒ idempotent across fix rounds (the verdict file is overwritten each round).
 *
 * Reconcile deliberately does NOT re-execute the plan's `#### Automated
 * Verification:` commands. That re-run (bare `execFileSync`, no shell, exit-0
 * contract) was measured across the full run history at zero genuine catches and
 * a 100% false-positive finding rate — stale cross-phase presence probes, agent-
 * shell-only binaries (`rg`), prose greps — each halting a finished run at a
 * fail route with no fix arm. The downstream `validate` stage runs the same AV
 * commands as an agent, with a real shell and the judgment to tell a legitimate
 * post-rename mismatch from actual plan-vs-tree drift.
 *
 * The route is the `match("verdict", …, { from: "reconcile" })` gate idiom — pass ⇒
 * validate, fail/missing ⇒ STOP (no fallback), mirroring `implementScopeCheck`.
 * Mirrors `implementScopeCheck`'s `ScriptContext` shape, basename-keyed verdict
 * path, and `dimension`/`pass`/`verdict`/`score`/`severity` data shape. `reads:
 * ["plans"]` only — reconcile consumes no run-start `goal` baseline (the scope
 * floor already proved the write-set; reconcile's own writes are directive targets
 * + the plan bookkeeping). The `from` form suppresses the READS_DATA outputSchema
 * lint, so no schema is declared (matching `slice-check`/`plan-cite-check`/
 * `implement-scope-check`).
 */
const reconcile = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latest = latestFsArtifact(state, "plans");
	if (latest?.handle.kind !== "fs") {
		throw haltPreflight(
			"reconcile",
			"reconcile: no plan to reconcile",
			"reconcile: no fs artifact on the 'plans' channel — implement / scope-check must run before reconcile",
		);
	}
	const planPath = latest.handle.path;
	const planAbs = isAbsolute(planPath) ? planPath : join(cwd, planPath);
	const findings: { detail: string; where: string }[] = [];

	// Fail-soft read + parse: an unreadable plan or malformed directive degrades
	// to a finding, never a terminal throw. If the read fails there is nothing to
	// apply.
	let body = "";
	let directives: ReconciliationDirective[] = [];
	let malformed: string[] = [];
	try {
		body = readArtifactFile(planPath, cwd);
		const parsed = reconciliationRecords(body);
		directives = parsed.directives;
		malformed = parsed.malformed;
	} catch (err) {
		findings.push({
			detail: `reconcile: could not read or parse the plan ${planPath} — ${err instanceof Error ? err.message : String(err)}`,
			where: planPath,
		});
	}
	for (const m of malformed) {
		findings.push({
			detail: `reconcile: malformed Reconciliation directive — expected a line of the form: - \`<target>\`: replace \`<find>\` → \`<replace>\` (target/find/replace each backtick-wrapped) — ${m}`,
			where: "reconciliation-directive",
		});
	}

	findings.push(...applyReconciliationDirectives(directives, cwd));

	// Best-effort bookkeeping: append a timestamped log under ## Synthesis Notes.
	// Non-fatal — a write failure here is silent (the verdict below is the signal).
	if (body) {
		try {
			const stamp = new Date().toISOString();
			const verdict = findings.length === 0 ? "pass" : "fail";
			const logBlock = `\n### Reconciliation Log (${stamp})\nApplied ${directives.length} directive(s); ${findings.length} finding(s); verdict: ${verdict}.\n`;
			const heading = "## Synthesis Notes";
			const idx = body.indexOf(heading);
			let updated: string;
			if (idx >= 0) {
				const lineEnd = body.indexOf("\n", idx);
				const at = lineEnd >= 0 ? lineEnd + 1 : body.length;
				updated = body.slice(0, at) + logBlock + body.slice(at);
			} else {
				updated = `${body.replace(/\s+$/, "")}\n${logBlock}`;
			}
			writeFileSync(planAbs, updated, "utf-8");
		} catch {
			// bookkeeping — ignore
		}
	}

	const pass = findings.length === 0;
	const data = {
		dimension: "reconcile",
		pass,
		verdict: pass ? "pass" : "fail",
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : "high",
		artifact: handleToString(latest.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	// Basename-keyed off the latest plan ⇒ idempotent across fix rounds (mirrors
	// implementScopeCheck / planCitationCheck, NOT round-stamped like grade).
	const rel = join(VERDICT_DIR, `reconcile__${basename(planPath, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

export { reconcile };
