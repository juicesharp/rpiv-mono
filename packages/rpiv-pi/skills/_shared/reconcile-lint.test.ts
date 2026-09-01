import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RECONCILE_LINT_MJS = fileURLToPath(new URL("./reconcile-lint.mjs", import.meta.url));

/** Run the lint; returns { status, out } with stdout+stderr folded (the CLI
 *  prints findings to stdout, usage errors to stderr). */
const run = (cwd: string, ...args: string[]): { status: number; out: string } => {
	try {
		const out = execFileSync("node", [RECONCILE_LINT_MJS, ...args], { cwd, encoding: "utf-8" });
		return { status: 0, out };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
};

const writeFile = (root: string, rel: string, body: string) => {
	const parts = rel.split("/");
	mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
	writeFileSync(join(root, rel), body);
};

// Mirrors the reconcile-lane fixture in built-in-workflows.test.ts: one phase,
// flow-style `files:` declarations, optional directives.
const planBody = (opts: { directives?: string[]; files?: string[]; phase2Directives?: string[] }) => {
	const files = opts.files ?? ["packages/a/a.test.ts"];
	const lines = [
		"---",
		"status: ready",
		"phase_count: 1",
		"phases:",
		`  - { n: 1, title: Lint, files: [${files.map((f) => JSON.stringify(f)).join(", ")}] }`,
		"---",
		"# Plan",
		"## Phase 1: Lint",
	];
	if (opts.directives?.length) {
		lines.push("#### Reconciliation");
		lines.push(...opts.directives);
	}
	if (opts.phase2Directives?.length) {
		lines.push("## Phase 2: Sibling", "#### Reconciliation");
		lines.push(...opts.phase2Directives);
	}
	return `${lines.join("\n")}\n`;
};

describe("reconcile-lint.mjs", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rpiv-reconcile-lint-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("exits 0 on a plan with no directives", () => {
		writeFile(root, "plan.md", planBody({}));
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/OK — 0 directive\(s\)/);
	});

	it("exits 0 for a valid inline directive whose find is present", () => {
		writeFile(root, "packages/a/a.test.ts", "expect(r).toBe(3);\n");
		writeFile(
			root,
			"plan.md",
			planBody({ directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — ok"] }),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/OK — 1 directive\(s\)/);
	});

	it("exits 0 for a fenced-form directive carrying backticks", () => {
		writeFile(root, "packages/a/a.test.ts", "const s = `a b`;\nrest();\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace — template literal",
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
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
	});

	it("flags a malformed directive (missing arrow) — exit 1", () => {
		writeFile(root, "plan.md", planBody({ directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)`"] }));
		const r = run(root, "plan.md");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/malformed directive/);
	});

	it("flags an undeclared target — plan-derived eligibility, exit 1", () => {
		writeFile(root, "packages/b/b.test.ts", "expect(r).toBe(3);\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: ["- `packages/b/b.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — undeclared"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/not in the plan's declared write-set/);
	});

	it("accepts a declared non-JS target — no filename convention", () => {
		writeFile(root, "tests/test_app.py", "assert r == 3\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				files: ["tests/test_app.py"],
				directives: ["- `tests/test_app.py`: replace `assert r == 3` → `assert r == 4` — py"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
	});

	it("twin expansion licenses a declared production file's .test.* twin", () => {
		writeFile(root, "packages/a/a.test.ts", "expect(r).toBe(3);\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				files: ["packages/a/a.ts"],
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — twin"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
	});

	it("reads block-style files: declarations", () => {
		writeFile(root, "tests/test_app.py", "assert r == 3\n");
		const plan = [
			"---",
			"phases:",
			"  - n: 1",
			"    title: Block",
			"    files:",
			"      - tests/test_app.py",
			"---",
			"## Phase 1: Block",
			"#### Reconciliation",
			"- `tests/test_app.py`: replace `assert r == 3` → `assert r == 4` — block style",
			"",
		].join("\n");
		writeFile(root, "plan.md", plan);
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
	});

	it("flags a `..`-escaping target — exit 1", () => {
		writeFile(
			root,
			"plan.md",
			planBody({ files: ["../escape.test.ts"], directives: ["- `../escape.test.ts`: replace `a` → `b` — escape"] }),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/outside the working tree/);
	});

	it("flags a find substring absent from the target — exit 1", () => {
		writeFile(root, "packages/a/a.test.ts", "expect(r).toBe(99);\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — stale"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/find substring not present/);
	});

	it("tolerates an already-applied directive (replacement present) — exit 0", () => {
		writeFile(root, "packages/a/a.test.ts", "expect(r).toBe(4);\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — applied"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(0);
	});

	it("flags an unreadable target — exit 1", () => {
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — no file"],
			}),
		);
		const r = run(root, "plan.md");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/unreadable/);
	});

	it("--phase scopes the scan to one phase's directives (declared set stays whole-plan)", () => {
		writeFile(root, "packages/a/a.test.ts", "expect(r).toBe(3);\n");
		writeFile(
			root,
			"plan.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — mine"],
				phase2Directives: [
					"- `packages/a/a.test.ts`: replace `not in the file` → `neither is this` — sibling's stale directive",
				],
			}),
		);
		// Whole-plan lint sees the sibling's stale directive and fails…
		expect(run(root, "plan.md").status).toBe(1);
		// …but a phase-1-scoped lint checks only phase 1's directive.
		const scoped = run(root, "plan.md", "--phase", "1");
		expect(scoped.status).toBe(0);
		expect(scoped.out).toMatch(/OK — 1 directive\(s\)/);
	});

	it("exits 2 on a missing plan file or absent --phase section", () => {
		expect(run(root, "missing.md").status).toBe(2);
		writeFile(root, "plan.md", planBody({}));
		expect(run(root, "plan.md", "--phase", "9").status).toBe(2);
	});
});
