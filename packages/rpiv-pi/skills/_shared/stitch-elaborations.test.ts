import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STITCH_MJS = fileURLToPath(new URL("./stitch-elaborations.mjs", import.meta.url));

const run = (planPath: string) =>
	execFileSync("node", [STITCH_MJS, planPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

// execFileSync throws on non-zero exit; surface status + stderr for assertions.
const runFail = (planPath: string): { status: number; stderr: string } => {
	try {
		execFileSync("node", [STITCH_MJS, planPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, stderr: "" };
	} catch (err) {
		const e = err as { status?: number; stderr?: string };
		return { status: e.status ?? -1, stderr: e.stderr ?? "" };
	}
};

// A two-phase synthesize-style plan (contract-level: prose bullets, no code).
const PLAN = [
	"---",
	"status: ready",
	"phase_count: 2",
	"phases:",
	'  - { n: 1, title: "First" }',
	'  - { n: 2, title: "Second" }',
	"tags: [plan, synthesized]",
	"---",
	"",
	"# Plan: demo",
	"",
	"## Synthesis Notes",
	"- seam wired between phase 1 and 2",
	"",
	"## Phase 1: First",
	"### Changes",
	"- `a.ts` — add foo",
	"### Success Criteria",
	"#### Automated Verification:",
	"- [ ] npm test",
	"",
	"## Phase 2: Second",
	"### Changes",
	"- `b.ts` — add bar",
	"### Success Criteria",
	"#### Automated Verification:",
	"- [ ] npm test",
	"",
].join("\n");

// An elaboration doc whose body is one code-bearing `## Phase N:` section.
// Built from an array (not a template literal) so the ```ts fences are plain strings.
const elaboration = (n: number, title: string, code: string) =>
	[
		"---",
		`phase_n: ${n}`,
		`phase_title: "${title}"`,
		"status: ready",
		"tags: [elaboration]",
		"---",
		"",
		`## Phase ${n}: ${title}`,
		"### Changes",
		"#### `x.ts`",
		"the implementation",
		"```ts",
		code,
		"```",
		"### Success Criteria",
		"#### Automated Verification:",
		"- [ ] npm test",
		"",
	].join("\n");

// An elaboration mirroring the real `elaborate` output that stalled the build workflow: a
// `## ` heading buried inside a Find/Replace code fence (must NOT be read as a
// section boundary), plus a trailing `## Notes / Deferred` that is an H2 SIBLING
// of `## Phase N:` (must be owned by the phase, not preserved as an orphan).
const elaborationWithTrailers = (n: number, title: string, code: string) =>
	[
		"---",
		`phase_n: ${n}`,
		"status: ready",
		"---",
		"",
		`## Phase ${n}: ${title}`,
		"### Changes",
		"#### `x.ts`",
		"```ts",
		code,
		"```",
		"#### `doc.md`",
		"Find:",
		"````markdown",
		"## Substitution Order (byte-equivalent)",
		"1. positional",
		"````",
		"Replace with:",
		"````markdown",
		"## Substitution Order (byte-equivalent)",
		"0. mask",
		"1. positional",
		"````",
		"### Success Criteria",
		"#### Automated Verification:",
		"- [ ] npm test",
		"",
		"## Notes / Deferred",
		`- deferred note for phase ${n}`,
		"",
	].join("\n");

let root: string;
let plansDir: string;
let elaborationsDir: string;
let planPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rpiv-stitch-"));
	plansDir = join(root, ".rpiv", "artifacts", "plans");
	elaborationsDir = join(root, ".rpiv", "artifacts", "elaborations");
	mkdirSync(plansDir, { recursive: true });
	mkdirSync(elaborationsDir, { recursive: true });
	planPath = join(plansDir, "2026-06-24_demo.md");
	writeFileSync(planPath, PLAN);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("stitch-elaborations.mjs", () => {
	it("splices every phase's elaboration into the plan", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("stitched 2/2 phases");
		expect(stitched).toContain("export const foo = 1;");
		expect(stitched).toContain("export const bar = 2;");
		// Both phase headings survive (the splice anchor is preserved 1:1).
		expect(stitched).toContain("## Phase 1: First");
		expect(stitched).toContain("## Phase 2: Second");
	});

	it("preserves frontmatter and non-phase sections verbatim", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(stitched).toContain("phase_count: 2");
		expect(stitched).toContain("tags: [plan, synthesized]");
		expect(stitched).toContain("## Synthesis Notes");
		expect(stitched).toContain("- seam wired between phase 1 and 2");
		// The original contract-level bullets are gone — replaced by real code.
		expect(stitched).not.toContain("- `a.ts` — add foo");
	});

	it("keeps the phase_count == '## Phase N:' heading-count derive invariant", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		const headingCount = [...stitched.matchAll(/^## Phase (\d+):/gm)].length;
		expect(headingCount).toBe(2);
	});

	it("leaves a phase with no elaboration as-is and reports it (partial run, exit 0)", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("stitched 1/2 phases");
		expect(out).toContain("no elaboration for phase(s) 2");
		expect(stitched).toContain("export const foo = 1;");
		// Phase 2's original contract bullet is untouched.
		expect(stitched).toContain("- `b.ts` — add bar");
	});

	it("ignores elaboration docs belonging to a different plan", () => {
		writeFileSync(join(elaborationsDir, "some-other-plan__phase-1.md"), elaboration(1, "First", "WRONG = true;"));
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(stitched).not.toContain("WRONG = true;");
		expect(stitched).toContain("export const foo = 1;");
	});

	it("treats a `## ` heading inside a code fence as phase content, not a section boundary", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaborationWithTrailers(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaborationWithTrailers(2, "Second", "export const bar = 2;"),
		);

		run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		// The fenced Find/Replace blocks survive intact (2 phases × Find+Replace),
		// not shredded into orphan fragments with dangling Replace-with markers.
		expect((stitched.match(/## Substitution Order/g) ?? []).length).toBe(4);
		// Exactly one Success Criteria and one Notes/Deferred per phase.
		expect((stitched.match(/^### Success Criteria$/gm) ?? []).length).toBe(2);
		expect((stitched.match(/^## Notes \/ Deferred$/gm) ?? []).length).toBe(2);
		expect([...stitched.matchAll(/^## Phase (\d+):/gm)].length).toBe(2);
	});

	it("is idempotent: re-stitching does not accumulate duplicate per-phase trailers", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaborationWithTrailers(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaborationWithTrailers(2, "Second", "export const bar = 2;"),
		);

		run(planPath);
		const first = readFileSync(planPath, "utf-8");
		run(planPath);
		const second = readFileSync(planPath, "utf-8");

		// Byte-identical: build's code-grade → code loop re-stitches every
		// round; a non-idempotent stitch grew the plan (tripled Success-Criteria /
		// Notes blocks) until the backward-jump guard halted the run.
		expect(second).toBe(first);
		expect((second.match(/^### Success Criteria$/gm) ?? []).length).toBe(2);
		expect((second.match(/^## Notes \/ Deferred$/gm) ?? []).length).toBe(2);
		expect([...second.matchAll(/^## Phase (\d+):/gm)].length).toBe(2);
	});

	it("exits 1 when no matching elaboration docs exist (wiring error)", () => {
		const { status, stderr } = runFail(planPath);
		expect(status).toBe(1);
		expect(stderr).toContain("nothing to stitch");
	});

	it("exits 1 when the plan file does not exist", () => {
		const { status, stderr } = runFail(join(plansDir, "missing.md"));
		expect(status).toBe(1);
		expect(stderr).toContain("plan not found");
	});
});
