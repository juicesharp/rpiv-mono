/**
 * slice-checks.test.ts — the deterministic slice/subplan cluster-coverage
 * floors plus the vet implement-scope-check declared-union loop (de-nested
 * from the vet describe), moved verbatim from built-in-workflows.test.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EdgeFn, Output, RunView } from "@juicesharp/rpiv-workflow";
import { fanin, fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

describe("build slice-check (deterministic floor)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-structure-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const structureRun = () => {
		const stage = findWorkflow("build").stages["slice-check"];
		if (!stage?.run) throw new Error("build slice-check stage has no run function");
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
	// state.named.slices = round-0 (frozen coverage source) ... latest (graded).
	const runOn = (...slices: ReturnType<typeof write>[]) =>
		structureRun()({ cwd: tmpDir, input: undefined, state: { named: { slices } } as unknown as RunView }).data;

	const map = (opts: { sliceLines: string; coverage?: string; count: number }) =>
		`---\nstatus: ready\nslice_count: ${opts.count}\n${opts.coverage ?? ""}slices:\n${opts.sliceLines}---\n${Array.from({ length: opts.count }, (_, i) => `## Slice ${i + 1}: S${i + 1}`).join("\n")}\n`;

	const COV = "coverage:\n  - { id: c1, brief: one }\n  - { id: c2, brief: two }\n";

	it("passes an acyclic, fully-covered slice map", () => {
		const rel = ".rpiv/artifacts/slices/ok.md";
		const m = write(
			rel,
			map({
				count: 2,
				coverage: COV,
				sliceLines:
					"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n",
			}),
		);
		const data = runOn(m);
		expect(data.dimension).toBe("structure");
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fails on a dependency cycle (1->2->1)", () => {
		const rel = ".rpiv/artifacts/slices/cycle.md";
		const m = write(
			rel,
			map({
				count: 2,
				coverage: COV,
				sliceLines:
					"  - { n: 1, title: A, deps: [2], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n",
			}),
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/cycle/i);
	});

	it("fails when a reslice drops a coverage unit frozen at the first cut", () => {
		const first = write(
			".rpiv/artifacts/slices/first.md",
			map({
				count: 2,
				coverage: COV,
				sliceLines:
					"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n",
			}),
		);
		// Latest reslice covers only c1 — c2 silently dropped. Frozen set is read from `first`.
		const latest = write(
			".rpiv/artifacts/slices/latest.md",
			map({ count: 1, coverage: COV, sliceLines: "  - { n: 1, title: A, deps: [], covers: [c1] }\n" }),
		);
		const data = runOn(first, latest);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/c2/);
	});

	it("is a no-op on coverage when the first cut froze no units", () => {
		const rel = ".rpiv/artifacts/slices/nocov.md";
		const m = write(rel, map({ count: 1, sliceLines: "  - { n: 1, title: A, deps: [] }\n" }));
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	// Finding 6 — unbacked precision: a file:line citation the slice map emits must
	// resolve, or the deterministic floor fails it rather than propagating it to design.
	it("fails on an unbacked file:line citation (nonexistent file)", () => {
		const rel = ".rpiv/artifacts/slices/cite.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** src/does-not-exist.ts:42\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
		expect(String(data.feedback)).toMatch(/does-not-exist\.ts:42/);
	});

	it("a `..`-escaping citation to an EXISTING out-of-tree file is unbacked, not backed", () => {
		// Containment: direct resolution must not confirm a file outside cwd — an
		// existing out-of-tree target would read as a backed citation (and leak its
		// line count). The escape falls through to the suffix fallback, which finds
		// no tree file ⇒ ordinary unbacked finding. FAILS without the guard.
		const escapeName = `${basename(tmpDir)}-cite-escape.md`;
		const outsideFile = join(tmpDir, "..", escapeName); // a tmpDir SIBLING — outside cwd
		writeFileSync(outsideFile, "line1\nline2\nline3\n");
		try {
			const rel = ".rpiv/artifacts/slices/cite-escape.md";
			const m = write(
				rel,
				`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** x/../../${escapeName}:2\n`,
			);
			const data = runOn(m);
			expect(data.pass).toBe(false);
			expect(String(data.feedback)).toMatch(/Unbacked citation/);
		} finally {
			rmSync(outsideFile, { force: true });
		}
	});

	it("fails on a file:line citation past end-of-file", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/small.ts"), "line1\nline2\n"); // 3 lines (trailing newline)
		const rel = ".rpiv/artifacts/slices/cite2.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** src/small.ts:900\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/matches no version of the file/);
	});

	it("passes a citation that resolves to a real file:line", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/real.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/cite3.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** src/real.ts:20\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	// Cite-only discharge — a `remedy: "cite"` design-readiness fail whose demands
	// (add a named seed) landed on a structurally identical re-cut earns the
	// `citeDischarged` stamp, so the gate can skip the re-grade panel. The fix is
	// witnessed by publication order (a re-slice may edit the map in place, so
	// basenames can't tell), and a revision note's `old→new` quotations don't
	// count as live citations. A fix that ALSO restructured forfeits the stamp
	// and takes the normal re-grade. (The former REFRESH mode — a `stale` drifted
	// line number to replace — was removed with anchor-precision grading.)
	const T_JUDGED = "2026-01-01T00:01:00.000Z";
	const T_VERDICT = "2026-01-01T00:02:00.000Z";
	const T_FIXED = "2026-01-01T00:03:00.000Z";
	const citeFailVerdict = (finding: Record<string, unknown>) =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts: T_VERDICT },
			data: {
				dimension: "design-readiness",
				pass: false,
				severity: "medium",
				remedy: "cite",
				artifact: ".rpiv/artifacts/slices/round1.md",
				findings: [{ detail: "under-cited", where: "## Slice 2", ...finding }],
			},
		}) as unknown as Output;
	const SHAPE = {
		slices: [
			{ n: 1, title: "A", deps: [], covers: ["c1"] },
			{ n: 2, title: "B", deps: [1], covers: ["c2"] },
		],
		coverage: [
			{ id: "c1", brief: "one" },
			{ id: "c2", brief: "two" },
		],
	};
	const TWO_SLICES =
		"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n";
	const THREE_SLICES =
		"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n  - { n: 3, title: C, deps: [1], covers: [c1] }\n";
	const SHAPE3 = {
		slices: [
			{ n: 1, title: "A", deps: [], covers: ["c1"] },
			{ n: 2, title: "B", deps: [1], covers: ["c2"] },
			{ n: 3, title: "C", deps: [1], covers: ["c1"] },
		],
		coverage: [
			{ id: "c1", brief: "one" },
			{ id: "c2", brief: "two" },
		],
	};
	// A map whose every slice carries a `Draws on:` line — the lift's target.
	const seededMap = (opts: { sliceLines: string; coverage?: string; count: number; drawsOn?: string[] }) =>
		`---\nstatus: ready\nslice_count: ${opts.count}\n${opts.coverage ?? ""}slices:\n${opts.sliceLines}---\n${Array.from({ length: opts.count }, (_, i) => `## Slice ${i + 1}: S${i + 1}\n**Draws on:** ${opts.drawsOn?.[i] ?? "src/base.ts:1"}`).join("\n")}\n`;
	// The seed-lift stage's run function — the deterministic arm the seed-only
	// branch of the slice-grade route dispatches (the structureRun twin).
	const liftRun = () => {
		const stage = findWorkflow("build").stages["slice-seed-lift"];
		if (!stage?.run) throw new Error("build slice-seed-lift stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			artifacts: readonly { handle: { kind: string; path: string } }[];
			data: {
				lifted: { requires: string; slice?: number; reason?: string }[];
				skipped: { requires: string; slice?: number; reason?: string }[];
			};
		};
	};
	// A seed-only design-readiness fail carrying arbitrary findings.
	const seedVerdict = (findings: Record<string, unknown>[], artifact: string, ts = T_VERDICT): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: {
				dimension: "design-readiness",
				pass: false,
				severity: "medium",
				remedy: "cite",
				artifact,
				findings: findings.map((f) => ({ detail: "under-cited", ...f })),
			},
		}) as unknown as Output;
	// A slice-seed-lift channel row (only `meta.ts` is load-bearing).
	const liftEntry = (ts: string, data: Record<string, unknown> = {}): Output =>
		({ artifacts: [], kind: "json", meta: { ts }, data }) as unknown as Output;

	it("stamps citeDischarged when a cite-only fail's demanded seeds landed on an unchanged shape", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const judged = {
			...write(".rpiv/artifacts/slices/round1.md", map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const fixed = {
			...write(
				".rpiv/artifacts/slices/round2.md",
				`${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:20\n`,
			),
			data: SHAPE,
			meta: { ts: T_FIXED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: { slices: [judged, fixed], "slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })] },
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.citeDischarged).toBe("round2.md");
	});

	it("withholds citeDischarged when the fix also restructured the map", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const judged = {
			...write(".rpiv/artifacts/slices/round1.md", map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const restructured =
			"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n  - { n: 3, title: C, deps: [], covers: [c1] }\n";
		const fixed = {
			...write(
				".rpiv/artifacts/slices/round2.md",
				`${map({ count: 3, coverage: COV, sliceLines: restructured })}**Draws on:** src/seed.ts:20\n`,
			),
			data: { ...SHAPE, slices: [...SHAPE.slices, { n: 3, title: "C", deps: [], covers: ["c1"] }] },
			meta: { ts: T_FIXED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: { slices: [judged, fixed], "slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })] },
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.citeDischarged).toBeUndefined();
	});

	it("discharges an IN-PLACE fix whose revision note quotes replaced cites as arrow pairs", () => {
		// The live-run shape: slice-fix edits the SAME file (same basename as the
		// judged round) and appends a note quoting each refresh as `old→new`. The
		// note's quotations must not read as live citations, and publication order
		// (not basename inequality) must witness that the fix happened.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/round1.md";
		const judged = {
			...write(rel, `${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:7\n`),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const fixed = {
			...write(
				rel,
				`${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}> Re-slice note: refreshed \`src/seed.ts:7→src/seed.ts:20\`.\n**Draws on:** src/seed.ts:20\n`,
			),
			data: SHAPE,
			meta: { ts: T_FIXED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged, fixed],
					"slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:20" })],
				},
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.citeDischarged).toBe("round1.md");
	});

	it("withholds citeDischarged when no slices round has been published since the verdict", () => {
		// Even a map whose text happens to satisfy the demands cannot discharge a
		// verdict that postdates every published round — the grader read this very
		// content and failed it; only a fix landing AFTER the verdict counts.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const only = {
			...write(
				".rpiv/artifacts/slices/round1.md",
				`${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:20\n`,
			),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: { slices: [only], "slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })] },
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.citeDischarged).toBeUndefined();
	});

	it("the discharge witness fires on the lift-channel entry alone (no post-verdict slices round)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/round1.md";
		// The post-lift map: the demanded seed landed on the judged map, in place.
		const lifted = {
			...write(rel, `${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:20\n`),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [lifted],
					"slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.citeDischarged).toBe("round1.md");
	});

	it("stamps citeDischarged beside one ADVISORY finding (the stamp floor matches the routing floor)", () => {
		// Red today: the literal-zero withholding gate let a single ADVISORY
		// resolver limitation — here a bare out-of-range drift cite in prose —
		// zero the stamp and buy the re-grade anyway. The advisory floor rides
		// through, mirroring the severity floor `allDimensionsPass` already
		// applies to the same channel (an advisory-only verdict rates `low`).
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/round1.md";
		const judged = {
			...write(
				rel,
				`${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:20\nNote: the earlier anchor src/seed.ts:60 has drifted.\n`,
			),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("low");
		expect(Array.isArray(data.findings) && data.findings.length === 1).toBe(true);
		expect(data.citeDischarged).toBe("round1.md");
	});

	it("withholds citeDischarged when a finding is blocking (a dropped coverage unit)", () => {
		// Fail-closed arm: a BLOCKING structural finding — a coverage unit the
		// map's own frozen first cut claims but no slice covers — still withholds
		// the stamp; only the advisory tier rides through.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/round1.md";
		const judged = {
			...write(rel, `${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}**Draws on:** src/seed.ts:20\n`),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		// Drop c2 from every slice's covers — the frozen first cut still claims it.
		writeFileSync(
			join(tmpDir, rel),
			map({
				count: 2,
				coverage: COV,
				sliceLines:
					"  - { n: 1, title: A, deps: [], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c1] }\n",
			}) + "**Draws on:** src/seed.ts:20\n",
		);
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(data.citeDischarged).toBeUndefined();
	});

	it("a revision note's arrow pair neither flags nor withholds: the stale old half is quoted (red today)", () => {
		// Red today: `verifyCitations` honored fences but not arrow pairs, so the
		// note's stale old half (line 60 of a 50-line file) read as a live
		// citation, flagged out-of-range advisory, and zeroed the stamp. Both
		// halves of a sanctioned `old→new` pair are quotes — skipped BEFORE
		// seen-key bookkeeping — while the live `Draws on:` occurrence of the
		// same cite still verifies below.
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/seed.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/round1.md";
		const judged = {
			...write(
				rel,
				`${map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })}> Re-slice note: refreshed \`src/seed.ts:60→src/seed.ts:20\`.\n**Draws on:** src/seed.ts:20\n`,
			),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const data = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [citeFailVerdict({ requires: "src/seed.ts:18-25" })],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
		expect(data.citeDischarged).toBe("round1.md");
	});

	it("sliceSeedLift appends both demanded seeds to the named Draws on lines and publishes the amended map in place", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/base.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "src/alpha.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "src/beta.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/twolift.md";
		const body = seededMap({ count: 3, coverage: COV, sliceLines: THREE_SLICES });
		const judged = { ...write(rel, body), data: SHAPE3, meta: { ts: T_JUDGED } };
		const out = liftRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [
						seedVerdict(
							[
								{ where: "## Slice 2", requires: "src/alpha.ts:18-25" },
								{ where: "## Slice 3", requires: "src/beta.ts:30-40" },
							],
							rel,
						),
					],
				},
			} as unknown as RunView,
		});
		expect(out.data.lifted).toEqual([
			{ requires: "src/alpha.ts:18-25", slice: 2 },
			{ requires: "src/beta.ts:30-40", slice: 3 },
		]);
		expect(out.data.skipped).toEqual([]);
		const amended = readFileSync(join(tmpDir, rel), "utf-8");
		expect(amended).toContain("**Draws on:** src/base.ts:1, src/alpha.ts:18-25");
		expect(amended).toContain("**Draws on:** src/base.ts:1, src/beta.ts:30-40");
		// every other byte identical (frontmatter + untouched slices + headings)
		expect(amended.replace(", src/alpha.ts:18-25", "").replace(", src/beta.ts:30-40", "")).toBe(body);
		expect(out.artifacts[0]?.handle).toEqual({ kind: "fs", path: rel });
	});

	it("does not re-append an already-satisfied seed (dedup on the evolving body)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/alpha.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/dedup.md";
		const body = seededMap({
			count: 2,
			coverage: COV,
			sliceLines: TWO_SLICES,
			drawsOn: ["src/alpha.ts:1", "src/alpha.ts:7"],
		});
		const judged = { ...write(rel, body), data: SHAPE, meta: { ts: T_JUDGED } };
		const out = liftRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [seedVerdict([{ where: "## Slice 2", requires: "src/alpha.ts:18-25" }], rel)],
				},
			} as unknown as RunView,
		});
		expect(out.data.lifted).toEqual([]);
		expect(out.data.skipped).toEqual([]);
		expect(readFileSync(join(tmpDir, rel), "utf-8")).toBe(body);
	});

	it("records a seed whose where names no slice heading as skipped and leaves the map unchanged", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/alpha.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/nosliceheading.md";
		const body = seededMap({ count: 2, coverage: COV, sliceLines: TWO_SLICES });
		const judged = { ...write(rel, body), data: SHAPE, meta: { ts: T_JUDGED } };
		const out = liftRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [
						seedVerdict([{ where: "prose: the footing is thin", requires: "src/alpha.ts:18-25" }], rel),
					],
				},
			} as unknown as RunView,
		});
		expect(out.data.skipped).toEqual([{ requires: "src/alpha.ts:18-25", reason: "no-slice-heading" }]);
		expect(out.data.lifted).toEqual([]);
		expect(readFileSync(join(tmpDir, rel), "utf-8")).toBe(body);
	});

	it("records no-draws-on-line when the named section carries no Draws on line", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src/base.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "src/alpha.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/nodrawson.md";
		const body =
			"---\nstatus: ready\nslice_count: 2\n" +
			COV +
			"slices:\n" +
			TWO_SLICES +
			"---\n## Slice 1: S1\n**Draws on:** src/base.ts:1\n## Slice 2: S2\n**Scope:** only a scope line\n";
		const judged = { ...write(rel, body), data: SHAPE, meta: { ts: T_JUDGED } };
		const out = liftRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [seedVerdict([{ where: "## Slice 2", requires: "src/alpha.ts:18-25" }], rel)],
				},
			} as unknown as RunView,
		});
		expect(out.data.skipped).toEqual([{ requires: "src/alpha.ts:18-25", slice: 2, reason: "no-draws-on-line" }]);
		expect(readFileSync(join(tmpDir, rel), "utf-8")).toBe(body);
	});

	it("halts loudly when the latest verdict is not seed-only (misroute guard)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		const rel = ".rpiv/artifacts/slices/misroute.md";
		const judged = {
			...write(rel, map({ count: 2, coverage: COV, sliceLines: TWO_SLICES })),
			data: SHAPE,
			meta: { ts: T_JUDGED },
		};
		const structural = seedVerdict([{ where: "## Slice 1", detail: "bundles two decisions" }], rel);
		(structural.data as { remedy?: string }).remedy = undefined;
		expect(() =>
			liftRun()({
				cwd: tmpDir,
				input: undefined,
				state: { named: { slices: [judged], "slice-verdicts": [structural] } } as unknown as RunView,
			}),
		).toThrow(/is not a seed-only cite fail/);
	});

	it("the f9a6 end-to-end shape: lift → slice-check stamp → slice-design (no fix session, no re-grade)", () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		for (const f of ["base", "alpha", "beta"]) {
			writeFileSync(join(tmpDir, `src/${f}.ts`), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		}
		const rel = ".rpiv/artifacts/slices/round1.md";
		const body = seededMap({ count: 3, coverage: COV, sliceLines: THREE_SLICES });
		const judged = { ...write(rel, body), data: SHAPE3, meta: { ts: T_JUDGED } };
		const verdict = seedVerdict(
			[
				{ where: "## Slice 2", requires: "src/alpha.ts:18-25" },
				{ where: "## Slice 3", requires: "src/beta.ts:30-40" },
			],
			rel,
		);
		const liftOut = liftRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [judged], "slice-verdicts": [verdict] } } as unknown as RunView,
		});
		expect(liftOut.data.lifted).toHaveLength(2);
		const checkData = structureRun()({
			cwd: tmpDir,
			input: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-verdicts": [verdict],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		}).data;
		expect(checkData.pass).toBe(true);
		expect(checkData.citeDischarged).toBe("round1.md");
		// The gate folds green on the stamp: the slice-check edge routes straight
		// to design — the fix arm and the grade panel are both skipped.
		const edge = findWorkflow("build").edges["slice-check"];
		if (typeof edge !== "function") throw new Error("build slice-check edge is not a function");
		const next = (edge as EdgeFn)({
			output: undefined,
			state: {
				named: {
					slices: [judged],
					"slice-check": [{ artifacts: [], kind: "json", meta: {}, data: checkData } as unknown as Output],
					"slice-verdicts": [verdict],
					"slice-seed-lift": [liftEntry(T_FIXED)],
				},
			} as unknown as RunView,
		});
		expect(next).toBe("slice-design");
	});

	// Fence-aware citation floor — a `path:line` shape inside a fenced code block is
	// example/fixture text, not a citation to verify. The skip is span-scoped: a real
	// dangling citation in prose still fails.
	it("skips a fenced path:line-shaped placeholder (citation floor is fence-aware)", () => {
		const rel = ".rpiv/artifacts/slices/fence-placeholder.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\nExample:\n\n\`\`\`ts\nconst x = load("src/does-not-exist.ts:42");\n\`\`\`\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("skips prose citations under the placeholder namespaces (path/to/, packages/x/)", () => {
		const rel = ".rpiv/artifacts/slices/placeholder-namespace.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\nAn evidence string is shaped like \`packages/x/y.ts:42 — helper returns early\`; templates use path/to/file.ext:12-30.\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("still flags a real unresolved path:line citation in slice-map prose (skip is span-scoped)", () => {
		const rel = ".rpiv/artifacts/slices/fence-prose.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\nSee src/does-not-exist.ts:42 for the footing.\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
		expect(String(data.feedback)).toMatch(/does-not-exist\.ts:42/);
	});

	it("skips a ~~~ tilde fence and a length-matched (four-backtick) fence identically to ```", () => {
		const rel = ".rpiv/artifacts/slices/fence-kinds.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n~~~ts\nconst a = load("src/tilde-fenced.ts:7");\n~~~\n\n\`\`\`\`ts\nconst b = load("src/four-back-fenced.ts:9");\n\`\`\`\`\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	// Cross-character regression (Q6): a bare ~~~ line must NOT close a ``` fence —
	// the post-~~~ path:line placeholder stays fenced and is not verified. Under the
	// old length-only close the ~~~ (len 3, trim 3) would close the ``` fence and
	// expose the placeholder in prose as a dangling citation.
	it("does not close a backtick fence with a mismatched-character (~~~) line (slice map)", () => {
		const rel = ".rpiv/artifacts/slices/fence-cross-char.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n\`\`\`ts\n~~~\nconst x = load("src/cross-char-fenced.ts:42");\n\`\`\`\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("skips a placeholder in an unterminated fence's remainder in a slice map", () => {
		const rel = ".rpiv/artifacts/slices/fence-unterminated.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\nExample:\n\n\`\`\`ts\nconst x = load("src/unterminated-fenced.ts:5");\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("still verifies a prose citation after a closed fenced block in a slice map (no closed-span leak)", () => {
		const rel = ".rpiv/artifacts/slices/fence-leak.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n\`\`\`ts\nconst x = load("src/fenced-placeholder.ts:11");\n\`\`\`\n\nSee src/after-fence.ts:30 for the footing.\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/after-fence\.ts:30/);
		expect(String(data.feedback)).not.toMatch(/fenced-placeholder/);
	});

	// Dependency citations — research/design artifacts legitimately cite installed
	// dependency source (lockfile-pinned, so line numbers are stable). The citation
	// regex cannot carry `@`, so a cited `node_modules/@scope/pkg/f.js` parses as
	// `scope/pkg/f.js`; the checker probes `node_modules/<path>` and
	// `node_modules/@<path>` before the suffix fallback.
	it("resolves a scoped-dependency citation cited without the @/node_modules prefix", () => {
		mkdirSync(join(tmpDir, "node_modules/@some-scope/pkg/dist"), { recursive: true });
		writeFileSync(
			join(tmpDir, "node_modules/@some-scope/pkg/dist/mod.js"),
			Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-dep-scoped.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** some-scope/pkg/dist/mod.js:20\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("resolves a full node_modules/@scope citation (regex drops the node_modules/@ prefix)", () => {
		mkdirSync(join(tmpDir, "node_modules/@some-scope/pkg/dist"), { recursive: true });
		writeFileSync(
			join(tmpDir, "node_modules/@some-scope/pkg/dist/mod.js"),
			Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-dep-full.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** node_modules/@some-scope/pkg/dist/mod.js:20\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("resolves an unscoped-dependency citation cited without the node_modules prefix", () => {
		mkdirSync(join(tmpDir, "node_modules/plainpkg"), { recursive: true });
		writeFileSync(
			join(tmpDir, "node_modules/plainpkg/index.js"),
			Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-dep-plain.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** plainpkg/index.js:5\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("still flags a dependency citation past end-of-file after resolving it", () => {
		mkdirSync(join(tmpDir, "node_modules/@some-scope/pkg/dist"), { recursive: true });
		writeFileSync(join(tmpDir, "node_modules/@some-scope/pkg/dist/mod.js"), "a\nb\nc\n");
		const rel = ".rpiv/artifacts/slices/cite-dep-eof.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** some-scope/pkg/dist/mod.js:900\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/matches no version of the file/);
	});

	// P1 — a bare basename (a path-prefix omission the producers routinely emit,
	// e.g. `workflows/build.ts:699` for a file nested many dirs deep) resolves
	// to the ONE tree file with that name, rather than failing the floor on a
	// mechanical omission and forcing an every-run fix loop.
	it("resolves a bare-basename citation to the unique tree file (path-prefix omission)", () => {
		mkdirSync(join(tmpDir, "packages/deep/nested"), { recursive: true });
		writeFileSync(
			join(tmpDir, "packages/deep/nested/uniquename.ts"),
			Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-bare.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** uniquename.ts:20\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("still flags a bare-basename citation past end-of-file after resolving it", () => {
		mkdirSync(join(tmpDir, "pkg"), { recursive: true });
		writeFileSync(join(tmpDir, "pkg/solename.ts"), "a\nb\nc\n"); // 4 lines
		const rel = ".rpiv/artifacts/slices/cite-bare-eof.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** solename.ts:900\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/matches no version of the file/);
	});

	it("leaves a bare-basename citation unbacked when the basename is ambiguous", () => {
		mkdirSync(join(tmpDir, "a"), { recursive: true });
		mkdirSync(join(tmpDir, "b"), { recursive: true });
		writeFileSync(join(tmpDir, "a/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "b/dup.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/cite-ambig.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** dup.ts:5\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
	});

	// The suffix generalization of the bare-basename fallback — producers also cite
	// PACKAGE-relative paths (`validate/stage-rules.ts:70` for a file under
	// `packages/rpiv-workflow/`), which are path-prefix omissions of real files, not
	// fabrications. A unique whole-segment suffix backs the citation; ambiguity or a
	// mid-segment match stays unbacked.
	it("resolves a package-relative suffix citation to the unique tree file", () => {
		mkdirSync(join(tmpDir, "packages/rpiv-workflow/validate"), { recursive: true });
		writeFileSync(
			join(tmpDir, "packages/rpiv-workflow/validate/stage-rules.ts"),
			Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-suffix.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** validate/stage-rules.ts:70\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("matches a suffix citation only on whole path segments", () => {
		// `workflow/validate/rules.ts` must NOT match `packages/rpiv-workflow/validate/rules.ts`
		// (the boundary char is `-`, not `/`) — a mid-segment match would back a wrong file.
		mkdirSync(join(tmpDir, "packages/rpiv-workflow/validate"), { recursive: true });
		writeFileSync(
			join(tmpDir, "packages/rpiv-workflow/validate/rules.ts"),
			Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-boundary.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** workflow/validate/rules.ts:5\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
	});

	it("leaves an ambiguous suffix citation unbacked and names the candidates", () => {
		mkdirSync(join(tmpDir, "packages/one/src"), { recursive: true });
		mkdirSync(join(tmpDir, "packages/two/src"), { recursive: true });
		writeFileSync(join(tmpDir, "packages/one/src/util.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		writeFileSync(join(tmpDir, "packages/two/src/util.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/cite-suffix-ambig.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** src/util.ts:5\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
		expect(String(data.feedback)).toMatch(/matches 2 tree files/);
		expect(String(data.feedback)).toMatch(/packages\/one\/src\/util\.ts/);
		expect(String(data.feedback)).toMatch(/packages\/two\/src\/util\.ts/);
	});

	it("still flags a suffix-resolved citation past end-of-file", () => {
		mkdirSync(join(tmpDir, "packages/rpiv-workflow/loops"), { recursive: true });
		writeFileSync(join(tmpDir, "packages/rpiv-workflow/loops/tiny.ts"), "a\nb\nc\n"); // 4 lines
		const rel = ".rpiv/artifacts/slices/cite-suffix-eof.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** loops/tiny.ts:900\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/matches no version of the file/);
	});

	// Dot-prefixed paths — before the regex allowed a leading dot, `.github/…` and
	// `.eslintrc.js` citations were captured with the dot stripped and guaranteed to
	// fail the floor as a mangled path (a false positive on a real file).
	it("resolves a dot-directory citation (.github/...) directly", () => {
		mkdirSync(join(tmpDir, ".github/workflows"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".github/workflows/ci.yml"),
			Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n"),
		);
		const rel = ".rpiv/artifacts/slices/cite-dotdir.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** .github/workflows/ci.yml:12\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("resolves a bare dotfile citation via the unique-basename fallback", () => {
		mkdirSync(join(tmpDir, "pkg"), { recursive: true });
		writeFileSync(join(tmpDir, "pkg/.eslintrc.js"), "a\nb\nc\n"); // 4 lines
		const rel = ".rpiv/artifacts/slices/cite-dotfile.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** .eslintrc.js:2\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("does not let a prose ellipsis mangle the following citation", () => {
		// `...packages/x.ts:5` must capture `packages/x.ts`, not `...packages/x.ts` —
		// the dot-start allowance is guarded so ellipses never join the path.
		mkdirSync(join(tmpDir, "packages"), { recursive: true });
		writeFileSync(join(tmpDir, "packages/x.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/cite-ellipsis.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\nSee the earlier discussion ...packages/x.ts:5 for details.\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(true);
	});

	it("never anchors a suffix above the repo root (checkout dir name can't back a citation)", () => {
		// Repo root holds utils.ts; the citation prefixes it with the CHECKOUT
		// DIRECTORY's own basename. Compared against the absolute path this would
		// falsely resolve (`/…/<tmpdir-name>/utils.ts` ends with the cited suffix);
		// the repo-relative comparison must leave it unbacked — otherwise the gate
		// verdict depends on where the repo happens to be cloned.
		writeFileSync(join(tmpDir, "utils.ts"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
		const rel = ".rpiv/artifacts/slices/cite-above-root.md";
		const m = write(
			rel,
			`---\nstatus: ready\nslice_count: 1\nslices:\n  - { n: 1, title: A, deps: [] }\n---\n## Slice 1: A\n**Draws on:** ${basename(tmpDir)}/utils.ts:5\n`,
		);
		const data = runOn(m);
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/Unbacked citation/);
	});

	// Finding 3 — the deterministic findings must REACH slice-fix. slice-check now
	// emits an fs artifact carrying the findings JSON; slice-fix's `reads` fanin over
	// that channel projects it as `--slice-check <path>` (arg-projection forwards
	// artifact handles — chain-state.test.ts), so the fix stage sees the findings that
	// triggered it. Before the fix, slice-check had `artifacts: []` and the fanin
	// projected nothing.
	it("slice-check emits an fs artifact carrying the findings (so slice-fix can consume them)", () => {
		const rel = ".rpiv/artifacts/slices/withfindings.md";
		const m = write(
			rel,
			map({
				count: 2,
				coverage: COV,
				sliceLines:
					"  - { n: 1, title: A, deps: [2], covers: [c1] }\n  - { n: 2, title: B, deps: [1], covers: [c2] }\n",
			}),
		);
		const stage = findWorkflow("build").stages["slice-check"];
		if (!stage?.run) throw new Error("build slice-check stage has no run function");
		const runFn = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			artifacts: readonly { handle: { kind: string; path: string } }[];
			data: Record<string, unknown>;
		};
		const out = runFn({ cwd: tmpDir, input: undefined, state: { named: { slices: [m] } } as unknown as RunView });
		const handle = out.artifacts[0]?.handle;
		expect(handle?.kind).toBe("fs");
		const written = JSON.parse(readFileSync(join(tmpDir, handle?.path ?? ""), "utf-8"));
		expect(written.pass).toBe(false);
		expect(Array.isArray(written.findings)).toBe(true);
		expect(written.findings.length).toBeGreaterThan(0);
	});

	it("slice-fix reads the slice-check channel as a fanin (the findings projection)", () => {
		const sliceFix = findWorkflow("build").stages["slice-fix"];
		expect(sliceFix?.reads).toContainEqual(fanin("slice-check"));
	});

	it("slice-seed-lift reads slices + the slice-verdicts fanin and re-enters slice-check via a plain edge", () => {
		const lift = findWorkflow("build").stages["slice-seed-lift"];
		expect(lift?.reads).toEqual(["slices", fanin("slice-verdicts")]);
		expect(findWorkflow("build").edges["slice-seed-lift"]).toBe("slice-check");
	});
});

// ---------------------------------------------------------------------------
// Design-readiness corpus replay — the committed census of design-readiness
// fail shapes, extracted once from the gitignored run trails (see the
// fixture's _meta for the population/derivation rules). Pins the census
// counts and the fail-closed direction of the seed-only classification.
// ---------------------------------------------------------------------------
describe("build subplan-check (deterministic cluster-coverage floor)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-subplan-check-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const subplanCheckRun = () => {
		const stage = findWorkflow("build").stages["subplan-check"];
		if (!stage?.run) throw new Error("build subplan-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			artifacts: readonly { handle: { kind: string; path: string } }[];
			data: Record<string, unknown>;
			kind: string;
		};
	};
	// Write a file under tmpDir and return the Output envelope that references it.
	// The stage resolves the handle path against cwd (tmpDir) and reads the body.
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} };
	};
	// Two independent slices ⇒ two single-slice clusters (expectedK = 2). Written
	// to disk so the stage can parse its slices: frontmatter.
	const sliceMap = ".rpiv/artifacts/slices/m.md";
	const twoClusters = () =>
		write(
			sliceMap,
			`---\nstatus: ready\nslice_count: 2\nslices:\n  - { n: 1, title: A, deps: [] }\n  - { n: 2, title: B, deps: [] }\n---\n## Slice 1: A\n## Slice 2: B\n`,
		);
	// The slice-map Output envelope — the file is already on disk (twoClusters).
	const mapOut = () => ({ artifacts: [{ handle: fsHandle(sliceMap) }], data: undefined, kind: "", meta: {} });
	// Design artifacts for the given slices on the `designs` channel — the fanout's
	// dispatch precondition the coverage check preflights (a slice with no design
	// is unrepairable by re-dispatching `subplan`, so the floor halts loud).
	const designsOut = (slices: number[] = [1, 2]) => ({
		artifacts: slices.map((n) => ({ handle: fsHandle(`.rpiv/artifacts/designs/d_slice-${n}.md`) })),
		data: undefined,
		kind: "",
		meta: {},
	});
	// A sub-plan body: `cluster` is the _cluster-<k> ordinal carried in the BASENAME
	// by the caller's `rel`, and `sources` is the slice numbers whose designs it lists.
	const subplanBody = (cluster: number, sources: number[]) =>
		`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: C${cluster} }${
			sources.length > 0
				? `\nsources: [${sources.map((n) => `.rpiv/artifacts/designs/d_slice-${n}.md`).join(", ")}]`
				: "\nsources: []"
		}\n---\n# Sub-plan\n## Phase 1: C${cluster}\n`;
	const findingDetails = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.detail).join(" ");
	const findingWheres = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.where);

	it("passes when K expected clusters yield K distinct _cluster-<k> sub-plans + full sources coverage", () => {
		twoClusters();
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/t_cluster-2.md", subplanBody(2, [2]));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.dimension).toBe("structure");
		expect(data.pass).toBe(true);
		expect(data.severity).toBe("none");
		expect(data.findings).toEqual([]);
	});

	it("fails (pass:false, severity:high) on a duplicate/clobbered _cluster-<k>", () => {
		twoClusters();
		// Both dispatched sub-plans claim cluster-1 → a clobber collision; the
		// sources still cover both slices, so only the duplicate (+ the missing
		// cluster it implies) fires.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/u_cluster-1.md", subplanBody(1, [2]));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findingWheres(data)).toContain("cluster-1");
		expect(findingDetails(data)).toMatch(/Duplicate\/clobbered cluster-1/);
	});

	it("fails (pass:false, severity:high) on a missing cluster (expected 2, dispatched 1)", () => {
		twoClusters();
		// One cluster dispatched, but its sources cover BOTH slices — isolating the
		// count check from the sources-coverage check.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1, 2]));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findingDetails(data)).toMatch(/Missing cluster coverage/);
		expect(findingWheres(data)).toContain("clusters (expected 2, dispatched 1)");
	});

	it("fails (pass:false, severity:high) on a tokenless sub-plan basename", () => {
		twoClusters();
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		// Tokenless: no _cluster-<k> token in the basename.
		const b = write(".rpiv/artifacts/subplans/tokenless.md", subplanBody(2, [2]));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findingDetails(data)).toMatch(/Tokenless sub-plan basename tokenless\.md/);
		expect(findingWheres(data)).toContain("tokenless.md");
	});

	it("fails (pass:false, severity:high) when a slice's design is absent from every sources:", () => {
		twoClusters();
		// cluster-1 lists slice 1; cluster-2 lists NO sources — so slice 2's design
		// is absent from every sub-plan's sources:. Counts still match (2 clusters,
		// 2 distinct tokens), isolating the sources-coverage check.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/t_cluster-2.md", subplanBody(2, []));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findingDetails(data)).toMatch(/Slice 2 design absent from every sub-plan's 'sources:'/);
		expect(findingWheres(data)).toContain("sources: slice 2");
	});

	it("degrades unparseable sub-plan frontmatter to a re-dispatchable finding (never a script throw) and defers slice coverage", () => {
		twoClusters();
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		// A bare ': ' inside an unquoted scalar — the stray-colon class
		// artifact-collector degrades on. parseFrontmatter throws on it; the floor
		// must catch, not escape as FAIL_SCRIPT_THREW.
		const b = write(
			".rpiv/artifacts/subplans/t_cluster-2.md",
			"---\ntarget: foo (lane UI: L0-L2)\nsources: [.rpiv/artifacts/designs/d_slice-2.md]\n---\n# Sub-plan\n",
		);
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(false);
		expect(data.severity).toBe("high");
		expect(findingDetails(data)).toMatch(/Unparseable frontmatter in sub-plan t_cluster-2\.md/);
		expect(findingWheres(data)).toContain("t_cluster-2.md");
		// Coverage is unknowable while a sub-plan is unreadable — the parse failure
		// must not be mis-blamed on the slices it happened to cover.
		expect(findingDetails(data)).not.toMatch(/design absent from every sub-plan's 'sources:'/);
	});

	it("halts loud (haltPreflight) when a slice has no design on the designs channel, naming the upstream cause", () => {
		twoClusters();
		// Both clusters dispatched with full sources coverage — the ONLY defect is
		// the missing slice-2 design, which no subplan re-dispatch can produce.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/t_cluster-2.md", subplanBody(2, [2]));
		expect(() =>
			subplanCheckRun()({
				cwd: tmpDir,
				input: undefined,
				state: {
					named: { slices: [mapOut()], designs: [designsOut([1])], subplans: [a, b] },
				} as unknown as RunView,
			}),
		).toThrow(/slice\(s\) 2 .* no design/);
	});

	it("binds the trailing _cluster-<k> token (tail-anchored) and accepts extensionless basenames", () => {
		twoClusters();
		// Extensionless write (the implement-scope floor precedent) still binds k=1;
		// a name carrying two tokens binds the TRAILING one (k=2), not first-match.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/t_cluster-1_cluster-2.md", subplanBody(2, [2]));
		const data = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		}).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("writes the verdict basename-keyed to VERDICT_DIR as kind:json dimension:structure", () => {
		twoClusters();
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const b = write(".rpiv/artifacts/subplans/t_cluster-2.md", subplanBody(2, [2]));
		const res = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a, b] } } as unknown as RunView,
		});
		expect(res.kind).toBe("json");
		// Basename-keyed off the slice map ⇒ subplan-check__m.json
		expect(res.artifacts[0]?.handle).toEqual({ kind: "fs", path: ".rpiv/artifacts/verdicts/subplan-check__m.json" });
		const written = JSON.parse(readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/subplan-check__m.json"), "utf-8"));
		expect(written.dimension).toBe("structure");
		expect(written.severity).toBe("none");
		expect(written.pass).toBe(true);
	});

	it("haltPreflight throws (not a silent empty verdict) when no fs artifact is on the slices channel", () => {
		expect(() =>
			subplanCheckRun()({
				cwd: tmpDir,
				input: undefined,
				state: { named: { slices: [], subplans: [] } } as unknown as RunView,
			}),
		).toThrow(/no fs artifact on the 'slices' channel/);
	});

	it("a fail verdict makes allDimensionsPass(state.named['subplan-check']) return false (gate contract)", () => {
		twoClusters();
		// One cluster dispatched where two were expected ⇒ a fail verdict on the channel.
		const a = write(".rpiv/artifacts/subplans/t_cluster-1.md", subplanBody(1, [1]));
		const verdict = subplanCheckRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { slices: [mapOut()], designs: [designsOut()], subplans: [a] } } as unknown as RunView,
		});
		expect(verdict.data.pass).toBe(false);
		expect(verdict.data.severity).toBe("high");
		// The gate predicate `subplanGatePasses` is module-private, so assert its
		// contract by reproducing `allDimensionsPass` over the channel the route
		// reads. severity 'high' is NOT floored away ⇒ the fold returns false ⇒ the
		// backward edge routes to `subplan`.
		const fold = (entries: readonly { data: Record<string, unknown> }[]): boolean => {
			const latest = new Map<string, boolean>();
			for (const o of entries) {
				const v = o.data;
				if (typeof v?.dimension !== "string") continue;
				const lowOrNone = v.severity === "low" || v.severity === "none";
				latest.set(v.dimension, v.pass === true || lowOrNone);
			}
			const vs = [...latest.values()];
			return vs.length > 0 && vs.every(Boolean);
		};
		expect(fold([verdict])).toBe(false);
	});

	// Stage / edge / route shape — the structural contract the splice relies on.
	it("subplan-check is produces.script with reads [fanin(subplans), slices]", () => {
		const stage = findWorkflow("build").stages["subplan-check"];
		expect(stage?.kind).toBe("produces");
		expect(stage?.run).toBeTruthy();
		expect(stage?.reads).toEqual([fanin("subplans"), "slices"]);
	});

	it("build edge routes subplan → subplan-check (not straight to plan)", () => {
		expect(findWorkflow("build").edges.subplan).toBe("subplan-check");
	});

	it("subplan-check route targets [plan, subplan]", () => {
		const edge = findWorkflow("build").edges["subplan-check"];
		if (typeof edge !== "function") throw new Error("subplan-check edge is not an EdgeFn");
		expect([...(edge.targets ?? [])].sort()).toEqual(["plan", "subplan"]);
	});
});

// ---------------------------------------------------------------------------
// ship — the lightweight /wf preset: ten linear stages, stop-on-fail at every
// gate, no fix/confirm/snapshot/demote arms.
// ---------------------------------------------------------------------------

describe("implement-scope-check declared union (vet review-fix loop)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-vet-scope-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const scopeRun = () => {
		const stage = findWorkflow("vet").stages["implement-scope-check"];
		if (!stage?.run) throw new Error("vet implement-scope-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	// Write a plan whose phase declares `files:` and return the channel entry.
	const writePlan = (rel: string, files: string[]) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(
			join(tmpDir, rel),
			`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: Fix, files: [${files
				.map((f) => JSON.stringify(f))
				.join(", ")}] }\n---\n# Plan\n## Phase 1: Fix\n`,
		);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} } as unknown as Output;
	};
	const runOn = (plans: ReturnType<typeof writePlan>[], goal?: unknown) =>
		scopeRun()({
			cwd: tmpDir,
			input: undefined,
			state: { named: { plans, ...(goal ? { goal } : {}) } } as unknown as RunView,
		}).data;
	const exec = (cmd: string, args: string[]) =>
		execFileSync(cmd, args, { cwd: tmpDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	const gitInit = () => {
		exec("git", ["init", "-q"]);
		exec("git", ["config", "user.email", "t@t.test"]);
		exec("git", ["config", "user.name", "test"]);
	};
	const where = (data: { findings?: { where?: string }[] }) => (data.findings ?? []).map((f) => f.where).sort();

	it("unions files: across plan iterations — a prior iteration's declared path is not excess", () => {
		gitInit();
		const plan1 = writePlan(".rpiv/artifacts/plans/plan-1.md", ["packages/a/x.ts", "packages/b/y.ts"]);
		const plan2 = writePlan(".rpiv/artifacts/plans/plan-2.md", ["packages/b/y.ts"]);
		// Seed + commit the source tree (so dirty paths report per-file, not as a
		// collapsed untracked dir), then modify the lanes-in-flight files.
		mkdirSync(join(tmpDir, "packages/a"), { recursive: true });
		mkdirSync(join(tmpDir, "packages/b"), { recursive: true });
		mkdirSync(join(tmpDir, "packages/c"), { recursive: true });
		writeFileSync(join(tmpDir, "packages/a/x.ts"), "v0");
		writeFileSync(join(tmpDir, "packages/b/y.ts"), "v0");
		writeFileSync(join(tmpDir, "packages/c/stray.ts"), "v0");
		exec("git", ["add", "-A"]);
		exec("git", ["commit", "-q", "-m", "baseline"]);
		// plan1's file (x) + a stray (declared by neither plan) are now dirty.
		writeFileSync(join(tmpDir, "packages/a/x.ts"), "v1");
		writeFileSync(join(tmpDir, "packages/c/stray.ts"), "v1");

		const data = runOn([plan1, plan2]);
		expect(data.dimension).toBe("scope");
		expect(data.pass).toBe(false);
		// x.ts is covered by the union (plan1) → not excess; stray.ts is declared
		// by neither iteration → the one excess finding.
		expect(where(data)).toEqual(["packages/c/stray.ts"]);
		// The verdict basename is keyed on the LATEST plan's basename (idempotent).
		expect(String(data.artifact)).toBe(".rpiv/artifacts/plans/plan-2.md");
		expect(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/implement-scope-check__plan-2.json"), "utf-8"),
		).toContain("packages/c/stray.ts");
	});

	it("passes when every dirty path is in the union (latest plan alone would false-fail)", () => {
		gitInit();
		const plan1 = writePlan(".rpiv/artifacts/plans/plan-1.md", ["packages/a/x.ts"]);
		const plan2 = writePlan(".rpiv/artifacts/plans/plan-2.md", ["packages/b/y.ts"]);
		mkdirSync(join(tmpDir, "packages/a"), { recursive: true });
		mkdirSync(join(tmpDir, "packages/b"), { recursive: true });
		writeFileSync(join(tmpDir, "packages/a/x.ts"), "v0");
		writeFileSync(join(tmpDir, "packages/b/y.ts"), "v0");
		exec("git", ["add", "-A"]);
		exec("git", ["commit", "-q", "-m", "baseline"]);
		writeFileSync(join(tmpDir, "packages/a/x.ts"), "v1"); // declared by plan1 only
		writeFileSync(join(tmpDir, "packages/b/y.ts"), "v1"); // declared by plan2

		const data = runOn([plan1, plan2]);
		expect(data.pass).toBe(true);
		expect(where(data)).toEqual([]);
	});

	it("degrades to pass in a non-repo cwd (git-missing ⇒ empty dirty, never throws)", () => {
		const plan = writePlan(".rpiv/artifacts/plans/plan.md", ["packages/a/x.ts"]);
		const data = runOn([plan]); // tmpDir is NOT a git repo here
		expect(data.pass).toBe(true);
		expect(where(data)).toEqual([]);
	});
});
