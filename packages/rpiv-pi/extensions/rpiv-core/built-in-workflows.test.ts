/**
 * Composition suite for the built-in workflows — the ONE test home for
 * describes that exercise the composed builtInWorkflows barrel rather than
 * any single module: the validate routing sweep, halt inventory, structural
 * suites, multi-lane fixture replays, edge placement, whole-lap progress.
 * Every per-module describe lives in a co-located twin next to its subject
 * (built-ins/*.test.ts, runner-regressions.test.ts,
 * skills/research/progress-markers.test.ts); all twins import the
 * graph-attached quartet from ./workflow-test-harness.js.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	type Output,
	produces,
	type RunView,
	runWorkflow,
	validateWorkflow,
	type Workflow,
} from "@juicesharp/rpiv-workflow";
import { fanin, fs as fsHandle, loopSpecOf, type ProgressValue } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpivArtifactMdOutcome } from "./artifact-collector.js";
import { builtInWorkflows } from "./built-in-workflows.js";
import {
	freshVerdicts,
	gateRoster,
	gateTier,
	latestArtifactPath,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	progressFromRoundCounts,
	SLICE_DIMENSIONS,
	type VerdictRecord,
	verdictBlocks,
} from "./built-ins/gates.js";
import {
	CODE_PANEL_PROGRESS,
	PLAN_PANEL_PROGRESS,
	SHIP_PANEL_PROGRESS,
	SLICE_PANEL_PROGRESS,
} from "./built-ins/grade-panel.js";
import { DECLARED_CONTRACTS, deriveAndValidate, findWorkflow, withDerivedOutcomes } from "./workflow-test-harness.js";

// validate must route to code-review (not commit) in build/arch workflows.
// ---------------------------------------------------------------------------

describe("validate → code-review routing in built-in workflows", () => {
	it("every stage in every built-in workflow is reachable from start", () => {
		for (const wf of builtInWorkflows) {
			const issues = validateWorkflow(wf);
			expect(
				issues.filter((i) => /unreachable/.test(i.message)),
				`workflow "${wf.name}" has unreachable stages`,
			).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// haltWhenAllFailed wiring — the flagged fanout inventory, swept across every
// built-in workflow. Flagging a fanout is a deliberate halt-semantics decision
// (collect-all is the default posture), so the flagged set is pinned exactly:
// build's design fanout, all five build grade/confirm panels, and ship's
// grade. Any future flagging (e.g. SYNTH_CLUSTER_FANOUT) must extend the
// expectation consciously.
// ---------------------------------------------------------------------------

describe("haltWhenAllFailed wiring (flagged fanout inventory)", () => {
	const fanoutLoopOf = (wf: Workflow, stage: string) => {
		const loop = wf.stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`${wf.name} ${stage} stage has no fanout loop`);
		return loop;
	};

	it("flags exactly build's design fanout + five panels + ship's grade; every other fanout stays flagless", () => {
		const fanoutStages: string[] = [];
		const flagged: string[] = [];
		for (const wf of builtInWorkflows) {
			for (const [stage, def] of Object.entries(wf.stages)) {
				const loop = def?.loop;
				if (loop?.kind !== "fanout") continue;
				fanoutStages.push(`${wf.name}:${stage}`);
				if (loop.haltWhenAllFailed === true) flagged.push(`${wf.name}:${stage}`);
			}
		}
		// The full fanout inventory is pinned too — a new (or renamed) fanout
		// stage forces a conscious decision here: flag it and extend the
		// expected set below, or leave it flagless.
		expect([...fanoutStages].sort()).toEqual([
			"build:code",
			"build:code-confirm",
			"build:code-grade",
			"build:implement",
			"build:plan-confirm",
			"build:plan-grade",
			"build:slice-design",
			"build:slice-grade",
			"build:subplan",
			"meta:implement",
			"meta:implement-grade",
			"meta:plan-grade",
			"meta:research-grade",
			"polish:implement",
			"ship:grade",
			"ship:implement",
			"vet:implement",
		]);
		expect(flagged.sort()).toEqual([
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
		]);
		// Belt-and-braces through the narrow helper: the leak-discipline stages
		// (the plan-phases spread bases and SYNTH_CLUSTER_FANOUT) read undefined.
		expect(fanoutLoopOf(findWorkflow("vet"), "implement").haltWhenAllFailed).toBeUndefined();
		expect(fanoutLoopOf(findWorkflow("polish"), "implement").haltWhenAllFailed).toBeUndefined();
		expect(fanoutLoopOf(findWorkflow("ship"), "implement").haltWhenAllFailed).toBeUndefined();
		expect(fanoutLoopOf(findWorkflow("build"), "implement").haltWhenAllFailed).toBeUndefined();
		expect(fanoutLoopOf(findWorkflow("build"), "code").haltWhenAllFailed).toBeUndefined();
		expect(fanoutLoopOf(findWorkflow("build"), "subplan").haltWhenAllFailed).toBeUndefined();
	});
});

it("build is the default workflow (builtInWorkflows[0].name === 'build')", () => {
	// Position 0 is load-bearing: resolve-default.ts picks
	// `Map.keys().next().value` when no project/user config sets a default, so
	// build MUST stay first in the builtInWorkflows export array.
	expect(builtInWorkflows[0]?.name).toBe("build");
});

describe("code-review routing field is sourced + validated from the contract", () => {
	it("no built-in code-review stage carries an inline outputSchema", () => {
		// Single source of truth: blockers_count lives in the skill contract,
		// not copy-pasted per workflow. Sourced at runtime by effectiveOutputSchema.
		for (const name of ["polish", "vet"]) {
			expect(findWorkflow(name).stages["code-review"]?.outputSchema, `${name} code-review`).toBeUndefined();
		}
	});

	it("the code-review contract requires blockers_count (so a missing field can't NaN-route)", () => {
		const data = DECLARED_CONTRACTS.get("code-review")?.produces?.data as { required?: string[] } | undefined;
		expect(data?.required).toContain("blockers_count");
	});

	it("every built-in workflow validates without errors or warnings (with contracts threaded in)", () => {
		for (const wf of builtInWorkflows) {
			const issues = deriveAndValidate(wf, { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				`${wf.name} errors`,
			).toEqual([]);
			expect(
				issues.filter((i) => i.severity === "warning"),
				`${wf.name} warnings`,
			).toEqual([]);
		}
	});
});

describe("vet workflow", () => {
	const findEdge = (): EdgeFn => {
		const wf = findWorkflow("vet");
		const edge = wf.edges["code-review"];
		if (typeof edge !== "function") throw new Error("code-review edge is not an EdgeFn");
		return edge as EdgeFn;
	};

	const ctxWithBlockers = (blockers_count: number) =>
		({
			output: {
				kind: "artifact-md",
				artifacts: [],
				data: { blockers_count },
				meta: { stage: "code-review", skill: "code-review", stageNumber: 1, ts: "", runId: "" },
			},
			state: {} as RunView,
		}) as const;

	// --- Unit tests: routing predicate ---

	describe("routing predicate", () => {
		it("declares targets matching both possible return values", () => {
			const edge = findEdge();
			expect(edge.targets).toEqual(["blueprint", "commit"]);
		});

		it("routes blockers_count: 0 to commit (same numeric gate as build/arch/polish)", () => {
			const edge = findEdge();
			expect(edge(ctxWithBlockers(0))).toBe("commit");
		});

		it("routes blockers_count > 0 to blueprint (fix loop)", () => {
			const edge = findEdge();
			expect(edge(ctxWithBlockers(3))).toBe("blueprint");
			expect(edge(ctxWithBlockers(1))).toBe("blueprint");
		});

		it("a missing blockers_count falls to the gate's commit fallback — guarded upstream by output validation", () => {
			// The code-review contract requires blockers_count, so the output loop
			// rejects a missing field before routing. If it somehow reaches the gate,
			// Number(undefined)=NaN satisfies neither gt(0) nor eq(0) → fallback (commit).
			const edge = findEdge();
			expect(edge({ output: undefined, state: {} as RunView })).toBe("commit");
		});
	});

	// --- Structural tests ---

	describe("structural validation", () => {
		it("code-review stage carries no inline outputSchema (sourced from contract) and gates on blockers_count", () => {
			const wf = findWorkflow("vet");
			expect(wf.stages["code-review"]?.outputSchema).toBeUndefined();
			const edge = wf.edges["code-review"];
			if (typeof edge !== "function") throw new Error("code-review edge is not an EdgeFn");
			expect([...(edge.targets ?? [])].sort()).toEqual(["blueprint", "commit"]);
		});

		it("validate routes back to code-review (backward-jump cycle)", () => {
			const wf = findWorkflow("vet");
			expect(wf.edges.validate).toBe("code-review");
		});

		it("all stages are reachable from start", () => {
			const wf = findWorkflow("vet");
			const issues = validateWorkflow(wf);
			expect(
				issues.filter((i) => /unreachable/.test(i.message)),
				`vet has unreachable stages`,
			).toEqual([]);
		});
	});

	// --- Integration test: backward-jump loop behavior ---

	describe("backward-jump loop behavior", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-q4-loop-"));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		const writeArtifact = (relPath: string) => {
			const parts = relPath.split("/");
			const dir = join(tmpDir, ...parts.slice(0, -1));
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(tmpDir, relPath), "");
		};

		it("halts when vet exceeds maxBackwardJumps", async () => {
			// Pre-write artifacts for each stage pass. With default
			// maxBackwardJumps=3, the guard halts when the 5th code-review's
			// decision re-enters blueprint a 4th time (>3). The cycle:
			//   cr1→bp1→impl1→v1 → … → cr4→bp4→impl4→v4 → cr5(HALT)
			// Stages completed: 17 (cr×5 + bp×4 + impl×4 + validate×4).
			writeArtifact(".rpiv/artifacts/code-review/cr1.md");
			writeArtifact(".rpiv/artifacts/blueprint/bp1.md");
			writeArtifact(".rpiv/artifacts/implement/impl1.md");
			writeArtifact(".rpiv/artifacts/validate/v1.md");
			writeArtifact(".rpiv/artifacts/code-review/cr2.md");
			writeArtifact(".rpiv/artifacts/blueprint/bp2.md");
			writeArtifact(".rpiv/artifacts/implement/impl2.md");
			writeArtifact(".rpiv/artifacts/validate/v2.md");
			writeArtifact(".rpiv/artifacts/code-review/cr3.md");
			writeArtifact(".rpiv/artifacts/blueprint/bp3.md");
			writeArtifact(".rpiv/artifacts/implement/impl3.md");
			writeArtifact(".rpiv/artifacts/validate/v3.md");
			writeArtifact(".rpiv/artifacts/code-review/cr4.md");
			writeArtifact(".rpiv/artifacts/blueprint/bp4.md");
			writeArtifact(".rpiv/artifacts/implement/impl4.md");
			writeArtifact(".rpiv/artifacts/validate/v4.md");
			writeArtifact(".rpiv/artifacts/code-review/cr5.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/blueprint/bp1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/implement/impl1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/validate/v1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/blueprint/bp2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/implement/impl2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/validate/v2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr3.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/blueprint/bp3.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/implement/impl3.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/validate/v3.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr4.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/blueprint/bp4.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/implement/impl4.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/validate/v4.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr5.md")] },
				],
			});

			// Build a workflow matching vet's graph shape, but the
			// code-review predicate always routes to "blueprint" (never approves),
			// so the loop runs until maxBackwardJumps exhausts.
			const workflow = defineWorkflow({
				name: "vet-test",
				start: "code-review",
				stages: {
					"code-review": produces({ outcome: rpivArtifactMdOutcome }),
					blueprint: produces({ outcome: rpivArtifactMdOutcome }),
					implement: acts(),
					validate: produces({ outcome: rpivArtifactMdOutcome }),
					commit: acts(),
				},
				edges: {
					"code-review": defineRoute(["blueprint", "commit"], () => "blueprint", { readsData: false }),
					blueprint: "implement",
					implement: "validate",
					validate: "code-review",
					commit: "stop",
				},
			});

			const result = await runWorkflow(chain.ctx, { workflow, input: "review changes" });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			// 17 stages: cr×5 + bp×4 + impl×4 + validate×4. The 5th code-review's
			// decision is blueprint's 4th re-entry (> maxBackwardJumps=3).
			expect(result.stagesCompleted).toBe(17);
		});
	});

	// --- Phase 4: DAG fanout + scope-check rollout ---

	describe("DAG fanout + scope-check rollout to vet", () => {
		it("starts at goal and lists the goal + scope-check stages in linear order", () => {
			const wf = findWorkflow("vet");
			expect(wf.start).toBe("goal");
			expect(Object.keys(wf.stages)).toEqual([
				"goal",
				"code-review",
				"blueprint",
				"implement",
				"implement-scope-check",
				"scope-quarantine",
				"reconcile",
				"reconcile-fix",
				"validate",
				"commit",
			]);
		});

		it("implement references the dep-gated DAG fanout (not IMPLEMENT_PHASE_FANOUT)", () => {
			const loop = findWorkflow("vet").stages.implement?.loop;
			expect(loopSpecOf(loop)).toMatchObject({
				kind: "fanout",
				source: "plans",
				unit: { by: "frontmatter-array", pattern: "phases" },
				max: 32,
			});
			// IMPLEMENT_DAG_FANOUT is the spread { ...FRONTMATTER_PHASE_FANOUT, units, … }
			// — same source/unit/max as the base; the distinction is the
			// deps-emitting units closure, asserted via the build implement lane's own
			// tests (the DAG-specific behavior is shared across build + vet).
		});

		it("implement stays flagless — a failed phase never halts its siblings (collect-all contract)", () => {
			const loop = findWorkflow("vet").stages.implement?.loop;
			if (loop?.kind !== "fanout") throw new Error("vet implement stage has no fanout loop");
			expect(loop.haltWhenAllFailed).toBeUndefined();
		});

		it("rewires the implement edge through the scope-check into validate, backward loop intact", () => {
			const wf = findWorkflow("vet");
			const edges = wf.edges;
			expect(edges.goal).toBe("code-review");
			expect(edges.blueprint).toBe("implement");
			expect(edges.implement).toBe("implement-scope-check");
			// The scope-check route is the shared tiered scopeFloorGate (readsData:
			// false suppresses the outputSchema lint → no schema on the script stage).
			expect(wf.stages["implement-scope-check"]?.outputSchema).toBeUndefined();
			// Quarantine's re-entry hop is a plain string edge (non-counted).
			expect(edges["scope-quarantine"]).toBe("implement-scope-check");
			expect(edges.validate).toBe("code-review"); // backward review-fix loop INTACT
			expect(edges.commit).toBe("stop");
		});

		it("validates clean (goal published → reads:[plans,goal] resolves) with no unreachable stages", () => {
			const wf = findWorkflow("vet");
			const issues = deriveAndValidate(wf, { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				issues.map((i) => `${i.severity}: ${i.message}`).join("\n"),
			).toEqual([]);
			expect(
				validateWorkflow(wf).filter((i) => /unreachable/.test(i.message)),
				"vet has unreachable stages",
			).toEqual([]);
		});
	});
});

describe("polish workflow", () => {
	describe("structural validation", () => {
		it("validates with zero errors", () => {
			expect(deriveAndValidate(findWorkflow("polish")).filter((i) => i.severity === "error")).toEqual([]);
		});

		it("all stages are reachable from start", () => {
			const issues = deriveAndValidate(findWorkflow("polish"));
			expect(
				issues.filter((i) => /unreachable/.test(i.message)),
				"polish has unreachable stages",
			).toEqual([]);
		});

		it("blueprint is an iterate stage and implement is a fanout stage (the two co-exist)", () => {
			const wf = findWorkflow("polish");
			expect(wf.stages.blueprint?.loop?.kind).toBe("iterate");
			expect(wf.stages.blueprint?.kind).toBe("produces");
			expect(wf.stages.implement?.loop?.kind).toBe("fanout");
		});

		it("implement stays flagless — the per-phase implement lane keeps the collect-all contract", () => {
			const loop = findWorkflow("polish").stages.implement?.loop;
			if (loop?.kind !== "fanout") throw new Error("polish implement stage has no fanout loop");
			expect(loop.haltWhenAllFailed).toBeUndefined();
		});

		it("code-review sources its schema from the contract (no inline outputSchema) and gates to commit | blueprint", () => {
			const wf = findWorkflow("polish");
			expect(wf.stages["code-review"]?.outputSchema).toBeUndefined();
			const edge = wf.edges["code-review"];
			if (typeof edge !== "function") throw new Error("code-review edge is not an EdgeFn");
			expect([...(edge.targets ?? [])].sort()).toEqual(["blueprint", "commit"]);
		});
	});

	describe("integration", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-polish-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		const write = (relPath: string, content: string) => {
			const parts = relPath.split("/");
			mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
			writeFileSync(join(tmpDir, relPath), content);
		};
		// Each plan carries the `phases:` array the implement fanout enumerates.
		const plan = (phase = 1) =>
			`---\ntopic: t\nphase_count: 1\nphases:\n  - { n: ${phase}, title: do the thing }\n---\n## Phase ${phase}: do the thing\nbody\n`;
		// The review carries a structured `phases:` array (derived from its
		// `### Phase N — name` headings) — what the iterate enumerates over.
		const review2 =
			"---\nphases:\n  - { n: 1, title: Alpha }\n  - { n: 2, title: Beta }\n---\n# Arch Review\n\n### Phase 1 — Alpha\nbody\n### Phase 2 — Beta\nbody\n";
		const review1 = "---\nphases:\n  - { n: 1, title: Alpha }\n---\n# Arch Review\n\n### Phase 1 — Alpha\nbody\n";
		const cr = (blockers: number) => `---\nblockers_count: ${blockers}\n---\n`;
		const impl = (m: string) => ({ branch: [mockAssistantMessage(m)] });

		it("happy path: one blueprint pass per review phase, each fed the prior plans; implement fans out the plans", async () => {
			write(".rpiv/artifacts/architecture-reviews/rev.md", review2);
			write(".rpiv/artifacts/plans/plan-1.md", plan());
			write(".rpiv/artifacts/plans/plan-2.md", plan());
			write(".rpiv/artifacts/validation/val.md", "");
			write(".rpiv/artifacts/reviews/cr.md", cr(0));

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					impl("wrote .rpiv/artifacts/architecture-reviews/rev.md"),
					impl("wrote .rpiv/artifacts/plans/plan-1.md"),
					impl("wrote .rpiv/artifacts/plans/plan-2.md"),
					impl("phase done"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val.md"),
					impl("wrote .rpiv/artifacts/reviews/cr.md"),
					impl("committed"),
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: withDerivedOutcomes(findWorkflow("polish")),
				input: "x",
			});

			expect(result.success).toBe(true);
			// arch-review + blueprint×2 + implement×2 + validate + code-review + commit
			expect(result.stagesCompleted).toBe(8);
			// blueprint pulled one unit per review phase; phase 2 saw phase 1's plan.
			expect(chain.sentMessages[1]).toBe(
				"/skill:blueprint .rpiv/artifacts/architecture-reviews/rev.md Implement Phase 1: Alpha",
			);
			expect(chain.sentMessages[2]).toBe(
				"/skill:blueprint .rpiv/artifacts/architecture-reviews/rev.md Implement Phase 2: Beta\n" +
					"Prior phase plans (read first; build on them, don't duplicate): .rpiv/artifacts/plans/plan-1.md",
			);
			// implement fanned out each accumulated plan's `phases:` array, title-enriched.
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:implement"))).toEqual([
				"/skill:implement .rpiv/artifacts/plans/plan-1.md Phase 1: do the thing",
				"/skill:implement .rpiv/artifacts/plans/plan-2.md Phase 1: do the thing",
			]);
		});

		it("validate receives EVERY plan from the latest blueprint pass in one /skill:validate call", async () => {
			write(".rpiv/artifacts/architecture-reviews/rev.md", review2);
			write(".rpiv/artifacts/plans/plan-1.md", plan());
			write(".rpiv/artifacts/plans/plan-2.md", plan());
			write(".rpiv/artifacts/validation/val.md", "");
			write(".rpiv/artifacts/reviews/cr.md", cr(0));

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					impl("wrote .rpiv/artifacts/architecture-reviews/rev.md"),
					impl("wrote .rpiv/artifacts/plans/plan-1.md"),
					impl("wrote .rpiv/artifacts/plans/plan-2.md"),
					impl("phase done"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val.md"),
					impl("wrote .rpiv/artifacts/reviews/cr.md"),
					impl("committed"),
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: withDerivedOutcomes(findWorkflow("polish")),
				input: "x",
			});

			expect(result.success).toBe(true);
			// The single validate session is handed ALL accumulated plans — not just
			// the rolling-primary (last) plan — so every phase gets validated.
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:validate"))).toEqual([
				"/skill:validate .rpiv/artifacts/plans/plan-1.md .rpiv/artifacts/plans/plan-2.md",
			]);
		});

		it("corrective loop: implement consumes only the LATEST blueprint pass, never re-implementing a stale plan", async () => {
			write(".rpiv/artifacts/architecture-reviews/rev.md", review1);
			for (const n of [1, 2, 3, 4]) write(`.rpiv/artifacts/plans/plan-${n}.md`, plan());
			for (const n of [1, 2, 3, 4]) write(`.rpiv/artifacts/validation/val-${n}.md`, "");
			for (const n of [1, 2, 3, 4]) write(`.rpiv/artifacts/reviews/cr-${n}.md`, cr(1)); // always blockers → loop

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					impl("wrote .rpiv/artifacts/architecture-reviews/rev.md"),
					// pass 0
					impl("wrote .rpiv/artifacts/plans/plan-1.md"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val-1.md"),
					impl("wrote .rpiv/artifacts/reviews/cr-1.md"),
					// pass 1 (backward jump 1)
					impl("wrote .rpiv/artifacts/plans/plan-2.md"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val-2.md"),
					impl("wrote .rpiv/artifacts/reviews/cr-2.md"),
					// pass 2 (backward jump 2)
					impl("wrote .rpiv/artifacts/plans/plan-3.md"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val-3.md"),
					impl("wrote .rpiv/artifacts/reviews/cr-3.md"),
					// pass 3 (backward jump 3)
					impl("wrote .rpiv/artifacts/plans/plan-4.md"),
					impl("phase done"),
					impl("wrote .rpiv/artifacts/validation/val-4.md"),
					impl("wrote .rpiv/artifacts/reviews/cr-4.md"),
					// 4th code-review's gate → blueprint = backward jump 4 > 3 → halt
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: withDerivedOutcomes(findWorkflow("polish")),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			// Each implement round saw ONLY that pass's plan — the latest-pass slice
			// dropped the stale generations, so no plan is implemented twice.
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:implement"))).toEqual([
				"/skill:implement .rpiv/artifacts/plans/plan-1.md Phase 1: do the thing",
				"/skill:implement .rpiv/artifacts/plans/plan-2.md Phase 1: do the thing",
				"/skill:implement .rpiv/artifacts/plans/plan-3.md Phase 1: do the thing",
				"/skill:implement .rpiv/artifacts/plans/plan-4.md Phase 1: do the thing",
			]);
			// validate shares the same latest-pass slice — each round validates only
			// that pass's plan, never a stale generation.
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:validate"))).toEqual([
				"/skill:validate .rpiv/artifacts/plans/plan-1.md",
				"/skill:validate .rpiv/artifacts/plans/plan-2.md",
				"/skill:validate .rpiv/artifacts/plans/plan-3.md",
				"/skill:validate .rpiv/artifacts/plans/plan-4.md",
			]);
		});
	});
});

describe("acceptance channel (executable standard threading)", () => {
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const gateUnits = (wfName: string, stage: string, named: Record<string, unknown>) => {
		const loop = findWorkflow(wfName).stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`${wfName} ${stage} stage has no fanout loop`);
		return loop.units({ cwd: "/repo", artifact: undefined, state: { named } as unknown as RunView });
	};

	it("build derives acceptance between research and slice; slice's research input rides its explicit read", () => {
		const wf = findWorkflow("build");
		expect(wf.stages.acceptance?.kind).toBe("produces");
		expect(wf.stages.acceptance?.reads).toEqual(["goal", "research"]);
		expect(wf.edges.research).toBe("acceptance");
		expect(wf.edges.acceptance).toBe("slice");
		// With acceptance holding the rolling primary at this seam, the explicit
		// read is what restores the research doc as slice's grounding input.
		expect(wf.stages.slice?.reads).toEqual(["research"]);
	});

	it("threads --acceptance into the completeness unit only (build plan gate)", async () => {
		const units = await gateUnits("build", "plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
			research: [out(".rpiv/artifacts/research/r.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
			acceptance: [out(".rpiv/artifacts/acceptance/a.md")],
		});
		const byLabel = new Map(units.map((u) => [u.label, u.prompt]));
		expect(byLabel.get("completeness")).toContain("--acceptance .rpiv/artifacts/acceptance/a.md");
		for (const d of ["correctness", "actionability", "pattern-following", "architecture-fit"]) {
			expect(byLabel.get(d)).not.toContain("--acceptance");
		}
	});

	it("threads --acceptance into the completeness unit only (ship grade)", async () => {
		const units = await gateUnits("ship", "grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
			research: [out(".rpiv/artifacts/research/r.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
			acceptance: [out(".rpiv/artifacts/acceptance/a.md")],
		});
		const byLabel = new Map(units.map((u) => [u.label, u.prompt]));
		expect(byLabel.get("completeness")).toContain("--acceptance .rpiv/artifacts/acceptance/a.md");
		for (const d of ["correctness", "architecture-fit"]) {
			expect(byLabel.get(d)).not.toContain("--acceptance");
		}
	});

	it("omits --acceptance when the channel is empty (vet/polish and user workflows carry no flag)", async () => {
		const units = await gateUnits("build", "plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
			research: [out(".rpiv/artifacts/research/r.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
		});
		expect(units.every((u) => !u.prompt.includes("--acceptance"))).toBe(true);
	});

	it("validate's dispatch appends --acceptance so the skill executes the inventory", () => {
		const prompt = findWorkflow("ship").stages.validate?.prompt;
		if (typeof prompt !== "function") throw new Error("ship validate stage has no prompt fn");
		const dispatch = prompt({
			cwd: "/repo",
			input: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					goal: [out(".rpiv/artifacts/goal/goal.md")],
					acceptance: [out(".rpiv/artifacts/acceptance/a.md")],
				},
			} as unknown as RunView,
		});
		expect(dispatch).toBe(
			"/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal.md --acceptance .rpiv/artifacts/acceptance/a.md",
		);
	});
});

describe("build audit-drop fixes", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	const dimVerdict = (dimension: string, pass: boolean, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: {},
			data: { dimension, pass, severity: pass ? "none" : "high", ...extra },
		}) as unknown as Output;

	// Finding 2 — a failing validate must NOT commit. The unconditional validate→commit
	// edge shipped a `verdict: fail`. The gate routes on the published verdict, and
	// classifies a fail BEFORE looping: only a fail carrying a remediable handle
	// (a `pass: false` risk ruling or a `blockers:` entry) reaches the repair arm —
	// a prose-only fail has nothing remediate may act on, so looping it re-validated
	// an unchanged tree until the backward-jump guard halted the run.
	describe("validate gate (finding 2)", () => {
		// validate publishes to the `validation` bucket (its contract artifactKind),
		// which is the channel the gate must read.
		const routeData = (data: Record<string, unknown>) =>
			edge("validate")({
				output: undefined,
				state: { named: { validation: [{ data }] } } as unknown as RunView,
			});

		it("commits ONLY on an explicit verdict: pass", () => {
			expect(routeData({ verdict: "pass" })).toBe("commit");
		});
		it("routes a fail WITH a pass:false risk ruling to validate-fix (the repair arm)", () => {
			expect(
				routeData({
					verdict: "fail",
					risk_rulings: [
						{ id: "r1", pass: true },
						{ id: "r2", pass: false },
					],
				}),
			).toBe("validate-fix");
		});
		it("routes a fail WITH a blockers entry to validate-fix (whole-plan gate failure, structured)", () => {
			expect(
				routeData({
					verdict: "fail",
					risk_rulings: [{ id: "r1", pass: true }],
					blockers: [{ id: "b1", command: "swift test", file: "Sources/A.swift", line: 64 }],
				}),
			).toBe("validate-fix");
		});
		it("STOPs a fail with NO remediable handle (all rulings pass, no blockers) — the futile-loop regression", () => {
			// Run 2026-08-22_12-14-12-64eb: verdict fail on whole-plan gates recorded
			// only in prose; remediate drift-escaped without an edit four times until
			// the backward-jump guard halted the run at reconcile.
			expect(routeData({ verdict: "fail", risk_rulings: [{ id: "r1", pass: true }] })).toBe("stop");
		});
		it("STOPs a fail with no rulings and no blockers at all", () => {
			expect(routeData({ verdict: "fail" })).toBe("stop");
		});
		it("routes a MISSING verdict to STOP (no commit) — safe by construction", () => {
			expect(routeData({})).toBe("stop");
		});
		it("declares commit, validate-fix, and stop as targets", () => {
			expect([...(edge("validate").targets ?? [])].sort()).toEqual(["commit", "stop", "validate-fix"]);
		});
		it("routes on the channel validate actually publishes to (validation bucket)", () => {
			// The channel the gate reads MUST equal validate's derived publish channel,
			// or the gate reads an empty channel and STOPs every run. Deriving the
			// contract outcome and routing on the same-named channel proves the coupling.
			const derived = withDerivedOutcomes(build());
			expect(derived.stages.validate?.outcome?.name).toBe("validation");
		});
		it("dispatches remediate with reads: [plans, validation] (the repair arm contract)", () => {
			// The validate-fix stage is `acts()` (side-effect/code-mutation, the tools
			// twin of implement) dispatching the remediate skill, reading the plan + the
			// latest failing validation report. `stageEntryArgs` derives
			// `--plans <plan> --validation <report>` from these reads.
			const stage = build().stages["validate-fix"];
			expect(stage?.kind).toBe("side-effect");
			expect(stage?.skill).toBe("remediate");
			expect([...(stage?.reads ?? [])]).toEqual(["plans", "validation"]);
		});
		it("validate-fix publishes the deterministic digest verdict on the remediation channel", () => {
			// The explicit outcome (the commit/gitCommitOutcome pattern on an acts
			// stage) — its `{ changed }` is what the arm's own edge folds.
			expect(build().stages["validate-fix"]?.outcome?.name).toBe("remediation");
		});
		it("re-enters at implement-scope-check when remediation changed the tree", () => {
			// After a real fix the flow re-runs scope-check → reconcile → validate
			// before the gate re-folds — a fix is re-verified end-to-end.
			expect(
				edge("validate-fix")({
					output: undefined,
					state: { named: { remediation: [{ data: { changed: true } }] } } as unknown as RunView,
				}),
			).toBe("implement-scope-check");
		});
		it("STOPs when remediation left the tree unchanged — re-validating is provably futile", () => {
			expect(
				edge("validate-fix")({
					output: undefined,
					state: { named: { remediation: [{ data: { changed: false } }] } } as unknown as RunView,
				}),
			).toBe("stop");
		});
		it("proceeds on a MISSING remediation signal — degrade on no signal, never stop", () => {
			expect(edge("validate-fix")({ output: undefined, state: { named: {} } as unknown as RunView })).toBe(
				"implement-scope-check",
			);
		});
		it("validate-fix declares implement-scope-check and stop as targets", () => {
			expect([...(edge("validate-fix").targets ?? [])].sort()).toEqual(["implement-scope-check", "stop"]);
		});
	});

	// Finding 1 — a plan-authored risk flag ruled `fail` by the grade panel must block
	// the gate even when every quality dimension passes.
	describe("plan/code gate enforces risk flags (finding 1)", () => {
		const allDimsPass = [dimVerdict("completeness", true), dimVerdict("correctness", true)];

		it("plan-grade routes a fresh risk-flag fail to plan-confirm, despite all dimensions passing", () => {
			// The essential claim is unchanged: a failed ruling never reaches
			// `code`. Under the severity-gated confirm a risk-ruling blocker is
			// confirm-worthy (the uphold-or-refute-with-evidence contract is the
			// designed remedy for an un-grounded ruling), so the fresh fail takes
			// one second judgment before the fix.
			const verdicts = [
				...allDimsPass,
				dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: false }] }),
			];
			const next = edge("plan-demote")({
				output: undefined,
				state: {
					named: { "plan-verdicts": verdicts, "plan-cite-check": [dimVerdict("structure", true)] },
				} as unknown as RunView,
			});
			expect(next).toBe("plan-confirm");
		});

		it("plan-grade routes to code when all dimensions AND all risk flags pass", () => {
			const verdicts = [
				...allDimsPass,
				dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: true }] }),
			];
			const next = edge("plan-demote")({
				output: undefined,
				state: {
					named: { "plan-verdicts": verdicts, "plan-cite-check": [dimVerdict("structure", true)] },
				} as unknown as RunView,
			});
			expect(next).toBe("code");
		});

		it("code-grade routes a fresh risk-flag fail to code-confirm (never code/implement)", () => {
			const verdicts = [
				...allDimsPass,
				dimVerdict("correctness", true, { risk_rulings: [{ id: "r2", pass: false }] }),
			];
			const next = edge("code-demote")({
				output: undefined,
				state: {
					named: { "code-verdicts": verdicts, "code-cite-check": [dimVerdict("structure", true)] },
				} as unknown as RunView,
			});
			expect(next).toBe("code-confirm");
		});
	});

	// Finding 6 (extended past the slice map) — a fabricated `file:line` in the plan
	// or code-bearing plan fails the deterministic cite-check floor and routes to the
	// fix arm, even when every LLM dimension and risk flag passes.
	describe("plan/code citation floor routes fabrications to the fix arm (finding 6)", () => {
		const allPass = [dimVerdict("completeness", true), dimVerdict("correctness", true, { risk_rulings: [] })];

		it("plan-grade routes to plan-snapshot when plan-cite-check fails, despite dimensions + risk flags passing", () => {
			const next = edge("plan-demote")({
				output: undefined,
				state: {
					named: { "plan-verdicts": allPass, "plan-cite-check": [dimVerdict("structure", false)] },
				} as unknown as RunView,
			});
			expect(next).toBe("plan-snapshot");
		});

		it("code-grade routes to code-snapshot when code-cite-check fails", () => {
			const next = edge("code-demote")({
				output: undefined,
				state: {
					named: { "code-verdicts": allPass, "code-cite-check": [dimVerdict("structure", false)] },
				} as unknown as RunView,
			});
			expect(next).toBe("code-snapshot");
		});
	});

	// Phase 4 — the fix stages thread their lineage sources so amend repairs
	// completeness-class findings from the brief/architecture/sub-plans rather than
	// reconstructing them from verdict prose. Regression guard against a future
	// narrowing of the reads arrays (and against wrongly adding subplans to code-fix).
	describe("plan-fix/code-fix read their lineage sources (phase 4)", () => {
		it("build plan-fix reads goal, acceptance, research, and subplans alongside the verdict/cite-check channels", () => {
			// `acceptance` rides along so a completeness finding naming an inventory
			// id is repaired in the plan's `acceptance:` block against a real id.
			expect(findWorkflow("build").stages["plan-fix"]?.reads).toEqual([
				"plans",
				fanin("plan-verdicts"),
				fanin("plan-cite-check"),
				"goal",
				"acceptance",
				"research",
				fanin("subplans"),
			]);
		});

		it("build code-fix reads goal and research, but NOT subplans (completeness settled at the plan gate)", () => {
			const reads = findWorkflow("build").stages["code-fix"]?.reads;
			expect(reads).toEqual(["plans", fanin("code-verdicts"), fanin("code-cite-check"), "goal", "research"]);
			expect(reads).not.toContainEqual(fanin("subplans"));
		});
	});

	// P2 — the deterministic-floor edges SKIP the re-grade when the accumulated
	// verdicts already clear the gate, so a fix that only cleared the citation/
	// structure floor doesn't re-roll a passing (flappy) LLM panel. The predicate
	// is the SAME the grade edge uses, so "skip" ≡ "grade then pass", minus waste.
	describe("re-grade skip on the deterministic-floor edge (P2)", () => {
		const routeFrom = (stage: string, named: Record<string, unknown>) =>
			edge(stage)({ output: undefined, state: { named } as unknown as RunView });

		it("slice-check skips straight to slice-design when structure + design-readiness already pass", () => {
			expect(
				routeFrom("slice-check", {
					"slice-check": [dimVerdict("structure", true)],
					"slice-verdicts": [dimVerdict("design-readiness", true)],
				}),
			).toBe("slice-design");
		});

		it("slice-check routes into slice-grade on the first pass (no design-readiness verdict yet)", () => {
			expect(
				routeFrom("slice-check", { "slice-check": [dimVerdict("structure", true)], "slice-verdicts": [] }),
			).toBe("slice-grade");
		});

		it("slice-check routes into slice-grade while the structure floor is still red", () => {
			expect(
				routeFrom("slice-check", {
					"slice-check": [dimVerdict("structure", false)],
					"slice-verdicts": [dimVerdict("design-readiness", true)],
				}),
			).toBe("slice-grade");
		});

		it("slice-check declares slice-design, slice-fix (stuck lifts), and slice-grade as its only targets", () => {
			expect([...(edge("slice-check").targets ?? [])].sort()).toEqual(["slice-design", "slice-fix", "slice-grade"]);
		});

		it("plan-cite-check skips straight to code when every dimension + risk flag already passes", () => {
			expect(
				routeFrom("plan-cite-check", {
					"plan-cite-check": [dimVerdict("structure", true)],
					"plan-verdicts": [
						dimVerdict("completeness", true),
						dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: true }] }),
					],
				}),
			).toBe("code");
		});

		it("plan-cite-check routes into plan-grade on the first pass (no verdicts yet)", () => {
			expect(
				routeFrom("plan-cite-check", { "plan-cite-check": [dimVerdict("structure", true)], "plan-verdicts": [] }),
			).toBe("plan-grade");
		});

		it("plan-cite-check routes into plan-grade when a fix left ONLY the cite floor red", () => {
			expect(
				routeFrom("plan-cite-check", {
					"plan-cite-check": [dimVerdict("structure", false)],
					"plan-verdicts": [dimVerdict("completeness", true), dimVerdict("correctness", true)],
				}),
			).toBe("plan-grade");
		});

		it("plan-cite-check routes into plan-grade when a risk flag is still ruled fail", () => {
			expect(
				routeFrom("plan-cite-check", {
					"plan-cite-check": [dimVerdict("structure", true)],
					"plan-verdicts": [
						dimVerdict("completeness", true),
						dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: false }] }),
					],
				}),
			).toBe("plan-grade");
		});

		it("an advisory-only floor verdict is green at this route", () => {
			expect(
				routeFrom("plan-cite-check", {
					"plan-cite-check": [dimVerdict("structure", false, { severity: "low" })],
					"plan-verdicts": [dimVerdict("completeness", true), dimVerdict("correctness", true)],
				}),
			).toBe("code");
		});

		it("plan-cite-check declares code and plan-grade as its only targets", () => {
			expect([...(edge("plan-cite-check").targets ?? [])].sort()).toEqual(["code", "plan-grade"]);
		});

		it("code-cite-check skips straight to implement when the code gate already passes", () => {
			expect(
				routeFrom("code-cite-check", {
					"code-cite-check": [dimVerdict("structure", true)],
					"code-verdicts": [
						dimVerdict("completeness", true),
						dimVerdict("correctness", true, { risk_rulings: [{ id: "r1", pass: true }] }),
					],
				}),
			).toBe("implement");
		});

		it("code-cite-check routes into code-grade while the code cite floor is the only red", () => {
			expect(
				routeFrom("code-cite-check", {
					"code-cite-check": [dimVerdict("structure", false)],
					"code-verdicts": [dimVerdict("completeness", true), dimVerdict("correctness", true)],
				}),
			).toBe("code-grade");
		});

		it("code-cite-check declares code-grade and implement as its only targets", () => {
			expect([...(edge("code-cite-check").targets ?? [])].sort()).toEqual(["code-grade", "implement"]);
		});
	});

	// P2e — the cite-check edges collapsed to two-way gates (skip arm + panel
	// lap; the divert-to-snapshot arm died with its predicate). Run 3212 recorded
	// four cite-check routing decisions under the OLD three-way edges; the
	// committed excerpt re-derives from the on-disk trail by its `_meta` rules
	// and must reproduce all four decisions under the collapsed edges — the
	// routing semantics the collapse promised to preserve.
	describe("3212 cite-check routing replay (collapsed two-way edges)", () => {
		type StageRow = { type?: undefined; stageNumber: number; channel: string; output: Output };
		type RoutingRow = { type: "routing"; fromStage: string; decision: string };
		const rows = (
			JSON.parse(
				readFileSync(
					fileURLToPath(new URL("./built-ins/__fixtures__/run-3212-cite-check-routing.json", import.meta.url)),
					"utf-8",
				),
			) as { rows: Array<StageRow | RoutingRow> }
		).rows;
		const routeFrom = (stage: string, named: Record<string, unknown>) =>
			edge(stage)({ output: undefined, state: { named } as unknown as RunView });

		it("folds the excerpted trail rows in order and reproduces every recorded cite-check routing decision", () => {
			const named: Record<string, Output[]> = {};
			const decisions: string[] = [];
			let last = 0;
			for (const row of rows) {
				if (row.type === "routing") {
					decisions.push(row.decision);
					expect(routeFrom(row.fromStage, named)).toBe(row.decision);
					continue;
				}
				// The excerpt keeps the trail's stage order — a fold that reordered
				// rows would be deriving a different run.
				expect(row.stageNumber, "excerpt keeps stageNumbers ascending").toBeGreaterThan(last);
				last = row.stageNumber;
				named[row.channel] = (named[row.channel] ?? []).concat(row.output);
			}
			// All four recorded decisions under the collapsed edges (plan-grade ×2,
			// code-grade ×2) — the replay's discharge of the routing-equivalence risk.
			expect(decisions.filter((d) => d === "plan-grade")).toHaveLength(2);
			expect(decisions.filter((d) => d === "code-grade")).toHaveLength(2);
		});
	});
});

// ---------------------------------------------------------------------------
// Converging-loop replay — the recorded cap-halt trails re-derived through the
// real blocking folds and the whole-lap progress rule. Six committed fixtures
// (each a trimmed excerpt of a gitignored run trail, re-derivable by its
// `_meta` rules) pin two layers per trail: the per-lap verdicts the rule
// assigns — which re-entries a panel hook waives — and the guard simulation
// over those verdicts, where re-entry 1 is always unknown-counting and the run
// halts when the count exceeds the recorded max. Local halt trails 089a,
// 8b79, e9f4, 7514 plus the two external research tuples cc02 and ec5e as
// plain data, a carry-forward synthetic, and the no-hook elaborate evidence
// whose older halt wording is the no-panel marker.
// ---------------------------------------------------------------------------
describe("converging-loop replay pinning (local halts + external tuples + carry-forward)", () => {
	type StageRow = { type?: undefined; stageNumber: number; stage: string; channel: string; output: Output };
	type RoutingRow = { type: "routing"; fromStage: string; decision: string };
	type HaltRow = { type: "halt"; stage: string; errMsg: string };
	type FixtureRow = StageRow | RoutingRow | HaltRow;

	// Fail-loud loader: every fixture names its run in `_meta.run_id`, the file
	// name carries the same 4-hex run token, and stage numbers ascend in trail
	// order — a fixture that silently lost any of these would pin a different
	// run's shape.
	const parseRunFixture = (parsed: unknown, file: string): FixtureRow[] => {
		const token = file.match(/^run-([0-9a-f]{4})-/)?.[1];
		const meta = (parsed as { _meta?: { run_id?: unknown } })?._meta;
		const rows = (parsed as { rows?: unknown })?.rows;
		if (typeof token !== "string" || typeof meta?.run_id !== "string" || !Array.isArray(rows)) {
			throw new Error(
				`fixture ${file} is not a run excerpt: expected _meta.run_id for run ${token ?? "?"} and a rows[] array`,
			);
		}
		if (!meta.run_id.endsWith(`-${token}`)) {
			throw new Error(`fixture ${file}: _meta.run_id "${meta.run_id}" does not name run prefix ${token}`);
		}
		let last = 0;
		for (const row of rows as FixtureRow[]) {
			if (row.type === undefined) {
				if (typeof row.stageNumber !== "number" || row.stageNumber <= last) {
					throw new Error(`fixture ${file}: stageNumbers must ascend in trail order`);
				}
				last = row.stageNumber;
			}
		}
		return rows as FixtureRow[];
	};
	const loadRunFixture = (file: string): FixtureRow[] =>
		parseRunFixture(
			JSON.parse(readFileSync(fileURLToPath(new URL(`./built-ins/__fixtures__/${file}`, import.meta.url)), "utf-8")),
			file,
		);

	type Lane = { verdictChannel: string; artifactChannel: string; dimensions: readonly string[]; gradedStage: string };
	const CODE_LANE: Lane = {
		verdictChannel: "code-verdicts",
		artifactChannel: "plans",
		dimensions: PLAN_DIMENSIONS,
		gradedStage: "code-grade",
	};
	const SLICE_LANE: Lane = {
		verdictChannel: "slice-verdicts",
		artifactChannel: "slices",
		dimensions: SLICE_DIMENSIONS,
		gradedStage: "slice-grade",
	};

	// The blocking count over real machinery only: the roster the tier picks,
	// freshness against the lane's artifact, latest-per-dimension, and the
	// exported blocking predicate. Never a re-implementation.
	const countBlocking = (named: Record<string, Output[]>, lane: Lane): number => {
		const state = { named } as unknown as RunView;
		const roster = gateRoster(gateTier(state, lane.verdictChannel), lane.dimensions);
		const fresh = freshVerdicts(named[lane.verdictChannel] ?? [], latestArtifactPath(state, lane.artifactChannel));
		const latest = latestVerdictPerDimension(fresh);
		return roster.filter((d) => verdictBlocks(latest.get(d)?.data as VerdictRecord | undefined)).length;
	};

	// ONE trail-order round rule for all lanes: a round is a maximal run of
	// verdict-channel stage rows (routing rows are transparent — a confirm
	// verdict extends the round it confirms), closed by any different-channel
	// stage row. The blocking count is folded at the round's end, BEFORE the
	// closer's own channel entry lands, so a fix that regenerates the graded
	// artifact cannot retroactively drop the round's verdicts. Fixture meta is
	// trimmed, so the live ts-based cuts cannot run here — trail order is the
	// only round delimiter.
	const replay = (rows: FixtureRow[], lane: Lane) => {
		const named: Record<string, Output[]> = {};
		const blocking: number[] = [];
		let reentryCount = 0;
		let runOpen = false;
		let firstDispatch = true;
		let halt: HaltRow | undefined;
		for (const row of rows) {
			if (row.type === "routing") {
				if (row.decision === lane.gradedStage) {
					if (firstDispatch) {
						firstDispatch = false;
					} else {
						reentryCount++;
					}
				}
				continue;
			}
			if (row.type === "halt") {
				halt = row;
				continue;
			}
			if (row.channel === lane.verdictChannel) {
				runOpen = true;
			} else if (runOpen) {
				blocking.push(countBlocking(named, lane));
				runOpen = false;
			}
			named[row.channel] = (named[row.channel] ?? []).concat(row.output);
		}
		return { blocking, reentryCount, halt };
	};

	// Layer A: the verdict each lap earns off the derived counts. Layer B: the
	// live guard simulation over those verdicts — re-entry 1 is always unknown
	// and counts, improved re-entries waive, the run halts at the re-entry
	// whose increment exceeds the recorded max.
	const simulateGuard = (blocking: readonly number[], max: number) => {
		const views: ProgressValue[] = blocking.map((b, k) => progressFromRoundCounts(blocking.slice(0, k), b));
		let counted = 0;
		let haltAt: number | null = null;
		views.forEach((view, k) => {
			if (view !== "improved") {
				counted++;
				if (counted > max && haltAt === null) haltAt = k + 1;
			}
		});
		return { views, counted, haltAt };
	};

	const pinPanelFixture = (spec: {
		file: string;
		lane: Lane;
		blocking: number[];
		laps: ProgressValue[];
		countedLaps: number;
		views: ProgressValue[];
		haltsAtReentry: number | null;
	}) => {
		const { blocking, reentryCount, halt } = replay(loadRunFixture(spec.file), spec.lane);
		if (!halt) throw new Error(`fixture ${spec.file}: no halt row`);
		expect(blocking, `${spec.file} per-round blocking counts`).toEqual(spec.blocking);
		const laps = blocking.slice(1).map((b, j) => progressFromRoundCounts(blocking.slice(0, j + 1), b));
		expect(laps, `${spec.file} per-lap verdicts`).toEqual(spec.laps);
		expect(
			laps.filter((v) => v !== "improved"),
			`${spec.file} counted laps`,
		).toHaveLength(spec.countedLaps);
		const recorded = halt.errMsg.match(/re-entered (\d+) times \(max (\d+)\)/);
		expect(recorded, `${spec.file} panel-era halt wording`).not.toBeNull();
		const recordedReentries = Number(recorded?.[1]);
		const max = Number(recorded?.[2]);
		expect(reentryCount, `${spec.file} re-entries in the excerpt`).toBe(blocking.length);
		expect(recordedReentries, `${spec.file} recorded halt consumed every re-entry`).toBe(reentryCount);
		const sim = simulateGuard(blocking, max);
		expect(sim.views, `${spec.file} simulated re-entry verdicts`).toEqual(spec.views);
		expect(sim.views[0], `${spec.file} first re-entry is always unknown`).toBe("unknown");
		if (spec.haltsAtReentry === null) {
			expect(sim.haltAt, `${spec.file} converging trail continues under the whole-lap rule`).toBeNull();
		} else {
			expect(sim.haltAt, `${spec.file} halts at the recorded re-entry under both guards`).toBe(spec.haltsAtReentry);
			expect(recordedReentries).toBe(spec.haltsAtReentry);
		}
	};

	it("loader is fail-loud: missing _meta.run_id, a mismatched run prefix, or non-ascending stageNumbers each throw naming the fixture", () => {
		expect(() => parseRunFixture({ rows: [] }, "run-089a-code-grade-cap.json")).toThrow(
			/run-089a-code-grade-cap\.json/,
		);
		expect(() =>
			parseRunFixture({ _meta: { run_id: "2026-09-01_11-34-37-dead" }, rows: [] }, "run-089a-code-grade-cap.json"),
		).toThrow(/089a/);
		expect(() =>
			parseRunFixture(
				{
					_meta: { run_id: "2026-09-01_11-34-37-089a" },
					rows: [
						{ stageNumber: 5, stage: "s", channel: "c", output: {} as Output },
						{ stageNumber: 5, stage: "s", channel: "c", output: {} as Output },
					],
				},
				"run-089a-code-grade-cap.json",
			),
		).toThrow(/ascend/);
	});

	it("089a: converging code lane — blocking 3/2/1/1, improving laps waive, the cap never trips", () => {
		pinPanelFixture({
			file: "run-089a-code-grade-cap.json",
			lane: CODE_LANE,
			blocking: [3, 2, 1, 1],
			laps: ["improved", "improved", "unchanged"],
			countedLaps: 1,
			views: ["unknown", "improved", "improved", "unchanged"],
			haltsAtReentry: null,
		});
	});

	it("8b79: converged panel over a persistent floor — blocking 1/0/0, the whole-lap rule continues past the recorded halt", () => {
		pinPanelFixture({
			file: "run-8b79-code-grade-cap.json",
			lane: CODE_LANE,
			blocking: [1, 0, 0],
			laps: ["improved", "unchanged"],
			countedLaps: 1,
			views: ["unknown", "improved", "unchanged"],
			haltsAtReentry: null,
		});
	});

	it("e9f4: never-improving trail — blocking 1/1/2/1, halts at re-entry 4 under both guards", () => {
		pinPanelFixture({
			file: "run-e9f4-code-grade-cap.json",
			lane: CODE_LANE,
			blocking: [1, 1, 2, 1],
			laps: ["unchanged", "regressed", "unchanged"],
			countedLaps: 3,
			views: ["unknown", "unchanged", "regressed", "unchanged"],
			haltsAtReentry: 4,
		});
	});

	it("7514: slice lane — blocking 1/1/1/1, halts at re-entry 4 under both guards", () => {
		pinPanelFixture({
			file: "run-7514-slice-grade-cap.json",
			lane: SLICE_LANE,
			blocking: [1, 1, 1, 1],
			laps: ["unchanged", "unchanged", "unchanged"],
			countedLaps: 3,
			views: ["unknown", "unchanged", "unchanged", "unchanged"],
			haltsAtReentry: 4,
		});
	});

	it("7514: the verbatim slice-lane panel hook over the same fixture reads one merged R3/R4 basename run and never waives", () => {
		const rows = loadRunFixture("run-7514-slice-grade-cap.json");
		const named: Record<string, Output[]> = {};
		const verdicts: ProgressValue[] = [];
		let firstDispatch = true;
		for (const row of rows) {
			if (row.type === "routing") {
				if (row.decision === "slice-grade") {
					if (firstDispatch) {
						firstDispatch = false;
					} else {
						// Rounds 3 and 4 share one artifact basename — the in-place
						// amend — so basename grouping merges them into a single
						// current round whose fold keeps the newest verdict per
						// dimension and stays blocking.
						verdicts.push(SLICE_PANEL_PROGRESS({ named } as unknown as RunView));
					}
				}
				continue;
			}
			if (row.type === undefined) {
				named[row.channel] = (named[row.channel] ?? []).concat(row.output);
			}
		}
		expect(verdicts).toEqual(["unknown", "unchanged", "unchanged", "unchanged"]);
	});

	it("external tuples: both research trails convert to 2-of-3 counted laps under the rule core", () => {
		// Scores as data, read by nothing else — the recorded external tuples.
		const cc02 = [2, 3, 1, 1];
		const cc02Laps = cc02.slice(1).map((b, j) => progressFromRoundCounts(cc02.slice(0, j + 1), b));
		expect(cc02Laps).toEqual(["regressed", "improved", "unchanged"]);
		expect(cc02Laps.filter((v) => v !== "improved")).toHaveLength(2);
		const ec5e = [2, 1, 2, 1];
		const ec5eLaps = ec5e.slice(1).map((b, j) => progressFromRoundCounts(ec5e.slice(0, j + 1), b));
		expect(ec5eLaps).toEqual(["improved", "regressed", "unchanged"]);
		expect(ec5eLaps.filter((v) => v !== "improved")).toHaveLength(2);
	});

	it("carry-forward: an in-place artifact keeps carried verdicts; a regenerated basename drops them", () => {
		const PLAN = ".rpiv/artifacts/plans/2026-09-01_13-01-59_runtime-supervisor-lane.md";
		const REGENERATED = ".rpiv/artifacts/plans/2026-09-01_13-01-60_runtime-supervisor-lane.md";
		const verdict = (dimension: string, pass: boolean, artifact: string): Output =>
			({
				artifacts: [],
				kind: "json",
				meta: {},
				data: { dimension, pass, severity: pass ? "none" : "medium", artifact },
			}) as unknown as Output;
		const plan = (path: string): Output =>
			({
				artifacts: [{ handle: { kind: "fs", path } }],
				kind: "artifact-md",
				meta: {},
				data: { phase_count: 8 },
			}) as unknown as Output;
		const round1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, d === "completeness" || d === "correctness" ? false : true, PLAN),
		);
		const state1: Record<string, Output[]> = { plans: [plan(PLAN)], "code-verdicts": round1 };
		const first = countBlocking(state1, CODE_LANE);
		expect(first).toBe(2);
		// Round 2 selectively re-grades only the two blocking dimensions, in
		// place: the cumulative fold carries the three passing verdicts forward.
		const selective: Record<string, Output[]> = {
			plans: [plan(PLAN)],
			"code-verdicts": [...round1, verdict("completeness", true, PLAN), verdict("correctness", true, PLAN)],
		};
		const second = countBlocking(selective, CODE_LANE);
		expect(second).toBe(0);
		const fullRoster: Record<string, Output[]> = {
			plans: [plan(PLAN)],
			"code-verdicts": [...round1, ...PLAN_DIMENSIONS.map((d) => verdict(d, true, PLAN))],
		};
		expect(countBlocking(fullRoster, CODE_LANE), "cumulative fold equals the full-roster form").toBe(second);
		expect(progressFromRoundCounts([first], second)).toBe("improved");
		// Control: round 2 regenerated the artifact — the carried verdicts judge
		// a document the channel has since replaced, so freshness drops them and
		// their roster dimensions count as blocking again.
		const regen: Record<string, Output[]> = {
			plans: [plan(REGENERATED)],
			"code-verdicts": [
				...round1,
				verdict("completeness", true, REGENERATED),
				verdict("correctness", true, REGENERATED),
			],
		};
		expect(countBlocking(regen, CODE_LANE)).toBe(3);
	});

	describe("no-hook loops: every re-entry counts — elaborate halts", () => {
		const pinElaborateFixture = (file: string) => {
			const rows = loadRunFixture(file);
			const halt = rows.find((r): r is HaltRow => r.type === "halt");
			if (!halt) throw new Error(`fixture ${file}: no halt row`);
			// The older wording is the no-panel marker: elaborate carries no panel
			// lane, so no progress hook exists and counting is the correct guard.
			const recorded = halt.errMsg.match(/^Backward-jump limit exceeded: (\d+) backward jumps \(max (\d+)\)$/);
			expect(recorded, `${file} keeps the pre-panel halt wording`).not.toBeNull();
			const recordedReentries = Number(recorded?.[1]);
			const max = Number(recorded?.[2]);
			const dispatches = rows.filter((r): r is RoutingRow => r.type === "routing" && r.decision === halt.stage);
			expect(dispatches.length, `${file} first visit plus re-entries`).toBe(recordedReentries + 1);
			let counted = 0;
			let haltedAt = 0;
			for (let i = 1; i < dispatches.length; i++) {
				counted++;
				if (counted > max) {
					haltedAt = i;
					break;
				}
			}
			expect(haltedAt, `${file} halts at the recorded re-entry`).toBe(recordedReentries);
			expect(haltedAt, `${file} last routing row is the halted dispatch`).toBe(dispatches.length - 1);
		};

		it("65fc: halts at the recorded third re-entry under the counting-only guard", () => {
			pinElaborateFixture("run-65fc-elaborate-cap.json");
		});

		it("caf9: same shape — the last routing row is the halted dispatch", () => {
			pinElaborateFixture("run-caf9-elaborate-cap.json");
		});

		it("live-records complement: no built-in stage outside the four panel lanes declares a progress hook", () => {
			const panelStages = new Set([
				"slice-grade",
				"slice-fix",
				"slice-seed-lift",
				"plan-grade",
				"plan-confirm",
				"plan-snapshot",
				"code-grade",
				"code-confirm",
				"code-snapshot",
				"grade",
			]);
			const hooked: string[] = [];
			for (const workflow of builtInWorkflows) {
				for (const [stage, def] of Object.entries(workflow.stages)) {
					if ((def as { progress?: unknown } | undefined)?.progress !== undefined) {
						hooked.push(`${workflow.name}:${stage}`);
					}
				}
			}
			// The complement direction: every hooked stage is a panel-lane
			// destination. Non-panel loops — elaborate, reconcile-fix,
			// validate-fix — and the plain forward edges stay hook-less.
			for (const id of hooked) {
				expect(panelStages.has(id.split(":")[1]), `${id} is not a panel-lane stage`).toBe(true);
			}
		});
	});
});

describe("ship workflow (lightweight /wf preset)", () => {
	// The thirteen stages in linear order — pins that none of build's elaborate
	// machinery (slice*/subplan/*confirm/*snapshot/plan-fix/code*/*demote)
	// leaked into the lightweight preset. `validate-fix` and `reconcile-fix`
	// are the TWO sanctioned arms: each is a single bounded hop
	// (maxFixRounds: 1) at a gate whose fail would otherwise strand verified
	// work — validate's remediation, and reconcile's plan-text directive
	// repair (a fail no TREE hand-repair can clear). `acceptance` is the
	// goal-derived executable standard of completion, frozen between research
	// and planning.
	const SHIP_STAGES: readonly string[] = [
		"goal",
		"research",
		"acceptance",
		"plan",
		"plan-cite-check",
		"grade",
		"implement",
		"implement-scope-check",
		"reconcile",
		"reconcile-fix",
		"validate",
		"validate-fix",
		"commit",
	];

	it("has exactly the thirteen stages in linear order (no slice/subplan/confirm/snapshot/plan-fix/code/demote arms)", () => {
		expect(Object.keys(findWorkflow("ship").stages)).toEqual([...SHIP_STAGES]);
	});

	it("gate edges are stop-on-fail; the backward paths are the two sanctioned fix re-entries", () => {
		const wf = findWorkflow("ship");
		const gates: Array<[string, string[]]> = [
			["plan-cite-check", ["grade", "stop"]],
			["grade", ["implement", "stop"]],
			["implement-scope-check", ["reconcile", "stop"]],
			["reconcile", ["validate", "reconcile-fix", "stop"]],
			["validate", ["commit", "stop", "validate-fix"]],
			// The re-entry: a real fix is re-verified end-to-end (scope floor →
			// reconcile → validate) before the gate re-folds — bounded by the
			// gate's fix-round cap. (reconcile-fix's own re-entry is a plain
			// string edge back to reconcile, asserted separately below.)
			["validate-fix", ["implement-scope-check", "stop"]],
		];
		for (const [src, expected] of gates) {
			const edge = wf.edges[src];
			if (typeof edge !== "function") throw new Error(`ship ${src} edge is not an EdgeFn`);

			expect([...(edge.targets ?? [])].sort(), src).toEqual([...expected].sort());
			// No backward edge otherwise: every non-stop target must follow `src`
			// in the linear order — the preset halts on fail instead of looping.
			if (src === "validate-fix") continue;
			const from = SHIP_STAGES.indexOf(src);
			for (const target of edge.targets ?? []) {
				if (target === "stop") continue;
				expect(SHIP_STAGES.indexOf(target), `${src} → ${target}`).toBeGreaterThan(from);
			}
		}
		// The reconcile-fix re-entry: a plain string edge — the counted decision
		// is the gate's reconcile-fix pick, capped at one round.
		expect(wf.edges["reconcile-fix"]).toBe("reconcile");
	});

	// The terminal gate's single bounded remediation hop — the `remediation`
	// channel length IS the rounds spent (each validate-fix pass publishes
	// exactly one digest), so the cap is deterministic and needs no counter.
	describe("ship validate gate (classifying, maxFixRounds: 1)", () => {
		const route = (named: Record<string, unknown[]>) => {
			const e = findWorkflow("ship").edges.validate;
			if (typeof e !== "function") throw new Error("ship validate edge is not an EdgeFn");
			return (e as EdgeFn)({ output: undefined, state: { named } as unknown as RunView });
		};
		const fail = { data: { verdict: "fail", blockers: [{ id: "b1", command: "npx vitest run", file: "a.ts" }] } };

		it("commits ONLY on an explicit verdict: pass", () => {
			expect(route({ validation: [{ data: { verdict: "pass" } }] })).toBe("commit");
		});
		it("a remediable fail with no remediation spent buys the one hop", () => {
			expect(route({ validation: [fail] })).toBe("validate-fix");
		});
		it("a remediable fail AFTER the spent round stops (the cap)", () => {
			expect(route({ validation: [fail], remediation: [{ data: { changed: true } }] })).toBe("stop");
		});
		it("a prose-only fail stops without buying the hop", () => {
			expect(route({ validation: [{ data: { verdict: "fail" } }] })).toBe("stop");
		});
		it("a missing/unexpected verdict stays terminal", () => {
			expect(route({})).toBe("stop");
			expect(route({ validation: [{ data: { verdict: "meh" } }] })).toBe("stop");
		});
	});

	it("ship's validate-fix is build's remediate arm verbatim (acts, plans+validation reads, remediation digest)", () => {
		const stage = findWorkflow("ship").stages["validate-fix"];
		expect(stage?.kind).toBe("side-effect");
		expect(stage?.skill).toBe("remediate");
		expect(stage?.reads).toEqual(["plans", "validation"]);
		expect(stage?.outcome?.name).toBe("remediation");
	});

	// Ship deliberately keeps the pass-only match — the tiered verdicts build
	// quarantines/adjudicates ("untracked-only"/"excess") are terminal here like
	// any other red gate (stop-on-fail contract, no quarantine arm).
	it("ship's scope gate STOPs the tiered non-pass verdicts (no quarantine arm)", () => {
		const e = findWorkflow("ship").edges["implement-scope-check"];
		if (typeof e !== "function") throw new Error("ship implement-scope-check edge is not an EdgeFn");
		const route = (verdict: string) =>
			String(
				(e as EdgeFn)({
					output: undefined,
					state: { named: { "implement-scope-check": [{ data: { verdict } }] } } as unknown as RunView,
				}),
			);
		expect(route("pass")).toBe("reconcile");
		expect(route("untracked-only")).toBe("stop");
		expect(route("excess")).toBe("stop");
	});

	it('implement reads ["plans"]', () => {
		expect(findWorkflow("ship").stages.implement?.reads).toEqual(["plans"]);
	});

	it('plan reads ["research", "goal", "acceptance"] (planner anchors on the same artifacts the completeness grade judges against)', () => {
		// Without the explicit reads the stage falls to the rolling primary and
		// quick-plan sees only the research doc — whose grounding may narrow the
		// brief — while the grade panel's completeness dimension anchors on the
		// verbatim goal and the acceptance inventory. Same-anchor wiring lets
		// the plan record a per-item disposition (implemented or deferred)
		// instead of silently inheriting the drop.
		expect(findWorkflow("ship").stages.plan?.reads).toEqual(["research", "goal", "acceptance"]);
	});

	it('acceptance derives between research and plan, reading ["goal", "research"]', () => {
		// The executable standard of completion is authored BEFORE the plan
		// exists (goal → items; research → evidence grounding only), so the
		// standard cannot inherit the plan's scope — items land as --acceptance
		// on the completeness grade and are EXECUTED by validate.
		const wf = findWorkflow("ship");
		expect(wf.stages.acceptance?.kind).toBe("produces");
		expect(wf.stages.acceptance?.reads).toEqual(["goal", "research"]);
		expect(wf.edges.research).toBe("acceptance");
		expect(wf.edges.acceptance).toBe("plan");
	});

	it("grade carries a fanout loop, the ship-verdicts outcome, and reads plans/research/goal/acceptance", () => {
		const grade = findWorkflow("ship").stages.grade;
		expect(grade?.loop?.kind).toBe("fanout");
		expect(grade?.outcome?.name).toBe("ship-verdicts");
		expect(grade?.reads).toEqual(["plans", "research", "goal", "acceptance"]);
	});

	// The tiered grounding prompt — pre-chewed briefs (root cause, files, or
	// fix named in the brief itself) VERIFY instead of re-deriving; symptom-only
	// briefs keep the lean two-dispatch mapping pass. Both tiers end at the same
	// Write: a directory-only research path (never a full example path — the
	// collector's pre-write path-echo hazard), announced in the final message.
	describe("SHIP_RESEARCH_PROMPT (tiered to the brief's pre-chewedness)", () => {
		const shipPromptOf = (stage: string) => {
			const prompt = findWorkflow("ship").stages[stage]?.prompt;
			if (typeof prompt !== "function") throw new Error(`ship ${stage} stage has no prompt fn`);
			return prompt;
		};
		const render = (brief: string) =>
			String(
				shipPromptOf("research")({
					cwd: "/repo",
					input: undefined,
					state: { originalInput: brief, named: {} } as unknown as RunView,
				}),
			);
		const tierLine = (prompt: string, tier: "- Tier A" | "- Tier B") => {
			const line = prompt.split("\n").find((l) => l.startsWith(tier));
			if (!line) throw new Error(`prompt has no ${JSON.stringify(tier)} line`);
			return line;
		};

		it("classifies the brief first and names both tiers under the no-/skill:research prohibition", () => {
			const brief = "fix the double-toast on lane switch";
			const prompt = render(brief);
			expect(prompt).toContain("Do NOT dispatch /skill:research");
			expect(prompt).toContain("Classify the brief first, then follow ONLY the matching tier:");
			expect(prompt).toContain(`Brief: ${brief}`);
			expect(tierLine(prompt, "- Tier A")).toContain("pre-chewed");
			expect(tierLine(prompt, "- Tier B")).toContain("symptom only");
		});

		it("Tier A verifies instead of re-deriving: ONE verify-only cap, drift with corrected file:line, zero-dispatch Read/Grep escape", () => {
			// The goal's motivating shape — diagnosis and fix named, no files —
			// is Tier A under the OR trigger (any one of the three suffices).
			const tierA = tierLine(render("diagnosis and fix named, no files"), "- Tier A");
			expect(tierA).toContain("the brief names the root cause, the files to touch, or the fix");
			expect(tierA).toContain("at most ONE codebase-analyzer subagent");
			expect(tierA).toContain("verify-only");
			expect(tierA).toContain("confirming or denying each named anchor");
			expect(tierA).toContain("reporting drift with the corrected file:line");
			expect(tierA).toContain("dispatch nothing — Read/Grep them yourself");
		});

		it("Tier B keeps the two-dispatch mapping sentence body byte-verbatim", () => {
			const tierB = tierLine(render("a symptom-only brief"), "- Tier B");
			expect(tierB).toContain(
				"dispatch at most TWO targeted codebase-analyzer subagents (sequentially — never parallel, never run_in_background) to map only what a single-phase plan needs to be correct: entry points, the relevant module's shape, and the conventions the implement lane must match.",
			);
		});

		it("the sequential discipline appears exactly once per tier and nowhere else", () => {
			const prompt = render("brief");
			expect((prompt.match(/never parallel, never run_in_background/g) ?? []).length).toBe(2);
		});

		it("writes to the research directory only (never a full example path), bounded to under 150 lines, announcing the path, and stops", () => {
			const prompt = render("brief");
			expect(prompt).toContain(".rpiv/artifacts/research/");
			expect(prompt).not.toMatch(/\.rpiv\/artifacts\/research\/\S+\.md/);
			expect((prompt.match(/under 150 lines/g) ?? []).length).toBe(1);
			expect(prompt).toContain("announce the written file's path in your final message");
			expect(prompt.trimEnd().endsWith("and stop.")).toBe(true);
		});

		it("carries the progress-marker protocol between the Tier B bullet and the Brief line: classified first line, dispatch echo with tier ceiling, zero-dispatch escape, transcript-only discipline", () => {
			const prompt = render("a brief for the marker protocol");
			const lines = prompt.split("\n");
			const tierB = lines.findIndex((l) => l.startsWith("- Tier B"));
			const marker = lines.findIndex((l) => l.startsWith("Progress markers"));
			const brief = lines.findIndex((l) => l.startsWith("Brief:"));
			expect(tierB).toBeGreaterThan(-1);
			expect(marker).toBeGreaterThan(tierB);
			expect(brief).toBeGreaterThan(marker);
			expect(prompt).toContain("[Classified]: Tier A — verify-only");
			expect(prompt).toContain("[Classified]: Tier B — map ground truth");
			expect(prompt).toContain("first line of your reply");
			expect(prompt).toContain("[Dispatch N/M]:");
			expect(prompt).toContain("[Dispatch N/M returned]:");
			expect(prompt).toContain("1 for Tier A, 2 for Tier B");
			expect(prompt).toContain("[Dispatch]: none — reading the named anchors directly.");
			expect(prompt).toContain("never artifact content");
			// The tier pins hold on the MERGED render — splicing the marker element
			// in must not disturb the Tier B body, the `and stop.` tail, or the
			// no-full-example-path guarantee (which now covers the marker element).
			expect(prompt).toContain(
				"dispatch at most TWO targeted codebase-analyzer subagents (sequentially — never parallel, never run_in_background) to map only what a single-phase plan needs to be correct: entry points, the relevant module's shape, and the conventions the implement lane must match.",
			);
			expect(prompt.trimEnd().endsWith("and stop.")).toBe(true);
			expect(prompt).not.toMatch(/\.rpiv\/artifacts\/research\/\S+\.md/);
		});
	});
});

