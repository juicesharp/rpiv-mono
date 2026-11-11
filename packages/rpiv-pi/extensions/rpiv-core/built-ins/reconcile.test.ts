/**
 * reconcile.test.ts — the reconcile lane stage and its gate (fix-arm
 * routing, ship's one-round cap, build+vet edge chain), moved verbatim from
 * built-in-workflows.test.ts minus the cross-workflow identity pin, which
 * stays in the composition suite.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type EdgeFn, type Output, type RunView, validateWorkflow } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECLARED_CONTRACTS, deriveAndValidate, findWorkflow } from "../workflow-test-harness.ts";

describe("reconcile lane stage", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-reconcile-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const reconcileRun = (wf = "build") => {
		const stage = findWorkflow(wf).stages.reconcile;
		if (!stage?.run) throw new Error(`${wf} reconcile stage has no run function`);
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	// Write a file under tmpDir and return a plans-channel entry pointing at it.
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} } as unknown as Output;
	};
	// A plans entry whose handle points at a path that does NOT exist on disk.
	const missingPlan = (rel: string) =>
		({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }) as unknown as Output;
	const runOn = (plan: ReturnType<typeof write>, wf = "build") =>
		reconcileRun(wf)({
			cwd: tmpDir,
			input: undefined,
			state: { named: { plans: [plan] } } as unknown as RunView,
		}).data;
	const details = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.detail).join(" ");
	const wheres = (data: Record<string, unknown>) =>
		((data.findings as { where: string }[] | undefined) ?? []).map((f) => f.where).sort();

	// A plan body with optional `#### Reconciliation` directives and an
	// `#### Automated Verification:` block, plus a `## Synthesis Notes` section.
	// `files` populates the phase's declared write-set (the plan-derived
	// authority reconcile applies against); defaults to the common test target.
	const planBody = (opts: { directives?: string[]; av?: string[]; synthesisNotes?: boolean; files?: string[] }) => {
		const files = opts.files ?? ["packages/a/a.test.ts"];
		const lines = [
			"---",
			"status: ready",
			"phase_count: 1",
			"phases:",
			`  - { n: 1, title: Reconcile, files: [${files.map((f) => JSON.stringify(f)).join(", ")}] }`,
			"---",
			"# Plan",
			"## Phase 1: Reconcile",
		];
		if (opts.directives?.length) {
			lines.push("#### Reconciliation");
			lines.push(...opts.directives);
		}
		lines.push("### Success Criteria");
		if (opts.av?.length) {
			lines.push("#### Automated Verification:");
			for (const c of opts.av) lines.push(`- [ ] \`${c}\``);
		}
		lines.push("#### Manual Verification:", "- [ ] a manual check");
		if (opts.synthesisNotes) lines.push("## Synthesis Notes", "- a baseline synthesis note");
		return `${lines.join("\n")}\n`;
	};
	const writeTestFile = (rel: string, content: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), content);
	};

	it("publishes a pass verdict (dimension: reconcile) with no directives and no AV", () => {
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({}));
		const data = runOn(plan);
		expect(data.dimension).toBe("reconcile");
		expect(data.pass).toBe(true);
		expect(data.verdict).toBe("pass");
		expect(data.severity).toBe("none");
		expect(data.findings).toEqual([]);
		expect(String(data.artifact)).toBe(".rpiv/artifacts/plans/p.md");
	});

	it("writes the basename-keyed verdict file under .rpiv/artifacts/verdicts/", () => {
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({}));
		runOn(plan);
		const verdict = readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/reconcile__p.json"), "utf-8");
		expect(JSON.parse(verdict).dimension).toBe("reconcile");
	});

	it("applies a directive to a *.test.ts target exactly once (find present)", () => {
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — phase invalidated the expectation",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(4);\n',
		);
	});

	it("flags a directive whose find substring is absent (and replacement absent) ⇒ verdict fail (no guessing)", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(99);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — stale"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("fail");
		expect(wheres(data)).toEqual(["packages/a/a.test.ts"]);
		// not applied — the file is unchanged
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(99);\n");
	});

	it("write-restricts to the declared write-set — an undeclared target is flagged and NOT applied", () => {
		writeTestFile("packages/a/a.ts", "export const r = 3;\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({ directives: ["- `packages/a/a.ts`: replace `r = 3` → `r = 4` — undeclared target"] }),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(wheres(data)).toEqual(["packages/a/a.ts"]);
		expect(details(data)).toMatch(/not in the plan's declared write-set/);
		// untouched
		expect(readFileSync(join(tmpDir, "packages/a/a.ts"), "utf-8")).toBe("export const r = 3;\n");
	});

	it("applies a directive to a DECLARED non-JS target — eligibility is plan-derived, not a filename convention", () => {
		writeTestFile("tests/test_app.py", "assert r == 3\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				files: ["tests/test_app.py"],
				directives: [
					"- `tests/test_app.py`: replace `assert r == 3` → `assert r == 4` — phase invalidated the expectation",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "tests/test_app.py"), "utf-8")).toBe("assert r == 4\n");
	});

	it("twin expansion licenses a declared production file's co-located test twin", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				files: ["packages/a/a.ts"], // declares only the production file; the .test.ts twin rides along
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — twin update"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(4);\n");
	});

	it("a `files:`-less plan declares nothing — every directive is rejected fail-closed", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				files: [],
				directives: [
					"- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — no declarations",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/not in the plan's declared write-set/);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(3);\n");
	});

	it("containment — an ABSOLUTE *.test.ts target outside the tree is flagged and NOT written", () => {
		// The suffix allowlist alone cannot confine the write: an absolute target
		// ending .test.ts passes it while bypassing cwd entirely. FAILS without the
		// resolve-then-contain guard.
		const outside = mkdtempSync(join(tmpdir(), "rpiv-reconcile-outside-"));
		try {
			const target = join(outside, "escape.test.ts");
			writeFileSync(target, "expect(r).toBe(3);\n");
			const plan = write(
				".rpiv/artifacts/plans/p.md",
				planBody({
					directives: [`- \`${target}\`: replace \`expect(r).toBe(3)\` → \`expect(r).toBe(4)\` — escape`],
				}),
			);
			const data = runOn(plan);
			expect(data.pass).toBe(false);
			expect(details(data)).toMatch(/outside the working tree/);
			// untouched — the guarded sink never resolved the escape
			expect(readFileSync(target, "utf-8")).toBe("expect(r).toBe(3);\n");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("containment — a `..`-escaping *.test.ts target is flagged and NOT written", () => {
		// A relative target that traverses out of cwd satisfies the suffix test on the
		// raw string; containment is checked on the RESOLVED path. FAILS without the guard.
		const outside = mkdtempSync(join(tmpdir(), "rpiv-reconcile-outside-"));
		try {
			const target = join(outside, "escape.test.ts");
			writeFileSync(target, "expect(r).toBe(3);\n");
			const traversal = `../${basename(outside)}/escape.test.ts`; // resolves to a tmpDir SIBLING
			const plan = write(
				".rpiv/artifacts/plans/p.md",
				planBody({
					directives: [`- \`${traversal}\`: replace \`expect(r).toBe(3)\` → \`expect(r).toBe(4)\` — escape`],
				}),
			);
			const data = runOn(plan);
			expect(data.pass).toBe(false);
			expect(details(data)).toMatch(/outside the working tree/);
			expect(readFileSync(target, "utf-8")).toBe("expect(r).toBe(3);\n");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("containment-shaped directive (replace ⊇ find) applies once and is a no-op on re-run (I1 regression)", () => {
		// The replacement carries the find as a substring, so post-apply the find
		// is still PRESENT inside the substituted text. The old apply-first
		// ordering re-substituted on every reconcile re-execution (reconcile-fix
		// / validate-fix loop re-entries), compounding "; // aligned; // aligned"
		// drift that validate then failed on. Verified reproducer from review
		// 2026-08-31 I1.
		writeTestFile("packages/a/a.test.ts", "expect(x).toBe(1);\nrest();\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace `expect(x).toBe(1);` → `expect(x).toBe(1); // aligned` — annotate",
				],
			}),
		);
		const first = runOn(plan);
		expect(first.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			"expect(x).toBe(1); // aligned\nrest();\n",
		);
		// Re-entries are normal loop behavior: the file must be byte-stable.
		const second = runOn(plan);
		expect(second.pass).toBe(true);
		const third = runOn(plan);
		expect(third.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			"expect(x).toBe(1); // aligned\nrest();\n",
		);
	});

	it("a coincidental pre-existing copy of the replacement does not mask a first apply (non-containment)", () => {
		// Both find and replace present, replace does NOT contain find: this is
		// the first-run case where the replacement text exists elsewhere by
		// coincidence — the apply must still run.
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(4);\nexpect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — align"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			"expect(r).toBe(4);\nexpect(r).toBe(4);\n",
		);
	});

	it("fenced form: a content line indented less than the opening fence is captured verbatim (no dedent)", () => {
		// The dedent strips the fence-open line's own indentation prefix ONLY
		// when a content line actually starts with it — an under-indented line
		// passes through byte-for-byte (review 2026-08-31 Q9 coverage gap).
		writeTestFile("packages/a/a.test.ts", "keep();\nflush();\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace — under-indented content",
					"  find:",
					"  ```",
					"flush();",
					"  ```",
					"  replace:",
					"  ```",
					"flushed();",
					"  ```",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("keep();\nflushed();\n");
	});

	it("treats an already-applied directive as satisfied on re-run (idempotent)", () => {
		// The find is gone but the replacement is present ⇒ already applied, no finding.
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(4);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — re-run"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(4);\n");
	});

	// --- relaxed grammar: multi-line inline items + the fenced form ---

	it("applies a MULTI-LINE inline directive — spans may carry newlines (run 57d0's halting shape)", () => {
		// Run 2026-08-31_15-21-14-57d0: the implementer wrote a biome-formatted
		// multi-line replacement; the old line-by-line split flagged it malformed
		// and the no-arm gate made every resume re-fail. Items now parse as list
		// ITEMS, so the natural multi-line output is legal.
		writeTestFile("packages/a/a.test.ts", 'vi.mock("./p.js", () => ({ a: 1 }));\nrest();\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					'- `packages/a/a.test.ts`: replace `vi.mock("./p.js", () => ({ a: 1 }));` → `vi.mock("./p.js", () => ({',
					"\ta: 1,",
					"\tb: 2,",
					"}));` — Phase 8's `agents.ts` now calls `findInstalledSiblings()` (rationale backticks ride the tail)",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'vi.mock("./p.js", () => ({\n\ta: 1,\n\tb: 2,\n}));\nrest();\n',
		);
	});

	it("multi-line inline spans match file bytes carrying interior-line trailing whitespace (I4 regression)", () => {
		// The old per-line trimEnd stripped interior trailing whitespace from the
		// captured spans while the applier matches raw file bytes — a span whose
		// file text carries line-trailing whitespace could never match, and the
		// amend arm's "ground the find in file content" repair was permanently
		// unsatisfiable (review 2026-08-31 I4). Spans now capture raw bytes.
		writeTestFile("packages/a/a.test.ts", 'vi.mock("./p.js", () => ({ \n\ta: 1, \n}));\nrest();\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					'- `packages/a/a.test.ts`: replace `vi.mock("./p.js", () => ({ ',
					"\ta: 1, ",
					'}));` → `vi.mock("./p.js", () => ({ b: 2 }));` — trailing-whitespace bytes preserved',
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'vi.mock("./p.js", () => ({ b: 2 }));\nrest();\n',
		);
	});

	it("an inline item whose spans start on a continuation line parses inline, not as a phantom malformed (Q2 regression)", () => {
		// Header ends at `replace`; the spans follow on the next line. The old
		// fenced-header-first routing sent this to the fenced parser and surfaced
		// a malformed finding for a well-formed inline directive.
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace",
					"  `expect(r).toBe(3)` → `expect(r).toBe(4)` — wrapped header",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(4);\n");
	});

	it("accepts the ASCII -> arrow as the find/replace separator", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` -> `expect(r).toBe(4)` — ascii arrow"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(4);\n");
	});

	it("applies a fenced-form directive whose content carries backticks (inexpressible inline)", () => {
		writeTestFile("packages/a/a.test.ts", "const s = `a b`;\nrest();\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace — template literal update",
					"  find:",
					"  ```",
					"  const s = `a b`;",
					"  ```",
					"  replace:",
					"  ```",
					"  const s = `a b c`;",
					"  ```",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("const s = `a b c`;\nrest();\n");
	});

	it("fenced form: an empty find block is rejected as malformed (anchorless), an empty replace block deletes", () => {
		writeTestFile("packages/a/a.test.ts", "keep();\ndrop();\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace — delete the call",
					"  find:",
					"  ```",
					"  drop();",
					"  ```",
					"  replace:",
					"  ```",
					"  ```",
					"- `packages/a/a.test.ts`: replace — empty find",
					"  find:",
					"  ```",
					"  ```",
					"  replace:",
					"  ```",
					"  x();",
					"  ```",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false); // the empty-find item is the one finding
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
		// the deletion directive still applied; the empty-find one did not prepend
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("keep();\n\n");
	});

	it("fenced form: an incomplete structure (missing replace block) degrades to a malformed finding", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(3);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace — truncated",
					"  find:",
					"  ```",
					"  expect(r).toBe(3);",
					"  ```",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(3);\n");
	});

	it("does NOT execute AV commands — a failing command line yields no finding (validate owns AV)", () => {
		// The AV re-run was removed: measured across the full run history it produced
		// zero genuine catches and a 100% false-positive rate (stale cross-phase
		// probes, agent-shell-only binaries, prose greps), each halting a finished
		// run at a fail route with no fix arm. `validate` runs AV agent-side instead.
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({ av: ['node -e "process.exit(1)"', "rg -l x y.ts"] }));
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fail-soft: an unreadable plan (missing file) degrades to a finding, never a throw", () => {
		const data = runOn(missingPlan(".rpiv/artifacts/plans/missing.md"));
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/could not read or parse the plan/);
	});

	it("fail-soft: a malformed Reconciliation directive degrades to a finding, never a throw", () => {
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({ directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)`"] }), // missing → `replace`
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
	});

	// --- empty-find / empty-replace regressions (find group tightened to `[^`]+` at parse time) ---

	it("rejects an empty-find directive at parse time ⇒ verdict fail + malformed finding, file unchanged (no prepend)", () => {
		// An empty `` find previously matched the grammar (find group was `([^`]*)` zero-or-more)
		// and `content.replace("", replace)` prepended the replacement on every run. The tightened
		// parser now rejects it: the line matches the attempt shape but not the full grammar ⇒ malformed.
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `` → `expect(r).toBe(4)` — empty find"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("fail");
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
		// the offending line is surfaced verbatim so an author can diagnose the empty find
		expect(details(data)).toMatch(/packages\/a\/a\.test\.ts/);
		// the empty-find directive is NOT applied — the target file is byte-for-byte unchanged
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
	});

	it("empty-find directive is idempotent across re-runs: no cumulative prepend, exactly one malformed finding", () => {
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(
			rel,
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `` → `expect(r).toBe(4)` — empty find"],
			}),
		);
		// run 1: malformed finding, file untouched
		const data1 = runOn(plan);
		expect(wheres(data1)).toEqual(["reconciliation-directive"]);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
		// run 2: reconcile re-evaluates the same plan — the file must NOT accumulate prepends
		const data2 = runOn(plan);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
		// still exactly one malformed finding across the re-run (no amplification / vet backward-jump)
		const malformedCount = ((data2.findings as { detail: string }[]) ?? []).filter((f) =>
			/malformed Reconciliation directive/.test(f.detail),
		).length;
		expect(malformedCount).toBe(1);
	});

	it("an empty-replace deletion directive applies exactly once and does not prepend/loop on re-run (replace stays `[^`]*`)", () => {
		// empty replace is a LEGITIMATE deletion: find present ⇒ removed. Proves the asymmetry is
		// intentional (find non-empty, replace optional) — symmetrizing replace to `[^`]+` would break this.
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3)\n');
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(
			rel,
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `` — delete the assertion"],
			}),
		);
		// run 1: find present ⇒ deleted (replaced with empty), no finding ⇒ pass
		const data1 = runOn(plan);
		expect(data1.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe('import { r } from ".";\n\n');
		// run 2: find now absent, replace empty ⇒ find-absent is the deletion's success
		// condition ⇒ the idempotent already-applied branch (no finding, no write). No prepend, no loop.
		const data2 = runOn(plan);
		expect(data2.pass).toBe(true);
		expect(details(data2)).not.toMatch(/directive find substring not present/);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe('import { r } from ".";\n\n');
	});

	it("appends a timestamped ### Reconciliation Log under the plan's ## Synthesis Notes", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(rel, planBody({ synthesisNotes: true }));
		runOn(plan);
		const after = readFileSync(join(tmpDir, rel), "utf-8");
		const notesIdx = after.indexOf("## Synthesis Notes");
		const logIdx = after.indexOf("### Reconciliation Log (");
		expect(notesIdx).toBeGreaterThanOrEqual(0);
		expect(logIdx).toBeGreaterThan(notesIdx); // the log lands under Synthesis Notes
		// the original baseline note is still present (the append is non-destructive)
		expect(after).toMatch(/a baseline synthesis note/);
	});

	describe("edge chain — reconcile gates validate (build + vet)", () => {
		const edge = (wf: string, stage: string): EdgeFn => {
			const e = findWorkflow(wf).edges[stage];
			if (typeof e !== "function") throw new Error(`${wf} ${stage} edge is not a function`);
			return e as EdgeFn;
		};
		const route = (wf: string, stage: string, channel: string, verdict: unknown) =>
			String(
				edge(
					wf,
					stage,
				)({
					output: undefined,
					state: { named: { [channel]: [{ data: { verdict } }] } } as unknown as RunView,
				}),
			);

		for (const wf of ["build", "vet"]) {
			it(`${wf}: implement-scope-check → reconcile on pass, STOP on fail/missing`, () => {
				expect(route(wf, "implement-scope-check", "implement-scope-check", "pass")).toBe("reconcile");
				expect(route(wf, "implement-scope-check", "implement-scope-check", "fail")).toBe("stop");
				expect(route(wf, "implement-scope-check", "implement-scope-check", undefined)).toBe("stop");
			});

			it(`${wf}: reconcile → validate on pass, reconcile-fix on fail, STOP on missing (a synthesized fail does NOT reach validate)`, () => {
				expect(route(wf, "reconcile", "reconcile", "pass")).toBe("validate");
				expect(route(wf, "reconcile", "reconcile", "fail")).toBe("reconcile-fix");
				expect(route(wf, "reconcile", "reconcile", undefined)).toBe("stop");
			});

			it(`${wf}: reconcile-fix re-enters reconcile (plain string edge — the counted decision is the gate's pick)`, () => {
				expect(findWorkflow(wf).edges["reconcile-fix"]).toBe("reconcile");
			});
		}
	});

	describe("reconcile gate — fix-arm routing + ship's one-round cap", () => {
		// The cap reads the `reconcile-fix` channel — the channel ONLY the arm
		// writes — never reconcile-entry counts (review 2026-08-31 I1: ship's
		// validate-fix loop re-enters through implement-scope-check → reconcile,
		// appending reconcile entries that spend no amend hop; an entry-count
		// budget let that loop exhaust the arm's one round before the arm ran).
		const gateRoute = (wf: string, named: Record<string, unknown[]>) => {
			const e = findWorkflow(wf).edges.reconcile;
			if (typeof e !== "function") throw new Error(`${wf} reconcile edge is not an EdgeFn`);
			return String((e as EdgeFn)({ output: undefined, state: { named } as unknown as RunView }));
		};
		const fail = { data: { verdict: "fail" } };
		const pass = { data: { verdict: "pass" } };
		const armHop = { data: undefined };

		it("ship: the first fail buys the one amend hop", () => {
			expect(gateRoute("ship", { reconcile: [fail] })).toBe("reconcile-fix");
		});
		it("ship: a fail AFTER the spent amend round stops (the reconcile-fix channel IS the rounds)", () => {
			expect(gateRoute("ship", { reconcile: [fail, fail], "reconcile-fix": [armHop] })).toBe("stop");
		});
		it("ship: validate-fix-loop reconcile re-entries do NOT spend the amend budget (I1 regression)", () => {
			// Three reconcile executions (initial + validate-fix loop re-entries),
			// zero amend hops — the arm must still be reachable.
			expect(gateRoute("ship", { reconcile: [pass, pass, fail] })).toBe("reconcile-fix");
		});
		it("ship: pass routes to validate regardless of spent rounds", () => {
			expect(gateRoute("ship", { reconcile: [fail, pass], "reconcile-fix": [armHop] })).toBe("validate");
		});
		it("build/vet: uncapped — a repeat fail still routes to the arm (the backward-jump budget is the bound)", () => {
			for (const wf of ["build", "vet"]) {
				expect(gateRoute(wf, { reconcile: [fail, fail, fail], "reconcile-fix": [armHop, armHop] }), wf).toBe(
					"reconcile-fix",
				);
			}
		});
	});

	it("reconcile-fix dispatches /skill:amend with --plans + --reconcile-verdicts, publishing plans (all three workflows)", async () => {
		const entry = (path: string) =>
			({ artifacts: [{ handle: fsHandle(path) }], data: undefined, kind: "", meta: {} }) as unknown as Output;
		const state = {
			named: {
				plans: [entry(".rpiv/artifacts/plans/p.md")],
				reconcile: [entry(".rpiv/artifacts/verdicts/reconcile__p.json")],
			},
		} as unknown as RunView;
		for (const wf of ["build", "vet", "ship"]) {
			const stage = findWorkflow(wf).stages["reconcile-fix"];
			expect(stage?.kind, wf).toBe("produces");
			// The arm publishes on its OWN channel (the gate's round counter);
			// amend re-emits the plan in place, so `plans` needs no republish.
			expect(stage?.outcome?.name, wf).toBe("reconcile-fix");
			if (typeof stage?.prompt !== "function") throw new Error(`${wf} reconcile-fix has no PromptFn`);
			const prompt = await stage.prompt({ cwd: "/x", input: undefined, state });
			// amend's generic parser: exactly one artifact flag (--plans) + one
			// `-verdicts`-suffixed flag — the reason this is a prompt stage (a
			// `reads: ["reconcile"]` skill stage would thread a second artifact flag).
			expect(prompt, wf).toBe(
				"/skill:amend --plans .rpiv/artifacts/plans/p.md --reconcile-verdicts .rpiv/artifacts/verdicts/reconcile__p.json",
			);
		}
	});

	it("build and vet each validate clean (zero errors AND zero warnings) with skill contracts threaded", () => {
		for (const wf of [findWorkflow("build"), findWorkflow("vet")]) {
			const issues = deriveAndValidate(wf, { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				`${wf.name} errors: ${issues.map((i) => `${i.severity}: ${i.message}`).join("\n")}`,
			).toEqual([]);
			expect(
				issues.filter((i) => i.severity === "warning"),
				`${wf.name} warnings: ${issues.map((i) => `${i.severity}: ${i.message}`).join("\n")}`,
			).toEqual([]);
			expect(
				validateWorkflow(wf).filter((i) => /unreachable/.test(i.message)),
				`${wf.name} has unreachable stages`,
			).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// Unit-failed routing — a dimension-bearing failed sentinel (a dead grade
// unit, post-re-dispatch) blocks every gate fold and routes the fix arm with
// a unit-failed note; the f9a6 incident shape (the sentinel's index overwrite
// erasing the stale round-1 fail) is the red-today regression.
// ---------------------------------------------------------------------------
