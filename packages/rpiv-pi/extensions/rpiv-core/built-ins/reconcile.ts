/**
 * The post-implement reconciliation backstop: `#### Reconciliation` directive
 * application, write-restricted to the plan's declared write-set.
 *
 * The directive grammar and parser live in the sibling
 * reconcile-directives.mjs — the SAME module the skills/_shared/
 * reconcile-lint.mjs pre-flight CLI (run by the implement skill before it
 * finishes a phase) imports, so a directive that lints clean locally parses
 * identically here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { handleToString, type Output, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { phaseFiles, planPhaseRecords, withTestTwins } from "./plan-phases.js";
import { classifyApplication, type ReconciliationDirective, reconciliationRecords } from "./reconcile-directives.mjs";
import {
	containedPath,
	haltPreflight,
	latestFsArtifact,
	readArtifactFile,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
} from "./shared.js";

/**
 * Apply each `#### Reconciliation` directive, write-restricted to the plan's
 * declared write-set — the union of every phase's `files:`, twin-expanded
 * (`withTestTwins`), the SAME authority the scope floor enforces, so reconcile
 * can never write a path the floor would flag. Eligibility derives from the
 * plan's own declarations, never from a filename convention, so the gate works
 * identically in a project of any language; an undeclared target is a finding,
 * left untouched, fail-closed (a `files:`-less plan declares nothing and
 * rejects every directive).
 *
 * The apply decision per directive is `classifyApplication` (shared with the
 * lint): `already-applied` / `deletion-satisfied` are the idempotent-re-run
 * no-ops (reconcile-fix and validate-fix loop re-entries are normal — see the
 * containment-shaped-directive rationale on `classifyApplication`); `apply`
 * substitutes the FIRST match exactly once (`String.replace`); `missing` is a
 * finding (reconcile does not guess). Paths resolve through `cwd` and must
 * stay INSIDE it (`containedPath` — an absolute or `..`-escaping target is a
 * finding, never a read/write; the declared-set membership check alone cannot
 * confine the sink, so containment is checked on the SAME resolved path
 * `readFileSync`/`writeFileSync` use). Fail-soft: a read/apply throw degrades
 * to a finding naming the target, never a terminal throw. Returns findings in
 * DIRECTIVE order and performs the side-effecting writes itself (`reconcile`
 * spreads the return).
 */
const applyReconciliationDirectives = (
	directives: readonly ReconciliationDirective[],
	declared: ReadonlySet<string>,
	cwd: string,
): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	for (const d of directives) {
		const abs = containedPath(cwd, d.target);
		if (abs === undefined) {
			findings.push({
				detail: `reconcile: directive target ${d.target} resolves outside the working tree — reconcile reads and writes only inside cwd; record the directive against a repo-root-relative target`,
				where: d.target,
			});
			continue;
		}
		if (!declared.has(d.target)) {
			findings.push({
				detail: `reconcile: directive target ${d.target} is not in the plan's declared write-set (the union of every phase's 'files:', twin-expanded) — reconcile writes only what the plan declares, the same authority the scope floor enforces; declare the file in the owning phase's 'files:', or route the edit through validate's remediation arm`,
				where: d.target,
			});
			continue;
		}
		try {
			const content = readFileSync(abs, "utf-8");
			switch (classifyApplication(d, content)) {
				case "already-applied":
				case "deletion-satisfied":
					// Idempotent re-run: treated as satisfied — reconcile must not fail
					// (or re-write) on its own prior successful apply.
					break;
				case "apply":
					// `String.replace` with a string pattern replaces the FIRST match exactly once.
					writeFileSync(abs, content.replace(d.find, d.replace), "utf-8");
					break;
				case "missing":
					findings.push({
						detail: `reconcile: directive find substring not present in ${d.target} (and the replacement is absent — not already applied) — the expected text to replace is absent; the directive is stale or the target no longer matches. Repair IN THE PLAN: update the directive's find text to match the target file's current content byte-for-byte (Read the file to ground it; if the text carries backticks, rewrite the directive in the fenced find:/replace: form, which preserves bytes exactly), or delete the directive if it no longer applies`,
						where: d.target,
					});
					break;
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
 * phase's correct change can invalidate an expectation that lives in a SIBLING
 * phase's landed section (which the implementer may not edit), and the combined
 * tree can break in ways no single phase's checks surface. `reconcile` runs
 * after the scope floor (which proved the write-set) and before `validate`:
 *
 *  1. reads the latest plan (`latestFsArtifact(state, "plans")` — latest-wins);
 *  2. parses every `#### Reconciliation` directive (shared parser) and derives
 *     the plan's declared write-set (`planPhaseRecords` + `phaseFiles`, twin-
 *     expanded) — fail-soft (a malformed directive / unreadable or unparseable
 *     plan degrades to a finding, never a terminal `FAIL_SCRIPT_THREW` halt —
 *     a `produces.script` that throws becomes one);
 *  3. applies each directive write-restricted to the declared set; a present
 *     `find` is replaced exactly once (`String.replace`); an absent `find`
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
 * The route is `reconcileGate` (built-in-workflows.ts) — pass ⇒ validate; fail ⇒
 * the `reconcile-fix` arm (`/skill:amend` over the plan's directives from this
 * verdict — every reconcile failure class is a plan-TEXT defect, so the plan
 * reviser has authority over all of them; amend never edits directive targets,
 * this stage stays the sole applier), looping back here; a missing/corrupt
 * verdict ⇒ STOP (integrity clause).
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

	// Fail-soft read + parse: an unreadable plan, unparseable phase frontmatter,
	// or malformed directive degrades to a finding, never a terminal throw. If
	// the read fails there is nothing to apply. Assignment order is load-bearing:
	// `directives` lands only after the declared set derived, so a
	// phase-frontmatter defect yields ONE parse finding, never a cascade of
	// per-directive not-declared findings against an empty set.
	let body = "";
	let directives: ReconciliationDirective[] = [];
	let malformed: string[] = [];
	let declared: ReadonlySet<string> = new Set<string>();
	try {
		body = readArtifactFile(planPath, cwd);
		const parsed = reconciliationRecords(body);
		declared = new Set(
			withTestTwins(planPhaseRecords(body, "reconcile", planPath).flatMap((r) => phaseFiles(r.entry))),
		);
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
			detail:
				"reconcile: malformed Reconciliation directive — rewrite the directive IN THE PLAN as either " +
				"(a) one list item: - `<target>`: replace `<find>` → `<replace>` — <rationale> " +
				"(find/replace may span lines but must carry no inner backticks), or " +
				"(b) the fenced form for content with backticks: - `<target>`: replace — <rationale>, then a " +
				"`find:` line followed by a fenced code block, then a `replace:` line followed by a fenced code " +
				`block — offending item: ${m}`,
			where: "reconciliation-directive",
		});
	}

	findings.push(...applyReconciliationDirectives(directives, declared, cwd));

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
