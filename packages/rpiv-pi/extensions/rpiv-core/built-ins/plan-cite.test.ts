/**
 * plan-cite.test.ts — plan-time citation floors routed through
 * plan-cite-check (phase-file coverage, declared-files tiebreak, severity
 * tier), moved verbatim from built-in-workflows.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

describe("plan-time coverage floor (verifyPhaseFilesCoverage via plan-cite-check)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-plan-cov-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const citeCheckRun = () => {
		const stage = findWorkflow("build").stages["plan-cite-check"];
		if (!stage?.run) throw new Error("build plan-cite-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} };
	};
	const runOn = (plan: ReturnType<typeof write>) =>
		citeCheckRun()({ cwd: tmpDir, input: undefined, state: { named: { plans: [plan] } } as unknown as RunView }).data;
	const findingDetails = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.detail).join(" ");

	it("flags an edit path cited in the body but absent from the phase's files:", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/foo.ts\` — add the thing\n`,
			),
		);
		expect(data.dimension).toBe("structure");
		expect(data.pass).toBe(false);
		expect(data.findings).toHaveLength(1);
		expect(findingDetails(data)).toMatch(/src\/foo\.ts/);
		expect((data.findings as { where: string }[])[0].where).toMatch(/phase 1/);
	});

	it("passes when every body-cited edit path is listed in files:", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["src/foo.ts"] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/foo.ts\` — add the thing\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("passes (empty-set degradation) for a files:-less phase — legacy plans never false-fail", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/foo.ts\` — add the thing\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("ignores a dotted identifier in a Changes bullet — a method name is not a file", () => {
		// `deps.finalize` cost a live run a blocking coverage finding and a full
		// code-fix round; the extension bound (1–5 chars) rejects it.
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`deps.finalize\` — call it after the retry fold\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("ignores a backticked-path bullet outside a Changes section — references are not writes", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Context\n- \`src/foo.ts\` — mirror this pattern\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("counts a bullet under a **Changes**: field line (blueprint's per-file form)", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n**Changes**: MODIFY —\n- \`src/foo.ts\` — add the thing\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/src\/foo\.ts/);
	});

	it("covers a bare-basename body form via whole-segment suffix against the declared files:", () => {
		// `#### 1. config.ts` with files: [packages/x/config.ts] used to be an
		// unfixable gap (exact-match only) whose remedy text would pollute files:
		// with the bare name.
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["packages/x/config.ts"] }\n---\n# Plan\n## Phase 1: One\n#### 1. config.ts\n**File**: \`config.ts\`\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("flags an undeclared extensionless write (Makefile) — the extension heuristic must not drop it", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`Makefile\` — add the check target\n**File**: packages/rpiv-btw/Dockerfile\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/Makefile/);
		expect(findingDetails(data)).toMatch(/packages\/rpiv-btw\/Dockerfile/);
	});

	it("passes a declared extensionless write, and prose with a slash never reads as a path", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["Makefile"] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`Makefile\` — either/or and/or update the target\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("ignores paths inside a fenced code block (post-code-splice safety)", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/foo.ts\` — add the thing\n\n\`\`\`ts\n// example fixture — its path must NOT read as a declared write\nimport { x } from "src/fenced-example.ts";\n\`\`\`\n`,
			),
		);
		expect(data.findings).toHaveLength(1);
		expect(findingDetails(data)).toMatch(/src\/foo\.ts/);
		expect(findingDetails(data)).not.toMatch(/fenced-example/);
	});

	// Cross-character regression (Q6): a bare ~~~ must NOT close a ``` fence, so a
	// post-~~~ `- `path`` list item stays fenced and is not surfaced as a declared
	// write. (editPathsOfPhase extracts the `- `path`` form — NOT import lines — so
	// this form, not an `import … from`, is what actually exercises the scanner:
	// under the old length-only close the ~~~ would close the fence and expose the
	// list item in prose, surfacing `fenced-example` as findings.length === 2.)
	it("does not surface a fenced edit-path list item appearing after a mismatched-character (~~~) line", () => {
		const rel = ".rpiv/artifacts/plans/fence-cross-char.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/foo.ts\` — add the thing\n\n\`\`\`ts\n~~~\n- \`src/fenced-example.ts\` — must stay fenced\n\`\`\`\n`,
			),
		);
		expect(data.findings).toHaveLength(1);
		expect(findingDetails(data)).toMatch(/src\/foo\.ts/);
		expect(findingDetails(data)).not.toMatch(/fenced-example/);
	});

	// Fence-aware citation floor — sibling cases to the verifyPhaseFilesCoverage
	// fence test above. A `path:line` shape inside a fenced code block is a
	// placeholder, not a citation to verify; the skip is span-scoped, so a real
	// dangling citation in prose still fails.
	it("skips a fenced path:line-shaped placeholder (citation floor is fence-aware)", () => {
		const rel = ".rpiv/artifacts/plans/fence-placeholder.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nExample fixture:\n\n\`\`\`ts\nconst x = load("src/does-not-exist.ts:42");\n\`\`\`\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("skips prose citations under the placeholder namespaces (path/to/, packages/x/)", () => {
		const rel = ".rpiv/artifacts/plans/placeholder-namespace.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nAn evidence string is shaped like \`packages/x/y.ts:85 (helper)\`; templates use path/to/file.ext:12-30.\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("still flags a real unresolved path:line citation in plan prose (skip is span-scoped)", () => {
		const rel = ".rpiv/artifacts/plans/fence-prose.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nSee src/does-not-exist.ts:42 for the broken example.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/Unbacked citation/);
		expect(findingDetails(data)).toMatch(/does-not-exist\.ts:42/);
	});

	it("skips a ~~~ tilde fence and a length-matched (four-backtick) fence identically to ```", () => {
		const rel = ".rpiv/artifacts/plans/fence-kinds.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n~~~ts\nconst a = load("src/tilde-fenced.ts:7");\n~~~\n\n\`\`\`\`ts\nconst b = load("src/four-back-fenced.ts:9");\n\`\`\`\`\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("skips a placeholder in an unterminated fence's remainder", () => {
		const rel = ".rpiv/artifacts/plans/fence-unterminated.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nExample:\n\n\`\`\`ts\nconst x = load("src/unterminated-fenced.ts:5");\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("still verifies a prose citation appearing after a closed fenced block (no closed-span leak)", () => {
		const rel = ".rpiv/artifacts/plans/fence-leak.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n\`\`\`ts\nconst x = load("src/fenced-placeholder.ts:11");\n\`\`\`\n\nSee src/after-fence.ts:30 for the broken example.\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/after-fence\.ts:30/);
		expect(findingDetails(data)).not.toMatch(/fenced-placeholder/);
	});

	it("extracts all three conventions: - `path` (synthesize), #### N. path (blueprint), **File**: (plan)", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n### Changes\n- \`src/synth-form.ts\` — synthesize list-item form\n#### 1. src/blueprint-form.ts\n**File**: src/plan-form.ts\n`,
			),
		);
		const details = findingDetails(data);
		expect(details).toMatch(/src\/synth-form\.ts/);
		expect(details).toMatch(/src\/blueprint-form\.ts/);
		expect(details).toMatch(/src\/plan-form\.ts/);
	});
});

// ---------------------------------------------------------------------------
// Declared-files citation tiebreak — exercised through the plan-cite-check
// stage. An ambiguous bare/suffix citation resolves iff exactly ONE tree
// candidate is in the plan's declared `files:` union (the ship run bf18 halt:
// four ambiguous basenames whose owning files the plan itself declared); a tie
// inside the declared set, or an empty intersection, stays unbacked.
// ---------------------------------------------------------------------------
describe("declared-files citation tiebreak (verifyCitations via plan-cite-check)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-plan-tiebreak-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const citeCheckRun = () => {
		const stage = findWorkflow("build").stages["plan-cite-check"];
		if (!stage?.run) throw new Error("build plan-cite-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} };
	};
	const runOn = (plan: ReturnType<typeof write>) =>
		citeCheckRun()({ cwd: tmpDir, input: undefined, state: { named: { plans: [plan] } } as unknown as RunView }).data;
	const findingDetails = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.detail).join(" ");
	const dupFiles = (lines = 50) => {
		mkdirSync(join(tmpDir, "a"), { recursive: true });
		mkdirSync(join(tmpDir, "b"), { recursive: true });
		writeFileSync(join(tmpDir, "a/dup.ts"), Array.from({ length: lines }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "b/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
	};

	it("resolves an ambiguous bare-basename citation when exactly one candidate is declared in files:", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/tiebreak-unique.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["a/dup.ts"] }\n---\n# Plan\n## Phase 1: One\nRetype the constant (dup.ts:5).\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("stays unbacked when BOTH ambiguous candidates are declared (tie inside the write-set)", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/tiebreak-tie.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["a/dup.ts", "b/dup.ts"] }\n---\n# Plan\n## Phase 1: One\nRetype the constant (dup.ts:5).\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/matches 2 tree files/);
	});

	it("stays unbacked when no ambiguous candidate is declared (empty intersection)", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/tiebreak-none.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nRetype the constant (dup.ts:5).\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/Unbacked citation/);
	});

	it("verifies the line range against the DECLARED candidate after the tiebreak resolves", () => {
		// a/dup.ts (declared) has 4 lines; b/dup.ts has 50 — a line-20 citation must
		// fail, proving resolution landed on the declared file, not the other one.
		dupFiles(4);
		const rel = ".rpiv/artifacts/plans/tiebreak-eof.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["a/dup.ts"] }\n---\n# Plan\n## Phase 1: One\nRetype the constant (dup.ts:20).\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/matches no version of the file/);
	});

	it("pools files: across phases — a citation owned by another phase's declared file still resolves", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/tiebreak-cross-phase.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 2\nphases:\n  - { n: 1, title: One, files: ["a/dup.ts"] }\n  - { n: 2, title: Two, files: [] }\n---\n# Plan\n## Phase 1: One\nEdit the constant.\n## Phase 2: Two\nMirror the retype from phase 1 (dup.ts:5).\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Proximity tiebreak — a section names its file in full (`**File**: …`)
	// then cites by bare basename, while the write-set declares BOTH candidates
	// (so the declared tiebreak ties). The nearest preceding prose mention
	// resolves the citation; the frontmatter `files:` array and fenced spans
	// never count as mentions.
	// -------------------------------------------------------------------------

	it("resolves a write-set tie via the nearest preceding prose mention of the full path", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/proximity-file-header.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: ["a/dup.ts", "b/dup.ts"] }\n---\n# Plan\n## Phase 1: One\n**File**: \`a/dup.ts\`\n**Changes**: retype the constant (\`dup.ts:5\`).\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("resolves to the NEAREST mention, then verifies the line range against that file", () => {
		// a/dup.ts has 4 lines, b/dup.ts has 50. Both are mentioned; a/dup.ts is
		// nearer, so dup.ts:20 must resolve there and fail the range check —
		// proving proximity (not mention order or the write-set) picked the file.
		dupFiles(4);
		const rel = ".rpiv/artifacts/plans/proximity-nearest.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nMirror \`b/dup.ts\` in the twin.\n**File**: \`a/dup.ts\`\n**Changes**: retype the constant (\`dup.ts:20\`).\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/matches no version of the file/);
	});

	it("resolves with no declared files at all when the prose names one candidate in full", () => {
		dupFiles(4);
		const rel = ".rpiv/artifacts/plans/proximity-undeclared.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nDraws on \`b/dup.ts\` for the pattern (\`dup.ts:20\`).\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("ignores a mention that only appears AFTER the citation", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/proximity-after.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nRetype the constant (\`dup.ts:5\`), then update \`a/dup.ts\` docs.\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/matches 2 tree files/);
	});

	it("ignores a mention inside a fenced span — fixture paths are not disambiguators", () => {
		dupFiles();
		const rel = ".rpiv/artifacts/plans/proximity-fenced.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\n\`\`\`ts\nimport { x } from "a/dup.ts";\n\`\`\`\nRetype the constant (\`dup.ts:5\`).\n`,
			),
		);
		expect(data.pass).toBe(false);
		expect(findingDetails(data)).toMatch(/matches 2 tree files/);
	});

	it("does not back-match a candidate inside a longer path mention (token boundary)", () => {
		// x/a/dup.ts is a THIRD candidate; its mention contains "a/dup.ts" as a
		// substring, which must not read as a mention of a/dup.ts. The nearest
		// clean mention is x/a/dup.ts itself (50 lines), so dup.ts:20 passes —
		// a boundary leak onto a/dup.ts (4 lines) would fail the range check.
		dupFiles(4);
		mkdirSync(join(tmpDir, "x/a"), { recursive: true });
		writeFileSync(join(tmpDir, "x/a/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/plans/proximity-boundary.md";
		const data = runOn(
			write(
				rel,
				`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [] }\n---\n# Plan\n## Phase 1: One\nExtend \`x/a/dup.ts\` (\`dup.ts:20\`).\n`,
			),
		);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Citation-floor severity tier — advisory findings (ambiguity, line drift past
// EOF) rate the structure verdict `low`, which the gates' allDimensionsPass
// severity floor rides through, so a loop-less preset RECORDS them without
// stopping (the run history's terminal cite stops were all advisory shapes,
// none a fabrication). A citation resolving to NOTHING — the one
// fabrication-shaped category — still rates `high` and blocks, as does a
// `files:` coverage gap. Exercised through plan-cite-check.
// ---------------------------------------------------------------------------
describe("citation-floor severity tier (advisory vs blocking via plan-cite-check)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-cite-tier-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const citeCheckRun = () => {
		const stage = findWorkflow("build").stages["plan-cite-check"];
		if (!stage?.run) throw new Error("build plan-cite-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} };
	};
	const runOn = (plan: ReturnType<typeof write>) =>
		citeCheckRun()({ cwd: tmpDir, input: undefined, state: { named: { plans: [plan] } } as unknown as RunView }).data;
	const findings = (data: Record<string, unknown>) =>
		(data.findings as { detail: string; where: string; advisory?: boolean }[] | undefined) ?? [];
	const dupFiles = () => {
		mkdirSync(join(tmpDir, "a"), { recursive: true });
		mkdirSync(join(tmpDir, "b"), { recursive: true });
		writeFileSync(join(tmpDir, "a/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "b/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
	};
	const plan = (body: string) => write(".rpiv/artifacts/plans/p.md", body);
	const fm = (files: string) =>
		`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: One, files: [${files}] }\n---\n# Plan\n## Phase 1: One\n`;

	it("rates an ambiguous-only verdict `low` (advisory) — recorded, never gate-blocking", () => {
		dupFiles();
		const data = runOn(plan(`${fm("")}Retype the constant (dup.ts:5).\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(findings(data)).toHaveLength(1);
		expect(findings(data)[0].advisory).toBe(true);
	});

	it("rates a line-past-EOF-only verdict `low` (drift is advisory)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/tiny.ts"), "a\nb\nc\n"); // 4 lines
		const data = runOn(plan(`${fm('"src/tiny.ts"')}Retype the constant (src/tiny.ts:900).\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(findings(data)[0].advisory).toBe(true);
	});

	it("rates a resolves-to-nothing citation `low` — every citation-resolution finding is advisory", () => {
		// The run-history audit: the no-match population was garbled-but-real
		// paths, skipped-tree files, and fixture prose — zero fabrications. The
		// grade panel adjudicates via --cite-check; the floor records only.
		const data = runOn(plan(`${fm("")}See src/does-not-exist.ts:42 for the footing.\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(findings(data)[0].advisory).toBe(true);
	});

	it("rates a mixed verdict `high` — a coverage gap outranks advisory citation findings", () => {
		dupFiles();
		const data = runOn(
			plan(`${fm("")}Retype the constant (dup.ts:5).\n### Changes\n- \`src/foo.ts\` — add the thing\n`),
		);
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		const byTier = new Set(findings(data).map((f) => f.advisory === true));
		expect(byTier).toEqual(new Set([true, false]));
	});

	it("resolves a guidance-tree suffix citation (.rpiv/guidance is carved back into the walk)", () => {
		mkdirSync(join(tmpDir, ".rpiv/guidance/packages/rpiv-workflow/sessions"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".rpiv/guidance/packages/rpiv-workflow/sessions/architecture.md"),
			Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n"),
		);
		const data = runOn(plan(`${fm("")}Update the contract note (sessions/architecture.md:33).\n`));
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("still never resolves into .rpiv/artifacts (stale artifact copies stay invisible)", () => {
		mkdirSync(join(tmpDir, ".rpiv/artifacts/priors/sub"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv/artifacts/priors/sub/only-here.md"), "a\nb\nc\n");
		const data = runOn(plan(`${fm("")}See sub/only-here.md:2 for the prior.\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(findings(data)[0].detail).toMatch(/does not exist/);
	});

	it("rescues a no-match citation via a unique declared-files: suffix match and verifies its lines", () => {
		// The file lives under a skipped tree (coverage/) — invisible to the
		// suffix walk — but the plan's own files: declares it. dist-file has 4
		// lines, so a line-20 citation must fail the range check, proving the
		// rescue resolved to the declared file rather than skipping the citation.
		mkdirSync(join(tmpDir, "coverage/gen"), { recursive: true });
		writeFileSync(join(tmpDir, "coverage/gen/report.md"), "a\nb\nc\n");
		const data = runOn(plan(`${fm('"coverage/gen/report.md"')}Refresh the table (gen/report.md:20).\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(findings(data)[0].detail).toMatch(/matches no version of the file/);
	});

	it("skips a citation to a declared file absent from the tree (forward reference to a planned CREATE)", () => {
		const data = runOn(plan(`${fm('"src/new-module.ts"')}The new helper lands at new-module.ts:10.\n`));
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("rates a files: coverage gap `high` (protects the implement fanout's dep derivation)", () => {
		const data = runOn(plan(`${fm("")}### Changes\n- \`src/foo.ts\` — add the thing\n`));
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findings(data)[0].advisory).toBeUndefined();
	});

	it("rates a clean floor `none` (unchanged green path)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/ok.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const data = runOn(plan(`${fm('"src/ok.ts"')}Retype the constant (src/ok.ts:5).\n`));
		expect(data.pass).toBe(true);
		expect(data.severity).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// SYNTH_CLUSTER_FANOUT — research threading (finding 4) + fail-loud identity
// resolution (finding 8).
// ---------------------------------------------------------------------------
