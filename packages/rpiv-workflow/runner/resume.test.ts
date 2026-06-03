/**
 * Reconstruction tests for `reconstructState` — the pure fold that rebuilds
 * `RunState` from a run's JSONL audit trail.
 *
 * Covers 8 cases:
 *   1. Produces-only linear chain (primary + named + output + counters)
 *   2. Side-effect stage between produces (primary preserved)
 *   3. Terminal stage (primary cleared)
 *   4. Failed trailing row (output NOT seeded; stagesCompleted excludes it;
 *      visited + lastStageNumber include it)
 *   5. Empty file → no-rows refusal
 *   6. Stage gone from workflow → stage-gone refusal
 *   7. Fanout/iterate stage → fanout-unsupported refusal
 *   8. Named-slot append-order (array history preserved across repeated calls)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workflow } from "../api.js";
import type { Artifact } from "../handle.js";
import { fs as fsHandle } from "../handle.js";
import type { Output } from "../output.js";
import {
	appendStage,
	readAllStages,
	stateFilePath,
	type WorkflowHeader,
	type WorkflowStage,
	writeHeader,
} from "../state/index.js";
import { reconstructState } from "./resume.js";
import { resumeWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeArtifact = (path: string): Artifact => ({ handle: fsHandle(path), role: "primary" });

const fakeOutput = (artifacts: readonly Artifact[] = []): Output => ({
	kind: "artifacts",
	artifacts,
	data: {},
	meta: { stage: "test", stageNumber: 1, ts: "", runId: "" },
});

/** Minimal 3-stage produces workflow used by most tests. */
const linearWorkflow: Workflow = {
	name: "test-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh" },
		build: { kind: "produces", sessionPolicy: "fresh" },
		deploy: { kind: "produces", sessionPolicy: "fresh" },
	},
	edges: {
		plan: "build",
		build: "deploy",
		deploy: "stop",
	},
};

/** Workflow with a side-effect stage between two produces. */
const sideEffectWorkflow: Workflow = {
	name: "test-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh" },
		commit: { kind: "side-effect", sessionPolicy: "fresh" },
		build: { kind: "produces", sessionPolicy: "fresh" },
	},
	edges: {
		plan: "commit",
		commit: "build",
		build: "stop",
	},
};

/** Workflow with a terminal stage. */
const terminalWorkflow: Workflow = {
	name: "test-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh" },
		cleanup: { kind: "side-effect", sessionPolicy: "fresh", inheritsArtifacts: false },
	},
	edges: {
		plan: "cleanup",
		cleanup: "stop",
	},
};

/** Workflow with a fanout stage. */
const fanoutWorkflow: Workflow = {
	name: "test-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh" },
		build: {
			kind: "produces",
			sessionPolicy: "fresh",
			fanout: () => [],
		},
	},
	edges: {
		plan: "build",
		build: "stop",
	},
} as Workflow;

/** Workflow with an iterate stage. */
const iterateWorkflow: Workflow = {
	name: "test-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh" },
		refine: {
			kind: "produces",
			sessionPolicy: "fresh",
			iterate: () => null,
		},
	},
	edges: {
		plan: "refine",
		refine: "stop",
	},
} as Workflow;

