/**
 * gate-rosters direct truth tables — the tier machinery and risk-duty folds
 * previously reachable only through the composed workflows: gateTier (tier
 * matrix, missing-signal-never-light, anchor-nit non-escalation), gateRoster
 * (light floor, never-empty), panelRoster (risk joins at every tier when
 * `risks:` declared, absent otherwise, idempotent), shipRoster (verbatim +
 * join), and the duty predicates' semantics (evidenceCitesFileLine's `.match()`
 * contract, procedureSatisfiesDuty, rulingEffectivePass's composition).
 *
 * Phase 3 appends the graph-attached movers: the risk-ruling evidence +
 * verify-at-implement duty route edges, and the risk-rulings panel unit.
 */
import type { EdgeFn } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { SHIP_DIMENSION_FANOUT, shipGatePasses } from "../built-in-workflows.js";
import { findWorkflow } from "../workflow-test-harness.js";
import {
	evidenceCitesFileLine,
	gateRoster,
	gateTier,
	panelRoster,
	procedureSatisfiesDuty,
	type RiskRecord,
	rulingEffectivePass,
	shipRoster,
} from "./gate-rosters.js";
import { planGatePasses } from "./gates.js";
import { PLAN_PANEL_PROGRESS } from "./grade-panel.js";
import { PLAN_DIMENSIONS, RISK_DIMENSION, SHIP_DIMENSIONS, SLICE_DIMENSIONS } from "./verdict-core.js";

const dataRow = (data: Record<string, unknown>): Output =>
	({ kind: "json", artifacts: [], data, meta: {} }) as unknown as Output;
/** An anchor-drift nit — matches `isAnchorNitDetail`'s drift phrasing. */
const NIT = "the anchor citation drifted 3 lines";
/** A real defect phrasing — matches none of the nit regexes. */
const DEFECT = "the plan omits the migration step entirely";
/** A verdict-channel row: `allNits` exercises the severity clamp inside gateTier. */
const verdictRow = (severity: string, allNits: boolean): Output =>
	dataRow({ severity, findings: [{ detail: allNits ? NIT : DEFECT }] });
const view = (named: Record<string, Output[]>): RunView => ({ named }) as unknown as RunView;
/** The slices/plans count signals gateTier reads (`undefined` = signal absent). */
const counts = (slices?: number, phases?: number): Record<string, Output[]> => ({
	...(slices !== undefined ? { slices: [dataRow({ slice_count: slices })] } : {}),
	...(phases !== undefined ? { plans: [dataRow({ phase_count: phases })] } : {}),
});
const risks = (declared: unknown[]): Record<string, Output[]> => ({ plans: [dataRow({ risks: declared })] });

describe("gateTier", () => {
	it("maps the signal matrix: strict at scale or high severity, light at the floor, standard between", () => {
		expect(gateTier(view(counts(5, 2)), "v")).toBe("strict");
		expect(gateTier(view(counts(2, 6)), "v")).toBe("strict");
		expect(gateTier(view({ ...counts(1, 2), v: [verdictRow("high", false)] }), "v")).toBe("strict");
		expect(gateTier(view(counts(1, 2)), "v")).toBe("light");
		expect(gateTier(view(counts(1, 1)), "v")).toBe("light");
		expect(gateTier(view(counts(2, 2)), "v")).toBe("standard");
		expect(gateTier(view(counts(3, 3)), "v")).toBe("standard");
	});

	it("a missing signal never yields light — ambiguity resolves toward scrutiny", () => {
		expect(gateTier(view(counts(undefined, 1)), "v")).toBe("standard");
		expect(gateTier(view(counts(1, undefined)), "v")).toBe("standard");
		expect(gateTier(view({}), "v")).toBe("standard");
	});

	it("an all-nit high verdict is severity-clamped — it never escalates the tier", () => {
		// The clamp lowers the recorded value only: an all-drift-nit high reads
		// low, so a floor-sized run stays light instead of escalating to strict.
		expect(gateTier(view({ ...counts(1, 2), v: [verdictRow("high", true)] }), "v")).toBe("light");
		// A NON-nit medium blocks the light tier — the clamp never reaches it.
		expect(gateTier(view({ ...counts(1, 2), v: [verdictRow("medium", false)] }), "v")).toBe("standard");
	});
});

