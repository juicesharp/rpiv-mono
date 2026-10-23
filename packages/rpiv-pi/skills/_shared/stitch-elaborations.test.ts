import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	// The mixed-delimiter close pin: a bare `~~~` line CLOSES a backtick-opened
	// fence under the stitch's length-only predicate (the same-char twins in
	// extensions/rpiv-core would not). Phase 2 stays kept-original with such a
	// fence; the boundary walk must exit at the `~~~` so the following real
	// `## Phase 3: Third` heading still reads as a section boundary — the
	// 8534cb3c failure class a same-char tightening would recreate.
	it("closes a backtick-opened fence at a bare ~~~ line so the next phase heading still counts", () => {
		writeFileSync(
			planPath,
			[
				"---",
				"status: ready",
				"phase_count: 3",
				"phases:",
				'  - { n: 1, title: "First" }',
				'  - { n: 2, title: "Second" }',
				'  - { n: 3, title: "Third" }',
				"tags: [plan, synthesized]",
				"---",
				"",
				"# Plan: demo",
				"",
				"## Synthesis Notes",
				"- seam",
				"",
				"## Phase 1: First",
				"### Changes",
				"- `a.ts` — add foo",
				"",
				"## Phase 2: Second",
				"### Changes",
				"#### `doc.md`",
				"Find:",
				"```markdown",
				"fenced example line",
				"~~~",
				"",
				"## Phase 3: Third",
				"### Changes",
				"- `c.ts` — add baz",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-3.md"),
			elaboration(3, "Third", "export const baz = 3;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		// The `~~~` closed the backtick fence: all three headings were seen,
		// phases 1 and 3 paired, phase 2 reported as kept-original.
		expect(out).toContain("stitched 2/3 phases");
		expect(out).toContain("no elaboration for phase(s) 2");
		expect([...stitched.matchAll(/^## Phase (\d+):/gm)]).toHaveLength(3);
		// Phase 3's elaboration spliced — and its original contract bullet
		// replaced, proving the splice landed at the real phase-3 boundary.
		expect(stitched).toContain("export const baz = 3;");
		expect(stitched).not.toContain("- `c.ts` — add baz");
		// Phase 2's kept-original span carries the mixed-delimiter fence
		// through verbatim — the example line survives exactly once.
		expect((stitched.match(/^fenced example line$/gm) ?? []).length).toBe(1);
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

// --- Whole-Plan Verification emission --------------------------------------

// The authored shape: canonical heading + intro prose + whole-tree gate
// checkboxes (mirrors a real synthesized plan's trailing block bytes).
const WPV_BLOCK = [
	"## Whole-Plan Verification",
	"",
	"Per-phase `Automated Verification` above is write-scoped to each phase's `files:` set; these whole-tree commands are the final block, owned by `validate` — run once all phases have landed:",
	"",
	"- [ ] `npm run check` exits 0 — Biome (`--write --error-on-warnings`) + `tsc --noEmit -p tsconfig.base.json`",
	"- [ ] `npm test` exits 0 — the single root Vitest runner over `packages/*/**/*.test.ts`",
	"",
].join("\n");

// A suffix-form heading — the same section under the suffix-tolerant grammar.
const WPV_SUFFIX_BLOCK = ["## Whole-Plan Verification (owned by validate)", "", "- [ ] `npm test` exits 0", ""].join(
	"\n",
);

// A plan whose last-phase span carries a trailing authored WPV block; the
// Synthesis Notes line optionally carries the canonical reference phrase.
const planWithAuthoredWpv = (block: string, withReference: boolean) =>
	[
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
		...(withReference
			? ["- whole-tree gates are collected into the final `## Whole-Plan Verification` block owned by validate"]
			: ["- seam wired between phase 1 and 2"]),
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
		block,
	].join("\n");

// The no-block shape: the Synthesis Notes reference the canonical phrase,
// but no trailing block was authored.
const REFERENCE_ONLY_PLAN = [
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
	"- Whole-plan gates deferred here: the repo-wide criteria are collected into the final `## Whole-Plan Verification` block owned by validate",
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

// An elaboration whose Success Criteria carries explicit AV items.
const elaborationWithAv = (n: number, title: string, av: readonly string[]) =>
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
		`export const v${n} = ${n};`,
		"```",
		"### Success Criteria",
		"#### Automated Verification:",
		...av,
		"",
	].join("\n");

describe("whole-plan verification emission", () => {
	it("re-appends a trailing authored block verbatim, even when the last phase is elaborated", () => {
		writeFileSync(planPath, planWithAuthoredWpv(WPV_BLOCK, true));
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

		// Authored wins over the concurrent Synthesis-Notes reference, and the
		// block survives byte-for-byte after the last phase — the swap drops the
		// whole original last-phase span (heading to EOF), block included.
		expect(out).toContain("whole-plan verification: authored");
		expect(stitched.endsWith(WPV_BLOCK)).toBe(true);
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
		// The notes were never consulted: no derived marker anywhere.
		expect(stitched).not.toContain("derived by stitch-elaborations");
	});

	it("re-appends the authored block verbatim when the last phase is kept original (strip + re-append)", () => {
		writeFileSync(planPath, planWithAuthoredWpv(WPV_BLOCK, false));
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("whole-plan verification: authored");
		expect(stitched.endsWith(WPV_BLOCK)).toBe(true);
		// Stripped from the kept section, re-appended as the tail: once, not twice.
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
		expect(stitched).toContain("## Phase 2: Second");
	});

	it("derives the block from the final sections' AV items when only the Synthesis Notes reference one", () => {
		writeFileSync(planPath, REFERENCE_ONLY_PLAN);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaborationWithAv(1, "First", ["- [ ] `npx vitest run a.test.ts` — exits 0", "- [ ] npm test"]),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaborationWithAv(2, "Second", ["- [ ] npm test", "- [ ] `npx vitest run b.test.ts` — exits 0"]),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("whole-plan verification: derived");
		// Anchor on the column-0 heading — the Synthesis-Notes reference line
		// carries the phrase inside backticks (mid-line, never a section).
		const heading = stitched.match(/^## Whole-Plan Verification$/m);
		expect(heading).not.toBeNull();
		const tail = stitched.slice(heading?.index ?? 0);
		// Heading + provenance marker + intro, then the deduped items in plan order.
		expect(tail.startsWith("## Whole-Plan Verification\n\n<!-- derived by stitch-elaborations")).toBe(true);
		const itemA = tail.indexOf("- [ ] `npx vitest run a.test.ts` — exits 0");
		const itemNpm = tail.indexOf("- [ ] npm test");
		const itemB = tail.indexOf("- [ ] `npx vitest run b.test.ts` — exits 0");
		expect(itemA).toBeGreaterThan(-1);
		expect(itemNpm).toBeGreaterThan(itemA);
		expect(itemB).toBeGreaterThan(itemNpm);
		// The shared "- [ ] npm test" item is deduped across phases.
		expect((tail.match(/^- \[ \] npm test$/gm) ?? []).length).toBe(1);
	});

	it("re-derives the updated block when a re-elaborated phase's AV items changed (drop + re-derivation via the marker)", () => {
		writeFileSync(planPath, REFERENCE_ONLY_PLAN);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaborationWithAv(1, "First", ["- [ ] npm test"]),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaborationWithAv(2, "Second", ["- [ ] `npx vitest run b.test.ts` — exits 0"]),
		);
		run(planPath);
		const first = readFileSync(planPath, "utf-8");
		expect(first).toContain("`npx vitest run b.test.ts`");

		// Phase 2 re-elaborated with different AV items.
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaborationWithAv(2, "Second", ["- [ ] `npx vitest run c.test.ts` — exits 0"]),
		);
		const out = run(planPath);
		const second = readFileSync(planPath, "utf-8");

		expect(out).toContain("whole-plan verification: derived");
		expect(second).toContain("`npx vitest run c.test.ts`");
		// The stale item was dropped with the stale derived block, not accumulated.
		expect(second).not.toContain("`npx vitest run b.test.ts`");
		expect((second.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
	});

	it("never invents a block: no authored block and no reference emits nothing (mode none)", () => {
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		// The beforeEach PLAN carries no block and no reference.
		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("whole-plan verification: none");
		expect(stitched).not.toContain("## Whole-Plan Verification");
	});

	it("never invents a block: a reference with zero collectible AV items emits nothing and says why", () => {
		writeFileSync(planPath, REFERENCE_ONLY_PLAN);
		// Both phases swapped for sections with an AV heading but no checkbox items.
		writeFileSync(join(elaborationsDir, "2026-06-24_demo__phase-1.md"), elaborationWithAv(1, "First", []));
		writeFileSync(join(elaborationsDir, "2026-06-24_demo__phase-2.md"), elaborationWithAv(2, "Second", []));

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("whole-plan verification: none (notes reference but no verification items)");
		// No column-0 section heading — the reference line's backticked phrase
		// is prose, not a section.
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(0);
		expect(stitched).not.toContain("derived by stitch-elaborations");
	});

	it("is idempotent across all four shapes (authored/derived × elaborated/kept-original last phase)", () => {
		const clearElaborations = () => {
			for (const f of readdirSync(elaborationsDir)) rmSync(join(elaborationsDir, f));
		};
		const shapes = [
			{ plan: planWithAuthoredWpv(WPV_BLOCK, true), elaborateLast: true },
			{ plan: planWithAuthoredWpv(WPV_BLOCK, false), elaborateLast: false },
			{ plan: REFERENCE_ONLY_PLAN, elaborateLast: true },
			{ plan: REFERENCE_ONLY_PLAN, elaborateLast: false },
		];
		for (const shape of shapes) {
			clearElaborations();
			writeFileSync(planPath, shape.plan);
			writeFileSync(
				join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
				elaborationWithAv(1, "First", ["- [ ] npm test"]),
			);
			if (shape.elaborateLast) {
				writeFileSync(
					join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
					elaborationWithAv(2, "Second", ["- [ ] npm test"]),
				);
			}
			run(planPath);
			const first = readFileSync(planPath, "utf-8");
			expect((first.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
			run(planPath);
			expect(readFileSync(planPath, "utf-8")).toBe(first);
		}
	});

	it("never treats a fenced `## Whole-Plan Verification` line as the section", () => {
		writeFileSync(
			planPath,
			[
				"---",
				"status: ready",
				"phase_count: 2",
				"phases:",
				'  - { n: 1, title: "First" }',
				'  - { n: 2, title: "Second" }',
				"---",
				"",
				"# Plan: demo",
				"",
				"## Synthesis Notes",
				"- seam",
				"",
				"## Phase 1: First",
				"### Changes",
				"### Success Criteria",
				"#### Automated Verification:",
				"- [ ] npm test",
				"",
				"## Phase 2: Second",
				"### Changes",
				"#### `doc.md`",
				"Find:",
				"```markdown",
				"## Whole-Plan Verification",
				"(fenced example — never a section)",
				"```",
				"### Success Criteria",
				"#### Automated Verification:",
				"- [ ] npm test",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-1.md"),
			elaboration(1, "First", "export const foo = 1;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		// The fenced line survives verbatim in the kept phase-2 section but is
		// never extracted, never emitted.
		expect(stitched).toContain("## Whole-Plan Verification\n(fenced example — never a section)");
		expect(out).toContain("whole-plan verification: none");
	});

	it("suppresses the append when a block is already present mid-document (exactly one section out)", () => {
		writeFileSync(
			planPath,
			[
				"---",
				"status: ready",
				"phase_count: 2",
				"phases:",
				'  - { n: 1, title: "First" }',
				'  - { n: 2, title: "Second" }',
				"---",
				"",
				"# Plan: demo",
				"",
				"## Synthesis Notes",
				"- whole-tree gates are collected into the final `## Whole-Plan Verification` block owned by validate",
				"",
				"## Phase 1: First",
				"### Changes",
				"### Success Criteria",
				"#### Automated Verification:",
				"- [ ] npm test",
				"",
				"## Whole-Plan Verification",
				"",
				"A degenerate mid-document block (phase 1's span).",
				"",
				"## Phase 2: Second",
				"### Changes",
				"### Success Criteria",
				"#### Automated Verification:",
				"- [ ] npm test",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		// Phase 1 kept-original carries the mid-document block into the final
		// composition → the derived candidate is suppressed with the note.
		expect(out).toContain("whole-plan verification: none (block already present)");
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
		expect(stitched).toContain("A degenerate mid-document block");
		expect(stitched).not.toContain("derived by stitch-elaborations");
	});

	it("keeps the phase_count == '## Phase N:' heading-count derive invariant with a WPV tail", () => {
		writeFileSync(planPath, planWithAuthoredWpv(WPV_BLOCK, false));
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

		// The WPV heading is not a phase heading — the count is unchanged.
		expect([...stitched.matchAll(/^## Phase (\d+):/gm)]).toHaveLength(2);
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
	});

	it("carries an authored block's bullet-shaped prose verbatim; the frontmatter stays byte-identical", () => {
		const bullet = "- **Scope addition, flagged: `wpv/x.ts`.** bookkeeping prose with a second `token`.";
		const plan = [
			"---",
			"status: ready",
			"phase_count: 2",
			"phases:",
			'  - { n: 1, title: "First", files: ["src/a.ts"] }',
			'  - { n: 2, title: "Second" }',
			"---",
			"",
			"# Plan: demo",
			"",
			"## Synthesis Notes",
			"- seam",
			"",
			"## Phase 1: First",
			"### Changes",
			"### Success Criteria",
			"#### Automated Verification:",
			"- [ ] npm test",
			"",
			"## Phase 2: Second",
			"### Changes",
			"### Success Criteria",
			"#### Automated Verification:",
			"- [ ] npm test",
			"",
			"## Whole-Plan Verification",
			"",
			"The block's own bookkeeping notes:",
			"",
			bullet,
			"",
		].join("\n");
		writeFileSync(planPath, plan);
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

		// The bullet rides the re-appended tail verbatim — §1.3's stitch moves
		// whole blocks only, never interprets their body prose — a future lift
		// must keep excluding this block as an input).
		expect(out).toContain("whole-plan verification: authored");
		expect(stitched).toContain(bullet);
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
		// The stitch never rewrites the frontmatter — byte-identical in and out.
		const fmOf = (s: string) => s.match(/^---\n[\s\S]*\n---\n/)?.[0] ?? "";
		expect(fmOf(stitched)).toBe(fmOf(plan));
	});

	it("detects and re-appends a suffix-form authored heading verbatim", () => {
		writeFileSync(planPath, planWithAuthoredWpv(WPV_SUFFIX_BLOCK, false));
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

		expect(out).toContain("whole-plan verification: authored");
		expect(stitched.endsWith(WPV_SUFFIX_BLOCK)).toBe(true);
		expect((stitched.match(/^## Whole-Plan Verification/gm) ?? []).length).toBe(1);
	});
});

// An elaboration that embeds a whole markdown file under a THREE-backtick fence
// while that file carries its own ``` blocks: the inner closer ends the outer
// fence early and the intended outer closer reopens one that never closes.
const elaborationWithLeakedFence = (n: number, title: string) =>
	[
		"---",
		`phase_n: ${n}`,
		"status: ready",
		"---",
		"",
		`## Phase ${n}: ${title}`,
		"### Changes",
		"#### `guide.md`",
		"Add — the package guidance",
		"```markdown",
		"# guide",
		"```ts",
		"export const x = 1;",
		"```",
		"more prose",
		"```",
		"### Success Criteria",
		"#### Automated Verification:",
		"- [ ] npm test",
		"",
	].join("\n");

describe("stitch-elaborations.mjs refusals", () => {
	it("refuses an elaboration whose fence never closes, naming the file and opener line, and leaves the plan untouched", () => {
		writeFileSync(join(elaborationsDir, "2026-06-24_demo__phase-1.md"), elaborationWithLeakedFence(1, "First"));
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		const { status, stderr } = runFail(planPath);

		expect(status).toBe(1);
		expect(stderr).toContain("2026-06-24_demo__phase-1.md refused");
		expect(stderr).toContain("fence opened at line 16 never closes");
		expect(stderr).toContain("four backticks");
		expect(readFileSync(planPath, "utf-8")).toBe(PLAN);
	});

	it("refuses an elaboration carrying a second out-of-fence '## Phase N:' heading", () => {
		const doubled = `${elaboration(1, "First", "export const foo = 1;")}\n## Phase 2: Second\n- stray\n`;
		writeFileSync(join(elaborationsDir, "2026-06-24_demo__phase-1.md"), doubled);

		const { status, stderr } = runFail(planPath);

		expect(status).toBe(1);
		expect(stderr).toContain("2026-06-24_demo__phase-1.md refused");
		expect(stderr).toContain("2 '## Phase N:' headings outside fences, expected exactly 1");
		expect(readFileSync(planPath, "utf-8")).toBe(PLAN);
	});

	it("accepts the same embed under a four-backtick outer fence", () => {
		const fixed = elaborationWithLeakedFence(1, "First")
			.replace("```markdown", "````markdown")
			.replace("more prose\n```", "more prose\n````");
		writeFileSync(join(elaborationsDir, "2026-06-24_demo__phase-1.md"), fixed);
		writeFileSync(
			join(elaborationsDir, "2026-06-24_demo__phase-2.md"),
			elaboration(2, "Second", "export const bar = 2;"),
		);

		const out = run(planPath);
		const stitched = readFileSync(planPath, "utf-8");

		expect(out).toContain("stitched 2/2 phases");
		expect([...stitched.matchAll(/^## Phase (\d+):/gm)].length).toBe(2);
		expect(stitched).toContain("````markdown");
	});
});
