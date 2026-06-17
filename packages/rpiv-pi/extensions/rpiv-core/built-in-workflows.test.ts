/**
 * Regression tests for built-in workflow behaviour. Each describe block
 * asserts the expected behaviour for one previously-broken path:
 *
 *   - the `validate → commit` auto edge must not skip the code-review fix loop;
 *   - `writeHeader` failure must not silently drop the first stage row;
 *   - a missing routing field must not silently route to `commit`;
 *   - a truncated reply (`stopReason ∈ {"length","toolUse"}`) must not collapse
 *     to `"ok"`;
 *   - `recordStage` must not reuse stageNumbers after an append failure, so
 *     `stagesCompleted` can't drift above the on-disk row count;
 *   - phase fanout must label JSONL rows by `stage.skill`, not stage id (which
 *     is wrong for aliased implement stages);
 *   - the runner must not reuse `originalInput` past the first stage, so later
 *     stages receive the upstream output rather than the user's brief.
 *
 * They exercise the `Workflow` shape directly.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	type FanoutFn,
	fanout,
	type Output,
	produces,
	type RunView,
	runWorkflow,
	validateWorkflow,
	type Workflow,
} from "@juicesharp/rpiv-workflow";
import { type RunState, runsDir, stateFilePath } from "@juicesharp/rpiv-workflow/internal";
import { describeFlow, fs as fsHandle, loopSpecOf } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpivArtifactMdOutcome } from "./artifact-collector.js";
import { builtInWorkflows } from "./built-in-workflows.js";
import { deriveOutcomes } from "./outcome-derivation.js";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import { buildSkillContractsFromFrontmatter } from "./skill-contracts-source.js";

// Built-ins are validated in production with the declared skill contracts
// threaded in (load/index.ts: buildEffectiveContracts → validateWorkflow). The
// code-review stages carry no inline outputSchema — `blockers_count` is sourced
// from the contract — so the same contracts must be supplied here, or the
// contract-backed routing lint (checkPredicateSchemas) fires a false warning.
const DECLARED_CONTRACTS = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));

/**
 * Prepare a workflow for validation by deriving contract-sourced outcomes onto
 * a mutable copy. The built-in workflows no longer carry explicit outcomes —
 * they are contract-derived. The deriver must run before validateWorkflow
 * checks the `produces-without-outcome` guard.
 */
const deriveAndValidate = (
	wf: Workflow,
	opts?: { skillContracts?: Map<string, import("@juicesharp/rpiv-workflow/registration").SkillContract> },
) => {
	return validateWorkflow(withDerivedOutcomes(wf, opts?.skillContracts), opts);
};

/**
 * Create a mutable copy of a workflow with contract-derived outcomes. Used by
 * tests that bypass the loader (passing workflows directly to `runWorkflow`).
 */
const withDerivedOutcomes = (
	wf: Workflow,
	skillContracts?: Map<string, import("@juicesharp/rpiv-workflow/registration").SkillContract>,
): Workflow => {
	const mutable: Workflow = { ...wf, stages: { ...wf.stages } };
	for (const [name, stage] of Object.entries(wf.stages)) {
		(mutable.stages as Record<string, typeof stage>)[name] = { ...stage };
	}
	deriveOutcomes([mutable], skillContracts ?? DECLARED_CONTRACTS, () => {}, new Map());
	return mutable;
};

const findWorkflow = (name: string): Workflow => {
	const w = builtInWorkflows.find((x) => x.name === name);
	if (!w) throw new Error(`built-in workflow "${name}" not found`);
	return w;
};

// ---------------------------------------------------------------------------
// validate must route to code-review (not commit) in build/arch workflows.
// ---------------------------------------------------------------------------