describe("gateRoster", () => {
	it("light tier keeps the light floor — the two goal-anchored dimensions only", () => {
		expect(gateRoster("light", PLAN_DIMENSIONS)).toEqual(["completeness", "correctness"]);
		expect(gateRoster("standard", PLAN_DIMENSIONS)).toBe(PLAN_DIMENSIONS);
		expect(gateRoster("strict", PLAN_DIMENSIONS)).toBe(PLAN_DIMENSIONS);
	});

	it("never empty — a list with no light-roster member keeps its full list at every tier", () => {
		expect(gateRoster("light", SLICE_DIMENSIONS)).toBe(SLICE_DIMENSIONS);
	});
});

describe("panelRoster", () => {
	/** counts + a latest plans row DECLARING risks — the tier signal and `risks:` share the latest record. */
	const withRisks = (slices: number, phases: number): Record<string, Output[]> => ({
		slices: [dataRow({ slice_count: slices })],
		plans: [dataRow({ phase_count: phases, risks: [{ id: "r1" }] })],
	});

	it("joins the risk unit at EVERY tier when the channel's latest record declares risks:", () => {
		// light: the floor roster plus the risk unit
		expect(panelRoster(view(withRisks(1, 2)), "plans", "v", PLAN_DIMENSIONS)).toEqual([
			"completeness",
			"correctness",
			RISK_DIMENSION,
		]);
		// standard and strict: the full roster plus the risk unit
		expect(panelRoster(view(withRisks(3, 3)), "plans", "v", PLAN_DIMENSIONS)).toEqual([
			...PLAN_DIMENSIONS,
			RISK_DIMENSION,
		]);
		expect(panelRoster(view(withRisks(5, 5)), "plans", "v", PLAN_DIMENSIONS)).toEqual([
			...PLAN_DIMENSIONS,
			RISK_DIMENSION,
		]);
	});

	it("no declared risks ⇒ the tier roster unchanged (light floor, absent/non-array alike)", () => {
		// latest plans row carries the phase_count signal but no `risks:` key
		const noRisksKey = view({ slices: [dataRow({ slice_count: 1 })], plans: [dataRow({ phase_count: 2 })] });
		expect(panelRoster(noRisksKey, "plans", "v", PLAN_DIMENSIONS)).toEqual(["completeness", "correctness"]);
		// a non-array `risks:` degrades the same way — planAuthoredRisks fails open to empty
		const nonArray = view({
			slices: [dataRow({ slice_count: 1 })],
			plans: [dataRow({ phase_count: 2, risks: "nope" })],
		});
		expect(panelRoster(nonArray, "plans", "v", PLAN_DIMENSIONS)).toEqual(["completeness", "correctness"]);
		// no plans channel at all
		expect(panelRoster(view(counts(5, 5)), "plans", "v", PLAN_DIMENSIONS)).toEqual([...PLAN_DIMENSIONS]);
	});

	it("idempotent — a dimensions list already naming the risk dimension is not duplicated", () => {
		const dims = [...PLAN_DIMENSIONS, RISK_DIMENSION];
		const roster = panelRoster(view({ ...counts(1, 2), ...risks([{ id: "r1" }]) }), "plans", "v", dims);
		expect(roster.filter((d) => d === RISK_DIMENSION)).toHaveLength(1);
	});
});

describe("shipRoster", () => {
	it("SHIP_DIMENSIONS verbatim without declared risks; joins the risk unit when the plan declares them", () => {
		expect(shipRoster(view({}))).toEqual(SHIP_DIMENSIONS);
		expect(shipRoster(view(risks([{ id: "r1" }])))).toEqual([...SHIP_DIMENSIONS, RISK_DIMENSION]);
	});
});