describe("implement reads wiring", () => {
	it('every implement stage declares reads: ["plans"]', () => {
		for (const wf of builtInWorkflows) {
			// Defensive: all three live built-ins (build/vet/polish) currently
			// carry `implement`, but this guard skips any read-only workflow should one
			// ever be re-added.
			if (!wf.stages.implement) continue;
			expect(wf.stages.implement.reads, `${wf.name}.implement`).toEqual(["plans"]);
		}
	});

	it("every built-in workflow with an implement stage validates clean (contracts threaded in)", () => {
		for (const name of ["build", "vet", "polish", "ship"]) {
			const issues = deriveAndValidate(findWorkflow(name), { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				name,
			).toEqual([]);
		}
	});
});

describe("contract ownership drift guards", () => {
	it("no built-in workflow stage re-declares a schema its skill's contract owns", () => {
		for (const wf of builtInWorkflows) {
			for (const [stageName, stage] of Object.entries(wf.stages)) {
				const skill = stage.skill ?? stageName;
				const contract = DECLARED_CONTRACTS.get(skill);
				if (contract?.produces?.data) {
					expect(
						stage.outputSchema,
						`${wf.name}.${stageName} re-declares outputSchema the ${skill} contract owns`,
					).toBeUndefined();
				}
				if (contract?.consumes?.data) {
					expect(
						stage.inputSchema,
						`${wf.name}.${stageName} re-declares inputSchema the ${skill} contract owns`,
					).toBeUndefined();
				}
			}
		}
	});

	it("the gate-routed field (blockers_count) is owned by the code-review contract's produces.data", () => {
		// Built-in workflows route only on `blockers_count` (gate("blockers_count", …)); gate()
		// captures the field in a closure (not introspectable), so assert the known routed
		// field is a required produces.data property of its producer. Complements the
		// runtime check that it is sourced + output-validated.
		const data = DECLARED_CONTRACTS.get("code-review")?.produces?.data as
			| { required?: string[]; properties?: Record<string, unknown> }
			| undefined;
		expect(data?.properties?.blockers_count).toBeDefined();
		expect(data?.required).toContain("blockers_count");
	});
});

describe("control-flow specs are introspectable (presets self-describe)", () => {
	// `describeFlow` now projects control-flow off the unified `loop` field;
	// `loopSpecOf(stage.loop)` is the same projection it carries in `control.spec`,
	// asserted directly here for the source/unit/max detail.
	const loopSpecOfStage = (workflow: string, stage: string) => {
		const wf = builtInWorkflows.find((w) => w.name === workflow);
		if (!wf) throw new Error(`workflow ${workflow} not found`);
		return loopSpecOf(wf.stages[stage]?.loop);
	};

	it("build/implement reports a fanout spec sourcing the plans channel", () => {
		expect(loopSpecOfStage("build", "implement")).toMatchObject({
			kind: "fanout",
			source: "plans",
			unit: { by: "frontmatter-array", pattern: "phases" },
			max: 32,
		});
	});

	it("polish/blueprint reports an iterate spec sourcing architecture-reviews", () => {
		expect(loopSpecOfStage("polish", "blueprint")).toMatchObject({
			kind: "iterate",
			source: "architecture-reviews",
		});
	});
});

describe("build edges — implement-scope-check sits between implement and validate", () => {
	const edge = (stage: string): EdgeFn => {
		const e = findWorkflow("build").edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	const route = (stage: string, named: Record<string, unknown>): string =>
		String(
			edge(stage)({
				output: undefined,
				state: { named } as unknown as RunView,
			}),
		);

	it("build routes implement → implement-scope-check (no longer straight to validate)", () => {
		expect(findWorkflow("build").edges.implement).toBe("implement-scope-check");
	});

	it("build routes the tiered scope verdict: pass/excess → reconcile, untracked-only → quarantine, else STOP", () => {
		// The tiered scopeFloorGate (readsData: false — no outputSchema demanded):
		// "pass" AND tracked "excess" continue to reconcile (excess is demoted to
		// validate's adjudication via --scope, the citation-floor precedent);
		// "untracked-only" takes the deterministic quarantine arm; anything else —
		// a missing/corrupt/legacy verdict — is the terminal integrity stop.
		expect(route("implement-scope-check", { "implement-scope-check": [{ data: { verdict: "pass" } }] })).toBe(
			"reconcile",
		);
		expect(route("implement-scope-check", { "implement-scope-check": [{ data: { verdict: "excess" } }] })).toBe(
			"reconcile",
		);
		expect(
			route("implement-scope-check", { "implement-scope-check": [{ data: { verdict: "untracked-only" } }] }),
		).toBe("scope-quarantine");
		// Legacy "fail" (a pre-tiering verdict replayed on resume) and a missing
		// verdict both hit the integrity stop.
		expect(route("implement-scope-check", { "implement-scope-check": [{ data: { verdict: "fail" } }] })).toBe("stop");
		expect(route("implement-scope-check", {})).toBe("stop");
	});

	it("build routes scope-quarantine → implement-scope-check (deterministic re-entry hop)", () => {
		expect(findWorkflow("build").edges["scope-quarantine"]).toBe("implement-scope-check");
	});

	it("build's stage order lists implement → implement-scope-check → scope-quarantine → reconcile → reconcile-fix → validate", () => {
		const keys = Object.keys(findWorkflow("build").stages);
		const i = keys.indexOf("implement");
		const s = keys.indexOf("implement-scope-check");
		const q = keys.indexOf("scope-quarantine");
		const r = keys.indexOf("reconcile");
		const f = keys.indexOf("reconcile-fix");
		const v = keys.indexOf("validate");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(s).toBe(i + 1);
		expect(q).toBe(s + 1);
		expect(r).toBe(q + 1);
		expect(f).toBe(r + 1);
		expect(v).toBe(f + 1);
	});

	it("build's code (elaborate) fanout is dep-gated like implement: phase ids + files-overlap deps, retryHaltedUnits kept", async () => {
		// Elaborate lanes probe the ONE shared working tree (apply → check → revert
		// their own write-scope). Two lanes whose `files:` overlap cannot both
		// revert byte-identically — a lane that snapshots a co-owned file while a
		// sibling's probe is live restores the sibling's transient blocks after the
		// sibling reverted them (run 2026-09-12_14-29-13-5eb9). So the code fanout
		// carries the same `id`/`deps` edges as IMPLEMENT_DAG_FANOUT.
		const loop = findWorkflow("build").stages.code?.loop;
		if (loop?.kind !== "fanout") throw new Error("build code stage has no fanout loop");
		expect(loop.retryHaltedUnits).toBe(1);
		expect(loop.concurrency).toBeUndefined();
		const dir = mkdtempSync(join(tmpdir(), "rpiv-build-code-dag-"));
		try {
			const rel = ".rpiv/artifacts/plans/code-dag.md";
			mkdirSync(join(dir, ".rpiv/artifacts/plans"), { recursive: true });
			writeFileSync(
				join(dir, rel),
				[
					"---",
					"status: ready",
					"phase_count: 3",
					"phases:",
					"  - { n: 1, title: P1, files: [packages/a/one.ts] }",
					"  - { n: 2, title: P2, files: [packages/a/X.ts, packages/a/T.ts] }",
					"  - { n: 3, title: P3, files: [packages/a/T.ts] }",
					"---",
					"# Plan",
					"## Phase 1: P1",
					"## Phase 2: P2",
					"## Phase 3: P3",
					"",
				].join("\n"),
			);
			const units = await loop.units({
				cwd: dir,
				artifact: undefined,
				state: {
					named: { plans: [{ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }] },
				} as unknown as RunView,
			});
			expect(units.map((u) => [u.id, u.deps ?? []])).toEqual([
				["phase-1", []],
				["phase-2", []],
				["phase-3", ["phase-2"]], // co-owns T.ts with phase 2 → serialized behind it
			]);
			expect(units[0]?.prompt).toBe(`${rel} Phase 1: P1`);
			expect(units[0]?.label).toBe("phase 1/3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("build's implement references IMPLEMENT_DAG_FANOUT, no longer carries concurrency (unpinned)", () => {
		const loop = findWorkflow("build").stages.implement?.loop;
		// Phase 2 rewired build to IMPLEMENT_DAG_FANOUT; Phase 3 deletes concurrency:1.
		// Both are unexported consts, exercised through the stage loop. Assert the
		// stage's loop kind is fanout and the DAG closure is distinct from the base
		// FRONTMATTER_PHASE_FANOUT units (the deps-emitting contract); the absence of
		// `concurrency` is the unpin (loop-parallel.ts:146 inherits the host cap).
		expect(loop?.kind).toBe("fanout");
		if (loop?.kind === "fanout") expect(loop.concurrency).toBeUndefined();
	});

	it("build still validates clean with the new stage + route (no unreachable stages)", () => {
		const issues = deriveAndValidate(findWorkflow("build"), { skillContracts: DECLARED_CONTRACTS });
		expect(issues.filter((i) => /unreachable/.test(i.message))).toEqual([]);
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
	});
});

describe("whole-lap progress declarations (panelProgress on the built-in panel lanes)", () => {
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
	const view = (verdictChannel: string, snapshotChannel: string, verdicts: Output[], snapshots: Output[]): RunView =>
		({
			named: { plans: [planRow()], [verdictChannel]: verdicts, [snapshotChannel]: snapshots },
		}) as unknown as RunView;
	const round = (ts: string, blocking: string[]): Output[] =>
		PLAN_DIMENSIONS.map((d) => verdict(d, !blocking.includes(d), ts));

	it("declares the lane's ONE progress instance on all ten re-entered panel stages", () => {
		const build = findWorkflow("build");
		const lanes: Record<string, string[]> = {
			slice: ["slice-grade", "slice-fix", "slice-seed-lift"],
			plan: ["plan-grade", "plan-confirm", "plan-snapshot"],
			code: ["code-grade", "code-confirm", "code-snapshot"],
		};
		const hooks: Record<string, unknown> = {
			slice: SLICE_PANEL_PROGRESS,
			plan: PLAN_PANEL_PROGRESS,
			code: CODE_PANEL_PROGRESS,
		};
		for (const [lane, stages] of Object.entries(lanes)) {
			for (const stage of stages) {
				expect(build.stages[stage]?.progress, `build/${stage}`).toBe(hooks[lane]);
			}
		}
		expect(findWorkflow("ship").stages.grade?.progress).toBe(SHIP_PANEL_PROGRESS);
	});

	it("an upholding lap reads the same verdict at all three of the lane's re-entry points", () => {
		const [A, B, C, D] = PLAN_DIMENSIONS;
		const r1 = round(iso(10), [A, B, C, D]); // 4 blocking
		const r2 = round(iso(11), [A, B]); // broad re-grade: 2 blocking
		const r3 = round(iso(12), [A]); // 1 blocking — the gate is still red
		const confirmUphold = round(iso(12, 20), [A]); // confirm upholds the blocker
		const s1 = [snapshotRow(iso(10, 30))];
		const s2 = [snapshotRow(iso(11, 30))];
		for (const [hook, verdictChannel, snapshotChannel] of [
			[PLAN_PANEL_PROGRESS, "plan-verdicts", "plan-snapshot"],
			[CODE_PANEL_PROGRESS, "code-verdicts", "code-snapshot"],
		] as const) {
			// Grade re-entry: rounds 1–2 behind, the last cut still the current round.
			expect(hook(view(verdictChannel, snapshotChannel, [...r1, ...r2], [...s1, ...s2]))).toBe("improved");
			// Confirm re-entry: round 3 graded, the fold still pre-confirm.
			expect(hook(view(verdictChannel, snapshotChannel, [...r1, ...r2, ...r3], [...s1, ...s2]))).toBe("improved");
			// Snapshot re-entry: the confirm upheld — the post-confirm fold reads the same.
			expect(
				hook(view(verdictChannel, snapshotChannel, [...r1, ...r2, ...r3, ...confirmUphold], [...s1, ...s2])),
			).toBe("improved");
		}
	});

	it("a confirm that overturns blockers reads improved only at the post-confirm re-entries", () => {
		const [A, B, C] = PLAN_DIMENSIONS;
		const r1 = round(iso(10), [A, B, C]); // 3 blocking
		const r2 = round(iso(11), [A, B, C]); // re-graded: still 3
		const overturn = [verdict(B, true, iso(11, 20)), verdict(C, true, iso(11, 20))];
		const s1 = [snapshotRow(iso(10, 30))];
		// The confirm re-entry itself reads the PRE-confirm fold: 3 blocking.
		expect(PLAN_PANEL_PROGRESS(view("plan-verdicts", "plan-snapshot", [...r1, ...r2], s1))).toBe("unchanged");
		// The snapshot re-entry after the overturn reads the POST-confirm fold: 1.
		expect(PLAN_PANEL_PROGRESS(view("plan-verdicts", "plan-snapshot", [...r1, ...r2, ...overturn.flat()], s1))).toBe(
			"improved",
		);
	});

	it("a seed lift leaves the verdict channel unchanged — the lap stays one unit", () => {
		const sliceVerdict = (i: number, ts: string): Output =>
			({
				artifacts: [],
				kind: "json",
				meta: { ts },
				data: {
					dimension: "design-readiness",
					pass: false,
					severity: "high",
					artifact: `.rpiv/artifacts/slices/map-${i}.md`,
				},
			}) as unknown as Output;
		// The grade re-entry that dispatched the lift saw rounds 1–2; the lift
		// amends the map in place and publishes NO verdict, so the post-lift
		// re-entry sees a byte-identical channel and reads the same value.
		const beforeLift = { named: { "slice-verdicts": [sliceVerdict(1, iso(10)), sliceVerdict(2, iso(11))] } };
		const afterLift = { named: { "slice-verdicts": [sliceVerdict(1, iso(10)), sliceVerdict(2, iso(11))] } };
		const before = SLICE_PANEL_PROGRESS(beforeLift as unknown as RunView);
		expect(before).toBe("unchanged");
		expect(SLICE_PANEL_PROGRESS(afterLift as unknown as RunView)).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Cross-workflow identity pins — module-instance sharing between workflows.
// ---------------------------------------------------------------------------

describe("shared-instance identity pins (cross-workflow)", () => {
	it("build and vet wire the SAME reconcile run function (no vet twin)", () => {
		const buildRun = findWorkflow("build").stages.reconcile?.run;
		const vetRun = findWorkflow("vet").stages.reconcile?.run;
		expect(vetRun).toBeDefined();
		expect(vetRun).toBe(buildRun); // reference equality — idempotent overwrite across the vet loop
	});
});