describe("validate → code-review routing in built-in workflows", () => {
	it("routes validate → code-review in build", () => {
		const build = findWorkflow("build");
		expect(build.edges.validate).toBe("code-review");
	});

	it("routes validate → code-review in arch", () => {
		const arch = findWorkflow("arch");
		expect(arch.edges.validate).toBe("code-review");
	});

	it("every stage in every built-in workflow is reachable from start", () => {
		for (const wf of builtInWorkflows) {
			const issues = validateWorkflow(wf);
			expect(
				issues.filter((i) => /unreachable/.test(i.message)),
				`workflow "${wf.name}" has unreachable stages`,
			).toEqual([]);
		}
	});

	it("revise loops back to implement (backward edge re-enters implement → validate → code-review cycle)", () => {
		const build = findWorkflow("build");
		expect(build.edges.revise).toBe("implement");
	});
});

// ---------------------------------------------------------------------------
// When writeHeader silently fails, the first stage row written by appendStage
// lands at line 0 and is dropped by every reader.
// ---------------------------------------------------------------------------

describe("readers must not silently drop the first row when no header is on disk", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-i2-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readLastStage returns the row even when the header line is missing", async () => {
		const { readLastStage } = await import("@juicesharp/rpiv-workflow");
		const runId = "2026-05-23_13-05-38-abcd";
		mkdirSync(runsDir(tmpDir), { recursive: true });
		const filePath = stateFilePath(tmpDir, runId);
		const stageRow = {
			stageNumber: 1,
			stage: "research",
			skill: "research",
			artifact: ".rpiv/artifacts/research/r.md",
			status: "completed" as const,
			ts: "2026-05-23T13:06:00-0400",
		};
		appendFileSync(filePath, `${JSON.stringify(stageRow)}\n`, "utf-8");

		// readLastStage must filter by row shape, not by line position.
		expect(readLastStage(tmpDir, runId)).toEqual(stageRow);
	});
});

// ---------------------------------------------------------------------------
// A predicate firing on un-validated frontmatter (missing severeIssueCount)
// must not silently route to commit. The output-schema layer is what makes
// missing data impossible to reach the predicate.
// ---------------------------------------------------------------------------

describe("code-review routing field is sourced + validated from the contract", () => {
	it("no built-in code-review stage carries an inline outputSchema", () => {
		// Single source of truth: blockers_count lives in the skill contract,
		// not copy-pasted per workflow. Sourced at runtime by effectiveOutputSchema.
		for (const name of ["build", "arch", "vet", "polish"]) {
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

// ---------------------------------------------------------------------------
// A `stopReason: "length"` reply on a side-effect stage must NOT be recorded
// as a successful "completed" stage.
// ---------------------------------------------------------------------------

describe("truncated reply (stopReason=length) must not record as completed", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-i7-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const singleActionWorkflow = (): Workflow =>
		defineWorkflow({
			name: "tiny",
			start: "implement",
			stages: { implement: acts() },
			edges: { implement: "stop" },
		});

	const readStages = (cwd: string): Array<Record<string, unknown>> => {
		const dir = join(cwd, ".rpiv", "workflows", "runs");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return lines.slice(1).map((l) => JSON.parse(l));
	};

	it("does not write status=completed for an implement stage that hit the length cap", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial edit before output cap reached", "length")] }],
		});

		const result = await runWorkflow(chain.ctx, { workflow: singleActionWorkflow(), input: "add dark mode" });

		expect(result.success).toBe(false);
		const stages = readStages(tmpDir);
		const recorded = stages.find((s) => s.skill === "implement");
		expect(recorded?.status).not.toBe("completed");
	});

	it("does not write status=completed for a side-effect stage that returned stopReason=toolUse", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("invoked a tool but never settled", "toolUse")] }],
		});

		const result = await runWorkflow(chain.ctx, { workflow: singleActionWorkflow(), input: "add dark mode" });

		expect(result.success).toBe(false);
		const stages = readStages(tmpDir);
		const recorded = stages.find((s) => s.skill === "implement");
		expect(recorded?.status).not.toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// recordStage must signal write success/failure so stagesCompleted stays
// aligned with on-disk rows, and stageNumbers never repeat.
// ---------------------------------------------------------------------------

