/**
 * priors.test.ts — prior-sidecar publication off the plans channel and the
 * plan/code demote route edges, moved verbatim from built-in-workflows.test.ts.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EdgeFn, Output, RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

describe("plan/code gate duty-demotion write-back (plan-demote / code-demote)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-demote-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const build = () => findWorkflow("build");
	const demoteRun = (stage: "plan-demote" | "code-demote") => {
		const run = build().stages[stage]?.run;
		if (!run) throw new Error(`build ${stage} stage has no run function`);
		return run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const V = ".rpiv/artifacts/verdicts/v.json";
	// `plans` channel entry carrying authored `risks:` (plan-sourced duty trigger).
	const plansWith = (risks: Record<string, unknown>[]) =>
		({ artifacts: [{ handle: fsHandle(PLAN) }], data: { risks }, kind: "", meta: {} }) as unknown as Output;
	// Write a verdict JSON to disk AND return the in-memory Output whose fs handle
	// points at it — keeping the two consistent (the grade panel writes the JSON;
	// the collector parses it back into Output.data, so o.data ≈ disk JSON).
	const verdictFile = (rel: string, data: Record<string, unknown>) => {
		mkdirSync(join(tmpDir, dirname(rel)), { recursive: true });
		writeFileSync(join(tmpDir, rel), JSON.stringify(data));
		return { artifacts: [{ handle: fsHandle(rel) }], kind: "json", meta: {}, data } as unknown as Output;
	};
	const runPlanDemote = (plans: Output, verdicts: Output[]) =>
		demoteRun("plan-demote")({
			cwd: tmpDir,
			input: undefined,
			state: { named: { plans: [plans], "plan-verdicts": verdicts } } as unknown as RunView,
		});

	it("writes risk_duty_demotions onto a demoted mechanics-pass verdict and echoes the record", () => {
		// A mechanics pass with prose (no file:line) evidence is demoted;
		// the on-disk JSON gains risk_duty_demotions naming id + duty, and the
		// returned data.demotions carries the {dimension,id,duty,verdict} record.
		const v = verdictFile(V, {
			dimension: "correctness",
			pass: true,
			risk_rulings: [{ id: "r1", pass: true, claim_type: "mechanics", evidence: "the code looks fine to me" }],
		});
		const out = runPlanDemote(plansWith([{ id: "r1", claim_type: "mechanics" }]), [v]);
		const onDisk = JSON.parse(readFileSync(join(tmpDir, V), "utf-8"));
		expect(onDisk.risk_duty_demotions).toEqual([{ id: "r1", duty: "evidence-format", reason: expect.any(String) }]);
		expect((out.data as { demotions: unknown[] }).demotions).toEqual([
			{ dimension: "correctness", id: "r1", duty: "evidence-format", verdict: V },
		]);
	});

	it("does NOT rewrite a compliant file:line-shaped evidence verdict (clean grade = no-op)", () => {
		// A mechanics pass whose evidence is an adjacent path.ext:NN passes the
		// duty ⇒ no demotion ⇒ the verdict file is left byte-unchanged (no field added).
		const data = {
			dimension: "correctness",
			pass: true,
			risk_rulings: [
				{ id: "r1", pass: true, claim_type: "mechanics", evidence: "built-in-workflows.ts:2347 folds the gate" },
			],
		};
		const before = JSON.stringify(data);
		const v = verdictFile(V, data);
		runPlanDemote(plansWith([{ id: "r1", claim_type: "mechanics" }]), [v]);
		const after = readFileSync(join(tmpDir, V), "utf-8");
		expect(after).toBe(before);
		expect((JSON.parse(after) as { risk_duty_demotions?: unknown }).risk_duty_demotions).toBeUndefined();
	});

	it("classifies a verify-at-implement pass with no procedure+owner as procedure-owner", () => {
		// A deferred pass with no procedure demotes on the procedure/owner duty.
		const v = verdictFile(V, {
			dimension: "correctness",
			pass: true,
			risk_rulings: [{ id: "r1", pass: true, disposition: "verify-at-implement" }],
		});
		runPlanDemote(plansWith([{ id: "r1", disposition: "verify-at-implement" }]), [v]);
		const onDisk = JSON.parse(readFileSync(join(tmpDir, V), "utf-8"));
		expect(onDisk.risk_duty_demotions).toEqual([{ id: "r1", duty: "procedure-owner", reason: expect.any(String) }]);
	});

	it("an unauthored-id / no-duty ruling yields no demotion entry (no-duty no-op preserved)", () => {
		// r2 is unauthored (no plan risk) and r1 is authored with no duty fields,
		// so neither demotes — the verdict is untouched and data.demotions is empty.
		const data = {
			dimension: "correctness",
			pass: true,
			risk_rulings: [
				{ id: "r1", pass: true },
				{ id: "r2", pass: true, claim_type: "mechanics" },
			],
		};
		const v = verdictFile(V, data);
		const out = runPlanDemote(plansWith([{ id: "r1" }]), [v]);
		const after = readFileSync(join(tmpDir, V), "utf-8");
		expect(after).toBe(JSON.stringify(data));
		expect((out.data as { demotions: unknown[] }).demotions).toEqual([]);
	});

	it("a genuine pass:false ruling is never demoted (only pass:true demotes)", () => {
		// The demotion targets pass:true rulings demoted by a duty — a pass:false
		// is already a fail, so it yields no entry (the verdict's pass is untouched).
		const data = {
			dimension: "correctness",
			pass: false,
			risk_rulings: [{ id: "r1", pass: false, claim_type: "mechanics" }],
		};
		const v = verdictFile(V, data);
		const out = runPlanDemote(plansWith([{ id: "r1", claim_type: "mechanics" }]), [v]);
		expect(
			(JSON.parse(readFileSync(join(tmpDir, V), "utf-8")) as { risk_duty_demotions?: unknown }).risk_duty_demotions,
		).toBeUndefined();
		expect((out.data as { demotions: unknown[] }).demotions).toEqual([]);
	});

	it("live-drift replay: a multi-site ruling naming the path once with only bare :NN refs demotes; adjacent-cited siblings pass", () => {
		// Verbatim rulings from a real code-grade round — the observed drift shape
		// the duty exists to catch. r2 names built-in-workflows.ts once with NO
		// adjacent :NN (its :34/:911/:20/:1014/:799 refs sit on bare symbols);
		// r1/r3/r5 each carry an adjacent path.ext:NN (:2028/:2025/:85); r4 carries
		// procedure+owner. Fed through code-demote against matching authored
		// risks ⇒ exactly one risk_duty_demotions entry, for r2.
		const risks = [
			{ id: "r1", claim_type: "mechanics" },
			{ id: "r2", claim_type: "mechanics" },
			{ id: "r3", claim_type: "mechanics" },
			{ id: "r4", disposition: "verify-at-implement" },
			{ id: "r5", claim_type: "mechanics" },
		];
		const risk_rulings = [
			{
				id: "r1",
				pass: true,
				claim_type: "mechanics",
				evidence:
					"packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts:2028 — scopeExcess(dirty, baseline, [...declared]) is a CODE statement (not a comment); the comment 'Phase 3's shared core:' at :2025 is the only thing Phase 6 Edit 13 rewrites, leaving the call beneath byte-identical, so Phase 4's node -e .includes('scopeExcess(dirty, baseline, [...declared])') AV is order-independent and survives reconcile's post-implement re-run",
			},
			{
				id: "r2",
				pass: true,
				claim_type: "mechanics",
				evidence:
					"packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts — verified the only phase-introduced symbol consumed by another phase is Phase 3's writeStructureVerdict body referencing Phase 2's VERDICT_PASS_SCORE/VERDICT_FAIL_SCORE; Phase 1 helpers (FENCE_LINE_RE/closesFence/forEachLineOutsideFences) are used only by Phase 1 consumers, Phase 4 helpers (readGoalBaseline :767-region deps, gitDirtyPaths, unionDeclaredWriteSet, FsArtifact) only by the two scope checks, Phase 5 helpers only by reconcile; all pre-existing symbols (handleToString :34, clusterSliceDag :911, parseFrontmatter :20, VERDICT_DIR :1014, scopeExcess :799) are not phase-introduced",
			},
			{
				id: "r3",
				pass: true,
				evidence:
					"packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts:2025 — the '// Phase 3's shared core:' comment sits above the scopeExcess call in implementScopeCheckVet; Phase 4's find/replace blocks end at the git catch (the baseline+git blocks only), explicitly leaving the comment + call untouched, so Phase 6 Edit 13's text-match ('Phase 3's shared core:' -> 'Shared core:') finds and rewrites it",
			},
			{
				id: "r4",
				pass: true,
				disposition: "verify-at-implement",
				procedure:
					"npx vitest run packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.test.ts packages/rpiv-workflow/dependency-cycles.test.ts",
				owner: 4,
				evidence:
					"Phase 4's Automated Verification block carries exactly that vitest line (built-in-workflows.test.ts + dependency-cycles.test.ts); Phases 3 and 5 each carry built-in-workflows.test.ts in their own AV (a later phase adds outcome-derivation.test.ts); the decomposition invariants (finding strings/order, severity floor, unparseable deferral, idempotent re-run) are only dischargeable against the shipped tree by these suites, which the grade panel cannot run",
			},
			{
				id: "r5",
				pass: true,
				claim_type: "mechanics",
				evidence:
					"packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts:85 (countHeadingsOutsideFences), :1173 (fencedSpans), :1568 (phaseBodySlices), :1640 (editPathsOfPhase) — forEachLineOutsideFences visits only non-fence lines with inFence false (fence opener/closer enter the if(fence) branch, never the visit branch), reproducing each consumer's continue-skip semantics; closesFence computes len=fence[1].length and checks fence[1][0]===fenceChar && len>=fenceLen && line.trim().length===len, byte-identical to the inlined arm; fencedSpans keeps its offset loop swapping only the regex and closer; the index++ at the loop tail advances once per line incl. fence lines, keeping start:i aligned with content.split('\\n') in phaseBodySlices",
			},
		];
		const v = verdictFile(V, { dimension: "correctness", pass: true, risk_rulings });
		demoteRun("code-demote")({
			cwd: tmpDir,
			input: undefined,
			state: { named: { plans: [plansWith(risks)], "code-verdicts": [v] } } as unknown as RunView,
		});
		const onDisk = JSON.parse(readFileSync(join(tmpDir, V), "utf-8"));
		expect(onDisk.risk_duty_demotions).toEqual([{ id: "r2", duty: "evidence-format", reason: expect.any(String) }]);
	});
});

describe("plan/code demote route edges (plan-grade → plan-demote simple hop)", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	const route = (stage: string, named: Record<string, unknown>) =>
		edge(stage)({ output: undefined, state: { named } as unknown as RunView });
	const chan = (rel: string, data?: Record<string, unknown>): Output =>
		({ artifacts: [{ handle: fsHandle(rel) }], data, kind: "", meta: {} }) as unknown as Output;
	const verdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "medium", ...extra },
		}) as unknown as Output;
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const PLAN_DIMS = ["actionability", "architecture-fit", "completeness", "correctness", "pattern-following"];
	const passRest = PLAN_DIMS.filter((d) => d !== "correctness").map((d) => verdict(d, true));

	it("plan-grade is now a simple always-hop edge to plan-demote (not a route)", () => {
		expect(build().edges["plan-grade"]).toBe("plan-demote");
	});

	it("code-grade is now a simple always-hop edge to code-demote (not a route)", () => {
		expect(build().edges["code-grade"]).toBe("code-demote");
	});

	it("plan-demote's route sends a first-time MEDIUM blocker straight to plan-snapshot (no confirm session)", () => {
		// The severity-gated confirm: a first-time medium finding-block buys the
		// surgical fix directly — the confirm's ~90% no-overturn rate priced it
		// out of the medium class.
		expect(
			route("plan-demote", {
				plans: [chan(PLAN)],
				"plan-cite-check": [verdict("structure", true)],
				"plan-verdicts": [...passRest, verdict("correctness", false)],
			}),
		).toBe("plan-snapshot");
	});

	it("plan-demote's route sends a first-time HIGH blocker to plan-confirm (the expensive class keeps its insurance)", () => {
		expect(
			route("plan-demote", {
				plans: [chan(PLAN)],
				"plan-cite-check": [verdict("structure", true)],
				"plan-verdicts": [...passRest, verdict("correctness", false, { severity: "high" })],
			}),
		).toBe("plan-confirm");
	});

	it("plan-demote's route: two agreeing blockers → plan-snapshot", () => {
		expect(
			route("plan-demote", {
				plans: [chan(PLAN)],
				"plan-cite-check": [verdict("structure", true)],
				"plan-verdicts": [...passRest, verdict("correctness", false), verdict("correctness", false)],
			}),
		).toBe("plan-snapshot");
	});

	it("plan-demote's route: clean gate → code", () => {
		expect(
			route("plan-demote", {
				plans: [chan(PLAN)],
				"plan-cite-check": [verdict("structure", true)],
				"plan-verdicts": PLAN_DIMS.map((d) => verdict(d, true)),
			}),
		).toBe("code");
	});

	it("code-demote's route mirrors the plan gate on code-verdicts (first-time MEDIUM block → code-snapshot)", () => {
		expect(
			route("code-demote", {
				plans: [chan(PLAN)],
				"code-cite-check": [verdict("structure", true)],
				"code-verdicts": [...passRest, verdict("correctness", false)],
			}),
		).toBe("code-snapshot");
	});

	it("code-demote's route: clean code gate → implement", () => {
		expect(
			route("code-demote", {
				plans: [chan(PLAN)],
				"code-cite-check": [verdict("structure", true)],
				"code-verdicts": PLAN_DIMS.map((d) => verdict(d, true)),
			}),
		).toBe("implement");
	});
});

// ---------------------------------------------------------------------------
// Plan-time coverage floor — verifyPhaseFilesCoverage, driven through the public
// plan-cite-check stage (no direct helper import). A body edit not declared in
// its phase's `files:` fails the dimension:"structure" verdict; a `files:`-less
// phase never false-fails (empty-set degradation).
// ---------------------------------------------------------------------------
describe("build snapshot stages publish a prior sidecar off the plans channel (delta re-grade guard)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-snapshot-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const REL = ".rpiv/artifacts/plans/p.md";
	const snapshotRun = (stage: string) => {
		const s = findWorkflow("build").stages[stage];
		if (!s?.run) throw new Error(`build ${stage} stage has no run function`);
		return s.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			artifacts: { handle: { kind: string; path: string }; role?: string }[];
			data: Record<string, unknown>;
			kind: string;
		};
	};

	it.each([["plan-snapshot"], ["code-snapshot"]])(
		"%s copies the plan bytes into .rpiv/artifacts/priors/ with role prior",
		(stage) => {
			const planBody = "---\nstatus: ready\n---\n# Plan\n\n## Phase 1: x\nbody\n";
			mkdirSync(join(tmpDir, ".rpiv/artifacts/plans"), { recursive: true });
			writeFileSync(join(tmpDir, REL), planBody);
			const out = snapshotRun(stage)({
				cwd: tmpDir,
				input: undefined,
				state: {
					named: { plans: [{ artifacts: [{ handle: fsHandle(REL) }], data: undefined, kind: "", meta: {} }] },
				} as unknown as RunView,
			});
			// Published on its OWN path under priors/, basename-keyed, role prior.
			expect(out.kind).toBe("artifact-md");
			expect(out.artifacts).toHaveLength(1);
			expect(out.artifacts[0].role).toBe("prior");
			expect(out.artifacts[0].handle.kind).toBe("fs");
			// Per-round file published (round 1 here); the basename-keyed copy is written beside it.
			expect(out.artifacts[0].handle.path).toBe(".rpiv/artifacts/priors/p.r1.md");
			expect(readFileSync(join(tmpDir, ".rpiv/artifacts/priors/p.r1.md"), "utf-8")).toBe(planBody);
			expect(out.data.snapshot_of).toBe(REL);
			// The prior file is a byte copy of the plan — the pre-fix content the
			// re-grade diffs against.
			expect(readFileSync(join(tmpDir, ".rpiv/artifacts/priors/p.md"), "utf-8")).toBe(planBody);
		},
	);

	it("throws haltPreflight when no plan is published on plans", () => {
		expect(() =>
			snapshotRun("plan-snapshot")({
				cwd: tmpDir,
				input: undefined,
				state: { named: {} } as unknown as RunView,
			}),
		).toThrow(/no fs artifact on the 'plans' channel/);
	});
});

// ---------------------------------------------------------------------------
// Adaptive gate scaling — the tier decides the roster (a one-slice, <=2-phase
// run grades correctness+completeness only), verdicts carried across an
// artifact REGENERATION are invalidated, and a dimension's first blocking
// verdict routes to a confirm stage for one independent second judgment
// before it buys a fix round.
// ---------------------------------------------------------------------------