const baseHeader: WorkflowHeader = {
	runId: "2026-06-03_07-30-00-ab12",
	workflow: "test-wf",
	input: "Add dark mode",
	ts: "2026-06-03T07:30:00Z",
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-resume-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeRunStages(stages: WorkflowStage[]): WorkflowHeader {
	writeHeader(tmpDir, baseHeader);
	for (const stage of stages) {
		appendStage(tmpDir, baseHeader.runId, stage);
	}
	return baseHeader;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("reconstructState", () => {
	it("produces-only linear chain: advances primary, appends named, tracks counters", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const art2 = fakeArtifact("plans/p2.md");
		const out1 = fakeOutput([art1]);
		const out2 = fakeOutput([art2]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
				output: out2,
			},
		]);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return; // type narrow

		expect(result.state.primaryArtifact).toStrictEqual(art2);
		expect(result.state.output).toStrictEqual(out2);
		expect(result.state.stagesCompleted).toBe(2);
		expect(result.state.lastAllocatedStageNumber).toBe(2);
		expect(result.state.named.plan).toEqual([out1]);
		expect(result.state.named.build).toEqual([out2]);
		expect(result.state.originalInput).toBe("Add dark mode");
		expect(result.visited).toEqual(new Set(["plan", "build"]));
		expect(result.lastStageNumber).toBe(2);
		expect(result.rows).toHaveLength(2);
	});

	it("side-effect stage between produces: primary preserved, named untouched by side-effect", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);
		const sideOut = fakeOutput([]); // side-effect output, no artifacts

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "commit",
				skill: "commit",
				status: "completed",
				ts: "2026-06-03T07:32:00Z",
				output: sideOut,
			},
		]);

		const result = reconstructState(tmpDir, sideEffectWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Primary stays on the produces artifact
		expect(result.state.primaryArtifact).toStrictEqual(art1);
		expect(result.state.output).toStrictEqual(sideOut);
		expect(result.state.stagesCompleted).toBe(2);
		// Side-effect stage did NOT write to named
		expect(result.state.named.plan).toEqual([out1]);
		expect(result.state.named.commit).toBeUndefined();
		expect(result.visited).toEqual(new Set(["plan", "commit"]));
	});

	it("terminal stage (inheritsArtifacts: false): clears primary", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);
		const termOut = fakeOutput([]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "cleanup",
				status: "completed",
				ts: "2026-06-03T07:32:00Z",
				output: termOut,
			},
		]);

		const result = reconstructState(tmpDir, terminalWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.primaryArtifact).toBeUndefined();
		expect(result.state.stagesCompleted).toBe(2);
		// Named is never cleared by terminal
		expect(result.state.named.plan).toEqual([out1]);
	});

	it("failed trailing row: output NOT seeded, stagesCompleted excludes it, visited + lastStageNumber include it", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "failed",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "Something went wrong",
			},
		]);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Only the completed stage counts
		expect(result.state.stagesCompleted).toBe(1);
		// Output is from the completed row only
		expect(result.state.output).toStrictEqual(out1);
		// Primary is from the completed row only
		expect(result.state.primaryArtifact).toStrictEqual(art1);
		// lastStageNumber INCLUDES the failed row
		expect(result.lastStageNumber).toBe(2);
		expect(result.state.lastAllocatedStageNumber).toBe(2);
		// visited INCLUDES the failed row
		expect(result.visited).toEqual(new Set(["plan", "build"]));
		// named only has the completed stage
		expect(result.state.named.plan).toEqual([out1]);
		expect(result.state.named.build).toBeUndefined();
	});

	it("empty file (no stage rows): returns no-rows refusal", () => {
		// Write header only, no stage rows
		writeHeader(tmpDir, baseHeader);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("no-rows");
		expect(result.detail).toBe(baseHeader.runId);
	});

	it("row whose stage is not in workflow.stages: returns stage-gone refusal", () => {
		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
			},
			{
				stageNumber: 2,
				stage: "renamed-away",
				skill: "renamed-away",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
			},
		]);

		// linearWorkflow only has plan, build, deploy — no "renamed-away"
		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("stage-gone");
		expect(result.detail).toBe("renamed-away");
	});

	it("fanout stage: returns fanout-unsupported refusal", () => {
		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
			},
		]);

		const result = reconstructState(tmpDir, fanoutWorkflow, baseHeader);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("fanout-unsupported");
		expect(result.detail).toBe("build");
	});

	it("iterate stage: returns fanout-unsupported refusal", () => {
		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
			},
			{
				stageNumber: 2,
				stage: "refine",
				skill: "refine",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
			},
		]);

		const result = reconstructState(tmpDir, iterateWorkflow, baseHeader);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("fanout-unsupported");
		expect(result.detail).toBe("refine");
	});

	it("named slot accumulates across completed rows for the same key (append order)", () => {
		// Simulate a backward-jump loop: plan runs twice, producing two outputs.
		const art1 = fakeArtifact("plans/p1.md");
		const art2 = fakeArtifact("plans/p2.md");
		const out1 = fakeOutput([art1]);
		const out2 = fakeOutput([art2]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
				output: out2,
			},
		]);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Primary is the latest artifact
		expect(result.state.primaryArtifact).toStrictEqual(art2);
		// Named preserves full history in order
		expect(result.state.named.plan).toEqual([out1, out2]);
		expect(result.state.stagesCompleted).toBe(2);
	});

	it("aborted row is treated like a failed row: excluded from state seeding", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "aborted",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "User cancelled",
			},
		]);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.stagesCompleted).toBe(1);
		expect(result.state.output).toStrictEqual(out1);
		expect(result.visited).toEqual(new Set(["plan", "build"]));
		expect(result.lastStageNumber).toBe(2);
	});

	it("skipped row is excluded from state seeding", () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRunStages([
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "skipped",
				ts: "2026-06-03T07:35:00Z",
			},
		]);

		const result = reconstructState(tmpDir, linearWorkflow, baseHeader);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.stagesCompleted).toBe(1);
		expect(result.state.output).toStrictEqual(out1);
		expect(result.visited).toEqual(new Set(["plan", "build"]));
	});
});

// ---------------------------------------------------------------------------
// resumeWorkflow — end-to-end resume tests
// ---------------------------------------------------------------------------