describe("recordStage signals success and advances stageNumber monotonically", () => {
	let tmpDir: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-i3-repro-"));
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	const freshState = (): RunState => ({
		originalInput: "",
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: {
			backwardJumps: 0,
			droppedRoutingRows: [],
			droppedFailureRows: [],
		},
		termination: { status: "running" },
	});

	it("returns the assigned stageNumber on a successful write", async () => {
		const { recordStage } = await import("@juicesharp/rpiv-workflow/internal");
		const state = freshState();
		const assigned = recordStage(
			tmpDir,
			"run-1",
			{ session: null, stage: "research", skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
			state,
		);
		expect(assigned).toBe(1);
		expect(state.lastAllocatedStageNumber).toBe(1);
	});

	it("returns undefined on a write failure but still advances lastAllocatedStageNumber (no number reuse)", async () => {
		const { recordStage } = await import("@juicesharp/rpiv-workflow/internal");
		const state = freshState();
		const failedAssignment = recordStage(
			"/dev/null/impossible",
			"run-1",
			{ session: null, stage: "research", skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
			state,
		);
		expect(failedAssignment).toBeUndefined();
		expect(state.lastAllocatedStageNumber).toBe(1);

		const nextAssignment = recordStage(
			tmpDir,
			"run-1",
			{ session: null, stage: "design", skill: "design", status: "completed", ts: "2026-05-23T00:00:01Z" },
			state,
		);
		expect(nextAssignment).toBe(2);
		expect(state.lastAllocatedStageNumber).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Non-first stages must NOT silently fall back to originalInput when their
// upstream produced no artifactPath.
// ---------------------------------------------------------------------------

describe("non-first stage with no artifactPath halts instead of reusing originalInput", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-q7-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("halts the chain when a non-start stage has no upstream artifactPath", async () => {
		const workflow = defineWorkflow({
			name: "tiny",
			start: "commit",
			stages: {
				commit: acts(),
				"annotate-guidance": acts(),
			},
			edges: { commit: "annotate-guidance", "annotate-guidance": "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("commit done")] },
				{ branch: [mockAssistantMessage("would never receive originalInput in a sane chain")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "add dark mode" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/artifact|input/i);
		expect(chain.sentMessages).not.toContain("/skill:annotate-guidance add dark mode");
	});
});

// ---------------------------------------------------------------------------
// Phase fanout must label JSONL rows by stage.skill, not by the stage name.
// ---------------------------------------------------------------------------

describe("phase fanout rows preserve both stage name (record key) and skill body across aliasing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-i9-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const readRows = (cwd: string): Array<Record<string, unknown>> => {
		const dir = join(cwd, ".rpiv", "workflows", "runs");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return lines.map((l) => JSON.parse(l));
	};

	it("phase rows for an aliased implement stage carry skill=implement AND stage='implement-after-revise (phase N/M)'", async () => {
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, planRelPath), "# Plan\n\n## Phase 1: a\nbody\n## Phase 2: b\nbody\n");

		// Local `## Phase N:` fanout — inlined (not imported) so the test exercises
		// the public FanoutFn shape; aliasing audit is what's under test, not phase
		// parsing, so a minimal number-only fanout suffices.
		const phaseFanout: FanoutFn = ({ artifact: primary, cwd }) => {
			if (primary?.handle.kind !== "fs") return [];
			const path = primary.handle.path;
			const abs = isAbsolute(path) ? path : join(cwd, path);
			const content = readFileSync(abs, "utf-8");
			const matches = [...content.matchAll(/^## Phase (\d+):/gm)];
			return matches.map((m, i) => ({
				prompt: `${path} Phase ${m[1]}`,
				label: `phase ${i + 1}/${matches.length}`,
			}));
		};

		const workflow = defineWorkflow({
			name: "tiny",
			start: "research",
			stages: {
				research: produces({ outcome: rpivArtifactMdOutcome }),
				"implement-after-revise": acts({ skill: "implement", loop: fanout({ units: phaseFanout }) }),
			},
			edges: { research: "implement-after-revise", "implement-after-revise": "stop" },
		});

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				{ branch: [mockAssistantMessage("phase 1 done")] },
				{ branch: [mockAssistantMessage("phase 2 done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);

		expect(chain.sentMessages).toEqual([
			"/skill:research x",
			`/skill:implement ${planRelPath} Phase 1`,
			`/skill:implement ${planRelPath} Phase 2`,
		]);

		const phaseRows = readRows(tmpDir).filter(
			(r) => typeof r.stage === "string" && (r.stage as string).includes("phase"),
		);
		expect(phaseRows).toHaveLength(2);
		for (const row of phaseRows) {
			// .stage carries the aliased record key + unit suffix (workflow-graph identity).
			expect(row.stage).toMatch(/^implement-after-revise \(phase \d+\/\d+\)$/);
			// .skill carries the raw Pi skill body — no aliasing, no unit suffix.
			expect(row.skill).toBe("implement");
		}
	});
});

// ---------------------------------------------------------------------------
// vet workflow routing predicate and backward-jump loop behavior.
// ---------------------------------------------------------------------------

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
			// maxBackwardJumps=2, the guard halts after the 4th code-review's
			// decision-edge increments backwardJumps to 3 (>2). The cycle:
			//   cr1→bp1→impl1→v1 → cr2→bp2→impl2→v2 → cr3→bp3→impl3→v3 → cr4(HALT)
			// Stages completed: 13 (cr×4 + bp×3 + impl×3 + validate×3).
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
			// 13 stages: cr×4 + bp×3 + impl×3 + validate×3. The 4th code-review's
			// decision increments backwardJumps to 3 (> maxBackwardJumps=2).
			expect(result.stagesCompleted).toBe(13);
		});
	});
});

// ---------------------------------------------------------------------------
// polish — iterate-driven per-review-phase blueprint + latest-pass implement.
// ---------------------------------------------------------------------------

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
			for (const n of [1, 2, 3]) write(`.rpiv/artifacts/plans/plan-${n}.md`, plan());
			for (const n of [1, 2, 3]) write(`.rpiv/artifacts/validation/val-${n}.md`, "");
			for (const n of [1, 2, 3]) write(`.rpiv/artifacts/reviews/cr-${n}.md`, cr(1)); // always blockers → loop

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
					// 3rd code-review's gate → blueprint = backward jump 3 > 2 → halt
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
			]);
			// validate shares the same latest-pass slice — each round validates only
			// that pass's plan, never a stale generation.
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:validate"))).toEqual([
				"/skill:validate .rpiv/artifacts/plans/plan-1.md",
				"/skill:validate .rpiv/artifacts/plans/plan-2.md",
				"/skill:validate .rpiv/artifacts/plans/plan-3.md",
			]);
		});
	});
});