describe("evidenceCitesFileLine", () => {
	const mechanics: RiskRecord = { id: "r1", claim_type: "mechanics" };

	it("no authored mechanics risk ⇒ no evidence duty", () => {
		expect(evidenceCitesFileLine({ id: "r1", pass: true })).toBe(true);
		expect(evidenceCitesFileLine({ id: "r1", pass: true }, { id: "r1" })).toBe(true);
	});

	it("a mechanics pass must cite a file:line in evidence — prose or absence demotes", () => {
		expect(evidenceCitesFileLine({ id: "r1", pass: true, evidence: "packages/rpiv-pi/index.ts:12" }, mechanics)).toBe(
			true,
		);
		expect(evidenceCitesFileLine({ id: "r1", pass: true, evidence: "I checked it" }, mechanics)).toBe(false);
		expect(evidenceCitesFileLine({ id: "r1", pass: true }, mechanics)).toBe(false);
	});

	it(".match() semantics — consecutive mechanics checks all match (a /g .test() would alternate on lastIndex)", () => {
		const r = { id: "r1", pass: true, evidence: "packages/rpiv-pi/index.ts:12" };
		expect(evidenceCitesFileLine(r, mechanics)).toBe(true);
		expect(evidenceCitesFileLine(r, mechanics)).toBe(true);
		expect(evidenceCitesFileLine(r, mechanics)).toBe(true);
	});
});

describe("procedureSatisfiesDuty", () => {
	const deferred: RiskRecord = { id: "r1", disposition: "verify-at-implement" };

	it("no authored verify-at-implement risk ⇒ judged in this panel, no duty", () => {
		expect(procedureSatisfiesDuty({ id: "r1", pass: true })).toBe(true);
		expect(procedureSatisfiesDuty({ id: "r1", pass: true }, { id: "r1" })).toBe(true);
	});

	it("a deferred pass must carry a concrete procedure AND a numeric owner phase", () => {
		expect(procedureSatisfiesDuty({ id: "r1", pass: true, procedure: "npm test", owner: 3 }, deferred)).toBe(true);
		expect(procedureSatisfiesDuty({ id: "r1", pass: true, procedure: "npm test" }, deferred)).toBe(false);
		expect(procedureSatisfiesDuty({ id: "r1", pass: true, owner: 3 }, deferred)).toBe(false);
		expect(procedureSatisfiesDuty({ id: "r1", pass: true, procedure: "", owner: 3 }, deferred)).toBe(false);
	});
});

describe("rulingEffectivePass", () => {
	it("bare pass composes with both duties — a duty-demoted pass is not effective", () => {
		const mechanics: RiskRecord = { id: "r1", claim_type: "mechanics" };
		expect(rulingEffectivePass({ id: "r1", pass: true })).toBe(true);
		expect(rulingEffectivePass({ id: "r1", pass: false })).toBe(false);
		expect(rulingEffectivePass({ id: "r1", pass: true }, mechanics)).toBe(false);
		expect(rulingEffectivePass({ id: "r1", pass: true, evidence: "packages/rpiv-pi/index.ts:12" }, mechanics)).toBe(
			true,
		);
	});
});