const RPIV_ARTIFACT_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Minimal outcome that scans assistant text for .rpiv/artifacts paths. */
const artifactOutcome: import("../output.js").OutputSpec<unknown, "artifact-md", Record<string, unknown>> = {
	collector: {
		collect: (ctx) => {
			let lastMatch: string | undefined;
			const start = Math.max(ctx.branchOffset ?? 0, 0);
			for (let i = ctx.branch.length - 1; i >= start && !lastMatch; i--) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (let j = content.length - 1; j >= 0; j--) {
					const part = content[j]!;
					if (part.type === "text" && typeof part.text === "string") {
						const matches = part.text.match(RPIV_ARTIFACT_PATTERN);
						if (matches && matches.length > 0) {
							lastMatch = matches[matches.length - 1];
							break;
						}
					}
				}
			}
			if (!lastMatch) {
				return {
					kind: "fatal",
					message: `${ctx.skill} finished without producing a .rpiv/artifacts path`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: fsHandle(lastMatch), role: "primary" }] };
		},
	},
};

/** Build a minimal 2-stage produces workflow for resume tests. */
const twoStageWf: Workflow = {
	name: "resume-wf",
	start: "plan",
	stages: {
		plan: { kind: "produces", sessionPolicy: "fresh", outcome: artifactOutcome },
		build: { kind: "produces", sessionPolicy: "fresh", outcome: artifactOutcome },
	},
	edges: {
		plan: "build",
		build: "stop",
	},
};

const resumeHeader: WorkflowHeader = {
	runId: "2026-06-03_07-30-00-ab12",
	workflow: "resume-wf",
	input: "Add dark mode",
	ts: "2026-06-03T07:30:00Z",
};