// ---------------------------------------------------------------------------
// design-to-code — the prompt-dispatch worked example. NOT registered in
// builtInWorkflows: it names `frontend-design` (a separate plugin skill, not
// bundled by rpiv-pi) and rides the unexercised continue path. Kept here as a
// validated example proving the spec's three-dispatch chain is well-formed.
// ---------------------------------------------------------------------------

describe("design-to-code example (prompt dispatch)", () => {
	const designToCode = defineWorkflow({
		name: "design-to-code",
		description: "Discover a spec, design in the same session, then implement from conversation context.",
		start: "discover",
		stages: {
			// skill dispatch, fresh — writes a spec artifact, opens the session
			discover: produces({ outcome: rpivArtifactMdOutcome }),
			// skill dispatch, continue — reasons in-session, produces no tracked artifact
			design: acts({ skill: "frontend-design", sessionPolicy: "continue" }),
			// prompt dispatch, continue — a focused instruction leaning on context
			implement: acts({ prompt: "Implement the design spec discussed above.", sessionPolicy: "continue" }),
		},
		edges: { discover: "design", design: "implement", implement: "stop" },
	});

	it("validates with zero errors and zero warnings", () => {
		expect(validateWorkflow(designToCode)).toEqual([]);
	});

	it("all stages are reachable from start", () => {
		expect(validateWorkflow(designToCode).filter((i) => /unreachable/.test(i.message))).toEqual([]);
	});

	it("resolves all three dispatch types in one chain", () => {
		// discover → skill dispatch (no prompt, no run)
		expect(designToCode.stages.discover?.prompt).toBeUndefined();
		expect(designToCode.stages.discover?.run).toBeUndefined();
		// design → skill dispatch in a continued session
		expect(designToCode.stages.design?.skill).toBe("frontend-design");
		expect(designToCode.stages.design?.sessionPolicy).toBe("continue");
		// implement → prompt dispatch in a continued session
		expect(typeof designToCode.stages.implement?.prompt).toBe("string");
		expect(designToCode.stages.implement?.sessionPolicy).toBe("continue");
		expect(designToCode.stages.implement?.skill).toBeUndefined();
	});

	it("runs the skill → continue-skill → continue-prompt chain end-to-end as detached children", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "rpiv-d2c-"));
		try {
			// discover's spec must exist on disk (rpivArtifactMdOutcome reads frontmatter).
			mkdirSync(join(tmpDir, ".rpiv", "artifacts", "research"), { recursive: true });
			writeFileSync(join(tmpDir, ".rpiv/artifacts/research/spec.md"), "");

			// Detachment: each stage (including continue stages) runs in its OWN
			// child — one scripted step per stage, each carrying that turn's branch.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/research/spec.md")] },
					{ branch: [mockAssistantMessage("design reasoning")] },
					{ branch: [mockAssistantMessage("implemented")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: designToCode,
				input: "build a dashboard",
			});

			expect(result.success).toBe(true);
			// discover (fresh) + design (continue) + implement (continue prompt)
			expect(result.stagesCompleted).toBe(3);
			// Every stage spawns its own child off the launcher — no shared session.
			expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(3);
			expect(chain.sentMessages).toEqual([
				"/skill:discover build a dashboard",
				"/skill:frontend-design .rpiv/artifacts/research/spec.md",
				"Implement the design spec discussed above.",
			]);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// ship — fast path: blueprint → implement → validate → commit. implement fans
// out over the plan's structured `phases:` array (derived by blueprint from its
// `## Phase N:` headings, title-enriched and verified against those headings).
// ---------------------------------------------------------------------------

describe("ship workflow", () => {
	it("chains blueprint → implement → validate → commit", () => {
		const wf = findWorkflow("ship");
		expect(wf.start).toBe("blueprint");
		expect(Object.keys(wf.stages)).toEqual(["blueprint", "implement", "validate", "commit"]);
		expect(wf.edges.blueprint).toBe("implement");
		expect(wf.edges.implement).toBe("validate");
		expect(wf.edges.validate).toBe("commit");
		expect(wf.edges.commit).toBe("stop");
	});

	it("blueprint stage carries no inline outputSchema (phases sourced from the skill contract)", () => {
		expect(findWorkflow("ship").stages.blueprint?.outputSchema).toBeUndefined();
	});

	it("validates without errors or warnings (contracts threaded in)", () => {
		const issues = deriveAndValidate(findWorkflow("ship"), { skillContracts: DECLARED_CONTRACTS });
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
		expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
	});

	describe("FRONTMATTER_PHASE_FANOUT", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-ship-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		const fanout = () => {
			const loop = findWorkflow("ship").stages.implement?.loop;
			if (loop?.kind !== "fanout") throw new Error("ship implement stage has no fanout loop");
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
			writePlan(
				rel,
				`---\nphases:\n  - { n: 1, title: Only one }\n---\n## Phase 1: a\n## Phase 2: b\n## Phase 3: c\n`,
			);
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

	describe("end-to-end via runWorkflow", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-ship-e2e-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});
		const write = (rel: string, body: string) => {
			const parts = rel.split("/");
			mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
			writeFileSync(join(tmpDir, rel), body);
		};
		const step = (m: string) => ({ branch: [mockAssistantMessage(m)] });

		it("drives blueprint → implement (fanned from the derived phases) → validate → commit", async () => {
			write(
				".rpiv/artifacts/plans/plan.md",
				`---\nstatus: ready\nphase_count: 2\nphases:\n  - { n: 1, title: Schema layer }\n  - { n: 2, title: Runtime wiring }\n---\n# Plan\n## Phase 1: Schema layer\n## Phase 2: Runtime wiring\n`,
			);
			write(".rpiv/artifacts/validation/val.md", "");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					step("wrote .rpiv/artifacts/plans/plan.md"), // blueprint
					step("phase done"), // implement — phase 1 unit
					step("phase done"), // implement — phase 2 unit
					step("wrote .rpiv/artifacts/validation/val.md"), // validate
					step("committed"), // commit
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: withDerivedOutcomes(findWorkflow("ship")),
				input: "add a feature",
			});

			expect(result.success).toBe(true);
			// blueprint + implement×2 (one per derived phase) + validate + commit
			expect(result.stagesCompleted).toBe(5);
			expect(chain.sentMessages.filter((m) => m.startsWith("/skill:implement"))).toEqual([
				"/skill:implement .rpiv/artifacts/plans/plan.md Phase 1: Schema layer",
				"/skill:implement .rpiv/artifacts/plans/plan.md Phase 2: Runtime wiring",
			]);
		});
	});
});

