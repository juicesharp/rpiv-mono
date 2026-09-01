/**
 * The post-implement reconciliation backstop: `#### Reconciliation` directive
 * parsing and write-restricted application.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { handleToString, type Output, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { closesFence, FENCE_LINE_RE } from "./markdown-fence.js";
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

/** Directive grammar (inline form), matched against a whole LIST ITEM (which
 *  may span lines — `[^`]` matches `\n`, so a multi-line find/replace snippet
 *  parses as long as it carries no inner backticks; the run-halting deviation
 *  class was the old line-by-line split, not the spans):
 *  `` - `<target>`: replace `<find>` → `<replace>` — <rationale> ``.
 *  The arrow is `→` (U+2192) or the ASCII `->`; the em-dash `—` (U+2014) +
 *  rationale is optional and may span lines. Find/replace carry no inner
 *  backticks (content WITH backticks needs the fenced form below). The two
 *  spans are intentionally asymmetric and MUST NOT be symmetrized: `find` is
 *  one-or-more `[^`]+` (an empty find has no anchored target and
 *  `String.replace("")` prepends the replacement on every run, so the parser
 *  rejects it at parse time), while `replace` is zero-or-more `[^`]*` (an
 *  empty replace is a legitimate deletion directive). */
const RECONCILE_DIRECTIVE_RE = /^-\s+`([^`]+)`\s*:\s*replace\s+`([^`]+)`\s*(?:→|->)\s*`([^`]*)`\s*(?:—[\s\S]*)?$/;
/** The fenced form's HEADER line — `- `<target>`: replace` with NO inline
 *  spans (an optional `— rationale` tail): the find/replace live in labeled
 *  fenced blocks on the item's continuation lines. The escape hatch for
 *  content a backtick grammar cannot express (inner backticks, template
 *  literals, markdown-in-tests). */
const RECONCILE_BLOCK_HEADER_RE = /^-\s+`([^`]+)`\s*:\s*replace\s*(?:—.*)?$/;
/** A directive ATTEMPT — `- `<target>`:` — that does not match either grammar.
 *  Used to surface a malformed directive as a finding rather than silently
 *  dropping it. */
const RECONCILE_DIRECTIVE_ATTEMPT_RE = /^-\s+`[^`]+`\s*:/;

/**
 * Parse the fenced-form continuation lines of one directive item: a `find:`
 * label line, a fenced code block, a `replace:` label line, a second fenced
 * block. Fence chars/lengths follow CommonMark (`closesFence`); content is
 * dedented by the opening fence line's own indentation so a list-nested block
 * captures the target file's exact bytes. Returns `undefined` when the
 * structure does not complete — the caller degrades to a malformed finding.
 */
const parseFencedSpans = (lines: readonly string[]): { find: string; replace: string } | undefined => {
	const spans: string[] = [];
	let i = 0;
	for (const label of ["find:", "replace:"]) {
		while (i < lines.length && lines[i]!.trim() === "") i++;
		if (lines[i]?.trim() !== label) return undefined;
		i++;
		const open = lines[i] !== undefined ? FENCE_LINE_RE.exec(lines[i]!) : null;
		if (!open) return undefined;
		const indent = /^[ \t]*/.exec(lines[i]!)?.[0] ?? "";
		const fenceChar = open[1]![0]!;
		const fenceLen = open[1]!.length;
		i++;
		const content: string[] = [];
		let closed = false;
		for (; i < lines.length; i++) {
			const close = FENCE_LINE_RE.exec(lines[i]!);
			if (close && closesFence(lines[i]!, close, fenceChar, fenceLen)) {
				closed = true;
				i++;
				break;
			}
			content.push(lines[i]!.startsWith(indent) ? lines[i]!.slice(indent.length) : lines[i]!);
		}
		if (!closed) return undefined;
		spans.push(content.join("\n"));
	}
	// An empty find is rejected for the same anchorless-`String.replace("")`
	// reason as the inline grammar; an empty replace is a legitimate deletion.
	if (spans[0] === "") return undefined;
	return { find: spans[0]!, replace: spans[1]! };
};

/** Classify one collected list item (header + continuation lines) as a
 *  directive, a malformed attempt (the header line, surfaced), or prose (ignored).
 *
 *  Order and byte discipline are both load-bearing (review 2026-08-31 I4/Q2):
 *  the INLINE grammar runs first, over the RAW joined item — a per-line
 *  `trimEnd` stripped interior-line trailing whitespace from the captured
 *  spans while `applyReconciliationDirectives` matches raw file bytes, so a
 *  span whose file text carries line-trailing whitespace could never match
 *  and the amend arm's "ground the find in file content" repair was
 *  permanently unsatisfiable (only the whole-item tail is trimmed, for the
 *  `$` anchor). Fenced-header second — trying it first mis-routed an inline
 *  item whose spans start on a continuation line (header ending at `replace`)
 *  into the fenced parser and surfaced a phantom malformed finding; the
 *  reverse mis-route cannot happen because a fenced item's `find:` label (or
 *  `— rationale` tail) sits where the inline grammar demands a backtick. */
const classifyItem = (
	lines: readonly string[],
	out: { directives: ReconciliationDirective[]; malformed: string[] },
): void => {
	const header = lines[0]!.trimEnd();
	const m = RECONCILE_DIRECTIVE_RE.exec(lines.join("\n").trimEnd());
	if (m) {
		out.directives.push({ target: m[1]!.trim(), find: m[2]!, replace: m[3]! });
		return;
	}
	const blockHeader = RECONCILE_BLOCK_HEADER_RE.exec(header);
	if (blockHeader) {
		const spans = parseFencedSpans(lines.slice(1));
		if (spans) {
			out.directives.push({ target: blockHeader[1]!.trim(), find: spans.find, replace: spans.replace });
		} else {
			out.malformed.push(header.trim());
		}
		return;
	}
	if (RECONCILE_DIRECTIVE_ATTEMPT_RE.test(header)) {
		out.malformed.push(header.trim());
	}
};

/**
 * Parse every `#### Reconciliation` directive from a plan body. Returns the
 * well-formed directives AND the malformed attempts (items that carry the
 * `- `<target>`:` shape but neither the inline `replace … → …` grammar nor a
 * complete fenced find:/replace: pair); `reconcile` turns each malformed
 * attempt into a finding so a broken directive is visible, never silently
 * dropped. Prose list items are ignored. Pure: no I/O, no throw.
 *
 * Structure: a section opens at a `#### Reconciliation` heading and closes at
 * the next `#{1,4}` heading (so `### Success Criteria` / `## Phase N:` / a
 * sibling `#### Automated Verification:` all end it) — headings are only
 * recognized OUTSIDE fenced code blocks, so fenced find/replace content that
 * happens to carry `#`-leading lines cannot truncate the section. Within a
 * section, a `- ` line outside a fence starts a new list item; every following
 * line until the next item / section end is that item's continuation (this is
 * what lets a multi-line inline directive parse as one unit).
 */
