/**
 * grade-panel.test.ts — grade/confirm panel threading on the built-in graph
 * (--context, --prior adjudication, ship roster bypass, cite-check,
 * pending-dimension re-grade), moved verbatim from built-in-workflows.test.ts.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Output, RunView } from "@juicesharp/rpiv-workflow";
import { takeRouteNote } from "@juicesharp/rpiv-workflow/internal";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHIP_DIMENSION_FANOUT, SHIP_DIMENSIONS, shipGatePasses, shipVerdictOutcome } from "../built-in-workflows.ts";
import { findWorkflow } from "../workflow-test-harness.ts";

describe("build plan gate grade panel (--context threading)", () => {
	const planGateLoop = () => {
		const loop = findWorkflow("build").stages["plan-grade"]?.loop;
		if (loop?.kind !== "fanout") throw new Error("build plan-grade stage has no fanout loop");
		return loop;
	};
	const sliceGateLoop = () => {
		const loop = findWorkflow("build").stages["slice-grade"]?.loop;
		if (loop?.kind !== "fanout") throw new Error("build slice-grade stage has no fanout loop");
		return loop;
	};
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });

	it("grades architecture-fit and threads the research artifact as --context", async () => {
		const units = await planGateLoop().units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					research: [out(".rpiv/artifacts/research/r.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
				},
			} as unknown as RunView,
		});
		const archFit = units.find((u) => u.label === "architecture-fit");
		const completeness = units.find((u) => u.label === "completeness");
		expect(archFit).toBeDefined();
		expect(archFit?.prompt).toContain("--dimension architecture-fit");
		expect(archFit?.prompt).toContain("--context");
		expect(archFit?.prompt).toContain("research/r.md");
		// Only architecture-fit gets --context.
		expect(completeness?.prompt).not.toContain("--context");
	});

	it("never threads --context into the slice gate (design-readiness has no fit dimension)", async () => {
		const units = await sliceGateLoop().units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					slices: [out(".rpiv/artifacts/slices/s.md")],
					research: [out(".rpiv/artifacts/research/r.md")],
				},
			} as unknown as RunView,
		});
		expect(units.every((u) => !u.prompt.includes("--context"))).toBe(true);
	});

	it("every grade/confirm panel halts when an entire generation fails (haltWhenAllFailed via the shared factory)", () => {
		for (const stage of ["slice-grade", "plan-grade", "plan-confirm", "code-grade", "code-confirm"]) {
			const loop = findWorkflow("build").stages[stage]?.loop;
			if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
			// One flag at the shared fanout({ ... }) in gradePanelFanout — all five
			// panel instances inherit by construction.
			expect(loop.haltWhenAllFailed, stage).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// build panels' --prior threading — a pending dimension (confirm or re-grade
// of a blocking prior) threads its latest fresh verdict as --prior so the
// grader adjudicates the prior findings instead of out-voting them; the
// correctness arm threads its prior whenever one is fresh (its re-grades scope
// to it). Carried passing priors on other dimensions, round 1, and stale
// verdicts stay flagless.
// ---------------------------------------------------------------------------

describe("build confirm panels (--prior adjudication threading)", () => {
	const loopOf = (stage: string) => {
		const loop = findWorkflow("build").stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop;
	};
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const verdict = (rel: string, data: Record<string, unknown>) => ({
		artifacts: [{ handle: fsHandle(rel) }],
		data,
		kind: "",
		meta: {},
	});
	const passing = (dimension: string) =>
		verdict(`.rpiv/artifacts/verdicts/p__${dimension}__round-1.json`, {
			dimension,
			pass: true,
			severity: "none",
			artifact: ".rpiv/artifacts/plans/p.md",
		});
	// The observed incident shape: a low-severity fail whose BLOCK comes from the
	// failed risk ruling, not the score.
	const failingCorrectness = (rel: string) =>
		verdict(rel, {
			dimension: "correctness",
			pass: false,
			severity: "low",
			artifact: ".rpiv/artifacts/plans/p.md",
			risk_rulings: [{ id: "r2", pass: false }],
		});
	const OTHER_DIMS = ["completeness", "actionability", "pattern-following", "architecture-fit"];

	it("plan-confirm emits only the blocking dimension, carrying its latest verdict as --prior", async () => {
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-1.json"),
					],
				},
			} as unknown as RunView,
		});
		expect(units.map((u) => u.label)).toEqual(["correctness"]);
		expect(units[0]?.prompt).toContain("--dimension correctness");
		expect(units[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__correctness__round-1.json");
	});

	it("--prior points at the LATEST round's verdict when rounds accumulate", async () => {
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-1.json"),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-2.json"),
					],
				},
			} as unknown as RunView,
		});
		expect(units[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__correctness__round-2.json");
		expect(units[0]?.prompt).not.toContain("round-1.json");
	});

	it("--prior composes with --goal on correctness (both flags, one unit)", async () => {
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					goal: [out(".rpiv/artifacts/goal/goal.md")],
					"plan-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-1.json"),
					],
				},
			} as unknown as RunView,
		});
		expect(units[0]?.prompt).toContain("--goal .rpiv/artifacts/goal/goal.md");
		expect(units[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__correctness__round-1.json");
	});

	it("code-confirm threads --prior off its OWN code-verdicts channel", async () => {
		const units = await loopOf("code-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"code-cite-check": [out(".rpiv/artifacts/verdicts/code-cite-check__p.json")],
					"code-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__code-round-1.json"),
					],
				},
			} as unknown as RunView,
		});
		expect(units.map((u) => u.label)).toEqual(["correctness"]);
		expect(units[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__correctness__code-round-1.json");
	});

	it("grade panels thread --prior on round ≥ 2 (the re-grade dispatch adjudicates too)", async () => {
		const units = await loopOf("plan-grade").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-1.json"),
					],
				},
			} as unknown as RunView,
		});
		// Only correctness is pending, and its fresh failing verdict threads —
		// the re-grade grader adjudicates the prior round like a confirm does.
		expect(units.map((u) => u.label)).toEqual(["correctness"]);
		expect(units[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__correctness__round-1.json");
	});

	it("a stale verdict (regenerated artifact) yields no --prior — nothing fresh to adjudicate", async () => {
		const stale = verdict(".rpiv/artifacts/verdicts/old__correctness__round-1.json", {
			dimension: "correctness",
			pass: false,
			severity: "low",
			artifact: ".rpiv/artifacts/plans/old.md",
			risk_rulings: [{ id: "r2", pass: false }],
		});
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": [stale],
				},
			} as unknown as RunView,
		});
		expect(units.length).toBeGreaterThan(0); // every dimension re-grades from scratch...
		expect(units.every((u) => !u.prompt.includes("--prior"))).toBe(true); // ...with no prior
	});

	it("the degenerate all-passing fallback threads --prior on correctness only (carried passes are not re-adjudicated)", async () => {
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": [...OTHER_DIMS.map(passing), passing("correctness")],
				},
			} as unknown as RunView,
		});
		// Nothing pending ⇒ the full roster falls back in; only correctness carries
		// its prior (its re-grade scopes to it) — a carried pass elsewhere is not
		// re-adjudicated.
		expect(units.length).toBe(OTHER_DIMS.length + 1);
		expect(units.filter((u) => u.prompt.includes("--prior")).map((u) => u.label)).toEqual(["correctness"]);
	});
});

// ---------------------------------------------------------------------------
// ship grade panel — the bespoke tier-independent roster. Ship is a lightweight
// preset: its grade panel binds SHIP_DIMENSIONS verbatim (never
// gateRoster(gateTier(...))), threads --context (architecture-fit) and --goal
// (completeness/correctness) with no --prior machinery, and its gate folds ONLY
// the ship-verdicts channel — no cite channel, no plan/code verdicts.
// ---------------------------------------------------------------------------

describe("ship grade panel (tier-independent roster bypass)", () => {
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	// A channel output carrying frontmatter data — `phase_count`/`slice_count`
	// are what gateTier WOULD read; the ship panel never consults them, so the
	// values are here only to make the "light-tier shape" it bypasses unambiguous.
	const dataOut = (rel: string, data: Record<string, unknown> = {}) => ({
		artifacts: [{ handle: fsHandle(rel) }],
		data,
		kind: "",
		meta: {},
	});
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const verdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}) =>
		({
			artifacts: [{ handle: fsHandle(`.rpiv/artifacts/verdicts/ship__${dimension}.json`) }],
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
			kind: "json",
			meta: {},
		}) as unknown as Output;

	describe("SHIP_DIMENSION_FANOUT.units()", () => {
		it("emits the full roster (architecture-fit NOT dropped) on a light-tier-shaped state", async () => {
			const units = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: {
					named: {
						// slice_count:1 + phase_count:1 (+ no verdict severities) is the
						// shape gateTier folds to "light" — a gradePanelFanout over this
						// state would emit only the LIGHT_ROSTER dims; the bespoke fanout
						// emits all three because it binds SHIP_DIMENSIONS verbatim.
						slices: [dataOut(".rpiv/artifacts/slices/s.md", { slice_count: 1 })],
						plans: [dataOut(PLAN, { phase_count: 1 })],
						research: [out(".rpiv/artifacts/research/r.md")],
						goal: [out(".rpiv/artifacts/goal/goal.md")],
						"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					},
				} as unknown as RunView,
			});
			expect(units.map((u) => u.label)).toEqual([...SHIP_DIMENSIONS]);
		});

		it("threads --context (architecture-fit) and --goal (goal dims); no unit carries --prior", async () => {
			const units = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: {
					named: {
						plans: [dataOut(PLAN, { phase_count: 1 })],
						research: [out(".rpiv/artifacts/research/r.md")],
						goal: [out(".rpiv/artifacts/goal/goal.md")],
						"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					},
				} as unknown as RunView,
			});
			const archFit = units.find((u) => u.label === "architecture-fit");
			const completeness = units.find((u) => u.label === "completeness");
			const correctness = units.find((u) => u.label === "correctness");
			expect(archFit?.prompt).toContain("--context");
			expect(archFit?.prompt).toContain("research/r.md");
			// architecture-fit is not goal-anchored: no --goal on that unit.
			expect(archFit?.prompt).not.toContain("--goal");
			expect(completeness?.prompt).toContain("--goal");
			expect(completeness?.prompt).toContain("goal/goal.md");
			expect(correctness?.prompt).toContain("--goal");
			expect(units.every((u) => !u.prompt.includes("--prior"))).toBe(true);
		});

		it("returns [] with no plans artifact (the latestFsArtifact guard)", async () => {
			const units = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: { named: { research: [out(".rpiv/artifacts/research/r.md")] } } as unknown as RunView,
			});
			expect(units).toEqual([]);
		});

		// Advisory citation findings reach the correctness grader: the cite gate
		// upstream passed (a blocking finding STOPs before grade), so a
		// findings-bearing plan-cite-check verdict here is advisory by
		// construction and threads as --cite-check on the correctness unit ONLY.
		it("threads --cite-check to the correctness unit when the cite floor recorded findings", async () => {
			const CITE = ".rpiv/artifacts/verdicts/plan-cite-check__p.json";
			const units = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: {
					named: {
						plans: [dataOut(PLAN, { phase_count: 1 })],
						research: [out(".rpiv/artifacts/research/r.md")],
						goal: [out(".rpiv/artifacts/goal/goal.md")],
						"plan-cite-check": [
							dataOut(CITE, {
								dimension: "structure",
								pass: false,
								severity: "low",
								findings: [{ detail: "Unbacked citation dup.ts:5", where: "dup.ts:5", advisory: true }],
							}),
						],
					},
				} as unknown as RunView,
			});
			const correctness = units.find((u) => u.label === "correctness");
			expect(correctness?.prompt).toContain(`--cite-check ${CITE}`);
			expect(units.filter((u) => u.label !== "correctness").every((u) => !u.prompt.includes("--cite-check"))).toBe(
				true,
			);
		});

		it("threads --cite-check on a CLEAN floor verdict too (resolution settled); halts when the channel is absent", async () => {
			// A clean verdict is load-bearing evidence: it settles citation
			// RESOLUTION, so the correctness grader skips the mechanical
			// re-resolution and spot-checks semantics only (citeCheckFlag).
			const CITE = ".rpiv/artifacts/verdicts/plan-cite-check__p.json";
			const base = {
				plans: [dataOut(PLAN, { phase_count: 1 })],
				research: [out(".rpiv/artifacts/research/r.md")],
				goal: [out(".rpiv/artifacts/goal/goal.md")],
			};
			const clean = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: {
					named: {
						...base,
						"plan-cite-check": [
							dataOut(CITE, { dimension: "structure", pass: true, severity: "none", findings: [] }),
						],
					},
				} as unknown as RunView,
			});
			expect(clean.find((u) => u.label === "correctness")?.prompt).toContain(`--cite-check ${CITE}`);
			expect(clean.filter((u) => u.label !== "correctness").every((u) => !u.prompt.includes("--cite-check"))).toBe(
				true,
			);
			// Fail-closed: ship's panel is configured over the cite channel and its
			// graph guarantees the floor ran first (shipCiteGate) — an absent verdict
			// is an integrity break, never a flag-less dispatch.
			expect(() =>
				SHIP_DIMENSION_FANOUT.units({
					cwd: "/repo",
					artifact: undefined,
					state: { named: base } as unknown as RunView,
				}),
			).toThrow(/'plan-cite-check' channel carries no fs verdict/);
		});

		it("halts the run when every dimension unit of a generation fails (haltWhenAllFailed)", () => {
			expect(SHIP_DIMENSION_FANOUT.haltWhenAllFailed).toBe(true);
		});
	});

	describe("shipGatePasses", () => {
		const state = (shipVerdicts: Output[], extra: Record<string, Output[]> = {}) =>
			({
				named: { plans: [dataOut(PLAN)], "ship-verdicts": shipVerdicts, ...extra },
			}) as unknown as RunView;

		it("returns false when architecture-fit fails, even with correctness+completeness passing", () => {
			// Tier-independence is structural: the roster is SHIP_DIMENSIONS
			// verbatim, never gateRoster(gateTier(...)) — the fanout's three-unit
			// emission on a light-tier-shaped state (above) is the observable
			// counterpart proof.
			const s = state([
				verdict("completeness", true),
				verdict("correctness", true),
				verdict("architecture-fit", false),
			]);
			expect(shipGatePasses(s)).toBe(false);
		});

		it("returns true when all three dimensions pass", () => {
			const s = state([
				verdict("completeness", true),
				verdict("correctness", true),
				verdict("architecture-fit", true),
			]);
			expect(shipGatePasses(s)).toBe(true);
		});

		it("ignores plan-verdicts and code-verdicts (folds only the ship-verdicts channel)", () => {
			// plan-verdicts + code-verdicts carry failing dimensions while
			// ship-verdicts all pass — a gate reading the wrong channel fails.
			const failing = (dimension: string) => verdict(dimension, false);
			const s = state(
				[verdict("completeness", true), verdict("correctness", true), verdict("architecture-fit", true)],
				{
					"plan-verdicts": [failing("completeness"), failing("correctness"), failing("architecture-fit")],
					"code-verdicts": [failing("completeness"), failing("correctness"), failing("architecture-fit")],
				},
			);
			expect(shipGatePasses(s)).toBe(true);
		});
	});

	describe("stop-pick route notes (the stopped-recap reason)", () => {
		// The two bespoke defineRoute gates attach a ROUTE_NOTE on their stop
		// pick — the routing audit persists it and summarizeRun surfaces it as
		// "stopped at <gate>: <note>". takeRouteNote is read-and-clear, so each
		// assertion drains what the pick just attached.
		const edgeOf = (name: string) => {
			const edge = findWorkflow("ship").edges[name];
			if (typeof edge !== "function") throw new Error(`ship ${name} edge is not an EdgeFn`);
			return edge;
		};
		const state = (named: Record<string, unknown[]>) => ({ named }) as unknown as RunView;

		it("grade stop names the blocking dimensions with their severity", () => {
			const edge = edgeOf("grade");
			const s = state({
				plans: [dataOut(PLAN)],
				"ship-verdicts": [
					verdict("completeness", false, { severity: "medium" }),
					verdict("correctness", true),
					verdict("architecture-fit", false),
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("stop");
			expect(takeRouteNote(edge)).toBe("completeness failed (medium), architecture-fit failed (high)");
		});

		it("grade stop on an empty verdict channel names the stale-verdict cause", () => {
			const edge = edgeOf("grade");
			const s = state({ plans: [dataOut(PLAN)], "ship-verdicts": [] });
			expect(edge({ state: s, output: undefined })).toBe("stop");
			expect(takeRouteNote(edge)).toBe("no fresh verdicts for the current plan");
		});

		it("grade pass attaches no note", () => {
			const edge = edgeOf("grade");
			const s = state({
				plans: [dataOut(PLAN)],
				"ship-verdicts": [
					verdict("completeness", true),
					verdict("correctness", true),
					verdict("architecture-fit", true),
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("implement");
			expect(takeRouteNote(edge)).toBeUndefined();
		});

		it("plan-cite-check stop carries the finding count", () => {
			const edge = edgeOf("plan-cite-check");
			const s = state({
				"plan-cite-check": [
					{
						artifacts: [],
						data: { dimension: "structure", pass: false, severity: "high", findings: [{}, {}] },
					},
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("stop");
			expect(takeRouteNote(edge)).toBe("plan citation check failed (2 findings)");
		});

		it("plan-cite-check pass attaches no note", () => {
			const edge = edgeOf("plan-cite-check");
			const s = state({
				"plan-cite-check": [
					{ artifacts: [], data: { dimension: "structure", pass: true, severity: "none", findings: [] } },
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("grade");
			expect(takeRouteNote(edge)).toBeUndefined();
		});

		it("plan-cite-check advisory-only verdict (severity low) rides through to grade", () => {
			// The severity tier's ship-side contract: ambiguity/drift rate `low`,
			// allDimensionsPass floors it, and the run proceeds to grade instead of
			// terminating over a resolver limitation.
			const edge = edgeOf("plan-cite-check");
			const s = state({
				"plan-cite-check": [
					{
						artifacts: [],
						data: { dimension: "structure", pass: false, severity: "low", findings: [{ advisory: true }] },
					},
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("grade");
			expect(takeRouteNote(edge)).toBeUndefined();
		});

		it("plan-cite-check stop note counts only the blocking findings", () => {
			const edge = edgeOf("plan-cite-check");
			const s = state({
				"plan-cite-check": [
					{
						artifacts: [],
						data: { dimension: "structure", pass: false, severity: "high", findings: [{ advisory: true }, {}] },
					},
				],
			});
			expect(edge({ state: s, output: undefined })).toBe("stop");
			expect(takeRouteNote(edge)).toBe("plan citation check failed (1 finding)");
		});
	});

	it("shipVerdictOutcome publishes to the ship-verdicts channel", () => {
		expect(shipVerdictOutcome.name).toBe("ship-verdicts");
	});
});

// ---------------------------------------------------------------------------
// build goal channel — the user's brief captured VERBATIM at run start and
// threaded into the judgment seams only: the grade panels' completeness/
// correctness dimensions (--goal) and validate's prompt. Generative stages
// (slice, design-slice) stay goal-blind by design, and research — displaced
// from the start slot — must still receive the raw brief via its prompt fn.
// ---------------------------------------------------------------------------

describe("build cite-check threading (settled-facts seam)", () => {
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const CITE = ".rpiv/artifacts/verdicts/plan-cite-check__p.json";
	const named = {
		plans: [out(".rpiv/artifacts/plans/p.md")],
		research: [out(".rpiv/artifacts/research/r.md")],
		goal: [out(".rpiv/artifacts/goal/goal.md")],
		"plan-cite-check": [out(CITE)],
	};
	const gateUnits = (stage: string, n: Record<string, unknown>) => {
		const loop = findWorkflow("build").stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop.units({ cwd: "/repo", artifact: undefined, state: { named: n } as unknown as RunView });
	};

	it("plan-grade threads --cite-check to the correctness unit only — a CLEAN verdict included", async () => {
		const units = await gateUnits("plan-grade", named);
		const byLabel = new Map(units.map((u) => [u.label, u.prompt]));
		expect(byLabel.get("correctness")).toContain(`--cite-check ${CITE}`);
		for (const [label, prompt] of byLabel) {
			if (label !== "correctness") expect(prompt).not.toContain("--cite-check");
		}
	});

	it("code-grade threads its OWN floor's verdict (code-cite-check), never the plan gate's", async () => {
		const CODE_CITE = ".rpiv/artifacts/verdicts/code-cite-check__p.json";
		const units = await gateUnits("code-grade", { ...named, "code-cite-check": [out(CODE_CITE)] });
		expect(units.find((u) => u.label === "correctness")?.prompt).toContain(`--cite-check ${CODE_CITE}`);
		expect(units.find((u) => u.label === "correctness")?.prompt).not.toContain(CITE);
	});

	it("halts when the configured floor channel is absent (fail-closed, not a flag-less dispatch)", () => {
		const { "plan-cite-check": _cite, ...bare } = named;
		expect(() => gateUnits("plan-grade", bare)).toThrow(/'plan-cite-check' channel carries no fs verdict/);
	});
});

// ---------------------------------------------------------------------------
// slice-structure — the deterministic Phase-1 floor under the design-readiness
// gate: dependency-cycle freedom + brief-coverage conservation (frozen at the
// first cut). Both are computed from the slice-map text, no LLM.
// ---------------------------------------------------------------------------

describe("build grade panel re-grades only the pending dimensions (P2)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-regrade-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const PLAN_DIMS = ["completeness", "correctness", "actionability", "pattern-following", "architecture-fit"];
	const REL = ".rpiv/artifacts/plans/p.md";

	// The fail-closed cite contract: every cite-configured panel requires its
	// floor's verdict on the state (citeCheckFlag throws otherwise) — spread at
	// every units() call below. Both channels: the helper is stage-generic.
	const citeChannels = {
		"plan-cite-check": [
			{
				artifacts: [{ handle: fsHandle(".rpiv/artifacts/verdicts/plan-cite-check__p.json") }],
				data: undefined,
				kind: "",
				meta: {},
			},
		],
		"code-cite-check": [
			{
				artifacts: [{ handle: fsHandle(".rpiv/artifacts/verdicts/code-cite-check__p.json") }],
				data: undefined,
				kind: "",
				meta: {},
			},
		],
	};

	const gradeUnits = (stage: string) => {
		const loop = findWorkflow("build").stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop.units;
	};
	const dimV = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}) =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "high", ...extra },
		}) as unknown as Output;
	const writePlan = () => {
		mkdirSync(join(tmpDir, ".rpiv/artifacts/plans"), { recursive: true });
		writeFileSync(join(tmpDir, REL), "---\nstatus: ready\n---\n# Plan\n");
	};
	const runUnits = (stage: string, verdictChannel: string, verdicts: Output[]) =>
		gradeUnits(stage)({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					plans: [{ artifacts: [{ handle: fsHandle(REL) }], data: undefined, kind: "", meta: {} }],
					...citeChannels,
					[verdictChannel]: verdicts,
				},
			} as unknown as RunView,
		});
	const labels = async (stage: string, verdictChannel: string, verdicts: Output[]) =>
		(await runUnits(stage, verdictChannel, verdicts)).map((u) => u.label).sort();

	// --- Phase 5: delta re-grade fallback guard (surgical-fix guard) ----------
	const PRIOR_REL = ".rpiv/artifacts/priors/p.md";
	const passingOthers = () => PLAN_DIMS.filter((d) => d !== "correctness").map((d) => dimV(d, true));
	const correctnessFailing = (where: string, detail = "correctness defect") =>
		dimV("correctness", false, { severity: "high", findings: [{ detail, where }] });
	const fm = () => `---\nstatus: ready\nlast_updated: 2026-07-27T20:00:00-0400\n---\n`;
	const phase = (n: number, body: string) => `## Phase ${n}: section-${n}\n${body}`;
	const planFrom = (sections: string[]) => `${fm()}# Plan\n\n${sections.join("\n\n")}\n`;
	const writePriorAndCurrent = (priorBody: string, currentBody: string) => {
		mkdirSync(join(tmpDir, ".rpiv/artifacts/priors"), { recursive: true });
		writeFileSync(join(tmpDir, PRIOR_REL), priorBody);
		writeFileSync(join(tmpDir, REL), currentBody);
	};
	// Run plan-grade with a fabricated `plan-snapshot` channel carrying a prior
	// sidecar at PRIOR_REL (role "prior"). `priorSidecarWritten` controls whether
	// the sidecar FILE exists on disk (false ⇒ the entry exists but is unreadable
	// ⇒ fail-closed to FULL roster, per risk c5r3 case (e)).
	const runUnitsWithPrior = (
		verdicts: Output[],
		priorBody: string,
		currentBody: string,
		priorSidecarWritten: boolean,
	) => {
		if (priorSidecarWritten) writePriorAndCurrent(priorBody, currentBody);
		else writeFileSync(join(tmpDir, REL), currentBody);
		return gradeUnits("plan-grade")({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					plans: [{ artifacts: [{ handle: fsHandle(REL) }], data: undefined, kind: "", meta: {} }],
					...citeChannels,
					"plan-verdicts": verdicts,
					"plan-snapshot": [
						{
							artifacts: [{ handle: fsHandle(PRIOR_REL), role: "prior" }],
							data: undefined,
							kind: "",
							meta: {},
						},
					],
				},
			} as unknown as RunView,
		});
	};
	const labelsWithPrior = async (
		verdicts: Output[],
		priorBody: string,
		currentBody: string,
		priorSidecarWritten = true,
	) => (await runUnitsWithPrior(verdicts, priorBody, currentBody, priorSidecarWritten)).map((u) => u.label).sort();

	beforeEach(writePlan);

	it("grades every dimension on the first pass (no prior verdicts)", async () => {
		expect(await labels("plan-grade", "plan-verdicts", [])).toEqual([...PLAN_DIMS].sort());
	});

	it("re-grades ONLY the failing dimension, carrying the rest forward", async () => {
		const verdicts = PLAN_DIMS.map((d) => dimV(d, d !== "correctness"));
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("re-grades a dimension that passed but ruled a risk flag fail", async () => {
		const verdicts = PLAN_DIMS.map((d) =>
			d === "correctness" ? dimV(d, true, { risk_rulings: [{ id: "r1", pass: false }] }) : dimV(d, true),
		);
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("falls back to the FULL panel when nothing needs re-grading (never an empty unit set)", async () => {
		const verdicts = PLAN_DIMS.map((d) => dimV(d, true, { risk_rulings: [{ id: "r1", pass: true }] }));
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual([...PLAN_DIMS].sort());
	});

	it("carries a low-severity dimension forward even when its raw pass is false", async () => {
		const verdicts = PLAN_DIMS.map((d) =>
			d === "actionability" ? dimV(d, false, { severity: "low" }) : dimV(d, true),
		);
		// low severity is floored to a pass, so nothing needs re-grading → full-panel fallback.
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual([...PLAN_DIMS].sort());
	});

	it("clamps an all-anchor-nit MEDIUM fail to non-blocking (mis-rated line-drift findings)", async () => {
		// The deterministic backstop for the grade skill's citation-resolution rule:
		// a fail whose EVERY finding is line-number drift never buys a fix round,
		// whatever severity the grader typed (6 historical fix rounds were exactly this).
		const verdicts = PLAN_DIMS.map((d) =>
			d === "correctness"
				? dimV(d, false, {
						severity: "medium",
						findings: [
							{ detail: "The citation is drifted ~4 lines; the alias declaration sits elsewhere", where: "s2" },
							{ detail: "loop.ts:92 cites curCtx but the usage is at line 94 in the driver", where: "s3" },
						],
					})
				: dimV(d, true),
		);
		// clamped to a pass, so nothing needs re-grading → full-panel fallback.
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual([...PLAN_DIMS].sort());
	});

	it("does NOT clamp when a drift nit sits beside a substantive finding", async () => {
		const verdicts = PLAN_DIMS.map((d) =>
			d === "correctness"
				? dimV(d, false, {
						severity: "medium",
						findings: [
							{ detail: "The citation is drifted ~4 lines", where: "s2" },
							{
								detail: "Slice 2 renames three PUBLIC type exports but the framing claims none are exported",
								where: "s2",
							},
						],
					})
				: dimV(d, true),
		);
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("does NOT clamp a shipped-false-claim finding phrased as 'line N is a …' (the I1 reproducer)", async () => {
		const verdicts = PLAN_DIMS.map((d) =>
			d === "correctness"
				? dimV(d, false, {
						severity: "medium",
						findings: [
							{
								detail: "line 42 is a comment that falsely claims the return value is non-null",
								where: "src/x.ts:42",
							},
						],
					})
				: dimV(d, true),
		);
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("does NOT clamp a real off-by-one bug finding (location shape without citing context)", async () => {
		const verdicts = PLAN_DIMS.map((d) =>
			d === "correctness"
				? dimV(d, false, {
						severity: "medium",
						findings: [
							{ detail: "The loop bound is off by one, so the final element is never processed", where: "s1" },
						],
					})
				: dimV(d, true),
		);
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("the code gate reads code-verdicts, not the plan gate's channel", async () => {
		// plan-verdicts all fail, but code-grade must ignore them and read code-verdicts.
		const codeVerdicts = PLAN_DIMS.map((d) => dimV(d, d !== "pattern-following"));
		const units = gradeUnits("code-grade")({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					plans: [{ artifacts: [{ handle: fsHandle(REL) }], data: undefined, kind: "", meta: {} }],
					...citeChannels,
					"plan-verdicts": PLAN_DIMS.map((d) => dimV(d, false)),
					"code-verdicts": codeVerdicts,
				},
			} as unknown as RunView,
		});
		expect((await units).map((u) => u.label)).toEqual(["pattern-following"]);
	});

	it("surgical amend (only the cited phase touched, ≤ threshold) re-grades ONLY correctness", async () => {
		// Round 1: only correctness blocks; its finding cites Phase 3.
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		// The amend changed ONLY Phase 3's body (2 lines del + 2 lines ins = 4 changed).
		const prior = planFrom([phase(3, "old line A\nold line B"), phase(5, "shared phase 5 content")]);
		const current = planFrom([phase(3, "new line A\nnew line B"), phase(5, "shared phase 5 content")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("out-of-scope amend (an uncited phase also touched) re-grades the FULL roster", async () => {
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		// The amend touched Phase 3 (cited) AND Phase 5 (NOT cited by any finding).
		const prior = planFrom([phase(3, "old line A\nold line B"), phase(5, "shared phase 5 content")]);
		const current = planFrom([phase(3, "new line A\nnew line B"), phase(5, "shared phase 5 content CHANGED")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual([...PLAN_DIMS].sort());
	});

	it("over-threshold amend (within cited phase but > 60 changed lines) re-grades the FULL roster", async () => {
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		const oldBody = Array.from({ length: 70 }, (_, i) => `old ${i}`).join("\n");
		const newBody = Array.from({ length: 70 }, (_, i) => `new ${i}`).join("\n");
		const prior = planFrom([phase(3, oldBody), phase(5, "shared phase 5 content")]);
		const current = planFrom([phase(3, newBody), phase(5, "shared phase 5 content")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual([...PLAN_DIMS].sort());
	});

	it("missing prior (round 1) carries forward — re-grades ONLY the failing dimension", async () => {
		// No `plan-snapshot` channel entry ⇒ hasPrior=false ⇒ carry-forward (the
		// scenario the existing carry-forward cases already model).
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		expect(await labels("plan-grade", "plan-verdicts", verdicts)).toEqual(["correctness"]);
	});

	it("unreadable prior sidecar (entry present, file missing) re-grades the FULL roster", async () => {
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		// priorSidecarWritten=false: the channel carries a prior entry, but the
		// sidecar file does not exist on disk ⇒ latestPriorContent throws ⇒
		// isSurgicalFix=false ⇒ priorPresent=true ⇒ FULL roster.
		const prior = planFrom([phase(3, "old"), phase(5, "shared")]);
		const current = planFrom([phase(3, "old"), phase(5, "shared")]);
		expect(await labelsWithPrior(verdicts, prior, current, false)).toEqual([...PLAN_DIMS].sort());
	});

	it("no extractable plan-section where (repo path:line only) re-grades the FULL roster", async () => {
		// The finding's where is a bare repo path:line — citedSections yields {}.
		const verdicts = [...passingOthers(), correctnessFailing("packages/x/y.ts:42")];
		const prior = planFrom([phase(3, "old line A\nold line B"), phase(5, "shared phase 5 content")]);
		const current = planFrom([phase(3, "new line A\nnew line B"), phase(5, "shared phase 5 content")]);
		// Phase 3 is touched but cited is empty ⇒ subset test fails ⇒ non-surgical.
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual([...PLAN_DIMS].sort());
	});

	it("a section-heading where cites its section: an Out of Scope amend is surgical", async () => {
		// citedSections' leading-segment extraction: the where "## Out of Scope >
		// deferral" cites the plan section "out of scope", so an amend touching
		// only that section (plus frontmatter) narrows the re-grade. Before the
		// widening, cited could only ever hold `phase N` keys and this exact
		// shape was structurally guaranteed broad.
		const verdicts = [...passingOthers(), correctnessFailing("## Out of Scope > dropped goal ask")];
		const outOfScope = (body: string) => `## Out of Scope\n${body}`;
		const prior = planFrom([phase(3, "phase body"), outOfScope("- old deferral")]);
		const current = planFrom([phase(3, "phase body"), outOfScope("- old deferral\n- new deferral with reason")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("a failing risk ruling cites the Risk Flags section (and the owner phase): a ruling repair is surgical", async () => {
		// The ruling-driven pending case has NO findings, so before the widening
		// its cite set was empty and every ruling repair was broad by
		// construction. The ruling now cites `risk flags` + the authored owner
		// phase; the plans channel carries no risks frontmatter here, so the
		// owner cite is absent and only the section cite applies.
		const verdicts = [
			...passingOthers(),
			dimV("correctness", true, { severity: "none", risk_rulings: [{ id: "r1", pass: false }] }),
		];
		const riskFlags = (body: string) => `## Risk Flags\n${body}`;
		const prior = planFrom([phase(3, "phase body"), riskFlags("- r1: unverified claim")]);
		const current = planFrom([
			phase(3, "phase body"),
			riskFlags("- r1: verified against names.ts, procedure attached"),
		]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("a suffixed section where covers the bare heading (and a suffixed heading is covered by a bare cite)", async () => {
		// Both directions observed in opendots run d5a9: the where "## Synthesis
		// Notes — 'Adopted rider' bullet" must cover the touched key "synthesis
		// notes", and a bare cite must cover a heading that carries its own
		// suffix. Word-boundary prefix matching, phase keys exact-only.
		const verdicts = [
			...passingOthers(),
			correctnessFailing("## Synthesis Notes — 'Adopted rider' bullet and 'Grep-scope' bullet"),
		];
		const notes = (body: string) => `## Synthesis Notes\n${body}`;
		const prior = planFrom([phase(3, "phase body"), notes("- old bullet")]);
		const current = planFrom([phase(3, "phase body"), notes("- corrected bullet")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("a ## heading mention inside the finding text cites that section (the created-section case)", async () => {
		// Run d5a9's completeness finding named the missing section only in a
		// parenthetical — "(missing ## Whole-Plan Verification section)" — and
		// the amend CREATED it; that creation must count as cited.
		const verdicts = [
			...passingOthers(),
			correctnessFailing("## Synthesis Notes / 'Adopted rider' bullet (missing ## Whole-Plan Verification section)"),
		];
		const notes = (body: string) => `## Synthesis Notes\n${body}`;
		const wpv = (body: string) => `## Whole-Plan Verification (owned by validate)\n${body}`;
		const prior = planFrom([phase(3, "phase body"), notes("- old bullet")]);
		const current = planFrom([phase(3, "phase body"), notes("- corrected bullet"), wpv("- [ ] npm test")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("phase keys never prefix-match: a phase 1 cite does not cover a touched phase 10", async () => {
		const verdicts = [...passingOthers(), correctnessFailing("Phase 1 > packages/x/y.ts:42")];
		const prior = planFrom([phase(1, "old line"), phase(10, "shared phase 10 content")]);
		const current = planFrom([phase(1, "new line"), phase(10, "shared phase 10 content CHANGED")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual([...PLAN_DIMS].sort());
	});

	it("a ## line inside a fenced code block never becomes a section — the embedded-changelog phantom", async () => {
		// Observed live (run b307): a plan phase embedding a CHANGELOG snippet
		// carries "## [Unreleased]" inside a fence; keying it as a section
		// manufactured a phantom touched key no finding could ever cite, forcing
		// broad on every amend touching the embedded block. Fenced lines
		// attribute to the enclosing phase.
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/CHANGELOG.md")];
		const fenced = (entry: string) =>
			"intro line\n```markdown\n## [Unreleased]\n\n### Added\n\n- " + entry + "\n```\ntail line";
		const prior = planFrom([phase(3, fenced("old changelog entry")), phase(5, "shared phase 5 content")]);
		const current = planFrom([phase(3, fenced("NEW changelog entry")), phase(5, "shared phase 5 content")]);
		expect(await labelsWithPrior(verdicts, prior, current)).toEqual(["correctness"]);
	});

	it("persists the guard's decision beside the prior — reason names the tripped condition", async () => {
		// The instrumentation the always-broad diagnosis lacked: the plan file is
		// later mutated by splice/reconcile, so a post-hoc replay cannot say which
		// fail-closed condition tripped. Every call records its decision.
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		const prior = planFrom([phase(3, "old line"), phase(5, "shared")]);
		const current = planFrom([phase(3, "new line"), phase(5, "shared CHANGED")]);
		await runUnitsWithPrior(verdicts, prior, current, true);
		const decision = JSON.parse(readFileSync(join(tmpDir, ".rpiv/artifacts/priors/p.md.decision.json"), "utf-8"));
		expect(decision.surgical).toBe(false);
		expect(decision.reason).toContain("phase 5");
		expect(decision.touchedSections).toContain("phase 5");
		expect(decision.citedSections).toEqual(["phase 3"]);
	});

	it("confirm arm is unchanged by the guard — a prior present still re-grades ONLY pending", async () => {
		// PLAN_CONFIRM_FANOUT carries no priorChannel ⇒ surgical=false, priorPresent
		// computed from a DIFFERENT (absent) channel ⇒ carry-forward wins. Even with
		// a plan-snapshot prior on the state, plan-confirm emits ONLY correctness.
		const verdicts = [...passingOthers(), correctnessFailing("Phase 3 > packages/x/y.ts:42")];
		const prior = planFrom([phase(3, "old"), phase(5, "shared")]);
		const current = planFrom([phase(3, "new"), phase(5, "shared")]);
		writePriorAndCurrent(prior, current);
		const units = gradeUnits("plan-confirm")({
			cwd: tmpDir,
			artifact: undefined,
			state: {
				named: {
					plans: [{ artifacts: [{ handle: fsHandle(REL) }], data: undefined, kind: "", meta: {} }],
					...citeChannels,
					"plan-verdicts": verdicts,
					"plan-snapshot": [
						{
							artifacts: [{ handle: fsHandle(PRIOR_REL), role: "prior" }],
							data: undefined,
							kind: "",
							meta: {},
						},
					],
				},
			} as unknown as RunView,
		});
		expect((await units).map((u) => u.label)).toEqual(["correctness"]);
	});
});