// ---------------------------------------------------------------------------
// pr-triage security-gate — the script-stage guard must fail closed on
// missing / malformed security_flag (NaN), not silently pass as SAFE.
// ---------------------------------------------------------------------------

describe("pr-triage security-gate", () => {
	const gateRun = () => {
		const stage = findWorkflow("pr-triage").stages["security-gate"];
		if (!stage?.run) throw new Error("pr-triage security-gate stage has no run function");
		return stage.run as (ctx: { input?: { data?: unknown } }) => void;
	};

	it("throws on missing input (undefined)", () => {
		expect(() => gateRun()({ input: undefined })).toThrow(/BLOCK/);
	});

	it("throws on non-numeric security_flag (NaN)", () => {
		expect(() => gateRun()({ input: { data: { security_flag: "not-a-number" } } })).toThrow(/BLOCK/);
	});

	it("throws on BLOCK (security_flag = 2)", () => {
		expect(() => gateRun()({ input: { data: { security_flag: 2 } } })).toThrow(/BLOCK/);
	});

	it("does not throw on SAFE (security_flag = 0)", () => {
		expect(() => gateRun()({ input: { data: { security_flag: 0 } } })).not.toThrow();
	});

	it("does not throw on REVIEW (security_flag = 1)", () => {
		expect(() => gateRun()({ input: { data: { security_flag: 1 } } })).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// implement reads wiring — every implement stage declares reads: ["plans"]
// and validates clean with contracts threaded in.
// ---------------------------------------------------------------------------

describe("implement reads wiring", () => {
	it('every implement stage declares reads: ["plans"]', () => {
		for (const wf of builtInWorkflows) {
			// Not every workflow has an implement stage (pr-triage is read-only triage).
			if (!wf.stages.implement) continue;
			expect(wf.stages.implement.reads, `${wf.name}.implement`).toEqual(["plans"]);
		}
	});

	it("every built-in workflow with an implement stage validates clean (contracts threaded in)", () => {
		for (const name of ["ship", "build", "arch", "vet", "polish"]) {
			const issues = deriveAndValidate(findWorkflow(name), { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				name,
			).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// polish — REVIEW_PHASE_ITERATE enumerates the review's structured `phases:`
// array (derived by architecture-review from its `### Phase N — name` headings)
// and verifies that array against the headings.
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
	const shapeOf = (workflow: string, stage: string) => {
		const wf = builtInWorkflows.find((w) => w.name === workflow);
		if (!wf) throw new Error(`workflow ${workflow} not found`);
		return describeFlow(wf).find((s) => s.stage === stage);
	};
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

	it("code-review reports a route edge with both branch targets", () => {
		const cr = shapeOf("build", "code-review");
		expect(cr?.edge.mode).toBe("route");
		expect(cr?.edge.targets).toEqual(expect.arrayContaining(["revise", "commit"]));
	});
});
