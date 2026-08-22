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

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
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
import { type RunState, runsDir, stateFilePath, takeRouteNote } from "@juicesharp/rpiv-workflow/internal";
import { fanin, fs as fsHandle, loopSpecOf } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpivArtifactMdOutcome } from "./artifact-collector.js";
import {
	builtInWorkflows,
	SHIP_DIMENSION_FANOUT,
	SHIP_DIMENSIONS,
	shipGatePasses,
	shipVerdictOutcome,
} from "./built-in-workflows.js";
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

it("build is the default workflow (builtInWorkflows[0].name === 'build')", () => {
	// Position 0 is load-bearing: resolve-default.ts picks
	// `Map.keys().next().value` when no project/user config sets a default, so
	// build MUST stay first in the builtInWorkflows export array.
	expect(builtInWorkflows[0]?.name).toBe("build");
});

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
		failureMemos: [],
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
});

// ---------------------------------------------------------------------------
// build confirm panels — the second judgment on a blocking dimension runs in
// confirm mode: the unit carries the blocking verdict as --prior so the grade
// skill must adjudicate the prior round's findings (uphold / refute with cited
// evidence) instead of silently out-voting them at the latest-per-dimension
// fold. Grade panels never thread --prior; neither does a confirm unit for a
// dimension with nothing blocking (first grade, stale verdict, carried pass).
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

	it("grade panels never thread --prior, even over the same failing verdicts", async () => {
		const units = await loopOf("plan-grade").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-verdicts": [
						...OTHER_DIMS.map(passing),
						failingCorrectness(".rpiv/artifacts/verdicts/p__correctness__round-1.json"),
					],
				},
			} as unknown as RunView,
		});
		expect(units.every((u) => !u.prompt.includes("--prior"))).toBe(true);
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
					"plan-verdicts": [stale],
				},
			} as unknown as RunView,
		});
		expect(units.length).toBeGreaterThan(0); // every dimension re-grades from scratch...
		expect(units.every((u) => !u.prompt.includes("--prior"))).toBe(true); // ...with no prior
	});

	it("the degenerate all-passing fallback re-grades the roster without --prior (a carried pass has nothing to adjudicate)", async () => {
		const units = await loopOf("plan-confirm").units({
			cwd: "/repo",
			artifact: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/p.md")],
					"plan-verdicts": [...OTHER_DIMS.map(passing), passing("correctness")],
				},
			} as unknown as RunView,
		});
		expect(units.length).toBeGreaterThan(0);
		expect(units.every((u) => !u.prompt.includes("--prior"))).toBe(true);
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

		it("omits --cite-check when the cite floor is clean or the channel is absent", async () => {
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
							dataOut(".rpiv/artifacts/verdicts/plan-cite-check__p.json", {
								dimension: "structure",
								pass: true,
								severity: "none",
								findings: [],
							}),
						],
					},
				} as unknown as RunView,
			});
			const absent = await SHIP_DIMENSION_FANOUT.units({
				cwd: "/repo",
				artifact: undefined,
				state: { named: base } as unknown as RunView,
			});
			expect([...clean, ...absent].every((u) => !u.prompt.includes("--cite-check"))).toBe(true);
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

describe("build goal channel (verbatim brief threading)", () => {
	const build = () => findWorkflow("build");
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const promptFnOf = (stage: string) => {
		const prompt = build().stages[stage]?.prompt;
		if (typeof prompt !== "function") throw new Error(`build ${stage} stage has no prompt fn`);
		return prompt;
	};
	const gateUnits = (stage: string, named: Record<string, unknown>) => {
		const loop = build().stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop.units({ cwd: "/repo", artifact: undefined, state: { named } as unknown as RunView });
	};

	describe("goal capture stage", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-goal-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("is the start stage and writes the brief byte-for-byte", () => {
			expect(build().start).toBe("goal");
			const stage = build().stages.goal;
			if (!stage?.run) throw new Error("build goal stage has no run function");
			const run = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
				artifacts: readonly { handle: { kind: string; path: string }; role?: string }[];
			};
			const brief = "add dark mode\n\nconstraints:\n- don't touch auth\n- keep it minimal";
			const output = run({
				cwd: tmpDir,
				input: undefined,
				state: { originalInput: brief, named: {} } as unknown as RunView,
			});
			const handle = output.artifacts[0]?.handle;
			expect(handle?.kind).toBe("fs");
			expect(handle?.path).toMatch(/^\.rpiv\/artifacts\/goal\/goal-.+\.md$/);
			expect(readFileSync(join(tmpDir, handle?.path ?? ""), "utf-8")).toBe(brief);
			// The run-start baseline rides SECOND on the same output, under its role —
			// per-run timestamped (no fixed rendezvous path), empty here (non-repo cwd).
			const baseline = output.artifacts[1];
			expect(baseline?.role).toBe("baseline");
			expect(baseline?.handle.path).toMatch(/^\.rpiv\/artifacts\/goal\/baseline-.+\.json$/);
			const parsed = JSON.parse(readFileSync(join(tmpDir, baseline?.handle.path ?? ""), "utf-8"));
			expect(parsed).toEqual({ paths: [] });
		});
	});

	it("research dispatches the raw brief via prompt (goal displaced it from the start slot)", () => {
		const dispatch = promptFnOf("research")({
			cwd: "/repo",
			input: undefined,
			state: { originalInput: "add dark mode", named: {} } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:research add dark mode");
	});

	it("threads --goal into completeness and correctness only, leaving --context untouched", async () => {
		const units = await gateUnits("plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			research: [out(".rpiv/artifacts/research/r.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
		});
		const byLabel = new Map(units.map((u) => [u.label, u.prompt]));
		expect(byLabel.get("completeness")).toContain("--goal .rpiv/artifacts/goal/goal.md");
		expect(byLabel.get("correctness")).toContain("--goal .rpiv/artifacts/goal/goal.md");
		for (const d of ["actionability", "pattern-following", "architecture-fit"]) {
			expect(byLabel.get(d)).not.toContain("--goal");
		}
		expect(byLabel.get("architecture-fit")).toContain("--context .rpiv/artifacts/research/r.md");
	});

	it("omits --goal when the channel is empty, and the slice gate stays goal-blind", async () => {
		const bare = await gateUnits("plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			research: [out(".rpiv/artifacts/research/r.md")],
		});
		expect(bare.every((u) => !u.prompt.includes("--goal"))).toBe(true);
		const slice = await gateUnits("slice-grade", {
			slices: [out(".rpiv/artifacts/slices/s.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
		});
		expect(slice.every((u) => !u.prompt.includes("--goal"))).toBe(true);
	});

	it("both grade gates declare the goal read", () => {
		expect(build().stages["plan-grade"]?.reads).toContain("goal");
		expect(build().stages["code-grade"]?.reads).toContain("goal");
	});

	it("validate dispatches the LATEST plan from the named channel plus --goal", () => {
		// Named-channel sourcing is load-bearing: after the code gate the
		// rolling primary is the last verdict JSON, not the plan.
		const dispatch = promptFnOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/old.md"), out(".rpiv/artifacts/plans/p.md")],
					goal: [out(".rpiv/artifacts/goal/goal.md")],
				},
			} as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal.md");
	});

	it("validate degrades to the bare plan path without a goal artifact", () => {
		const dispatch = promptFnOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans: [out(".rpiv/artifacts/plans/p.md")] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md");
	});
});

