/**
 * slices.test.ts — slice-design and subplan-cluster fanout mechanics on the
 * built-in graph, moved verbatim from built-in-workflows.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { fanin, fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.ts";
import { designOutcome } from "./index.ts";

describe("SLICE_DESIGN_FANOUT (build design — deps + --upstream)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-design-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const designLoop = () => {
		const loop = findWorkflow("build").stages["slice-design"]?.loop;
		if (loop?.kind !== "fanout") throw new Error("build slice-design stage has no fanout loop");
		return loop;
	};
	const writeSlices = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
	};
	const runFanout = (rel: string) =>
		designLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: { slices: [{ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }] },
			} as unknown as RunView,
		});

	it("carries the --upstream dep-artifact flag", () => {
		expect(designLoop().depArtifactFlag).toBe("--upstream");
	});

	it("halts the run when every design unit of a generation fails (haltWhenAllFailed)", () => {
		expect(designLoop().haltWhenAllFailed).toBe(true);
	});

	it("re-dispatches a contract-refused design unit once (retryHaltedUnits) and parses through designOutcome", () => {
		expect(designLoop().retryHaltedUnits).toBe(1);
		expect(findWorkflow("build").stages["slice-design"]?.outcome).toBe(designOutcome);
	});

	it("maps each slice's frontmatter deps to slice-N unit ids", async () => {
		const rel = ".rpiv/artifacts/slices/map.md";
		writeSlices(
			rel,
			`---\nstatus: ready\nslice_count: 3\nslices:\n  - { n: 1, title: Types, deps: [] }\n  - { n: 2, title: Logic, deps: [1] }\n  - { n: 3, title: Wiring, deps: [1, 2] }\n---\n## Slice 1: Types\n## Slice 2: Logic\n## Slice 3: Wiring\n`,
		);
		const units = await runFanout(rel);
		expect(units.map((u) => u.id)).toEqual(["slice-1", "slice-2", "slice-3"]);
		expect(units.map((u) => u.deps)).toEqual([[], ["slice-1"], ["slice-1", "slice-2"]]);
	});

	it("emits empty deps for a flat (independent) slice map", async () => {
		const rel = ".rpiv/artifacts/slices/flat.md";
		writeSlices(
			rel,
			`---\nstatus: ready\nslice_count: 2\nslices:\n  - { n: 1, title: A, deps: [] }\n  - { n: 2, title: B, deps: [] }\n---\n## Slice 1: A\n## Slice 2: B\n`,
		);
		const units = await runFanout(rel);
		expect(units.every((u) => u.deps?.length === 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// PLAN_DIMENSION_FANOUT — the plan gate's grade panel. architecture-fit is the
// one dimension that needs the research artifact threaded in as --context; every
// other dimension (and the slice gate's design-readiness) gets the bare flags.
// ---------------------------------------------------------------------------

describe("build subplan cluster fanout (research threading + fail-loud mapping)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-subplan-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const subplanLoop = () => {
		const loop = findWorkflow("build").stages.subplan?.loop;
		if (loop?.kind !== "fanout") throw new Error("build subplan stage has no fanout loop");
		return loop;
	};
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const writeSlices = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
	};
	const sliceMap = ".rpiv/artifacts/slices/m.md";
	const twoIndependentSlices = () => {
		writeSlices(
			sliceMap,
			`---\nstatus: ready\nslice_count: 2\nslices:\n  - { n: 1, title: A, deps: [] }\n  - { n: 2, title: B, deps: [] }\n---\n## Slice 1: A\n## Slice 2: B\n`,
		);
	};

	// Finding 4 — research threads DIRECTLY into each cluster's subplan pass.
	it("appends --research to every subplan unit when research is present", async () => {
		twoIndependentSlices();
		const units = await subplanLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					slices: [out(sliceMap)],
					designs: [out(".rpiv/artifacts/designs/d_slice-1.md"), out(".rpiv/artifacts/designs/d_slice-2.md")],
					research: [out(".rpiv/artifacts/research/r.md")],
				},
			} as unknown as RunView,
		});
		expect(units.length).toBeGreaterThan(0);
		expect(units.every((u) => u.prompt.includes("--research .rpiv/artifacts/research/r.md"))).toBe(true);
		expect(units.every((u) => u.prompt.includes("--as-subplan"))).toBe(true);
	});

	// Phase 1 — the cluster ordinal threads into each subplan unit's prompt so a
	// re-dispatched fanout unit writes a distinct `_cluster-<k>.md` (never
	// clobbering a sibling's same-timestamped file). `<k>` is the unit's ordinal
	// and MUST match its `id: cluster-<k>`.
	it("appends --cluster <k> to every subplan unit, <k> matching its id (cluster-<k>)", async () => {
		twoIndependentSlices();
		const units = await subplanLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					slices: [out(sliceMap)],
					designs: [out(".rpiv/artifacts/designs/d_slice-1.md"), out(".rpiv/artifacts/designs/d_slice-2.md")],
				},
			} as unknown as RunView,
		});
		expect(units.length).toBeGreaterThan(0);
		const ks = units.map((u) => {
			const k = u.prompt.match(/--cluster\s+(\d+)/)?.[1];
			const idK = u.id?.match(/^cluster-(\d+)$/)?.[1];
			expect(k).toBeDefined();
			expect(idK).toBeDefined();
			// `<k>` in the prompt equals the unit's ordinal, surfaced as `id: cluster-<k>`.
			expect(k).toBe(idK);
			return k;
		});
		// Distinct `<k>` across units — the actual collision fix: no two units share
		// an ordinal, so two same-timestamped sub-plan files never clobber.
		expect(new Set(ks).size).toBe(ks.length);
		expect(units.every((u) => u.prompt.includes("--as-subplan"))).toBe(true);
	});

	it("build plan stage reads research, goal, and acceptance alongside the subplans fan-in (finding 4)", () => {
		// Same-anchor wiring as ship's plan stage: the root merge sees the goal and
		// the frozen inventory the completeness judge and validate read, so it can
		// dispose of every inventory id in the plan's `acceptance:` block.
		expect(findWorkflow("build").stages.plan?.reads).toEqual(["research", "goal", "acceptance", fanin("subplans")]);
	});

	// Finding 8 — an artifact whose identity can't be resolved must FAIL LOUD, not
	// fall back to a positional guess that silently mis-routes and drops slices.
	// The observed halt: a lane dropped the `_slice-3_` segment while its
	// frontmatter `slice_n: 3` was right. The channel carries that frontmatter as
	// `output.data`, so identity resolves from it and the filename is the fallback.
	it("resolves a tokenless design filename from the channel's data.slice_n", async () => {
		twoIndependentSlices();
		const units = await subplanLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					slices: [out(sliceMap)],
					designs: [
						{ ...out(".rpiv/artifacts/designs/lv-2-the-face.md"), data: { slice_n: 1 } },
						out(".rpiv/artifacts/designs/d_slice-2.md"),
					],
				},
			} as unknown as RunView,
		});
		const prompts = units.map((u) => u.prompt).join("\n");
		expect(prompts).toContain("--designs .rpiv/artifacts/designs/lv-2-the-face.md");
		expect(prompts).toContain("--designs .rpiv/artifacts/designs/d_slice-2.md");
	});

	it("throws when a design carries neither slice_n nor a slice-<N> filename token (no positional fallback)", () => {
		twoIndependentSlices();
		expect(() =>
			subplanLoop().units({
				cwd: tmpDir,
				artifact: undefined,
				state: {
					named: {
						slices: [out(sliceMap)],
						designs: [out(".rpiv/artifacts/designs/mystery.md")],
					},
				} as unknown as RunView,
			}),
		).toThrow(/no frontmatter 'slice_n' and no 'slice-<N>' filename token|has no slice number/);
	});

	it("takes the LATEST design when a slice is claimed twice (design-review re-emits — latest-wins, no throw)", async () => {
		twoIndependentSlices();
		// slice 1 claimed twice: slice-design emits `a_slice-1`, then design-review
		// re-emits it as `b_slice-1` on the same channel (its "latest-wins" contract).
		// The resolver must take the newest, never halt.
		const units = await subplanLoop().units({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					slices: [out(sliceMap)],
					designs: [
						out(".rpiv/artifacts/designs/a_slice-1.md"),
						out(".rpiv/artifacts/designs/b_slice-1.md"),
						out(".rpiv/artifacts/designs/d_slice-2.md"),
					],
				},
			} as unknown as RunView,
		});
		const slice1Unit = units.find((u) => u.prompt.includes("slice-1"));
		expect(slice1Unit?.prompt).toContain("--designs .rpiv/artifacts/designs/b_slice-1.md");
		expect(slice1Unit?.prompt).not.toContain("a_slice-1.md");
	});
});

// ---------------------------------------------------------------------------
// subplanCoverageCheck — deterministic cluster-coverage floor between the
// cluster fanout and the root merge (twin of slice-check).
// ---------------------------------------------------------------------------