describe("resumeWorkflow", () => {
	/** Helper: write header + stages, return the header. */
	function writeRun(header: WorkflowHeader, stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const stage of stages) {
			appendStage(tmpDir, header.runId, stage);
		}
	}

	/** Helper: read all stage rows from the run's JSONL. */
	function readRunStages(runId: string): WorkflowStage[] {
		return readAllStages(tmpDir, runId);
	}

	/** Write an artifact file at the given relative path under tmpDir. */
	function writeArtifact(relPath: string, content = "") {
		const parts = relPath.split("/");
		const dir = join(tmpDir, ...parts.slice(0, -1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(tmpDir, relPath), content);
	}

	it("failed-trailer: re-runs the failed stage and continues to completion", async () => {
		// Stage 1 (plan) completed, stage 2 (build) failed.
		// Resume should re-run build and complete.
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "failed",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "Something went wrong",
			},
		]);

		writeArtifact(".rpiv/artifacts/builds/b1.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/builds/b1.md")] }],
		});

		const result = await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(true);
		expect(result.runId).toBe(resumeHeader.runId);
		// 1 (original plan) + 1 (re-ran build) = 2
		expect(result.stagesCompleted).toBe(2);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/builds/b1.md");

		// JSONL should have: original header + plan(completed) + build(failed) + build(completed)
		const stages = readRunStages(resumeHeader.runId);
		expect(stages).toHaveLength(3); // 2 original + 1 new
		expect(stages[2]).toMatchObject({
			stage: "build",
			status: "completed",
		});
		// New stage number is strictly greater than the failed row's number
		expect(stages[2]!.stageNumber).toBeGreaterThan(stages[1]!.stageNumber);

		// Dispatched the re-run with the prior stage's artifact as input
		expect(chain.sentMessages).toEqual(["/skill:build plans/p1.md"]);
	});

	it("completed-trailer: routes onward from the last completed stage", async () => {
		// Stage 1 (plan) completed. The last row is completed,
		// so resume should route onward to build.
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
		]);

		writeArtifact(".rpiv/artifacts/builds/b1.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/builds/b1.md")] }],
		});

		const result = await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);

		const stages = readRunStages(resumeHeader.runId);
		expect(stages).toHaveLength(2); // 1 original + 1 new (build)
		expect(stages[1]).toMatchObject({ stage: "build", status: "completed" });
		expect(stages[1]!.stageNumber).toBeGreaterThan(stages[0]!.stageNumber);

		expect(chain.sentMessages).toEqual(["/skill:build plans/p1.md"]);
	});

	it("cleanly finished run: immediate stop no-op (stagesCompleted unchanged)", async () => {
		// Both stages completed, edge is "stop". Resuming routes onward from build,
		// which hits stop → finalizeWorkflow → success. No new stage rows.
		const art1 = fakeArtifact("plans/p1.md");
		const art2 = fakeArtifact("builds/b1.md");
		const out1 = fakeOutput([art1]);
		const out2 = fakeOutput([art2]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "completed",
				ts: "2026-06-03T07:35:00Z",
				output: out2,
			},
		]);

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2); // unchanged
		expect(result.lastArtifact).toBe("builds/b1.md");

		// No new stage rows appended
		const stages = readRunStages(resumeHeader.runId);
		expect(stages).toHaveLength(2);

		// No new session was spawned
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
	});

	it("no-rows refusal: returns error envelope, no self-notify (caller surfaces it)", async () => {
		// Header-only file (no stage rows)
		writeHeader(tmpDir, resumeHeader);

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no recorded stages/);
		expect(result.stagesCompleted).toBe(0);
		// No runId on a no-JSONL refusal — the discriminator command uses to decide
		// whether to notify (the stage machinery never wrote a failure row here).
		expect(result.runId).toBeUndefined();

		// Pure envelope: resumeWorkflow does NOT self-notify (mirrors runWorkflow's
		// pre-flight rejections). The caller surfaces result.error.
		const errorNotifies = chain.notifications.filter((n) => n.level === "error" && /no recorded stages/.test(n.msg));
		expect(errorNotifies).toHaveLength(0);

		// No new JSONL rows written on refusal
		const stages = readRunStages(resumeHeader.runId);
		expect(stages).toHaveLength(0);
	});

	it("stage-gone refusal: returns error envelope, no self-notify", async () => {
		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
			},
			{
				stageNumber: 2,
				stage: "removed-stage",
				skill: "removed-stage",
				status: "failed",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "fail",
			},
		]);

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no longer exists/);
		expect(result.runId).toBeUndefined();

		const errorNotifies = chain.notifications.filter((n) => n.level === "error" && /no longer exists/.test(n.msg));
		expect(errorNotifies).toHaveLength(0);
	});

	it("fanout-unsupported refusal: returns error envelope, no self-notify", async () => {
		const fanoutWf: Workflow = {
			name: "fanout-wf",
			start: "plan",
			stages: {
				plan: { kind: "produces", sessionPolicy: "fresh" },
				build: { kind: "produces", sessionPolicy: "fresh", fanout: () => [] },
			},
			edges: { plan: "build", build: "stop" },
		} as Workflow;

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "failed",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "fail",
			},
		]);

		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: fanoutWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/fanout\/iterate/);
		expect(result.runId).toBeUndefined();

		const errorNotifies = chain.notifications.filter((n) => n.level === "error" && /fanout\/iterate/.test(n.msg));
		expect(errorNotifies).toHaveLength(0);
	});

	it("resume does not write a new header (append-only)", async () => {
		// Write a completed run, then resume it. The JSONL should have exactly
		// one header line (the original) — no second header was appended.
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
		]);

		writeArtifact(".rpiv/artifacts/builds/b1.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/builds/b1.md")] }],
		});

		await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		// Read raw file and count header lines (lines with runId + workflow but no stageNumber)
		const content = readFileSync(stateFilePath(tmpDir, resumeHeader.runId), "utf-8");
		const lines = content.trim().split("\n");
		const headerLines = lines.filter((l) => {
			try {
				const p = JSON.parse(l);
				return typeof p.runId === "string" && typeof p.stageNumber !== "number";
			} catch {
				return false;
			}
		});
		expect(headerLines).toHaveLength(1);
	});

	it("new stage numbers are strictly greater than all prior stage numbers", async () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
			{
				stageNumber: 2,
				stage: "build",
				skill: "build",
				status: "failed",
				ts: "2026-06-03T07:35:00Z",
				errMsg: "fail",
			},
		]);

		writeArtifact(".rpiv/artifacts/builds/b1.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/builds/b1.md")] }],
		});

		await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@2026-06-03_07-30-00-ab12",
		});

		const stages = readRunStages(resumeHeader.runId);
		const maxOriginal = Math.max(...stages.slice(0, 2).map((s) => s.stageNumber));
		const newStages = stages.slice(2);
		for (const s of newStages) {
			expect(s.stageNumber).toBeGreaterThan(maxOriginal);
		}
	});

	it("stamps resumedFrom in trigger.meta", async () => {
		const art1 = fakeArtifact("plans/p1.md");
		const out1 = fakeOutput([art1]);

		writeRun(resumeHeader, [
			{
				stageNumber: 1,
				stage: "plan",
				skill: "plan",
				status: "completed",
				ts: "2026-06-03T07:31:00Z",
				output: out1,
			},
		]);

		writeArtifact(".rpiv/artifacts/builds/b1.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/builds/b1.md")] }],
		});

		// Use lifecycle listeners to capture the trigger from LifecycleContext
		const capturedTriggers: unknown[] = [];
		await resumeWorkflow(chain.ctx, {
			workflow: twoStageWf,
			header: resumeHeader,
			ref: "@my-run-ref",
			lifecycle: {
				onWorkflowStart: (lc) => {
					capturedTriggers.push(lc.trigger);
				},
			},
		});

		expect(capturedTriggers).toHaveLength(1);
		expect(capturedTriggers[0]).toMatchObject({
			kind: "command",
			name: "wf",
			meta: { resumedFrom: "@my-run-ref" },
		});
	});
});