// ---------------------------------------------------------------------------
// slice-structure — the deterministic Phase-1 floor under the design-readiness
// gate: dependency-cycle freedom + brief-coverage conservation (frozen at the
// first cut). Both are computed from the slice-map text, no LLM.
// ---------------------------------------------------------------------------

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
	// e.g. `built-in-workflows.ts:1431` for a file nested many dirs deep) resolves
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
});

// ---------------------------------------------------------------------------
// Audit-drop regression suite — the gate/routing/identity fixes.
// ---------------------------------------------------------------------------

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

		it("plan-grade routes to plan-snapshot when a risk flag is ruled fail, despite all dimensions passing", () => {
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
			expect(next).toBe("plan-snapshot");
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

		it("code-grade routes to code-snapshot when a risk flag is ruled fail", () => {
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
			expect(next).toBe("code-snapshot");
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
		it("build plan-fix reads goal, research, and subplans alongside the verdict/cite-check channels", () => {
			expect(findWorkflow("build").stages["plan-fix"]?.reads).toEqual([
				"plans",
				fanin("plan-verdicts"),
				fanin("plan-cite-check"),
				"goal",
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

		it("slice-check declares slice-design and slice-grade as its only targets", () => {
			expect([...(edge("slice-check").targets ?? [])].sort()).toEqual(["slice-design", "slice-grade"]);
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

		it("plan-cite-check routes into plan-grade when a fix left the cite floor red (degenerate)", () => {
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

		it("code-cite-check routes into code-grade while the code cite floor is red", () => {
			expect(
				routeFrom("code-cite-check", {
					"code-cite-check": [dimVerdict("structure", false)],
					"code-verdicts": [dimVerdict("completeness", true), dimVerdict("correctness", true)],
				}),
			).toBe("code-grade");
		});

		it("code-cite-check declares implement and code-grade as its only targets", () => {
			expect([...(edge("code-cite-check").targets ?? [])].sort()).toEqual(["code-grade", "implement"]);
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 3 — mechanics evidence duty + verify-at-implement disposition.
// The risk-fold helpers are module-local, so the duty is exercised through the
// gate's observable surface: a mechanics pass with no `file:line` evidence
// demotes (allRiskFlagsPass → planGatePasses blocks), and a verify-at-implement
// pass with no concrete procedure+owner demotes. A demoted pass re-opens its
// owning dimension (dimensionsToRegrade clause 3) and counts as blocking for
// confirm (confirmDue riskFail) — the three folds agree via rulingEffectivePass.
// ---------------------------------------------------------------------------
describe("plan/code gate risk-ruling evidence + verify-at-implement duty (phase 3)", () => {
	const build = () => findWorkflow("build");
	const edge = (stage: string): EdgeFn => {
		const e = build().edges[stage];
		if (typeof e !== "function") throw new Error(`build ${stage} edge is not a function`);
		return e as EdgeFn;
	};
	// dimVerdict mirrors the audit-drop block helper (packages/rpiv-pi/extensions/
	// rpiv-core/built-in-workflows.test.ts:2325): severity floored on pass.
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
	// appear exactly once: confirmDue counts verdicts per dimension, so a stray
	// second `correctness` (as the audit-drop block's `dimsPass` carries) bumps
	// the count to 2 and routes a single demoted verdict to plan-FIX instead of
	// plan-CONFIRM. The risk ruling is the only variable per case.
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
		it("a demoted mechanics pass on correctness re-opens correctness in the re-grade set", async () => {
			// full roster (no slices signal ⇒ standard tier); every dimension
			// passes with a FRESH verdict (artifact: PLAN), only correctness
			// carries a demoted mechanics pass ⇒ only correctness re-grades.
			const verdicts = PLAN_DIMS.map((d) =>
				d === "correctness"
					? verdict(d, true, { artifact: PLAN, risk_rulings: [{ id: "r1", pass: true, claim_type: "mechanics" }] })
					: verdict(d, true, { artifact: PLAN }),
			);
			expect(
				await gradeLabels("plan-grade", {
					plans: [chan(PLAN, { risks: [{ id: "r1", claim_type: "mechanics" }] })],
					"plan-verdicts": verdicts,
				}),
			).toEqual(["correctness"]);
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

	it("plan-demote's route reproduces the prior confirm/snapshot/code decisions (single block → plan-confirm)", () => {
		expect(
			route("plan-demote", {
				plans: [chan(PLAN)],
				"plan-cite-check": [verdict("structure", true)],
				"plan-verdicts": [...passRest, verdict("correctness", false)],
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

	it("code-demote's route mirrors the plan gate on code-verdicts (single block → code-confirm)", () => {
		expect(
			route("code-demote", {
				plans: [chan(PLAN)],
				"code-cite-check": [verdict("structure", true)],
				"code-verdicts": [...passRest, verdict("correctness", false)],
			}),
		).toBe("code-confirm");
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

	it("build plan stage reads research alongside the subplans fan-in (finding 4)", () => {
		expect(findWorkflow("build").stages.plan?.reads).toEqual(["research", fanin("subplans")]);
	});

	// Finding 8 — an artifact whose identity can't be resolved must FAIL LOUD, not
	// fall back to a positional guess that silently mis-routes and drops slices.
	it("throws when a design filename carries no slice-<N> token (no positional fallback)", () => {
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
		).toThrow(/no 'slice-<N>' token|has no slice number/);
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

describe("ship workflow (lightweight /wf preset)", () => {
	// The ten stages in linear order — pins that none of build's elaborate
	// machinery (slice*/subplan/*confirm/*snapshot/*fix/code*/validate-fix/
	// *demote) leaked into the lightweight preset.
	const SHIP_STAGES: readonly string[] = [
		"goal",
		"research",
		"plan",
		"plan-cite-check",
		"grade",
		"implement",
		"implement-scope-check",
		"reconcile",
		"validate",
		"commit",
	];

	it("has exactly the ten stages in linear order (no slice/subplan/confirm/snapshot/fix/code/demote arms)", () => {
		expect(Object.keys(findWorkflow("ship").stages)).toEqual([...SHIP_STAGES]);
	});

	it("gate edges are stop-on-fail with no backward edge", () => {
		const wf = findWorkflow("ship");
		const gates: Array<[string, string[]]> = [
			["plan-cite-check", ["grade", "stop"]],
			["grade", ["implement", "stop"]],
			["implement-scope-check", ["reconcile", "stop"]],
			["reconcile", ["validate", "stop"]],
			["validate", ["commit", "stop"]],
		];
		for (const [src, expected] of gates) {
			const edge = wf.edges[src];
			if (typeof edge !== "function") throw new Error(`ship ${src} edge is not an EdgeFn`);

			expect([...(edge.targets ?? [])].sort(), src).toEqual([...expected].sort());
			// No backward edge: every non-stop target must follow `src` in the
			// linear order — the preset terminates on fail instead of looping.
			const from = SHIP_STAGES.indexOf(src);
			for (const target of edge.targets ?? []) {
				if (target === "stop") continue;
				expect(SHIP_STAGES.indexOf(target), `${src} → ${target}`).toBeGreaterThan(from);
			}
		}
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

	it('plan reads ["research", "goal"] (planner anchors on the same verbatim goal the completeness grade judges against)', () => {
		// Without the explicit reads the stage falls to the rolling primary and
		// quick-plan sees only the research doc — whose grounding may narrow the
		// brief — while the grade panel's completeness dimension anchors on the
		// verbatim goal. Same-anchor wiring lets the plan defer narrowed-out
		// asks explicitly instead of silently inheriting the drop.
		expect(findWorkflow("ship").stages.plan?.reads).toEqual(["research", "goal"]);
	});

	it("grade carries a fanout loop, the ship-verdicts outcome, and reads plans/research/goal", () => {
		const grade = findWorkflow("ship").stages.grade;
		expect(grade?.loop?.kind).toBe("fanout");
		expect(grade?.outcome?.name).toBe("ship-verdicts");
		expect(grade?.reads).toEqual(["plans", "research", "goal"]);
	});
});

// ---------------------------------------------------------------------------
// implement reads wiring — every implement stage declares reads: ["plans"]
// and validates clean with contracts threaded in.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// P2 — the grade panel re-runs ONLY the dimensions that still need grading
// (carry-forward), reading its OWN verdict channel, and never emits an empty
// unit set (empty ⇒ single dimensionless grade fall-through).
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
			expect(out.artifacts[0].handle.path).toBe(".rpiv/artifacts/priors/p.md");
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

	describe("tier → roster", () => {
		it("light tier (1 slice, 1 phase, clean channel) grades correctness+completeness only", async () => {
			expect(await gradeLabels("plan-grade", { ...lightSignals, "plan-verdicts": [] })).toEqual([
				"completeness",
				"correctness",
			]);
		});

		it("missing signals never yield light — full roster", async () => {
			expect(await gradeLabels("plan-grade", { plans: [chan(PLAN)], "plan-verdicts": [] })).toEqual(PLAN_DIMS);
		});

		it("strict signals (slice_count >= 5) keep the full roster", async () => {
			expect(
				await gradeLabels("plan-grade", {
					slices: [chan(".rpiv/artifacts/slices/s.md", { slice_count: 7 })],
					plans: [chan(PLAN, { phase_count: 1 })],
					"plan-verdicts": [],
				}),
			).toEqual(PLAN_DIMS);
		});

		it("a medium verdict on the channel lifts a light run out of the light tier (roster widens)", async () => {
			const labels = await gradeLabels("plan-grade", {
				...lightSignals,
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
					"plan-verdicts": [verdict("correctness", false)],
					"code-verdicts": [],
				}),
			).toEqual(["completeness", "correctness"]);
		});
	});

	describe("verdict freshness (artifact-identity invalidation)", () => {
		it("verdicts judged against a REPLACED artifact do not carry — full re-grade", async () => {
			const stale = PLAN_DIMS.map((d) => verdict(d, true, { artifact: ".rpiv/artifacts/plans/old.md" }));
			expect(await gradeLabels("plan-grade", { plans: [chan(PLAN)], "plan-verdicts": stale })).toEqual(PLAN_DIMS);
		});

		it("verdicts judged against the CURRENT artifact carry — only the failing dimension re-grades", async () => {
			const verdicts = PLAN_DIMS.map((d) => verdict(d, d !== "correctness", { artifact: PLAN }));
			expect(await gradeLabels("plan-grade", { plans: [chan(PLAN)], "plan-verdicts": verdicts })).toEqual([
				"correctness",
			]);
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

	describe("confirm-before-block", () => {
		const passRest = PLAN_DIMS.filter((d) => d !== "correctness").map((d) => verdict(d, true));

		it("plan-grade routes a dimension's FIRST blocking verdict to plan-confirm", () => {
			expect(
				route("plan-demote", {
					plans: [chan(PLAN)],
					"plan-cite-check": [verdict("structure", true)],
					"plan-verdicts": [...passRest, verdict("correctness", false)],
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

		it("code-grade mirrors the contract on its own channel", () => {
			expect(
				route("code-demote", {
					plans: [chan(PLAN)],
					"code-cite-check": [verdict("structure", true)],
					"code-verdicts": [...passRest, verdict("correctness", false)],
				}),
			).toBe("code-confirm");
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

describe("build validate + commit dispatch thread the run-start baseline", () => {
	const promptOf = (stage: string) => {
		const prompt = findWorkflow("build").stages[stage]?.prompt;
		if (typeof prompt !== "function") throw new Error(`build ${stage} stage has no prompt fn`);
		return prompt;
	};
	const out = (artifacts: unknown[]) => ({ artifacts, data: undefined, kind: "", meta: {} });
	const goalWithBaseline = out([
		{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") },
		{ handle: fsHandle(".rpiv/artifacts/goal/baseline-t.json"), role: "baseline" },
	]);
	const goalAlone = out([{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") }]);
	const plans = [out([{ handle: fsHandle(".rpiv/artifacts/plans/p.md") }])];

	it("validate appends --baseline with the goal channel's recorded snapshot path", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalWithBaseline] } } as unknown as RunView,
		});
		// Exact match doubles as the --scope OMISSION proof: no scope channel in
		// this state, so no --scope flag may appear.
		expect(dispatch).toBe(
			"/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md --baseline .rpiv/artifacts/goal/baseline-t.json",
		);
	});

	it("validate appends --scope with the scope floor's recorded verdict path", async () => {
		// The demote-and-adjudicate tier rests on this thread: a tracked-excess
		// verdict reaches validate ONLY via --scope, so the flag must ride the
		// dispatch whenever the floor has published.
		const scopeVerdict = out([{ handle: fsHandle(".rpiv/artifacts/verdicts/implement-scope-check__p.json") }]);
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: {
				named: { plans, goal: [goalWithBaseline], "implement-scope-check": [scopeVerdict] },
			} as unknown as RunView,
		});
		expect(dispatch).toBe(
			"/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md --baseline .rpiv/artifacts/goal/baseline-t.json --scope .rpiv/artifacts/verdicts/implement-scope-check__p.json",
		);
	});

	it("validate omits --baseline when the goal output carries no baseline artifact", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalAlone] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md");
	});

	it("the --goal flag still points at the goal md (baseline rides SECOND on the channel)", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalWithBaseline] } } as unknown as RunView,
		});
		expect(dispatch).toContain("--goal .rpiv/artifacts/goal/goal-t.md");
		expect(dispatch).not.toContain("--goal .rpiv/artifacts/goal/baseline-t.json");
	});

	it("commit dispatches /skill:commit --baseline with the recorded snapshot path", async () => {
		const dispatch = await promptOf("commit")({
			cwd: "/repo",
			input: undefined,
			state: { named: { goal: [goalWithBaseline] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:commit --baseline .rpiv/artifacts/goal/baseline-t.json");
	});

	it("commit dispatches bare /skill:commit when no baseline was captured", async () => {
		const dispatch = await promptOf("commit")({
			cwd: "/repo",
			input: undefined,
			state: { named: { goal: [goalAlone] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:commit");
	});
});

// ---------------------------------------------------------------------------
// build implement-scope-check (lane-level scope floor) — the deterministic
// structural backstop beneath the quality gates. Exercises scopeExcess through
// the implement-scope-check stage's published verdict (no direct helper import:
// the file exports only builtInWorkflows, as the suite does at line 42).
// ---------------------------------------------------------------------------

describe("build implement-scope-check (lane-level scope floor)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-scope-"));
		// The scope-check reads `git status --porcelain` against cwd, so make the
		// tmpDir a real git repo: an un-tracked file IS a dirty path git reports.
		// A non-repo cwd degrades to an empty dirty set (pass) — tested separately.
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const scopeRun = () => {
		const stage = findWorkflow("build").stages["implement-scope-check"];
		if (!stage?.run) throw new Error("build implement-scope-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const out = (rel: string, role?: string) => ({
		artifacts: role ? [{ handle: fsHandle(rel), role }] : [{ handle: fsHandle(rel) }],
		data: undefined,
		kind: "",
		meta: {},
	});
	// Write the plan and the baseline JSON; return the RunView shape the stage reads.
	const seed = (planRel: string, planBody: string, baselineRel: string, baselinePaths: string[]) => {
		const parts = planRel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, planRel), planBody);
		const bparts = baselineRel.split("/");
		mkdirSync(join(tmpDir, ...bparts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, baselineRel), JSON.stringify({ paths: baselinePaths }, null, 2));
		return {
			named: {
				plans: [out(planRel)],
				goal: [out(".rpiv/artifacts/goal/goal-t.md"), out(baselineRel, "baseline")],
			},
		} as unknown as RunView;
	};
	const plan = (filesLines: string[], phaseCount: number) =>
		`---\nstatus: ready\nphase_count: ${phaseCount}\nphases:\n${filesLines
			.map((l) => `  - { n: ${phaseCount}, title: P, files: [${l}] }`)
			.join("\n")}\n---\n## Phase ${phaseCount}: P\n`;
	// Make `path` dirty so `git status --porcelain` reports it. `git add` keeps
	// these cases on the tracked-file report path; the untracked-directory shape
	// (git's default collapse to `?? dir/`, defused by -uall) is exercised by the
	// dedicated regression cases below via un-added writes.
	const dirty = (rel: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), "x\n");
		execFileSync("git", ["add", "--", rel], { cwd: tmpDir, stdio: "ignore" });
	};
	// Write WITHOUT `git add` — the file stays untracked, so without -uall git
	// collapses its brand-new parent directory to a single `?? dir/` entry.
	const dirtyUntracked = (rel: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), "x\n");
	};

	it("passes when every dirty path is declared in the plan's files: union", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts");
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.dimension).toBe("scope");
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fails on an undeclared dirty path (the stray write)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/stray.ts"); // undeclared, staged (tracked) → excess tier
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("excess"); // tracked → demoted-and-adjudicated tier
		expect(data.severity).toBe("high");
		expect(String(data.feedback)).toMatch(/packages\/a\/stray\.ts/);
		expect(String(data.feedback)).toMatch(/Undeclared write/);
	});

	// Twin expansion (the 5de3 halt class): a declared production file carries its
	// co-located test twin — a signature change legitimately drags the twin's
	// assertions along, so the mechanical follow-up edit is not a stray write.
	it("passes a dirty co-located test twin of a declared production file", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/foo.test.ts"); // twin of declared → within scope
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("twin expansion is asymmetric — declaring x.test.ts does not license writing x.ts", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.test.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.test.ts"); // declared
		dirty("packages/a/foo.ts"); // production twin NOT licensed → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/a\/foo\.ts/);
	});

	it("a dirty NON-twin test file still fails the floor", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/bar.test.ts"); // not foo's twin → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/a\/bar\.test\.ts/);
	});

	// Regression (post-a777 run halt at 2026-07-28T03:12Z): git's default status
	// collapses a wholly-untracked directory to one `?? dir/` entry, which can
	// never string-match a declared FILE path — a phase creating exactly its
	// declared files under a brand-new directory false-failed the floor. The
	// -uall flag enumerates untracked files individually.
	it("passes declared files created in a brand-new untracked directory (untracked-dir collapse)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"pkgs/skills/x/_helpers/check.mjs", "pkgs/skills/x/_helpers/check.test.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirtyUntracked("pkgs/skills/x/_helpers/check.mjs");
		dirtyUntracked("pkgs/skills/x/_helpers/check.test.ts");
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fails an UNDECLARED file in a new untracked directory, naming the full path (not the collapsed dir)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"pkgs/skills/x/_helpers/check.mjs"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirtyUntracked("pkgs/skills/x/_helpers/check.mjs"); // declared
		dirtyUntracked("pkgs/skills/x/_helpers/stray.mjs"); // undeclared → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		// All excess is untracked (`??`) → the deterministically-remediable tier.
		expect(data.verdict).toBe("untracked-only");
		expect(data.severity).toBe("medium");
		expect(String(data.feedback)).toMatch(/pkgs\/skills\/x\/_helpers\/stray\.mjs/);
	});

	// Regression: run 2026-08-20_18-10-39-17e7. A validate-fix round left two
	// scratch scripts in an untracked `.tmp/` and the floor's terminal fail killed
	// a functionally green 5-hour run. The tier now routes that shape to the
	// quarantine arm instead; ANY tracked excess still escalates the whole verdict
	// (one stomp taints the tree — quarantining the untracked remainder wouldn't
	// make it judgeable-clean).
	it("mixed tracked + untracked excess folds to the tracked tier (excess)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/stray.ts"); // tracked excess
		dirtyUntracked(".tmp/check-c3r2.mjs"); // untracked excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.verdict).toBe("excess");
		expect(data.severity).toBe("high");
		const wheres = (data.findings as { where: string }[]).map((f) => f.where).sort();
		expect(wheres).toEqual([".tmp/check-c3r2.mjs", "packages/a/stray.ts"]);
	});

	it("subtracts run-start baseline paths (pre-existing dirt is not the run's fault)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			["packages/a/pre-existing.ts"],
		);
		dirty("packages/a/pre-existing.ts"); // dirty AND in baseline → subtracted
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("subtracts .rpiv/ and thoughts/ bookkeeping paths", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty(".rpiv/artifacts/x.json"); // bookkeeping → subtracted
		dirty("thoughts/y.md"); // bookkeeping → subtracted
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("is inert (pass) for a files:-less plan — empty-declared degradation", () => {
		// No `files:` key on the phase ⇒ phaseFiles yields [] ⇒ declared=[] ⇒ scopeExcess([]).
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: P }\n---\n## Phase 1: P\n`,
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/anything.ts"); // would be excess, but declared=[] ⇒ inert
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("writes the verdict to a basename-keyed fs artifact (idempotent across the build loop)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/stray.ts");
		const result = scopeRun()({ cwd: tmpDir, input: undefined, state });
		expect(result.data.artifact).toBe(".rpiv/artifacts/plans/p.md");
		// Basename-keyed off the plan: implement-scope-check__p.json
		const verdict = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/implement-scope-check__p.json"), "utf-8"),
		);
		expect(verdict.dimension).toBe("scope");
		expect(verdict.pass).toBe(false);
	});

	it("degrades to pass (empty dirty) when cwd is not a git repo — never throws", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "rpiv-build-scope-nongit-"));
		try {
			// Write the plan + baseline into the non-repo cwd.
			const planRel = ".rpiv/artifacts/plans/p.md";
			const parts = planRel.split("/");
			mkdirSync(join(nonRepo, ...parts.slice(0, -1)), { recursive: true });
			writeFileSync(join(nonRepo, planRel), plan(['"packages/a/foo.ts"'], 1));
			const baselineRel = ".rpiv/artifacts/goal/baseline-t.json";
			const bparts = baselineRel.split("/");
			mkdirSync(join(nonRepo, ...bparts.slice(0, -1)), { recursive: true });
			writeFileSync(join(nonRepo, baselineRel), JSON.stringify({ paths: [] }, null, 2));
			const state = {
				named: {
					plans: [out(planRel)],
					goal: [out(".rpiv/artifacts/goal/goal-t.md"), out(baselineRel, "baseline")],
				},
			} as unknown as RunView;
			const data = scopeRun()({ cwd: nonRepo, input: undefined, state }).data;
			expect(data.pass).toBe(true); // empty dirty ⇒ no excess ⇒ pass
			expect(data.findings).toEqual([]);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	it("reads the declared union across MULTIPLE phases (not just the first)", () => {
		// Two phases with disjoint files: unions both into the declared set.
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			`---\nstatus: ready\nphase_count: 2\nphases:\n  - { n: 1, title: A, files: ["packages/a/x.ts"] }\n  - { n: 2, title: B, files: ["packages/b/y.ts"] }\n---\n## Phase 1: A\n## Phase 2: B\n`,
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/x.ts"); // phase 1's declared write
		dirty("packages/b/y.ts"); // phase 2's declared write
		dirty("packages/c/stray.ts"); // declared by NEITHER → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/c\/stray\.ts/);
		expect(String(data.feedback)).not.toMatch(/packages\/a\/x\.ts/);
		expect(String(data.feedback)).not.toMatch(/packages\/b\/y\.ts/);
	});
});

// ---------------------------------------------------------------------------
// build scope-quarantine — the deterministic remedy arm for an untracked-only
// scope verdict: MOVE (never delete) run-created untracked excess under
// .rpiv/tmp/scope-quarantine/ and publish a manifest, then re-enter the floor.
// ---------------------------------------------------------------------------

describe("build scope-quarantine (untracked-excess remedy arm)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-quarantine-"));
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const quarantineRun = () => {
		const stage = findWorkflow("build").stages["scope-quarantine"];
		if (!stage?.run) throw new Error("build scope-quarantine stage has no run function");
		return stage.run as unknown as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: { moved: { from: string; to: string }[]; refused: { path: string; reason: string }[] };
			artifacts: { handle: { kind: string; path: string } }[];
		};
	};
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const verdictEntry = (wheres: string[]) => ({
		artifacts: [],
		data: { verdict: "untracked-only", findings: wheres.map((where) => ({ detail: "x", where })) },
		kind: "json",
		meta: {},
	});
	const stateOf = (wheres: string[]) =>
		({
			named: {
				plans: [out(".rpiv/artifacts/plans/p.md")],
				"implement-scope-check": [verdictEntry(wheres)],
			},
		}) as unknown as RunView;
	const untrackedFile = (rel: string, content = "x\n") => {
		const parts = rel.split("/");
		if (parts.length > 1) mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), content);
	};

	// Mechanical proof of "at most one quarantine hop per gate entry": after the
	// move, the re-check's untracked-excess set is empty (the quarantined copies
	// live under the exempt .rpiv/ tree), so the second verdict can never be
	// "untracked-only" again — the loop converges to pass (or reveals tracked
	// drift), never ping-pongs.
	it("check → quarantine → re-check converges: the second verdict is pass, never untracked-only again", () => {
		const planRel = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv/artifacts/plans"), { recursive: true });
		writeFileSync(
			join(tmpDir, planRel),
			`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: P, files: ["packages/a/foo.ts"] }\n---\n## Phase 1: P\n`,
		);
		const baselineRel = ".rpiv/artifacts/goal/baseline-t.json";
		mkdirSync(join(tmpDir, ".rpiv/artifacts/goal"), { recursive: true });
		writeFileSync(join(tmpDir, baselineRel), JSON.stringify({ paths: [] }, null, 2));
		untrackedFile(".tmp/scratch.mjs");

		const checkStage = findWorkflow("build").stages["implement-scope-check"];
		if (!checkStage?.run) throw new Error("build implement-scope-check stage has no run function");
		const checkRun = checkStage.run as unknown as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
		const checkState = {
			named: {
				plans: [out(planRel)],
				goal: [
					out(".rpiv/artifacts/goal/goal-t.md"),
					{
						artifacts: [{ handle: fsHandle(baselineRel), role: "baseline" }],
						data: undefined,
						kind: "",
						meta: {},
					},
				],
			},
		} as unknown as RunView;

		const first = checkRun({ cwd: tmpDir, input: undefined, state: checkState });
		expect(first.data.verdict).toBe("untracked-only");

		const quarantineState = {
			named: {
				...(checkState as unknown as { named: Record<string, unknown> }).named,
				"implement-scope-check": [{ artifacts: [], data: first.data, kind: "json", meta: {} }],
			},
		} as unknown as RunView;
		quarantineRun()({ cwd: tmpDir, input: undefined, state: quarantineState });

		const second = checkRun({ cwd: tmpDir, input: undefined, state: checkState });
		expect(second.data.verdict).toBe("pass");
		expect(second.data.findings).toEqual([]);
	});

	it("moves listed untracked files under .rpiv/tmp/scope-quarantine/ and writes the manifest", () => {
		untrackedFile(".tmp/check-c3r2.mjs", "console.log(1)\n");
		untrackedFile(".tmp/check-c4r5.mjs", "console.log(2)\n");
		const result = quarantineRun()({
			cwd: tmpDir,
			input: undefined,
			state: stateOf([".tmp/check-c3r2.mjs", ".tmp/check-c4r5.mjs"]),
		});
		// Moved, not deleted: content survives at the quarantine path, source is gone.
		expect(existsSync(join(tmpDir, ".tmp/check-c3r2.mjs"))).toBe(false);
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/.tmp/check-c3r2.mjs"), "utf-8")).toBe(
			"console.log(1)\n",
		);
		expect(result.data.moved).toEqual([
			{ from: ".tmp/check-c3r2.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/check-c3r2.mjs") },
			{ from: ".tmp/check-c4r5.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/check-c4r5.mjs") },
		]);
		// Manifest basename-keyed off the plan, beside the scope verdict.
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toHaveLength(2);
		expect(result.artifacts[0]?.handle.path).toBe(join(".rpiv/artifacts/verdicts", "scope-quarantine__p.json"));
	});

	it("never touches a listed path that is tracked (or otherwise not untracked) at move time — recorded as refused", () => {
		untrackedFile("packages/a/kept.ts", "v0\n");
		execFileSync("git", ["add", "--", "packages/a/kept.ts"], { cwd: tmpDir, stdio: "ignore" });
		const result = quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["packages/a/kept.ts"]) });
		expect(result.data.moved).toEqual([]);
		expect(result.data.refused).toEqual([{ path: "packages/a/kept.ts", reason: "not-untracked-at-move-time" }]);
		expect(readFileSync(join(tmpDir, "packages/a/kept.ts"), "utf-8")).toBe("v0\n");
	});

	it("refuses a cwd-escaping finding path (containedPath guard) without throwing — recorded as refused", () => {
		// Cannot arise from `git status` (which reports repo-relative paths only) —
		// belt-and-braces against a corrupt verdict JSON on the channel. The
		// escaping path is refused by the untracked check first; either way it
		// lands in `refused`, observable without re-running the floor.
		const result = quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["../escape.txt"]) });
		expect(result.data.moved).toEqual([]);
		expect((result.data.refused as { path: string }[]).map((r) => r.path)).toEqual(["../escape.txt"]);
	});

	it("is idempotent — a re-run finds nothing untracked, and the manifest KEEPS round 1's moves", () => {
		untrackedFile(".tmp/scratch.mjs");
		const state = stateOf([".tmp/scratch.mjs"]);
		quarantineRun()({ cwd: tmpDir, input: undefined, state });
		const second = quarantineRun()({ cwd: tmpDir, input: undefined, state });
		expect(second.data.moved).toEqual([]);
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/.tmp/scratch.mjs"), "utf-8")).toBe("x\n");
		// Merge-on-write: the re-run's empty round must not erase the recorded move.
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([
			{ from: ".tmp/scratch.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/scratch.mjs") },
		]);
	});

	// The manifest is validate's cross-round adjudication record: a validate-fix
	// re-entry that quarantines AGAIN (round 2) must not erase round 1's moves —
	// a round-2 missing-file diagnosis on a round-1-moved file consults this file.
	it("merges across rounds — a second quarantine keeps the first round's move records", () => {
		untrackedFile(".tmp/round-one.mjs");
		quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf([".tmp/round-one.mjs"]) });
		untrackedFile(".tmp/round-two.mjs");
		quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf([".tmp/round-two.mjs"]) });
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([
			{ from: ".tmp/round-one.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/round-one.mjs") },
			{ from: ".tmp/round-two.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/round-two.mjs") },
		]);
	});

	// Failure injection: the second move's destination directory is blocked by a
	// pre-created FILE, so its mkdirSync throws mid-loop. The throw must
	// propagate (fail-loud STOP on a real fs error), but the finally-write must
	// land the FIRST move in the manifest — never moved-but-unrecorded files.
	it("a mid-loop move failure still records completed moves in the manifest before failing", () => {
		untrackedFile("a/one.mjs", "one\n");
		untrackedFile("b/two.mjs", "two\n");
		mkdirSync(join(tmpDir, ".rpiv/tmp/scope-quarantine"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/b"), "blocker"); // file where a dir must go
		expect(() =>
			quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["a/one.mjs", "b/two.mjs"]) }),
		).toThrow();
		// First move completed and is recorded; second stayed in place.
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/a/one.mjs"), "utf-8")).toBe("one\n");
		expect(readFileSync(join(tmpDir, "b/two.mjs"), "utf-8")).toBe("two\n");
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([{ from: "a/one.mjs", to: join(".rpiv/tmp/scope-quarantine", "a/one.mjs") }]);
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

	it("build's stage order lists implement → implement-scope-check → scope-quarantine → reconcile → validate", () => {
		const keys = Object.keys(findWorkflow("build").stages);
		const i = keys.indexOf("implement");
		const s = keys.indexOf("implement-scope-check");
		const q = keys.indexOf("scope-quarantine");
		const r = keys.indexOf("reconcile");
		const v = keys.indexOf("validate");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(s).toBe(i + 1);
		expect(q).toBe(s + 1);
		expect(r).toBe(q + 1);
		expect(v).toBe(r + 1);
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

describe("reconcile lane stage", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-reconcile-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const reconcileRun = (wf = "build") => {
		const stage = findWorkflow(wf).stages.reconcile;
		if (!stage?.run) throw new Error(`${wf} reconcile stage has no run function`);
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	// Write a file under tmpDir and return a plans-channel entry pointing at it.
	const write = (rel: string, body: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), body);
		return { artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} } as unknown as Output;
	};
	// A plans entry whose handle points at a path that does NOT exist on disk.
	const missingPlan = (rel: string) =>
		({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} }) as unknown as Output;
	const runOn = (plan: ReturnType<typeof write>, wf = "build") =>
		reconcileRun(wf)({
			cwd: tmpDir,
			input: undefined,
			state: { named: { plans: [plan] } } as unknown as RunView,
		}).data;
	const details = (data: Record<string, unknown>) =>
		((data.findings as { detail: string; where: string }[] | undefined) ?? []).map((f) => f.detail).join(" ");
	const wheres = (data: Record<string, unknown>) =>
		((data.findings as { where: string }[] | undefined) ?? []).map((f) => f.where).sort();

	// A plan body with optional `#### Reconciliation` directives and an
	// `#### Automated Verification:` block, plus a `## Synthesis Notes` section.
	const planBody = (opts: { directives?: string[]; av?: string[]; synthesisNotes?: boolean }) => {
		const lines = [
			"---",
			"status: ready",
			"phase_count: 1",
			"phases:",
			"  - { n: 1, title: Reconcile }",
			"---",
			"# Plan",
			"## Phase 1: Reconcile",
		];
		if (opts.directives?.length) {
			lines.push("#### Reconciliation");
			lines.push(...opts.directives);
		}
		lines.push("### Success Criteria");
		if (opts.av?.length) {
			lines.push("#### Automated Verification:");
			for (const c of opts.av) lines.push(`- [ ] \`${c}\``);
		}
		lines.push("#### Manual Verification:", "- [ ] a manual check");
		if (opts.synthesisNotes) lines.push("## Synthesis Notes", "- a baseline synthesis note");
		return `${lines.join("\n")}\n`;
	};
	const writeTestFile = (rel: string, content: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), content);
	};

	it("publishes a pass verdict (dimension: reconcile) with no directives and no AV", () => {
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({}));
		const data = runOn(plan);
		expect(data.dimension).toBe("reconcile");
		expect(data.pass).toBe(true);
		expect(data.verdict).toBe("pass");
		expect(data.severity).toBe("none");
		expect(data.findings).toEqual([]);
		expect(String(data.artifact)).toBe(".rpiv/artifacts/plans/p.md");
	});

	it("writes the basename-keyed verdict file under .rpiv/artifacts/verdicts/", () => {
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({}));
		runOn(plan);
		const verdict = readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/reconcile__p.json"), "utf-8");
		expect(JSON.parse(verdict).dimension).toBe("reconcile");
	});

	it("applies a directive to a *.test.ts target exactly once (find present)", () => {
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: [
					"- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — phase invalidated the expectation",
				],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(4);\n',
		);
	});

	it("flags a directive whose find substring is absent (and replacement absent) ⇒ verdict fail (no guessing)", () => {
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(99);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — stale"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("fail");
		expect(wheres(data)).toEqual(["packages/a/a.test.ts"]);
		// not applied — the file is unchanged
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(99);\n");
	});

	it("write-restricts to test paths — a non-test target is flagged and NOT applied", () => {
		writeTestFile("packages/a/a.ts", "export const r = 3;\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({ directives: ["- `packages/a/a.ts`: replace `r = 3` → `r = 4` — production change"] }),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(wheres(data)).toEqual(["packages/a/a.ts"]);
		expect(details(data)).toMatch(/not a test-expectation file/);
		// untouched
		expect(readFileSync(join(tmpDir, "packages/a/a.ts"), "utf-8")).toBe("export const r = 3;\n");
	});

	it("containment — an ABSOLUTE *.test.ts target outside the tree is flagged and NOT written", () => {
		// The suffix allowlist alone cannot confine the write: an absolute target
		// ending .test.ts passes it while bypassing cwd entirely. FAILS without the
		// resolve-then-contain guard.
		const outside = mkdtempSync(join(tmpdir(), "rpiv-reconcile-outside-"));
		try {
			const target = join(outside, "escape.test.ts");
			writeFileSync(target, "expect(r).toBe(3);\n");
			const plan = write(
				".rpiv/artifacts/plans/p.md",
				planBody({
					directives: [`- \`${target}\`: replace \`expect(r).toBe(3)\` → \`expect(r).toBe(4)\` — escape`],
				}),
			);
			const data = runOn(plan);
			expect(data.pass).toBe(false);
			expect(details(data)).toMatch(/outside the working tree/);
			// untouched — the guarded sink never resolved the escape
			expect(readFileSync(target, "utf-8")).toBe("expect(r).toBe(3);\n");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("containment — a `..`-escaping *.test.ts target is flagged and NOT written", () => {
		// A relative target that traverses out of cwd satisfies the suffix test on the
		// raw string; containment is checked on the RESOLVED path. FAILS without the guard.
		const outside = mkdtempSync(join(tmpdir(), "rpiv-reconcile-outside-"));
		try {
			const target = join(outside, "escape.test.ts");
			writeFileSync(target, "expect(r).toBe(3);\n");
			const traversal = `../${basename(outside)}/escape.test.ts`; // resolves to a tmpDir SIBLING
			const plan = write(
				".rpiv/artifacts/plans/p.md",
				planBody({
					directives: [`- \`${traversal}\`: replace \`expect(r).toBe(3)\` → \`expect(r).toBe(4)\` — escape`],
				}),
			);
			const data = runOn(plan);
			expect(data.pass).toBe(false);
			expect(details(data)).toMatch(/outside the working tree/);
			expect(readFileSync(target, "utf-8")).toBe("expect(r).toBe(3);\n");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("treats an already-applied directive as satisfied on re-run (idempotent)", () => {
		// The find is gone but the replacement is present ⇒ already applied, no finding.
		writeTestFile("packages/a/a.test.ts", "expect(r).toBe(4);\n");
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `expect(r).toBe(4)` — re-run"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe("expect(r).toBe(4);\n");
	});

	it("does NOT execute AV commands — a failing command line yields no finding (validate owns AV)", () => {
		// The AV re-run was removed: measured across the full run history it produced
		// zero genuine catches and a 100% false-positive rate (stale cross-phase
		// probes, agent-shell-only binaries, prose greps), each halting a finished
		// run at a fail route with no fix arm. `validate` runs AV agent-side instead.
		const plan = write(".rpiv/artifacts/plans/p.md", planBody({ av: ['node -e "process.exit(1)"', "rg -l x y.ts"] }));
		const data = runOn(plan);
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fail-soft: an unreadable plan (missing file) degrades to a finding, never a throw", () => {
		const data = runOn(missingPlan(".rpiv/artifacts/plans/missing.md"));
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/could not read or parse the plan/);
	});

	it("fail-soft: a malformed Reconciliation directive degrades to a finding, never a throw", () => {
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({ directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)`"] }), // missing → `replace`
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
	});

	// --- empty-find / empty-replace regressions (find group tightened to `[^`]+` at parse time) ---

	it("rejects an empty-find directive at parse time ⇒ verdict fail + malformed finding, file unchanged (no prepend)", () => {
		// An empty `` find previously matched the grammar (find group was `([^`]*)` zero-or-more)
		// and `content.replace("", replace)` prepended the replacement on every run. The tightened
		// parser now rejects it: the line matches the attempt shape but not the full grammar ⇒ malformed.
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const plan = write(
			".rpiv/artifacts/plans/p.md",
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `` → `expect(r).toBe(4)` — empty find"],
			}),
		);
		const data = runOn(plan);
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("fail");
		expect(details(data)).toMatch(/malformed Reconciliation directive/);
		// the offending line is surfaced verbatim so an author can diagnose the empty find
		expect(details(data)).toMatch(/packages\/a\/a\.test\.ts/);
		// the empty-find directive is NOT applied — the target file is byte-for-byte unchanged
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
	});

	it("empty-find directive is idempotent across re-runs: no cumulative prepend, exactly one malformed finding", () => {
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3);\n');
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(
			rel,
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `` → `expect(r).toBe(4)` — empty find"],
			}),
		);
		// run 1: malformed finding, file untouched
		const data1 = runOn(plan);
		expect(wheres(data1)).toEqual(["reconciliation-directive"]);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
		// run 2: reconcile re-evaluates the same plan — the file must NOT accumulate prepends
		const data2 = runOn(plan);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe(
			'import { r } from ".";\nexpect(r).toBe(3);\n',
		);
		// still exactly one malformed finding across the re-run (no amplification / vet backward-jump)
		const malformedCount = ((data2.findings as { detail: string }[]) ?? []).filter((f) =>
			/malformed Reconciliation directive/.test(f.detail),
		).length;
		expect(malformedCount).toBe(1);
	});

	it("an empty-replace deletion directive applies exactly once and does not prepend/loop on re-run (replace stays `[^`]*`)", () => {
		// empty replace is a LEGITIMATE deletion: find present ⇒ removed. Proves the asymmetry is
		// intentional (find non-empty, replace optional) — symmetrizing replace to `[^`]+` would break this.
		writeTestFile("packages/a/a.test.ts", 'import { r } from ".";\nexpect(r).toBe(3)\n');
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(
			rel,
			planBody({
				directives: ["- `packages/a/a.test.ts`: replace `expect(r).toBe(3)` → `` — delete the assertion"],
			}),
		);
		// run 1: find present ⇒ deleted (replaced with empty), no finding ⇒ pass
		const data1 = runOn(plan);
		expect(data1.pass).toBe(true);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe('import { r } from ".";\n\n');
		// run 2: find now absent, replace empty ⇒ find-absent is the deletion's success
		// condition ⇒ the idempotent already-applied branch (no finding, no write). No prepend, no loop.
		const data2 = runOn(plan);
		expect(data2.pass).toBe(true);
		expect(details(data2)).not.toMatch(/directive find substring not present/);
		expect(readFileSync(join(tmpDir, "packages/a/a.test.ts"), "utf-8")).toBe('import { r } from ".";\n\n');
	});

	it("appends a timestamped ### Reconciliation Log under the plan's ## Synthesis Notes", () => {
		const rel = ".rpiv/artifacts/plans/p.md";
		const plan = write(rel, planBody({ synthesisNotes: true }));
		runOn(plan);
		const after = readFileSync(join(tmpDir, rel), "utf-8");
		const notesIdx = after.indexOf("## Synthesis Notes");
		const logIdx = after.indexOf("### Reconciliation Log (");
		expect(notesIdx).toBeGreaterThanOrEqual(0);
		expect(logIdx).toBeGreaterThan(notesIdx); // the log lands under Synthesis Notes
		// the original baseline note is still present (the append is non-destructive)
		expect(after).toMatch(/a baseline synthesis note/);
	});

	describe("edge chain — reconcile gates validate (build + vet)", () => {
		const edge = (wf: string, stage: string): EdgeFn => {
			const e = findWorkflow(wf).edges[stage];
			if (typeof e !== "function") throw new Error(`${wf} ${stage} edge is not a function`);
			return e as EdgeFn;
		};
		const route = (wf: string, stage: string, channel: string, verdict: unknown) =>
			String(
				edge(
					wf,
					stage,
				)({
					output: undefined,
					state: { named: { [channel]: [{ data: { verdict } }] } } as unknown as RunView,
				}),
			);

		for (const wf of ["build", "vet"]) {
			it(`${wf}: implement-scope-check → reconcile on pass, STOP on fail/missing`, () => {
				expect(route(wf, "implement-scope-check", "implement-scope-check", "pass")).toBe("reconcile");
				expect(route(wf, "implement-scope-check", "implement-scope-check", "fail")).toBe("stop");
				expect(route(wf, "implement-scope-check", "implement-scope-check", undefined)).toBe("stop");
			});

			it(`${wf}: reconcile → validate on pass, STOP on fail/missing (a synthesized fail does NOT reach validate)`, () => {
				expect(route(wf, "reconcile", "reconcile", "pass")).toBe("validate");
				expect(route(wf, "reconcile", "reconcile", "fail")).toBe("stop");
				expect(route(wf, "reconcile", "reconcile", undefined)).toBe("stop");
			});
		}
	});

	it("build and vet wire the SAME reconcile run function (no vet twin)", () => {
		const buildRun = findWorkflow("build").stages.reconcile?.run;
		const vetRun = findWorkflow("vet").stages.reconcile?.run;
		expect(vetRun).toBeDefined();
		expect(vetRun).toBe(buildRun); // reference equality — idempotent overwrite across the vet loop
	});

	it("build and vet each validate clean (zero errors AND zero warnings) with skill contracts threaded", () => {
		for (const wf of [findWorkflow("build"), findWorkflow("vet")]) {
			const issues = deriveAndValidate(wf, { skillContracts: DECLARED_CONTRACTS });
			expect(
				issues.filter((i) => i.severity === "error"),
				`${wf.name} errors: ${issues.map((i) => `${i.severity}: ${i.message}`).join("\n")}`,
			).toEqual([]);
			expect(
				issues.filter((i) => i.severity === "warning"),
				`${wf.name} warnings: ${issues.map((i) => `${i.severity}: ${i.message}`).join("\n")}`,
			).toEqual([]);
			expect(
				validateWorkflow(wf).filter((i) => /unreachable/.test(i.message)),
				`${wf.name} has unreachable stages`,
			).toEqual([]);
		}
	});
});
