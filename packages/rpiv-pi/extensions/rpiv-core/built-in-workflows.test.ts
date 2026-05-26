/**
 * Regression tests for blockers identified in the 2026-05-23 code review
 * of feat/rpiv-workflow-command. Each describe block asserts the
 * EXPECTED (post-fix) behavior, so a test fails on the current source
 * until that blocker is resolved.
 *
 * Critical:
 * - I1 — `validate → commit` auto edge skips the code-review fix loop.
 * - I2 — `writeHeader` silent failure drops the first stage row.
 * - I6 — Missing `severeIssueCount` silently routes to `commit`.
 * - I7 — `StopReason ∈ {"length","toolUse"}` collapses to `"ok"`.
 *
 * Important:
 * - I3 — recordStage swallows append failures and reuses stageNumbers on
 *        the next successful write; stagesCompleted drifts above the
 *        actual on-disk row count.
 * - I9 — Phase fanout labels JSONL rows by stage id (wrong for aliased
 *        implement stages); should label by stage.skill instead.
 * - Q7 — runner reuses originalInput whenever artifactPath is unset, not
 *        just at the first stage; later stages silently receive the user's
 *        original brief instead of the upstream stage's output.
 *
 * These tests follow Phase 5 of the TS-native workflow migration — they
 * exercise the new `Workflow` shape directly, not the legacy `WorkflowDag`.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import {
	acts,
	defineWorkflow,
	type FanoutFn,
	produces,
	type RunState,
	runWorkflow,
	stateFilePath,
	validateWorkflow,
	type Workflow,
	workflowsDir,
} from "@juicesharp/rpiv-workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpivArtifactMdOutcome } from "./artifact-resolver.js";
import { builtInWorkflows } from "./built-in-workflows.js";

const findWorkflow = (name: string): Workflow => {
	const w = builtInWorkflows.find((x) => x.name === name);
	if (!w) throw new Error(`built-in workflow "${name}" not found`);
	return w;
};

// ---------------------------------------------------------------------------
// I1 — validate must route to code-review (not commit) in mid/large workflows.
// ---------------------------------------------------------------------------

describe("[I1] validate → code-review routing in built-in workflows", () => {
	it("routes validate → code-review in mid", () => {
		const mid = findWorkflow("mid");
		expect(mid.edges.validate).toBe("code-review");
	});

	it("routes validate → code-review-large in large", () => {
		const large = findWorkflow("large");
		expect(large.edges.validate).toBe("code-review-large");
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

	it("revise routes forward to implement-after-revise (not the original implement)", () => {
		const mid = findWorkflow("mid");
		expect(mid.edges.revise).toBe("implement-after-revise");
	});
});

// ---------------------------------------------------------------------------
// I2 — When writeHeader silently fails, the first stage row written by
//      appendStage lands at line 0 and is dropped by every reader.
// ---------------------------------------------------------------------------

describe("[I2] readers must not silently drop the first row when no header is on disk", () => {
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
		mkdirSync(workflowsDir(tmpDir), { recursive: true });
		const filePath = stateFilePath(tmpDir, runId);
		const stageRow = {
			stageNumber: 1,
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
// I6 — Predicate fires on un-validated frontmatter; missing severeIssueCount
//      must not silently route to commit. The output-schema layer is what
//      makes missing data impossible to reach the predicate.
// ---------------------------------------------------------------------------

describe("[I6] code-review predicate must not silently route to commit on missing field", () => {
	it("built-in code-review stage carries an outputSchema", () => {
		const mid = findWorkflow("mid");
		const codeReview = mid.stages["code-review"];
		expect(codeReview?.outputSchema).toBeDefined();
	});

	it("the declared schema rejects an empty data object", async () => {
		const mid = findWorkflow("mid");
		const schema = mid.stages["code-review"]?.outputSchema;
		if (!schema) throw new Error("code-review outputSchema missing — fix I6 first");
		const { validateOutputData } = await import("@juicesharp/rpiv-workflow");
		const result = await validateOutputData(schema, {});
		expect(result.valid).toBe(false);
	});

	it("every built-in workflow validates without errors or warnings", () => {
		for (const wf of builtInWorkflows) {
			const issues = validateWorkflow(wf);
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
// I7 — A `stopReason: "length"` reply on a side-effect stage must NOT be
//      recorded as a successful "completed" stage.
// ---------------------------------------------------------------------------

describe("[I7] truncated reply (stopReason=length) must not record as completed", () => {
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
		const dir = join(cwd, ".rpiv", "workflows");
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
// I3 — recordStage must signal write success/failure so stagesCompleted
//      stays aligned with on-disk rows, and stageNumbers never repeat.
// ---------------------------------------------------------------------------

describe("[I3] recordStage signals success and advances stageNumber monotonically", () => {
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
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: {
			backwardJumps: 0,
			droppedRoutingRows: [],
		},
		termination: {
			success: false,
			error: undefined,
		},
	});

	it("returns the assigned stageNumber on a successful write", async () => {
		const { recordStage } = await import("@juicesharp/rpiv-workflow/internal");
		const state = freshState();
		const assigned = recordStage(
			tmpDir,
			"run-1",
			{ skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
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
			{ skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
			state,
		);
		expect(failedAssignment).toBeUndefined();
		expect(state.lastAllocatedStageNumber).toBe(1);

		const nextAssignment = recordStage(
			tmpDir,
			"run-1",
			{ skill: "design", status: "completed", ts: "2026-05-23T00:00:01Z" },
			state,
		);
		expect(nextAssignment).toBe(2);
		expect(state.lastAllocatedStageNumber).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Q7 — Non-first stages must NOT silently fall back to originalInput when
//      their upstream produced no artifactPath.
// ---------------------------------------------------------------------------

describe("[Q7] non-first stage with no artifactPath halts instead of reusing originalInput", () => {
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
// I9 — Phase fanout must label JSONL rows by stage.skill, not by the stage name.
// ---------------------------------------------------------------------------

describe("[I9] phase fanout labels by skill name, not by aliased stage name", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-i9-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const readRows = (cwd: string): Array<Record<string, unknown>> => {
		const dir = join(cwd, ".rpiv", "workflows");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return lines.map((l) => JSON.parse(l));
	};

	it("phase rows for an aliased implement node carry skill=implement, not the node name", async () => {
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, planRelPath), "# Plan\n\n## Phase 1: a\nbody\n## Phase 2: b\nbody\n");

		// Local copy of the `## Phase N:` convention used by rpiv-pi's built-in
		// workflows — mirrors `PHASE_FANOUT` in `built-in-workflows.ts`. Inlined
		// rather than imported so the test exercises the public FanoutFn shape.
		const phaseFanout: FanoutFn = ({ artifact: primary, cwd }) => {
			if (!primary || primary.handle.kind !== "fs") return [];
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
				"implement-after-revise": acts({ skill: "implement", fanout: phaseFanout }),
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
			(r) => typeof r.skill === "string" && (r.skill as string).includes("phase"),
		);
		expect(phaseRows).toHaveLength(2);
		for (const row of phaseRows) {
			expect(row.skill).toMatch(/^implement \(phase \d+\/\d+\)$/);
			expect(row.skill).not.toMatch(/implement-after-revise/);
		}
	});
});