describe("plan/code gate risk-ruling evidence + verify-at-implement duty (phase 3)", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	// dimVerdict mirrors the audit-drop block helper (the acceptance-channel
	// describe in rpiv-core/built-in-workflows.test.ts): severity floored on pass.
	const dimVerdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "high", ...extra },
		}) as unknown as Output;
	// chan/verdict/gradeLabels mirror the adaptive-gate-scaling block helpers
	// (:3414/:3416/:3425) so the re-open-coherence case can drive the fanout's
	// units() with fresh verdicts.
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
	const citeGreen = { "plan-cite-check": [dimVerdict("structure", true)] };
	// Phase 1 / I1: the duty trigger is now PLAN-sourced. A demotion case publishes
	// the plan's `risks:` frontmatter on the `plans` channel (via the block's
	// existing `chan` helper); the ruling's own `claim_type`/`disposition` are now
	// non-load-bearing — the duty is read off the authored risk, not the ruling.
	const authoredRisks = (risks: Record<string, unknown>[]) => ({ plans: [chan(PLAN, { risks })] });
	// Each case fixes the completeness verdict (always passes) + the ONE
	// correctness verdict carrying the risk ruling under test. correctness MUST
	// appear exactly once: confirmDue keys on the dimension's PREVIOUS verdict,
	// so a stray second blocking `correctness` (as the audit-drop block's
	// `dimsPass` carries) makes the block REPEATED and routes a demoted verdict
	// to plan-FIX instead of plan-CONFIRM. The risk ruling is the only variable
	// per case.
	const mkVerdicts = (risk: Record<string, unknown>[]) => [
		dimVerdict("completeness", true),
		dimVerdict("correctness", true, { risk_rulings: risk }),
	];

	describe("mechanics evidence duty (headline a777 regression)", () => {
		it("a mechanics pass with NO evidence demotes — a single such verdict routes to plan-confirm (does not reach code)", () => {
			// planGatePasses is false (allRiskFlagsPass demotes the mechanics pass);
			// confirmDue sees one blocking verdict (count 1 < 2) ⇒ plan-confirm.
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true, claim_type: "mechanics" }]),
			});
			expect(next).toBe("plan-confirm");
		});

		it("two agreeing demoted mechanics-pass verdicts route to plan-snapshot (still blocked, never code)", () => {
			// count 2 ⇒ confirmDue false ⇒ the confirmed-block path to the snapshot
			// (which deterministically hops to plan-fix), never code.
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": [
					...mkVerdicts([{ id: "r1", pass: true, claim_type: "mechanics" }]),
					dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: true, claim_type: "mechanics" }] }),
				],
			});
			expect(next).toBe("plan-snapshot");
		});

		it("the same mechanics pass WITH a file:line-shaped evidence passes — plan-grade reaches code", () => {
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([
					{
						id: "r1",
						pass: true,
						claim_type: "mechanics",
						evidence: "built-in-workflows.ts:2347 folds rulingEffectivePass",
					},
				]),
			});
			expect(next).toBe("code");
		});
	});

	describe("evidence must be file:line-shaped", () => {
		it("a mechanics pass whose evidence is prose (no file:line) demotes — does not reach code", () => {
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([
					{ id: "r1", pass: true, claim_type: "mechanics", evidence: "the code looks fine to me" },
				]),
			});
			expect(next).not.toBe("code");
		});
	});

	describe("duty is mechanics-scoped (ordinary risks carry no evidence duty)", () => {
		it("a plain {pass:true} risk with no claim_type and no evidence still passes", () => {
			const next = route("plan-demote", {
				...citeGreen,
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true }]),
			});
			expect(next).toBe("code");
		});
	});

	describe("verify-at-implement floor", () => {
		it("a deferred pass with NO procedure demotes — does not reach code", () => {
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", disposition: "verify-at-implement" }]),
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true, disposition: "verify-at-implement" }]),
			});
			expect(next).not.toBe("code");
		});

		it("a deferred pass with a non-empty procedure AND a numeric owner passes — reaches code", () => {
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", disposition: "verify-at-implement" }]),
				"plan-verdicts": mkVerdicts([
					{
						id: "r1",
						pass: true,
						disposition: "verify-at-implement",
						procedure: "npx vitest run built-in-workflows.test.ts",
						owner: 3,
					},
				]),
			});
			expect(next).toBe("code");
		});

		it("a bare 'verify later' (disposition with empty procedure) demotes — does not reach code", () => {
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", disposition: "verify-at-implement" }]),
				"plan-verdicts": mkVerdicts([
					{ id: "r1", pass: true, disposition: "verify-at-implement", procedure: "", owner: 3 },
				]),
			});
			expect(next).not.toBe("code");
		});
	});

	describe("re-open coherence (dimensionsToRegrade clause 3)", () => {
		it("a demoted mechanics pass on a LEGACY correctness verdict re-opens correctness, and the never-ruled risk unit joins it", async () => {
			// full roster (no slices signal ⇒ standard tier); every dimension
			// passes with a FRESH verdict (artifact: PLAN), only correctness
			// carries a demoted mechanics pass ⇒ correctness re-grades (clause 3
			// is dimension-agnostic, so a pre-split trail whose correctness
			// verdict still carries rulings re-opens exactly as before). The plan
			// declares risks: and no `risk-rulings` verdict exists yet, so the
			// risk unit is pending too — never graded ⇒ must grade at least once.
			const verdicts = PLAN_DIMS.map((d) =>
				d === "correctness"
					? verdict(d, true, { artifact: PLAN, risk_rulings: [{ id: "r1", pass: true, claim_type: "mechanics" }] })
					: verdict(d, true, { artifact: PLAN }),
			);
			expect(
				await gradeLabels("plan-grade", {
					plans: [chan(PLAN, { risks: [{ id: "r1", claim_type: "mechanics" }] })],
					"plan-cite-check": [chan(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
					"plan-verdicts": verdicts,
				}),
			).toEqual(["correctness", "risk-rulings"]);
		});
	});

	describe("existing behavior preserved", () => {
		it("a plain {pass:false} risk still blocks (does not reach code)", () => {
			const next = route("plan-demote", {
				...citeGreen,
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: false }]),
			});
			expect(next).not.toBe("code");
		});

		it("an empty risk-flag channel (no rulings) imposes no constraint — passes when dims pass", () => {
			const next = route("plan-demote", {
				...citeGreen,
				"plan-verdicts": [dimVerdict("completeness", true), dimVerdict("correctness", true, { risk_rulings: [] })],
			});
			expect(next).toBe("code");
		});
	});

	describe("plan-sourced duty — the dropped-duty bypass", () => {
		it("a ruling that DROPS its claim_type still demotes when the plan authored a mechanics risk", () => {
			// The headline bypass: the ruling is a bare { id, pass } (no claim_type,
			// no evidence), yet the PLAN authored claim_type:"mechanics" for r1, so the
			// duty still fires off the authored risk and the un-evidenced pass demotes.
			// The old ruling-sourced code could never catch this — it read the ruling's
			// own claim_type, which the panel can simply omit.
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true }]),
			});
			expect(next).toBe("plan-confirm");
		});

		it("an authored risk with no duty fields does not demote a plain pass (fail-open)", () => {
			// The plan authored r1 but gave it no claim_type/disposition, so no duty
			// trigger fires and rulingEffectivePass(r) === r.pass — a plain pass passes.
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1" }]),
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true }]),
			});
			expect(next).toBe("code");
		});

		it("a ruling whose id matches no authored risk fails open (plain pass)", () => {
			// The plan authored r1 (mechanics) but the ruling is for r2 (unauthored):
			// risks.get("r2") is undefined, so r2 carries no duty and its plain pass passes.
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([{ id: "r2", pass: true }]),
			});
			expect(next).toBe("code");
		});
	});

	describe("confirmDue treats a demoted mechanics pass as blocking", () => {
		it("a single demoted mechanics-pass verdict routes to plan-confirm (the ruling gets a second opinion)", () => {
			// same verdicts as the headline single-verdict case; restated here to
			// pin the confirm-arm behavior (riskFail = !rulingEffectivePass ⇒ blocking).
			const next = route("plan-demote", {
				...citeGreen,
				...authoredRisks([{ id: "r1", claim_type: "mechanics" }]),
				"plan-verdicts": mkVerdicts([{ id: "r1", pass: true, claim_type: "mechanics" }]),
			});
			expect(next).toBe("plan-confirm");
		});
	});
});

