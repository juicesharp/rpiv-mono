/**
 * gate-passes behavioral suites, moved verbatim from gates.test.ts at the
 * gates layer split: the whole-lap rule core (progressFromRoundCounts), the
 * three panelProgress describes (basename-mode delineation, snapshot-mode
 * cuts, fail-safe pins), and the risk-blind confirmDue-composition it that
 * pins the `verdictBlocks` boundary (verdictBlocks itself imports from its
 * new home ./verdict-core.js). Phase 3's graph-attached movers extend this
 * file with the corpus-replay / adaptive-gate-scaling / unit-failed-routing
 * suites.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EdgeFn } from "@juicesharp/rpiv-workflow";
import { takeRouteNote } from "@juicesharp/rpiv-workflow/internal";
import { fs as fsHandle, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { builtInWorkflows, shipGatePasses } from "../built-in-workflows.js";
import { deriveAndValidate, findWorkflow } from "../workflow-test-harness.js";
import { confirmDue, panelProgress, progressFromRoundCounts } from "./gate-passes.js";
import { codeGatePasses, planGatePasses, sliceGatePasses, unitFailedDimensions } from "./gates.js";
import { seedOnlyFindings } from "./index.js";
import { PLAN_DIMENSIONS, SLICE_DIMENSIONS, verdictBlocks } from "./verdict-core.js";

describe("progressFromRoundCounts (whole-lap rule core)", () => {
	it("maps count trajectories to the four verdicts — counts only, never scores", () => {
		// The signature is the pin: two count parameters, nothing else — no
		// score input exists for the rule core to consult.
		expect(progressFromRoundCounts).toHaveLength(2);
		// Nothing completed behind the current round — the first lap.
		expect(progressFromRoundCounts([], 0)).toBe("unknown");
		expect(progressFromRoundCounts([], 5)).toBe("unknown");
		// Strictly fewer blockers than every earlier round's best.
		expect(progressFromRoundCounts([3], 2)).toBe("improved");
		expect(progressFromRoundCounts([3, 2], 1)).toBe("improved");
		expect(progressFromRoundCounts([2, 1], 0)).toBe("improved");
		// Grew past the immediately previous round.
		expect(progressFromRoundCounts([1], 2)).toBe("regressed");
		expect(progressFromRoundCounts([1, 1, 2], 3)).toBe("regressed");
		// Flat at the best, or between best and last: counted, not waived.
		expect(progressFromRoundCounts([1], 1)).toBe("unchanged");
		expect(progressFromRoundCounts([3, 1], 1)).toBe("unchanged");
		expect(progressFromRoundCounts([1, 3], 2)).toBe("unchanged");
		expect(progressFromRoundCounts([3, 2], 2)).toBe("unchanged");
	});
});

describe("panelProgress — basename-mode round delineation", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	// A basename-mode round re-grades from scratch (the regenerated artifact
	// invalidates prior verdicts), so every round carries the FULL roster under
	// one fresh artifact basename.
	const rosterRound = (blocking: string[], artifact: string, ts: string): Output[] =>
		PLAN_DIMENSIONS.map((d) => verdict(d, !blocking.includes(d), ts, { artifact }));
	const mapRound = (pass: boolean, i: number, ts: string): Output[] =>
		SLICE_DIMENSIONS.map((d) => verdict(d, pass, ts, { artifact: `.rpiv/artifacts/slices/map-${i}.md` }));
	const progress = panelProgress("code-verdicts", PLAN_DIMENSIONS);
	const sliceProgress = panelProgress("slice-verdicts", SLICE_DIMENSIONS);
	// The per-re-entry verdict sequence: after each round lands, the hook reads
	// the channel a re-entering guard would see.
	const trajectory = (rounds: Output[][], read: (channel: Output[]) => string): string[] => {
		const channel: Output[] = [];
		const out: string[] = [];
		for (const r of rounds) {
			channel.push(...r);
			out.push(read(channel));
		}
		return out;
	};
	const view = (verdicts: Output[]): RunView => ({ named: { "code-verdicts": verdicts } }) as unknown as RunView;
	const sliceView = (verdicts: Output[]): RunView => ({ named: { "slice-verdicts": verdicts } }) as unknown as RunView;

	it("four-round converging trail: 3,2,1,1 counts once, then waives twice, then counts", () => {
		const rounds = [
			rosterRound(["completeness", "correctness", "actionability"], ".rpiv/artifacts/plans/m-1.md", iso(10)),
			rosterRound(["completeness", "correctness"], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-3.md", iso(12)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-4.md", iso(13)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "improved", "improved", "unchanged"]);
	});

	it("converged panel: 1,0,0 improves once then holds", () => {
		const rounds = [
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-1.md", iso(10)),
			rosterRound([], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound([], ".rpiv/artifacts/plans/m-3.md", iso(12)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "improved", "unchanged"]);
	});

	it("single-dimension lane: 1,1,1,1 never improves", () => {
		const rounds = [
			mapRound(false, 1, iso(10)),
			mapRound(false, 2, iso(11)),
			mapRound(false, 3, iso(12)),
			mapRound(false, 4, iso(13)),
		];
		expect(trajectory(rounds, (c) => sliceProgress(sliceView(c)))).toEqual([
			"unknown",
			"unchanged",
			"unchanged",
			"unchanged",
		]);
	});

	it("severity-floored nit never blocks: 1,1,2,1 regresses on the third lap only", () => {
		const A1 = ".rpiv/artifacts/plans/m-1.md";
		// Round 1: the floored pattern-following nit (pass:false, severity low) is
		// NON-blocking — the lone blocker is completeness.
		const round1 = [
			...PLAN_DIMENSIONS.filter((d) => d !== "pattern-following" && d !== "completeness").map((d) =>
				verdict(d, true, iso(10), { artifact: A1 }),
			),
			verdict("pattern-following", false, iso(10), { artifact: A1, severity: "low" }),
			verdict("completeness", false, iso(10), { artifact: A1 }),
		];
		const rounds = [
			round1,
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound(["completeness", "correctness"], ".rpiv/artifacts/plans/m-3.md", iso(12)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-4.md", iso(13)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "unchanged", "regressed", "unchanged"]);
	});
});

describe("panelProgress — snapshot-mode cuts, carry-forward, boundary exclusion", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	const snapshotRow = (ts: string): Output =>
		({ artifacts: [], kind: "", meta: { ts }, data: { snapshot_of: PLAN } }) as unknown as Output;
	const planRow = (): Output =>
		({ artifacts: [{ handle: fsHandle(PLAN) }], data: {}, kind: "", meta: {} }) as unknown as Output;
	const progress = panelProgress("plan-verdicts", PLAN_DIMENSIONS, {
		snapshotChannel: "plan-snapshot",
		artifactChannel: "plans",
	});
	const view = (verdicts: Output[], snapshots: Output[]): RunView =>
		({
			named: { plans: [planRow()], "plan-verdicts": verdicts, "plan-snapshot": snapshots },
		}) as unknown as RunView;

	it("the last cut is the CURRENT round until the channel grows past it", () => {
		const r1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(10)),
		);
		const r2 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(11)),
		);
		const s1 = [snapshotRow(iso(10, 30))];
		const s2 = [snapshotRow(iso(11, 30))];
		// Grade re-entry after two laps: nothing follows s2, so s2 closes the
		// CURRENT round — the earlier set is [3] only, current fold is 3.
		expect(progress(view([...r1, ...r2], [...s1, ...s2]))).toBe("unchanged");
		// Round 3 grades the same three blockers, then its confirm OVERTURNS two
		// of them — the whole-channel fold drops to 1 while both cuts now close
		// completed rounds: earlier [3,3], current 1 ⇒ improved.
		const r3 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(12)),
		);
		const confirm = [verdict("correctness", true, iso(12, 20)), verdict("actionability", true, iso(12, 20))];
		expect(progress(view([...r1, ...r2, ...r3, ...confirm], [...s1, ...s2]))).toBe("improved");
	});

	it("a dimension graded only in round 1 still counts in round 2's cumulative fold", () => {
		const r1 = PLAN_DIMENSIONS.map((d) => verdict(d, d !== "correctness", iso(10))); // 1 blocking
		// Round 2 re-grades every dimension EXCEPT the still-blocking one — its
		// round-1 verdict carries forward into the current fold.
		const r2 = PLAN_DIMENSIONS.filter((d) => d !== "correctness").map((d) => verdict(d, true, iso(11)));
		const s1 = [snapshotRow(iso(10, 30))];
		// Carried blocker keeps the current count at 1 — unchanged, NOT the
		// "improved" a dropped carry would manufacture.
		expect(progress(view([...r1, ...r2], s1))).toBe("unchanged");
	});
});

describe("panelProgress — fail-safe pins", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	const sentinel = (dimension: string, ts: string): Output =>
		({ artifacts: [], kind: "failed", meta: { ts }, data: { dimension } }) as unknown as Output;
	const snapshotRow = (ts: string): Output =>
		({ artifacts: [], kind: "", meta: { ts }, data: { snapshot_of: PLAN } }) as unknown as Output;
	const planRow = (): Output =>
		({ artifacts: [{ handle: fsHandle(PLAN) }], data: {}, kind: "", meta: {} }) as unknown as Output;
	const basenameProgress = panelProgress("code-verdicts", PLAN_DIMENSIONS);
	const snapshotProgress = panelProgress("plan-verdicts", PLAN_DIMENSIONS, {
		snapshotChannel: "plan-snapshot",
		artifactChannel: "plans",
	});

	it("a roster dimension absent from the current fold reads unknown — never waived on missing evidence", () => {
		const r1 = [verdict("completeness", false, iso(10))]; // partial first round
		const r2 = [verdict("correctness", true, iso(11))];
		const s1 = [snapshotRow(iso(10, 30))];
		// The cumulative fold carries completeness's blocker, but three roster
		// dimensions were never graded at all — the round is incomplete.
		expect(
			snapshotProgress({
				named: { plans: [planRow()], "plan-verdicts": [...r1, ...r2], "plan-snapshot": s1 },
			} as unknown as RunView),
		).toBe("unknown");
	});

	it("a failed-unit sentinel counts blocking — it cannot waive the lap", () => {
		const round1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, d !== "completeness", iso(10), { artifact: ".rpiv/artifacts/plans/m-1.md" }),
		);
		const round2 = [
			...PLAN_DIMENSIONS.filter((d) => d !== "completeness").map((d) =>
				verdict(d, true, iso(11), { artifact: ".rpiv/artifacts/plans/m-2.md" }),
			),
			sentinel("completeness", iso(11)),
		];
		// The sentinel is completeness's latest entry with no pass/severity —
		// blocking. Without it the current group would be missing the dimension
		// (unknown) or pass-only (a spurious improved); it reads unchanged.
		expect(
			basenameProgress({
				named: { "code-verdicts": [...round1, ...round2] },
			} as unknown as RunView),
		).toBe("unchanged");
	});

	it("a passed dimension with a failed risk ruling contributes zero blocking — risk-blind", () => {
		const round1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, d !== "completeness", iso(10), { artifact: ".rpiv/artifacts/plans/m-1.md" }),
		);
		const round2 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, true, iso(11), {
				artifact: ".rpiv/artifacts/plans/m-2.md",
				...(d === "completeness" ? { risk_rulings: [{ id: "r1", pass: false }] } : {}),
			}),
		);
		// The predicate folds dimension verdicts only — risk rulings are the
		// confirm gate's composition, never the progress hook's: every dimension
		// passes, so the lap improves despite the failed ruling.
		expect(
			basenameProgress({
				named: { "code-verdicts": [...round1, ...round2] },
			} as unknown as RunView),
		).toBe("improved");
	});
});

describe("confirmDue — risk-blind verdictBlocks boundary", () => {
	it("is risk-blind: a passing verdict with a failed risk ruling stays non-blocking, while confirmDue's composition still blocks", () => {
		const verdict = {
			dimension: "correctness",
			pass: true,
			severity: "low",
			risk_rulings: [{ id: "r1", pass: false }],
		};
		expect(verdictBlocks(verdict)).toBe(false);
		const state: RunView = {
			originalInput: "",
			output: undefined,
			named: {
				"plan-verdicts": [
					{
						kind: "artifacts",
						artifacts: [],
						data: verdict,
						meta: { stage: "plan-grade", stageNumber: 1, ts: "2026-09-05T00:00:00.000Z", runId: "run-1" },
					},
				],
			},
		};
		expect(confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS)).toBe(true);
	});
});

describe("design-readiness corpus replay (trail-derived shapes)", () => {
	type CorpusRow = {
		class: string;
		pass: boolean;
		remedy?: string;
		findings: { requires?: string }[];
	};
	const corpus = JSON.parse(
		readFileSync(fileURLToPath(new URL("./__fixtures__/design-readiness-corpus.json", import.meta.url)), "utf-8"),
	) as { _meta: Record<string, unknown>; rows: CorpusRow[] };

	it("carries the ledger census: 19 fail shapes, 16 bookkeeping, 3 structural", () => {
		expect(corpus.rows).toHaveLength(19);
		expect(corpus.rows.filter((r) => r.class === "bookkeeping")).toHaveLength(16);
		expect(corpus.rows.filter((r) => r.class === "structural")).toHaveLength(3);
		expect(corpus.rows.every((r) => r.pass === false)).toBe(true);
	});

	it("classifies exactly the marker-emitted bookkeeping shapes seed-only; structural never", () => {
		const seedOnly = corpus.rows.filter((r) => seedOnlyFindings(r));
		expect(seedOnly).toHaveLength(8);
		expect(seedOnly.every((r) => r.class === "bookkeeping" && r.remedy === "cite")).toBe(true);
		// fail-closed: a structural demand (a re-cut) never routes to the lift
		expect(corpus.rows.filter((r) => r.class === "structural").every((r) => !seedOnlyFindings(r))).toBe(true);
		// the marker-omitted bookkeeping half carries no `requires` on the trail
		// and classifies not seed-only today — the grade skill's requires
		// emission contract owns that residual, not the engine
		expect(corpus.rows.filter((r) => r.class === "bookkeeping" && !seedOnlyFindings(r))).toHaveLength(8);
	});
});

// ---------------------------------------------------------------------------
// Audit-drop regression suite — the gate/routing/identity fixes.
// ---------------------------------------------------------------------------

describe("build adaptive gate scaling (tier / roster / freshness / confirm)", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	const chan = (rel: string, data?: Record<string, unknown>): Output =>
		({ artifacts: [{ handle: fsHandle(rel) }], data, kind: "", meta: {} }) as unknown as Output;
	const verdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "medium", ...extra },
		}) as unknown as Output;
	const route = (stage: string, named: Record<string, unknown>) =>
		edge(stage)({ output: undefined, state: { named } as unknown as RunView });
	const gradeLabels = async (stage: string, named: Record<string, unknown>) => {
		const loop = build().stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		const units = await loop.units({ cwd: "/repo", artifact: undefined, state: { named } as unknown as RunView });
		return units.map((u) => u.label).sort();
	};

	const PLAN_DIMS = ["actionability", "architecture-fit", "completeness", "correctness", "pattern-following"];
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const lightSignals = {
		slices: [chan(".rpiv/artifacts/slices/s.md", { slice_count: 1 })],
		plans: [chan(PLAN, { phase_count: 1 })],
	};
	// The fail-closed cite contract: every cite-configured panel requires its
	// floor's verdict on the state (citeCheckFlag throws otherwise) — spread at
	// every gradeLabels site below (route sites construct their own channels).
	const citeChannels = {
		"plan-cite-check": [chan(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
		"code-cite-check": [chan(".rpiv/artifacts/verdicts/code-cite-check__p.json")],
	};

	describe("tier → roster", () => {
		it("light tier (1 slice, 1 phase, clean channel) grades correctness+completeness only", async () => {
			expect(await gradeLabels("plan-grade", { ...lightSignals, ...citeChannels, "plan-verdicts": [] })).toEqual([
				"completeness",
				"correctness",
			]);
		});

		it("missing signals never yield light — full roster", async () => {
			expect(await gradeLabels("plan-grade", { plans: [chan(PLAN)], ...citeChannels, "plan-verdicts": [] })).toEqual(
				PLAN_DIMS,
			);
		});

		it("strict signals (slice_count >= 5) keep the full roster", async () => {
			expect(
				await gradeLabels("plan-grade", {
					slices: [chan(".rpiv/artifacts/slices/s.md", { slice_count: 7 })],
					plans: [chan(PLAN, { phase_count: 1 })],
					...citeChannels,
					"plan-verdicts": [],
				}),
			).toEqual(PLAN_DIMS);
		});

		it("a medium verdict on the channel lifts a light run out of the light tier (roster widens)", async () => {
			const labels = await gradeLabels("plan-grade", {
				...lightSignals,
				...citeChannels,
				"plan-verdicts": [verdict("correctness", false)],
			});
			expect(labels).toEqual(PLAN_DIMS);
		});

		it("the slice gate keeps design-readiness at light tier (a roster never empties)", async () => {
			expect(await gradeLabels("slice-grade", { ...lightSignals, "slice-verdicts": [] })).toEqual([
				"design-readiness",
			]);
		});

		it("the code gate reads its own channel's severities for the tier", async () => {
			// Light signals + a medium fail on plan-verdicts must NOT lift the CODE
			// gate's tier — its channel is code-verdicts.
			expect(
				await gradeLabels("code-grade", {
					...lightSignals,
					...citeChannels,
					"plan-verdicts": [verdict("correctness", false)],
					"code-verdicts": [],
				}),
			).toEqual(["completeness", "correctness"]);
		});
	});

	describe("verdict freshness (artifact-identity invalidation)", () => {
		it("verdicts judged against a REPLACED artifact do not carry — full re-grade", async () => {
			const stale = PLAN_DIMS.map((d) => verdict(d, true, { artifact: ".rpiv/artifacts/plans/old.md" }));
			expect(
				await gradeLabels("plan-grade", { plans: [chan(PLAN)], ...citeChannels, "plan-verdicts": stale }),
			).toEqual(PLAN_DIMS);
		});

		it("verdicts judged against the CURRENT artifact carry — only the failing dimension re-grades", async () => {
			const verdicts = PLAN_DIMS.map((d) => verdict(d, d !== "correctness", { artifact: PLAN }));
			expect(
				await gradeLabels("plan-grade", { plans: [chan(PLAN)], ...citeChannels, "plan-verdicts": verdicts }),
			).toEqual(["correctness"]);
		});

		it("slice-check does NOT skip the re-grade after a re-slice (stale design-readiness verdict)", () => {
			expect(
				route("slice-check", {
					slices: [chan(".rpiv/artifacts/slices/s2.md", { slice_count: 1 })],
					"slice-check": [verdict("structure", true)],
					"slice-verdicts": [verdict("design-readiness", true, { artifact: ".rpiv/artifacts/slices/s1.md" })],
				}),
			).toBe("slice-grade");
		});

		it("slice-check still skips when the passing verdict matches the current slice map", () => {
			expect(
				route("slice-check", {
					slices: [chan(".rpiv/artifacts/slices/s2.md", { slice_count: 1 })],
					"slice-check": [verdict("structure", true)],
					"slice-verdicts": [verdict("design-readiness", true, { artifact: ".rpiv/artifacts/slices/s2.md" })],
				}),
			).toBe("slice-design");
		});

		it("slice-check skips the re-grade when its verdict discharges a cite-only fail for the CURRENT map", () => {
			// The design-readiness fail is stale (it judged s1, the fix re-sliced to
			// s2), so the verdict fold can never pass — the citeDischarged stamp is
			// the only green path, and it must key to the current map's basename.
			expect(
				route("slice-check", {
					slices: [chan(".rpiv/artifacts/slices/s2.md", { slice_count: 1 })],
					"slice-check": [verdict("structure", true, { citeDischarged: "s2.md" })],
					"slice-verdicts": [
						verdict("design-readiness", false, { artifact: ".rpiv/artifacts/slices/s1.md", remedy: "cite" }),
					],
				}),
			).toBe("slice-design");
		});

		it("a citeDischarged stamp keyed to an OLDER map does not carry to a newer re-slice", () => {
			expect(
				route("slice-check", {
					slices: [chan(".rpiv/artifacts/slices/s3.md", { slice_count: 1 })],
					"slice-check": [verdict("structure", true, { citeDischarged: "s2.md" })],
					"slice-verdicts": [
						verdict("design-readiness", false, { artifact: ".rpiv/artifacts/slices/s1.md", remedy: "cite" }),
					],
				}),
			).toBe("slice-grade");
		});
	});

	describe("seed-only cite-remedy routing (three-way grade edge / stuck check edge)", () => {
		const T_JUDGED2 = "2026-09-03T11:21:26.000Z";
		const T_VERDICT2 = "2026-09-03T11:28:03.000Z";
		const T_LIFT = "2026-09-03T11:31:00.000Z";
		const T_RESLICE = "2026-09-03T11:35:04.000Z";
		const MAP = ".rpiv/artifacts/slices/s2.md";
		const tsVerdict = (pass: boolean, extra: Record<string, unknown> = {}, ts = T_VERDICT2): Output =>
			({
				artifacts: [],
				kind: "json",
				meta: { ts },
				data: { dimension: "design-readiness", pass, severity: pass ? "none" : "medium", ...extra },
			}) as unknown as Output;
		const tsChan = (rel: string, data: Record<string, unknown>, ts: string): Output =>
			({ artifacts: [{ handle: fsHandle(rel) }], data, kind: "", meta: { ts } }) as unknown as Output;
		const tsLift = (ts: string): Output =>
			({ artifacts: [], kind: "json", meta: { ts }, data: { lifted: [], skipped: [] } }) as unknown as Output;
		const SEEDS = [
			{ detail: "under-cited", where: "## Slice 2", requires: "src/alpha.ts:18-25" },
			{ detail: "under-cited", where: "## Slice 3", requires: "src/beta.ts:30-40" },
		];
		const STRUCTURE_PASS = { "slice-check": [verdict("structure", true)] };

		it("a seed-only fail (remedy cite) routes slice-grade to slice-seed-lift, never slice-fix", () => {
			expect(
				route("slice-grade", {
					slices: [chan(MAP, { slice_count: 2 })],
					...STRUCTURE_PASS,
					"slice-verdicts": [tsVerdict(false, { remedy: "cite", findings: SEEDS })],
				}),
			).toBe("slice-seed-lift");
		});

		it("a remedy-absent seed-only fail routes the same way (the omitted-marker leak, closed engine-side)", () => {
			expect(
				route("slice-grade", {
					slices: [chan(MAP, { slice_count: 2 })],
					...STRUCTURE_PASS,
					"slice-verdicts": [tsVerdict(false, { findings: SEEDS })],
				}),
			).toBe("slice-seed-lift");
		});

		it("a verdict mixing one finding without requires routes to slice-fix (today's path preserved)", () => {
			expect(
				route("slice-grade", {
					slices: [chan(MAP, { slice_count: 2 })],
					...STRUCTURE_PASS,
					"slice-verdicts": [
						tsVerdict(false, {
							remedy: "cite",
							findings: [{ detail: "bundles two decisions", where: "## Slice 1" }, ...SEEDS],
						}),
					],
				}),
			).toBe("slice-fix");
		});

		it("a lone no-requires finding routes to slice-fix the same way", () => {
			expect(
				route("slice-grade", {
					slices: [chan(MAP, { slice_count: 2 })],
					...STRUCTURE_PASS,
					"slice-verdicts": [
						tsVerdict(false, { findings: [{ detail: "an epic spanning two verticals", where: "## Slice 1" }] }),
					],
				}),
			).toBe("slice-fix");
		});

		it("after a lift publication + clean structure stamp, slice-check routes straight to slice-design (no re-grade)", () => {
			expect(
				route("slice-check", {
					slices: [chan(MAP, { slice_count: 2 })],
					"slice-check": [verdict("structure", true, { citeDischarged: "s2.md" })],
					"slice-verdicts": [tsVerdict(false, { remedy: "cite", findings: SEEDS, artifact: MAP })],
					"slice-seed-lift": [tsLift(T_LIFT)],
				}),
			).toBe("slice-design");
		});

		it("a lift that left the gate red is stuck: slice-check routes to slice-fix, not another grade", () => {
			expect(
				route("slice-check", {
					slices: [tsChan(MAP, { slice_count: 2 }, T_JUDGED2)],
					"slice-check": [verdict("structure", true)], // no stamp — a seed was skipped
					"slice-verdicts": [tsVerdict(false, { remedy: "cite", findings: SEEDS, artifact: MAP })],
					"slice-seed-lift": [tsLift(T_LIFT)],
				}),
			).toBe("slice-fix");
		});

		it("a slices publication postdating the lift un-sticks the loop: slice-check routes to slice-grade", () => {
			expect(
				route("slice-check", {
					slices: [
						tsChan(MAP, { slice_count: 2 }, T_JUDGED2),
						tsChan(".rpiv/artifacts/slices/s3.md", { slice_count: 2 }, T_RESLICE),
					],
					"slice-check": [verdict("structure", true)],
					"slice-verdicts": [tsVerdict(false, { remedy: "cite", findings: SEEDS, artifact: MAP })],
					"slice-seed-lift": [tsLift(T_LIFT)],
				}),
			).toBe("slice-grade");
		});

		it("a dead design-readiness unit takes the fix arm with the unit-failed note, AHEAD of the seed-only arm", () => {
			// Upstream composition: a dimension-bearing sentinel is never a
			// classification candidate — there is no verdict to classify — so the
			// unit-failed arm fires before the seed-only check even with a prior
			// seed-only verdict on the channel; the note is the observable that
			// distinguishes the arm order (the seed-only fallthrough reaches the
			// same target WITHOUT a note).
			const named = {
				slices: [chan(MAP, { slice_count: 2 })],
				...STRUCTURE_PASS,
				"slice-verdicts": [
					tsVerdict(false, { remedy: "cite", findings: SEEDS }),
					{
						artifacts: [],
						kind: "failed",
						meta: { ts: T_LIFT },
						data: { reason: "grade produced no verdict", dimension: "design-readiness" },
					} as unknown as Output,
				],
			};
			expect(route("slice-grade", named)).toBe("slice-fix");
			expect(takeRouteNote(edge("slice-grade"))).toBe("unit-failed: design-readiness produced no verdict");
		});
	});

	describe("confirm-before-block", () => {
		const passRest = PLAN_DIMS.filter((d) => d !== "correctness").map((d) => verdict(d, true));

		it("plan-grade sends a first-time MEDIUM blocker straight to plan-snapshot (severity-gated confirm)", () => {
			// Run telemetry priced the confirm out of the medium class (~13:1
			// onward-to-fix vs overturn): amend is surgical and cheap, and the
			// delta re-grade guard keeps the re-judgment narrow.
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false)],
				}),
			).toBe("plan-snapshot");
		});

		it("plan-grade routes a dimension's first HIGH blocking verdict to plan-confirm", () => {
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false, { severity: "high" })],
				}),
			).toBe("plan-confirm");
		});

		it("plan-grade routes a FLAP (a carried pass regressing to a block) to plan-confirm, whatever the severity", () => {
			// The dimension previously passed and now blocks on the same artifact —
			// the exact single-judge instability the confirm exists to adjudicate.
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", true), verdict("correctness", false)],
				}),
			).toBe("plan-confirm");
		});

		it("plan-grade routes to plan-snapshot once the blocker has two judgments behind it", () => {
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false), verdict("correctness", false)],
				}),
			).toBe("plan-snapshot");
		});

		it("plan-grade routes to plan-snapshot when only the citation floor is red (no dimension blocking)", () => {
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", false)],
					"plan-verdicts": [...passRest, verdict("correctness", true)],
				}),
			).toBe("plan-snapshot");
		});

		it("plan-confirm clears the gate when the second judgment passes (latest-per-dimension wins)", () => {
			expect(
				route("plan-confirm", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false), verdict("correctness", true)],
				}),
			).toBe("code");
		});

		it("plan-confirm routes a CONFIRMED blocker to plan-snapshot", () => {
			expect(
				route("plan-confirm", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false), verdict("correctness", false)],
				}),
			).toBe("plan-snapshot");
		});

		it("a first-time risk-flag fail routes to confirm (the ruling gets a second opinion)", () => {
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [
						...passRest,
						verdict("correctness", true, { severity: "none", risk_rulings: [{ id: "r1", pass: false }] }),
					],
				}),
			).toBe("plan-confirm");
		});

		it("code-grade mirrors the contract on its own channel (HIGH confirms, medium goes to the fix)", () => {
			expect(
				route("code-demote", {
					plans: [chan(PLAN)],
					"code-cite-check": [verdict("structure", true)],
					"code-verdicts": [...passRest, verdict("correctness", false, { severity: "high" })],
				}),
			).toBe("code-confirm");
			expect(
				route("code-demote", {
					plans: [chan(PLAN)],
					"code-cite-check": [verdict("structure", true)],
					"code-verdicts": [...passRest, verdict("correctness", false)],
				}),
			).toBe("code-snapshot");
		});

		it("declares the confirm arms as edge targets", () => {
			expect([...(edge("plan-demote").targets ?? [])].sort()).toEqual(["code", "plan-confirm", "plan-snapshot"]);
			expect([...(edge("plan-confirm").targets ?? [])].sort()).toEqual(["code", "plan-snapshot"]);
			expect([...(edge("code-demote").targets ?? [])].sort()).toEqual([
				"code-confirm",
				"code-snapshot",
				"implement",
			]);
			expect([...(edge("code-confirm").targets ?? [])].sort()).toEqual(["code-snapshot", "implement"]);
		});

		it("the confirm stages publish to their gates' verdict channels", () => {
			expect(build().stages["plan-confirm"]?.outcome?.name).toBe("plan-verdicts");
			expect(build().stages["code-confirm"]?.outcome?.name).toBe("code-verdicts");
		});
	});

	it("build still validates with zero errors (confirm stages wired structurally sound)", () => {
		expect(deriveAndValidate(build()).filter((i) => i.severity === "error")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// build validate dispatch — the run-start baseline threads into validate so
// working-tree scope criteria judge the run's own delta, not pre-existing
// dirt (which the commit skill already fences off via the same snapshot).
// ---------------------------------------------------------------------------

describe("grade panel unit-failed routing (dimension-bearing sentinels)", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	const chan = (rel: string, data?: Record<string, unknown>): Output =>
		({ artifacts: [{ handle: fsHandle(rel) }], data, kind: "", meta: {} }) as unknown as Output;
	const verdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "medium", ...extra },
		}) as unknown as Output;
	const sentinel = (dimension: string, reason = "grade produced no verdict"): Output =>
		({ artifacts: [], kind: "failed", meta: {}, data: { reason, dimension } }) as unknown as Output;
	const state = (named: Record<string, unknown>) => ({ named }) as unknown as RunView;
	const route = (stage: string, named: Record<string, unknown>) =>
		edge(stage)({ output: undefined, state: state(named) });

	const PLAN = ".rpiv/artifacts/plans/p.md";
	const PLAN_DIMS = ["actionability", "architecture-fit", "completeness", "correctness", "pattern-following"];
	const passRest = PLAN_DIMS.filter((d) => d !== "actionability").map((d) => verdict(d, true));
	const codeGate = (verdicts: Output[]) => ({
		plans: [chan(PLAN)],
		"code-cite-check": [verdict("structure", true)],
		"code-verdicts": verdicts,
	});
	const planGate = (verdicts: Output[]) => ({
		plans: [chan(PLAN)],
		"plan-cite-check": [verdict("structure", true)],
		"plan-verdicts": verdicts,
	});

	it("wiring: the six grade-panel loops and build's elaborate + slice-design fanouts opt into retryHaltedUnits: 1; every other fanout stays without it", () => {
		const expected = [
			"build:code",
			"build:code-confirm",
			"build:code-grade",
			"build:plan-confirm",
			"build:plan-grade",
			"build:slice-design",
			"build:slice-grade",
			"meta:implement-grade",
			"meta:plan-grade",
			"meta:research-grade",
			"ship:grade",
		];
		const optedIn: string[] = [];
		for (const wf of builtInWorkflows) {
			for (const [stage, def] of Object.entries(wf.stages)) {
				const loop = def?.loop;
				if (loop?.kind !== "fanout") continue;
				if (loop.retryHaltedUnits !== undefined) optedIn.push(`${wf.name}:${stage}`);
			}
		}
		expect(optedIn.sort()).toEqual(expected);
		for (const stage of ["slice-grade", "plan-grade", "plan-confirm", "code", "code-grade", "code-confirm"]) {
			const loop = build().stages[stage]?.loop;
			expect(loop?.kind).toBe("fanout");
			if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
			expect(loop.retryHaltedUnits).toBe(1);
		}
		const shipLoop = findWorkflow("ship").stages.grade?.loop;
		expect(shipLoop?.kind).toBe("fanout");
		if (shipLoop?.kind !== "fanout") throw new Error("ship grade stage has no fanout loop");
		expect(shipLoop.retryHaltedUnits).toBe(1);
	});

	it("gate fold: four passing dimensions + one dimension-bearing sentinel ⇒ every gate fails; the dead dimension is named", () => {
		const slice = state({
			slices: [chan(".rpiv/artifacts/slices/s.md")],
			"slice-check": [verdict("structure", true)],
			"slice-verdicts": [sentinel("design-readiness")],
		});
		expect(sliceGatePasses(slice)).toBe(false);
		expect(unitFailedDimensions(slice, "slices", "slice-verdicts", ["design-readiness"])).toEqual([
			"design-readiness",
		]);
		const plan = state(planGate([...passRest, sentinel("actionability")]));
		expect(planGatePasses(plan)).toBe(false);
		const code = state(codeGate([...passRest, sentinel("actionability")]));
		expect(codeGatePasses(code)).toBe(false);
		expect(unitFailedDimensions(code, "plans", "code-verdicts", PLAN_DIMS)).toEqual(["actionability"]);
		const ship = state({
			plans: [chan(PLAN)],
			"ship-verdicts": [verdict("completeness", true), verdict("correctness", true), sentinel("architecture-fit")],
		});
		expect(shipGatePasses(ship)).toBe(false);
	});

	it("f9a6 regression (red-today): the sentinel's index overwrite erased the stale round-1 medium fail — the gate passed on four survivors; with the dimension it blocks", () => {
		// The exact f9a6 channel: the dead unit's sentinel sits at actionability's
		// index, having overwritten the stale 13:49:57 medium fail.
		const s = state(codeGate([...passRest, sentinel("actionability")]));
		expect(unitFailedDimensions(s, "plans", "code-verdicts", PLAN_DIMS)).toEqual(["actionability"]);
		// The route folds it: fix arm + note (on the pre-change tree the
		// dimensionless sentinel is skipped and the gate routes onward).
		expect(route("code-demote", codeGate([...passRest, sentinel("actionability")]))).toBe("code-snapshot");
		expect(takeRouteNote(edge("code-demote"))).toBe("unit-failed: actionability produced no verdict");
	});

	it("red-first mirror: stale-fail-then-sentinel latest-wins at the fold; the UNFILLED-slot variant blocks WITHOUT being unit-failed", () => {
		// Latest-wins: the sentinel follows the stale fail as the dimension's
		// latest entry — blocking, with the dimension named for routing.
		const staleThenSentinel = state(
			codeGate([verdict("actionability", false), ...passRest, sentinel("actionability")]),
		);
		expect(codeGatePasses(staleThenSentinel)).toBe(false);
		expect(unitFailedDimensions(staleThenSentinel, "plans", "code-verdicts", PLAN_DIMS)).toEqual(["actionability"]);
		// The unfilled-slot mirror (infra death, no sentinel at all): the stale
		// fail stays the dimension's latest entry and blocks — the dimension
		// stays pending in dimensionsToRegrade — but is NOT unit-failed.
		const staleOnly = state(codeGate([verdict("actionability", false), ...passRest]));
		expect(codeGatePasses(staleOnly)).toBe(false);
		expect(unitFailedDimensions(staleOnly, "plans", "code-verdicts", PLAN_DIMS)).toEqual([]);
	});

	it("plan-demote does NOT divert to confirm on a unit-failed block, even when the dimension previously passed", () => {
		// The dead unit was actionability's re-grade; its round-1 pass makes
		// prevBlocking === false — exactly the flap shape confirmDue diverts on.
		// The unit-failed preemption fires FIRST: fix arm + note, no confirm
		// session for a dimension with no verdict to adjudicate.
		const named = planGate([verdict("actionability", true), ...passRest, sentinel("actionability")]);
		expect(route("plan-demote", named)).toBe("plan-snapshot");
		expect(takeRouteNote(edge("plan-demote"))).toContain("unit-failed");
	});

	it("an ordinary (non-sentinel) fail still routes through confirmDue unchanged — no note", () => {
		expect(route("plan-demote", planGate([...passRest, verdict("actionability", false, { severity: "high" })]))).toBe(
			"plan-confirm",
		);
		expect(takeRouteNote(edge("plan-demote"))).toBeUndefined();
	});

	it("slice-grade routes a dead design-readiness unit to slice-fix with the note", () => {
		const named = {
			slices: [chan(".rpiv/artifacts/slices/s.md")],
			"slice-check": [verdict("structure", true)],
			"slice-verdicts": [sentinel("design-readiness")],
		};
		expect(route("slice-grade", named)).toBe("slice-fix");
		expect(takeRouteNote(edge("slice-grade"))).toBe("unit-failed: design-readiness produced no verdict");
	});

	it("ship's grade stop names unit-failed dimensions ahead of severity blockers", () => {
		const shipEdge = findWorkflow("ship").edges.grade;
		if (typeof shipEdge !== "function") throw new Error("ship grade edge is not an EdgeFn");
		const s = state({
			plans: [chan(PLAN)],
			"ship-verdicts": [verdict("completeness", true), verdict("correctness", true), sentinel("architecture-fit")],
		});
		expect(shipEdge({ state: s, output: undefined })).toBe("stop");
		expect(takeRouteNote(shipEdge)).toBe("unit-failed: architecture-fit produced no verdict");
	});
});

// ---------------------------------------------------------------------------
// Whole-lap progress declarations — every stage the backward-jump guard can
// re-enter in the three quality-panel lanes carries the lane's ONE
// panelProgress instance, so a lap reads as a single unit at every counted
// destination. The synthetic states below replay the channel shapes each
// re-entry point actually sees (snapshot cuts, confirm overturns, seed lifts).
// ---------------------------------------------------------------------------