const reconciliationRecords = (
	body: string,
): {
	directives: ReconciliationDirective[];
	malformed: string[];
} => {
	const out = { directives: [] as ReconciliationDirective[], malformed: [] as string[] };
	let inSection = false;
	let item: string[] | undefined;
	let fenceChar = "";
	let fenceLen = 0;
	const flush = () => {
		if (item) classifyItem(item, out);
		item = undefined;
	};
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		if (fenceLen > 0) {
			// Inside a fenced block: only a matching closer changes state; every
			// line (closer included) rides the current item verbatim.
			const close = FENCE_LINE_RE.exec(line);
			if (close && closesFence(line, close, fenceChar, fenceLen)) {
				fenceChar = "";
				fenceLen = 0;
			}
			item?.push(raw);
			continue;
		}
		const open = FENCE_LINE_RE.exec(line);
		if (open) {
			fenceChar = open[1]![0]!;
			fenceLen = open[1]!.length;
			item?.push(raw);
			continue;
		}
		if (/^####\s+Reconciliation\b/.test(line)) {
			flush();
			inSection = true;
			continue;
		}
		// Any other heading ends the section (the open-heading branch above `continue`s,
		// so this only fires for non-`#### Reconciliation` headings).
		if (/^#{1,4}\s/.test(line)) {
			flush();
			inSection = false;
			continue;
		}
		if (!inSection) continue;
		if (/^-\s/.test(line)) {
			flush();
			item = [raw];
		} else {
			item?.push(raw);
		}
	}
	flush();
	return out;
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
			// The ALREADY-APPLIED check runs BEFORE the apply branch (review
			// 2026-08-31 I1): for a containment-shaped directive — `replace`
			// carrying `find` as a substring ("expect(x).toBe(1)" → "expect(x)
			// .toBe(1); // aligned") — the find stays present INSIDE the applied
			// replacement, so the old apply-first ordering re-substituted at the
			// same site on every reconcile re-execution (reconcile-fix and
			// validate-fix loop re-entries are normal), compounding "…; //
			// aligned; // aligned" drift. Applied ⇔ the replacement is present
			// AND (the find is gone, or the find only survives because the
			// replacement contains it). The non-containment both-present case
			// still applies (a coincidental pre-existing copy of the replacement
			// elsewhere must not mask a first apply); the containment
			// both-present case skips — a skipped apply degrades to a validate
			// catch, a re-apply is silent corruption.
			const applied =
				d.replace !== "" &&
				content.includes(d.replace) &&
				(!content.includes(d.find) || d.replace.includes(d.find));
			if (applied) {
				// Idempotent re-run: treated as satisfied — reconcile must not fail
				// (or re-write) on its own prior successful apply.
			} else if (content.includes(d.find)) {
				// `String.replace` with a string pattern replaces the FIRST match exactly once.
				writeFileSync(abs, content.replace(d.find, d.replace), "utf-8");
			} else if (d.replace === "") {
				// Idempotent re-run of a deletion: the find is gone and the replacement is
				// empty ⇒ find-absent is the deletion's success condition (a prior successful
				// apply removed it). Treated as satisfied — reconcile must not fail on its
				// own prior successful apply (e.g. a validate-fix loop re-running reconcile).
			} else {
				findings.push({
					detail: `reconcile: directive find substring not present in ${d.target} (and the replacement is absent — not already applied) — the expected text to replace is absent; the directive is stale or the test no longer matches. Repair IN THE PLAN: update the directive's find text to match the target file's current content byte-for-byte (Read the file to ground it; if the text carries backticks, rewrite the directive in the fenced find:/replace: form, which preserves bytes exactly), or delete the directive if it no longer applies`,
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
 * The route is `reconcileGate` (built-in-workflows.ts) — pass ⇒ validate; fail ⇒
 * the `reconcile-fix` arm (`/skill:amend` over the plan's directives from this
 * verdict — every reconcile failure class is a plan-TEXT defect, so the plan
 * reviser has authority over all of them; amend never edits test files, this
 * stage stays the sole applier), looping back here; a missing/corrupt verdict ⇒
 * STOP (integrity clause).
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
