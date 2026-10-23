/**
 * plan-phases.test.ts — phase-plan frontmatter mechanics on the built-in
 * graph (FRONTMATTER_PHASE_FANOUT, IMPLEMENT_DAG_FANOUT, polish
 * REVIEW_PHASE_ITERATE), moved verbatim from built-in-workflows.test.ts.
 * Graph-attached: stages are reached through findWorkflow(...).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Output, RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.ts";

describe("FRONTMATTER_PHASE_FANOUT", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-frontmatter-fanout-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const fanout = () => {
		const loop = findWorkflow("build").stages.implement?.loop;
		if (loop?.kind !== "fanout") throw new Error("build implement stage has no fanout loop");
		return loop.units;
	};
	const writePlan = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
	};
	const runFanout = (rel: string) =>
		fanout()({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: { plans: [{ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }] },
			} as unknown as RunView,
		});

	it("reads phases from frontmatter and dispatches one title-enriched unit per phase", async () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		writePlan(
			rel,
			`---\nstatus: ready\nphase_count: 2\nphases:\n  - { n: 1, title: Schema layer }\n  - { n: 2, title: Runtime wiring }\n---\n# Plan\n## Phase 1: Schema layer\n## Phase 2: Runtime wiring\n`,
		);
		const units = await runFanout(rel);
		expect(units.map((u) => u.prompt)).toEqual([`${rel} Phase 1: Schema layer`, `${rel} Phase 2: Runtime wiring`]);
		expect(units.map((u) => u.label)).toEqual(["phase 1/2", "phase 2/2"]);
	});

	it("throws when the frontmatter phases disagree with the body headings (stale derive)", () => {
		const rel = ".rpiv/artifacts/plans/mismatch.md";
		writePlan(rel, `---\nphases:\n  - { n: 1, title: Only one }\n---\n## Phase 1: a\n## Phase 2: b\n## Phase 3: c\n`);
		expect(() => runFanout(rel)).toThrow(/frontmatter phases \(1\) ≠ '## Phase N:' headings \(3\)/);
	});

	it("returns no units for a plan with neither structured phases nor body headings", async () => {
		const rel = ".rpiv/artifacts/plans/empty.md";
		writePlan(rel, `---\nstatus: ready\n---\n# Plan with no phases\n`);
		expect(await runFanout(rel)).toEqual([]);
	});

	it('returns [] when no plan is published to the named "plans" channel', async () => {
		const units = await fanout()({
			cwd: tmpDir,
			artifact: undefined,
			state: { named: {} } as unknown as RunView,
		});
		expect(units).toEqual([]);
	});

	it("throws when phase_count disagrees with the derived phases length", () => {
		const rel = ".rpiv/artifacts/plans/pc-mismatch.md";
		writePlan(
			rel,
			`---\nstatus: ready\nphase_count: 3\nphases:\n  - { n: 1, title: A }\n  - { n: 2, title: B }\n---\n## Phase 1: A\n## Phase 2: B\n`,
		);
		expect(() => runFanout(rel)).toThrow(/phase_count \(3\) ≠ phases length \(2\)/);
	});

	it("throws when a phased plan omits the required phase_count", () => {
		const rel = ".rpiv/artifacts/plans/pc-absent.md";
		writePlan(rel, `---\nstatus: ready\nphases:\n  - { n: 1, title: A }\n---\n## Phase 1: A\n`);
		expect(() => runFanout(rel)).toThrow(/phase_count \(undefined\) ≠ phases length \(1\)/);
	});
});

describe("IMPLEMENT_DAG_FANOUT (build implement — dep-gated phase units)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-implement-dag-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const dagLoop = () => {
		const loop = findWorkflow("build").stages.implement?.loop;
		if (loop?.kind !== "fanout") throw new Error("build implement stage has no fanout loop");
		return loop;
	};
	const writePlan = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
	};
	const runFanout = (rel: string) =>
		dagLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: { plans: [{ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }] },
			} as unknown as RunView,
		});

	it("is a spread of FRONTMATTER_PHASE_FANOUT with a distinct deps-emitting closure (unpinned)", () => {
		// IMPLEMENT_DAG_FANOUT spreads FRONTMATTER_PHASE_FANOUT, so it shares the
		// base's introspectable shape (kind/source/unit/max) — asserted against the
		// literal FRONTMATTER values now that no built-in ships the bare const's
		// units on an implement stage. Its own units closure emits id/deps.
		expect(dagLoop()).toMatchObject({
			kind: "fanout",
			source: "plans",
			unit: { by: "frontmatter-array", pattern: "phases" },
			max: 32,
		});
		// No depArtifactFlag (implement phases feed each other through the working
		// tree, not published artifacts), and no `concurrency` ⇒ inherits host cap.
		expect(dagLoop().depArtifactFlag).toBeUndefined();
		expect(dagLoop().concurrency).toBeUndefined();
	});

	it("emits phase-N ids + directed deps (clause A file-overlap + union of depends_on)", async () => {
		const rel = ".rpiv/artifacts/plans/audited.md";
		writePlan(
			rel,
			[
				"---",
				"status: ready",
				"phase_count: 11",
				"phases:",
				"  - { n: 1, title: P1, files: [packages/a/one.ts] }",
				"  - { n: 2, title: P2, files: [packages/a/X.ts] }",
				"  - { n: 3, title: P3, files: [packages/a/X.ts, packages/a/Y.ts] }",
				"  - { n: 4, title: P4, files: [packages/a/Y.ts] }",
				"  - { n: 5, title: P5, files: [packages/c/five.ts] }",
				"  - { n: 6, title: P6, files: [packages/c/six.ts] }",
				"  - { n: 7, title: P7, files: [packages/c/seven.ts] }",
				"  - { n: 8, title: P8, files: [packages/c/eight.ts] }",
				"  - { n: 9, title: P9, files: [packages/b/Z.ts] }",
				"  - { n: 10, title: P10, files: [packages/b/Z.ts] }",
				"  - { n: 11, title: P11, files: [packages/b/W.ts], depends_on: [9] }",
				"---",
				"# Plan",
				"## Phase 1: P1",
				"## Phase 2: P2",
				"## Phase 3: P3",
				"## Phase 4: P4",
				"## Phase 5: P5",
				"## Phase 6: P6",
				"## Phase 7: P7",
				"## Phase 8: P8",
				"## Phase 9: P9",
				"## Phase 10: P10",
				"## Phase 11: P11",
				"",
			].join("\n"),
		);
		const units = await runFanout(rel);
		const depsByPhase = new Map(units.map((u) => [u.id, u.deps ?? []]));
		expect(units.map((u) => u.id)).toEqual([
			"phase-1",
			"phase-2",
			"phase-3",
			"phase-4",
			"phase-5",
			"phase-6",
			"phase-7",
			"phase-8",
			"phase-9",
			"phase-10",
			"phase-11",
		]);
		// File-overlap edges: 3∩2 (X), 4∩3 (Y), 10∩9 (Z).
		expect(depsByPhase.get("phase-1")).toEqual([]);
		expect(depsByPhase.get("phase-2")).toEqual([]); // no overlap with phase 1
		expect(depsByPhase.get("phase-3")).toEqual(["phase-2"]); // overlaps phase 2 on X
		expect(depsByPhase.get("phase-4")).toEqual(["phase-3"]); // overlaps phase 3 on Y (not phase 2)
		expect(depsByPhase.get("phase-5")).toEqual([]); // unique path — root
		expect(depsByPhase.get("phase-6")).toEqual([]);
		expect(depsByPhase.get("phase-7")).toEqual([]);
		expect(depsByPhase.get("phase-8")).toEqual([]);
		expect(depsByPhase.get("phase-9")).toEqual([]); // unique path — root
		expect(depsByPhase.get("phase-10")).toEqual(["phase-9"]); // overlaps phase 9 on Z
		expect(depsByPhase.get("phase-11")).toEqual(["phase-9"]); // depends_on [9], no file overlap
		// prompt/label unchanged from the base fanout.
		expect(units[0]?.prompt).toBe(`${rel} Phase 1: P1`);
		expect(units[0]?.label).toBe("phase 1/11");
	});

	it("serializes a phase declaring x.ts against one declaring x.test.ts (twin conflict edge)", async () => {
		// The production phase's implicit twin write (a signature change drags its
		// co-located test's assertions along) would race a concurrent sibling that
		// owns the test explicitly — under the twin-blind fold these two counted as
		// disjoint and ran concurrently.
		const rel = ".rpiv/artifacts/plans/twin.md";
		writePlan(
			rel,
			[
				"---",
				"status: ready",
				"phase_count: 2",
				"phases:",
				"  - { n: 1, title: P1, files: [packages/a/mod.ts] }",
				"  - { n: 2, title: P2, files: [packages/a/mod.test.ts] }",
				"---",
				"# Plan",
				"## Phase 1: P1",
				"## Phase 2: P2",
				"",
			].join("\n"),
		);
		const units = await runFanout(rel);
		const depsByPhase = new Map(units.map((u) => [u.id, u.deps ?? []]));
		expect(depsByPhase.get("phase-2")).toEqual(["phase-1"]);
	});

	it("degrades to the full chain when every phase omits files (clause B — serial at any cap)", async () => {
		const rel = ".rpiv/artifacts/plans/no-files.md";
		writePlan(
			rel,
			[
				"---",
				"status: ready",
				"phase_count: 3",
				"phases:",
				"  - { n: 1, title: A }",
				"  - { n: 2, title: B }",
				"  - { n: 3, title: C }",
				"---",
				"# Plan",
				"## Phase 1: A",
				"## Phase 2: B",
				"## Phase 3: C",
				"",
			].join("\n"),
		);
		const units = await runFanout(rel);
		const depsByPhase = new Map(units.map((u) => [u.id, u.deps ?? []]));
		expect(depsByPhase.get("phase-1")).toEqual([]);
		expect(depsByPhase.get("phase-2")).toEqual(["phase-1"]);
		expect(depsByPhase.get("phase-3")).toEqual(["phase-1", "phase-2"]);
	});

	it("dedups a file-overlap edge and an explicit depends_on to the same phase (union)", async () => {
		const rel = ".rpiv/artifacts/plans/dup.md";
		writePlan(
			rel,
			[
				"---",
				"status: ready",
				"phase_count: 2",
				"phases:",
				"  - { n: 1, title: Root, files: [packages/d/shared.ts] }",
				"  - { n: 2, title: Dup, files: [packages/d/shared.ts], depends_on: [1] }",
				"---",
				"# Plan",
				"## Phase 1: Root",
				"## Phase 2: Dup",
				"",
			].join("\n"),
		);
		const units = await runFanout(rel);
		// phase-2 overlaps phase-1 on shared.ts AND lists 1 in depends_on → single edge.
		expect(units[1]?.deps).toEqual(["phase-1"]);
	});

	it("build implement emits phase-N ids + deps (the dep-gated DAG units)", async () => {
		const rel = ".rpiv/artifacts/plans/distinct.md";
		writePlan(
			rel,
			[
				"---",
				"status: ready",
				"phase_count: 2",
				"phases:",
				"  - { n: 1, title: A }",
				"  - { n: 2, title: B }",
				"---",
				"# Plan",
				"## Phase 1: A",
				"## Phase 2: B",
				"",
			].join("\n"),
		);
		const buildUnits = await runFanout(rel);
		expect(buildUnits.every((u) => u.id !== undefined && Array.isArray(u.deps))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// When writeHeader silently fails, the first stage row written by appendStage
// lands at line 0 and is dropped by every reader.
// ---------------------------------------------------------------------------

describe("polish — REVIEW_PHASE_ITERATE (frontmatter-driven)", () => {
	const reviewWithPhases = (phaseCount: number) => {
		const phases = Array.from(
			{ length: phaseCount },
			(_, i) => `  - { n: ${i + 1}, title: Phase ${i + 1} name }`,
		).join("\n");
		const headings = Array.from(
			{ length: phaseCount },
			(_, i) => `### Phase ${i + 1} — Phase ${i + 1} name\nbody`,
		).join("\n");
		return `---\nstatus: ready\nphases:\n${phases}\n---\n# Arch Review\n\n${headings}\n`;
	};

	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-polish-iter-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const iterate = () => {
		const loop = findWorkflow("polish").stages.blueprint?.loop;
		if (loop?.kind !== "iterate") throw new Error("polish blueprint stage has no iterate loop");
		return loop.next;
	};
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
	};
	const stateFor = (rel: string) => {
		const artifact = { handle: fsHandle(rel) };
		return {
			artifact,
			state: {
				named: { "architecture-reviews": [{ artifacts: [artifact], data: undefined, kind: "", meta: {} }] },
			} as unknown as RunView,
		};
	};
	const out = () => ({ artifacts: [], data: undefined, kind: "", meta: {} }) as unknown as Output;

	it("reads phases from frontmatter and dispatches one title-enriched unit per phase", async () => {
		const rel = ".rpiv/artifacts/architecture-reviews/rev.md";
		write(rel, reviewWithPhases(2));
		const { artifact, state } = stateFor(rel);

		const unit1 = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 });
		expect(unit1?.prompt).toBe(`${rel} Implement Phase 1: Phase 1 name`);
		expect(unit1?.label).toBe("phase 1/2 — Phase 1 name");

		const unit2 = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [out()], index: 1 });
		expect(unit2?.prompt).toBe(`${rel} Implement Phase 2: Phase 2 name`);

		const unit3 = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [out(), out()], index: 2 });
		expect(unit3).toBeNull(); // every phase planned → terminate
	});

	it("reads only the depended-on prior plans; blast_radius/effort tag the label", async () => {
		const rel = ".rpiv/artifacts/architecture-reviews/rev.md";
		write(
			rel,
			`---\nstatus: ready\nphases:\n` +
				`  - { n: 1, title: Foundation, blast_radius: internal, effort: S }\n` +
				`  - { n: 2, title: Vocabulary, depends_on: [1], effort: M }\n` +
				`  - { n: 3, title: Behavioural, depends_on: [1], blast_radius: public-API, effort: L }\n` +
				`---\n# Arch Review\n\n### Phase 1 — Foundation\nbody\n### Phase 2 — Vocabulary\nbody\n### Phase 3 — Behavioural\nbody\n`,
		);
		const { artifact, state } = stateFor(rel);
		const planOut = (n: number) =>
			({
				artifacts: [{ handle: fsHandle(`.rpiv/artifacts/plans/plan-${n}.md`) }],
				data: undefined,
				kind: "",
				meta: {},
			}) as unknown as Output;

		const u1 = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 });
		expect(u1?.label).toBe("phase 1/3 — Foundation [S, internal]");

		// Phase 3 depends_on [1] only → reads plan-1, not the accumulated plan-2.
		const u3 = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [planOut(1), planOut(2)], index: 2 });
		expect(u3?.prompt).toBe(
			`${rel} Implement Phase 3: Behavioural\n` +
				`Prior phase plans (read first; build on them, don't duplicate): .rpiv/artifacts/plans/plan-1.md`,
		);
		expect(u3?.label).toBe("phase 3/3 — Behavioural [L, public-API]");
	});

	it("throws when the frontmatter phases disagree with the body headings (stale derive)", () => {
		const rel = ".rpiv/artifacts/architecture-reviews/mismatch.md";
		// 1 structured phase, 2 `### Phase N —` headings.
		write(
			rel,
			`---\nphases:\n  - { n: 1, title: Only one }\n---\n# Arch Review\n\n### Phase 1 — Only one\nbody\n### Phase 2 — Extra\nbody\n`,
		);
		const { artifact, state } = stateFor(rel);
		expect(() => iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 })).toThrow(
			/frontmatter phases \(1\) ≠ '### Phase N —' headings \(2\)/,
		);
	});

	it("does not count '### Phase N —' headings inside a fenced code block (meta-review body)", async () => {
		const rel = ".rpiv/artifacts/architecture-reviews/fenced.md";
		// 1 structured phase + 1 REAL heading; the fenced `### Phase 2 —` is example
		// text a meta-review (one whose subject is the pipeline) legitimately embeds
		// and must NOT be counted — else the derive-check false-throws (1 ≠ 2).
		write(
			rel,
			"---\nphases:\n  - { n: 1, title: Only one, depends_on: [], blast_radius: internal, effort: S }\n---\n# Arch Review\n\n### Phase 1 — Only one\nbody\n\n```md\n### Phase 2 — fenced example (must not count)\n```\n",
		);
		const { artifact, state } = stateFor(rel);
		const u = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 });
		expect(u?.label).toContain("phase 1/1");
	});

	// Cross-character regression (Q6): a bare ~~~ must NOT close a ``` fence, so a
	// fenced `### Phase N —` heading after the ~~~ stays fenced and is not counted
	// by the derive-check. Under the old length-only close the ~~~ (len 3, trim 3)
	// would close the fence, expose the heading in prose, and false-throw 1 ≠ 2.
	it("does not count a '### Phase N —' heading appearing after a mismatched-character (~~~) line inside a ``` fence", async () => {
		const rel = ".rpiv/artifacts/architecture-reviews/fence-cross-char.md";
		write(
			rel,
			"---\nphases:\n  - { n: 1, title: Only one, depends_on: [], blast_radius: internal, effort: S }\n---\n# Arch Review\n\n### Phase 1 — Only one\nbody\n\n```md\n~~~\n### Phase 2 — fenced example (must not count)\n```\n",
		);
		const { artifact, state } = stateFor(rel);
		const u = await iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 });
		expect(u?.label).toContain("phase 1/1");
	});

	it("returns null for a review with neither structured phases nor body headings", async () => {
		const rel = ".rpiv/artifacts/architecture-reviews/empty.md";
		write(rel, `---\nstatus: ready\n---\n# No phases\n`);
		const { artifact, state } = stateFor(rel);
		expect(await iterate()({ cwd: tmpDir, artifact, state, accumulated: [], index: 0 })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// contract ownership drift guards — no built-in workflow stage re-declares
// a schema its skill's contract owns, and routed fields are owned by their producer.
// ---------------------------------------------------------------------------
