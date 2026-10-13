/**
 * runner-regressions.test.ts — regression pins for the @juicesharp/rpiv-workflow
 * runner itself (row readers, stage recording, truncated replies, fanout row
 * labeling, prompt dispatch), moved verbatim from built-in-workflows.test.ts.
 * They build throwaway workflows and never touch the built-in graph, but stay
 * in-package (developer-checkpoint scope): they exercise the sibling runner
 * against the shapes the built-ins produce.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import {
	acts,
	defineWorkflow,
	type FanoutFn,
	fanout,
	produces,
	runWorkflow,
	validateWorkflow,
	type Workflow,
} from "@juicesharp/rpiv-workflow";
import { type RunState, runsDir, stateFilePath } from "@juicesharp/rpiv-workflow/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpivArtifactMdOutcome } from "./artifact-collector.js";

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