// ---------------------------------------------------------------------------
// Post-grade duty-demotion write-back — the `plan-demote`/`code-demote` stages
// stamp a `risk_duty_demotions` array onto each demoted verdict's on-disk JSON
// IN PLACE (the medium amend + confirm `--prior` read), without flipping the
// verdict's `pass`. Exercises the stage `run` fn directly (citeCheckRun style)
// against a tmpdir holding a verdict JSON + a `plans` channel carrying `risks:`.
// ---------------------------------------------------------------------------
describe("risk-rulings panel unit (split out of correctness)", () => {
	const build = () => findWorkflow("build");
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const RISKS = [{ id: "r1", claim: "the helper returns early on undefined", claim_type: "mechanics" }];
	const chan = (rel: string, data?: Record<string, unknown>): Output =>
		({ artifacts: [{ handle: fsHandle(rel) }], data, kind: "", meta: {} }) as unknown as Output;
	const verdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [{ handle: fsHandle(`.rpiv/artifacts/verdicts/p__${dimension}__r1.json`) }],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "medium", artifact: PLAN, ...extra },
		}) as unknown as Output;
	// A GREEN citation floor on both channels: the gate predicates fold the
	// floor's own verdict (`allDimensionsPass(state.named["plan-cite-check"])`),
	// so the channel must carry a passing dimension verdict, not a bare handle.
	const citeChannels = {
		"plan-cite-check": [
			chan(".rpiv/artifacts/verdicts/plan-cite-check__p.json", {
				dimension: "citations",
				pass: true,
				severity: "none",
			}),
		],
		"code-cite-check": [
			chan(".rpiv/artifacts/verdicts/code-cite-check__p.json", {
				dimension: "citations",
				pass: true,
				severity: "none",
			}),
		],
	};
	const units = async (stage: string, named: Record<string, unknown>) => {
		const loop = build().stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop.units({ cwd: "/repo", artifact: undefined, state: { named } as unknown as RunView });
	};
	const edge = (stage: string, named: Record<string, unknown>) => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return (e as EdgeFn)({ output: undefined, state: { named } as unknown as RunView });
	};
	const FIVE = ["actionability", "architecture-fit", "completeness", "correctness", "pattern-following"];
	const passingFive = () => FIVE.map((d) => verdict(d, true));

	it("dispatches the risk-rulings unit beside the five dimensions when the plan declares risks:, with bare flags plus nothing correctness-specific", async () => {
		const us = await units("plan-grade", {
			plans: [chan(PLAN, { risks: RISKS })],
			goal: [chan(".rpiv/artifacts/goal/g.md")],
			research: [chan(".rpiv/artifacts/research/r.md")],
			...citeChannels,
			"plan-verdicts": [],
		});
		expect(us.map((u) => u.label).sort()).toEqual([...FIVE, "risk-rulings"].sort());
		const risk = us.find((u) => u.label === "risk-rulings");
		expect(risk?.id).toBe("plans-dim-risk-rulings");
		expect(risk?.prompt).toBe(`--dimension risk-rulings --artifact ${PLAN}`);
		// Correctness keeps its own inputs — the split moves duties, not flags.
		const correctness = us.find((u) => u.label === "correctness");
		expect(correctness?.prompt).toContain("--goal .rpiv/artifacts/goal/g.md");
		expect(correctness?.prompt).toContain("--cite-check");
	});

	it("emits no risk unit when the plan declares no risks: (the lightening quick-plan relies on)", async () => {
		const us = await units("plan-grade", { plans: [chan(PLAN, {})], ...citeChannels, "plan-verdicts": [] });
		expect(us.map((u) => u.label).sort()).toEqual(FIVE);
		expect(build().stages["plan-grade"]?.loop?.kind === "fanout").toBe(true);
	});

	it("joins the light-tier roster too — the duty follows the split out of the light roster's correctness member", async () => {
		const us = await units("code-grade", {
			slices: [chan(".rpiv/artifacts/slices/s.md", { slice_count: 1 })],
			plans: [chan(PLAN, { phase_count: 1, risks: RISKS })],
			...citeChannels,
			"code-verdicts": [],
		});
		expect(us.map((u) => u.label).sort()).toEqual(["completeness", "correctness", "risk-rulings"]);
	});

	it("a failed ruling re-opens ONLY the risk unit, threading its verdict as --prior; a passing correctness carries forward", async () => {
		const failedRisk = verdict("risk-rulings", false, { risk_rulings: [{ id: "r1", pass: false }] });
		const us = await units("plan-grade", {
			plans: [chan(PLAN, { risks: RISKS })],
			...citeChannels,
			"plan-verdicts": [...passingFive(), failedRisk],
		});
		expect(us.map((u) => u.label)).toEqual(["risk-rulings"]);
		expect(us[0]?.prompt).toContain("--prior .rpiv/artifacts/verdicts/p__risk-rulings__r1.json");
	});

	it("a duty-demoted pass (mechanics ruling with no file:line evidence) re-opens the risk unit and fails the gate", async () => {
		const demoted = verdict("risk-rulings", true, {
			risk_rulings: [{ id: "r1", pass: true, claim_type: "mechanics" }],
		});
		const named = {
			plans: [chan(PLAN, { risks: RISKS })],
			...citeChannels,
			"plan-verdicts": [...passingFive(), demoted],
		};
		expect(planGatePasses({ named } as unknown as RunView)).toBe(false);
		expect((await units("plan-grade", named)).map((u) => u.label)).toEqual(["risk-rulings"]);
		const grounded = verdict("risk-rulings", true, {
			risk_rulings: [
				{ id: "r1", pass: true, claim_type: "mechanics", evidence: "packages/x/y.ts:42 — early return" },
			],
		});
		expect(
			planGatePasses({
				named: { ...named, "plan-verdicts": [...passingFive(), grounded] },
			} as unknown as RunView),
		).toBe(true);
	});

	it("the plan gate blocks on a dead risk unit (a dimension-bearing sentinel), and the demote edge routes it as unit-failed", () => {
		const sentinel = {
			artifacts: [],
			kind: "failed",
			meta: {},
			data: { dimension: "risk-rulings" },
		} as unknown as Output;
		const named = {
			plans: [chan(PLAN, { risks: RISKS })],
			...citeChannels,
			"plan-verdicts": [...passingFive(), sentinel],
		};
		expect(planGatePasses({ named } as unknown as RunView)).toBe(false);
		expect(edge("plan-demote", named)).toBe("plan-snapshot");
		// Without a risks: declaration the same sentinel is outside the roster —
		// the five passing dimensions clear the gate.
		expect(planGatePasses({ named: { ...named, plans: [chan(PLAN, {})] } } as unknown as RunView)).toBe(true);
	});

	it("a fresh failed ruling on the risk unit is confirm-worthy (routes plan-confirm), and the confirm panel re-emits only that unit", async () => {
		const failedRisk = verdict("risk-rulings", false, { risk_rulings: [{ id: "r1", pass: false }] });
		const named = {
			plans: [chan(PLAN, { risks: RISKS })],
			...citeChannels,
			"plan-verdicts": [...passingFive(), failedRisk],
		};
		expect(edge("plan-demote", named)).toBe("plan-confirm");
		const us = await units("plan-confirm", named);
		expect(us.map((u) => u.label)).toEqual(["risk-rulings"]);
		expect(us[0]?.prompt).toContain("--prior");
	});

	it("the whole-lap progress hook counts the risk unit as a roster member only when risks are declared", () => {
		const snapshot = {
			artifacts: [],
			kind: "json",
			meta: { ts: "2026-09-20T10:00:00.000Z" },
			data: {},
		} as unknown as Output;
		const at = (o: Output, ts: string): Output => ({ ...o, meta: { ...o.meta, ts } });
		const r1 = [...FIVE.map((d) => at(verdict(d, true), "2026-09-20T09:00:00.000Z"))];
		// Risks declared, but the current round never graded the risk unit: the
		// lap is incomplete — never a waiver on missing evidence.
		expect(
			PLAN_PANEL_PROGRESS({
				named: {
					plans: [chan(PLAN, { risks: RISKS })],
					"plan-snapshot": [snapshot],
					"plan-verdicts": [...r1, ...FIVE.map((d) => at(verdict(d, true), "2026-09-20T11:00:00.000Z"))],
				},
			} as unknown as RunView),
		).toBe("unknown");
		// No risks declared: the same trail folds over the five and improves.
		expect(
			PLAN_PANEL_PROGRESS({
				named: {
					plans: [chan(PLAN, {})],
					"plan-snapshot": [snapshot],
					"plan-verdicts": [
						...FIVE.map((d) => at(verdict(d, d !== "correctness"), "2026-09-20T09:00:00.000Z")),
						...FIVE.map((d) => at(verdict(d, true), "2026-09-20T11:00:00.000Z")),
					],
				},
			} as unknown as RunView),
		).toBe("improved");
	});

	it("ship's tier-independent panel and gate carry the risk unit the same way", async () => {
		const named = {
			plans: [chan(PLAN, { risks: RISKS })],
			research: [chan(".rpiv/artifacts/research/r.md")],
			...citeChannels,
			"ship-verdicts": [],
		};
		const us = await SHIP_DIMENSION_FANOUT.units({
			cwd: "/repo",
			artifact: undefined,
			state: { named } as unknown as RunView,
		});
		expect(us.map((u) => u.label).sort()).toEqual([...SHIP_DIMENSIONS, "risk-rulings"].sort());
		const shipPass = SHIP_DIMENSIONS.map((d) => verdict(d, true));
		const sentinel = {
			artifacts: [],
			kind: "failed",
			meta: {},
			data: { dimension: "risk-rulings" },
		} as unknown as Output;
		expect(
			shipGatePasses({ named: { ...named, "ship-verdicts": [...shipPass, sentinel] } } as unknown as RunView),
		).toBe(false);
		expect(
			shipGatePasses({
				named: {
					...named,
					"ship-verdicts": [
						...shipPass,
						verdict("risk-rulings", true, {
							risk_rulings: [{ id: "r1", pass: true, evidence: "packages/x/y.ts:42" }],
						}),
					],
				},
			} as unknown as RunView),
		).toBe(true);
	});
});
