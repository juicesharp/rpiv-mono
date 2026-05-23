/**
 * Reproducer tests for blockers identified in the 2026-05-23 code review
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
 * - I9 — Phase fanout labels JSONL rows by node id (wrong for aliased
 *        implement nodes); should label by node.skill instead.
 * - Q7 — runner reuses originalInput whenever artifactPath is unset, not
 *        just at the first stage; later stages silently receive the user's
 *        original brief instead of the upstream stage's output.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DagNode, WorkflowDag } from "./dag.js";
import { validateDag, WORKFLOW_DAG } from "./dag.js";
import { resolveNextStageId } from "./routing.js";
import { runWorkflow } from "./runner.js";
import { resolveStateFile, resolveWorkflowsDir } from "./state.js";
import type { RunState } from "./types.js";

const makeState = (manifestData?: Record<string, unknown>): RunState => ({
	originalInput: "",
	artifactPath: undefined,
	manifest: manifestData
		? { kind: "artifact-md", data: manifestData, meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" } }
		: undefined,
	stagesCompleted: 0,
	lastStageNumber: 0,
	success: false,
	error: undefined,
	backwardJumps: 0,
});

// ---------------------------------------------------------------------------
// I1 — validate must route to code-review (not commit) in mid/large presets,
//      and the second `implement` in `mid` must be reachable through routing.
// ---------------------------------------------------------------------------

describe("[I1] validate → code-review routing in mid/large", () => {
	it("routes validate → code-review (not commit) in the mid preset", () => {
		const mid = WORKFLOW_DAG.presets.mid!;
		// validate sits at index 3 in mid: [research, blueprint, implement, validate, code-review, ...]
		expect(mid[3]).toBe("validate");
		expect(mid[4]).toBe("code-review");

		const next = resolveNextStageId(WORKFLOW_DAG, "validate", mid, 3, makeState());
		// Bug: returns "commit" because dag.ts:195 declares validate → ["commit"].
		expect(next).toBe("code-review");
	});

	it("routes validate → code-review-large (not commit) in the large preset", () => {
		// validate's outgoing edge is a 2-target choice that falls through to
		// linearNextOf, so the right code-review variant is selected per preset.
		const large = WORKFLOW_DAG.presets.large!;
		expect(large[4]).toBe("validate");
		expect(large[5]).toBe("code-review-large");

		const next = resolveNextStageId(WORKFLOW_DAG, "validate", large, 4, makeState());
		expect(next).toBe("code-review-large");
	});

	it("every preset is fully reachable from preset[0] via the edge graph", () => {
		// BFS-style reachability: follow every outgoing edge to every target
		// (auto / choice / predicate all branch); choice edges also count their
		// linear-fallback successor since `routing.ts` picks it at runtime. The
		// invariant is static — predicate edges decide dynamically, but every
		// declared position in the preset must be reachable along SOME path.
		for (const [name, stageIds] of Object.entries(WORKFLOW_DAG.presets)) {
			const reached = new Set<number>([0]);
			const queue: number[] = [0];
			while (queue.length) {
				const idx = queue.shift()!;
				const id = stageIds[idx]!;
				const edge = WORKFLOW_DAG.edges.find((e) => e.from === id);
				const linearTarget: string | undefined = idx + 1 < stageIds.length ? stageIds[idx + 1] : undefined;
				const targets: string[] = edge
					? edge.condition === "choice" && linearTarget
						? [...edge.to, linearTarget]
						: [...edge.to]
					: linearTarget
						? [linearTarget]
						: [];
				for (const target of targets) {
					const targetIdx = stageIds.indexOf(target);
					if (targetIdx < 0) continue; // edge target outside this preset — fine
					if (!reached.has(targetIdx)) {
						reached.add(targetIdx);
						queue.push(targetIdx);
					}
				}
			}
			for (let i = 0; i < stageIds.length; i++) {
				expect(reached.has(i), `preset "${name}": idx ${i} (${stageIds[i]}) unreachable`).toBe(true);
			}
		}
	});

	it("revise routes forward to implement-after-revise (not the original implement)", () => {
		// Direct check on the duplicate-implement fix: routing must reach the
		// post-revise position via Array.indexOf rather than looping back to
		// the pre-validate implement at idx 2.
		const mid = WORKFLOW_DAG.presets.mid!;
		const reviseIdx = mid.indexOf("revise");
		expect(reviseIdx).toBeGreaterThan(-1);
		const next = resolveNextStageId(WORKFLOW_DAG, "revise", mid, reviseIdx, makeState());
		expect(next).toBe("implement-after-revise");
		expect(mid.indexOf(next!)).toBeGreaterThan(reviseIdx);
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
		// Simulate the writeHeader-silent-failure path: the workflows directory
		// exists, but no header line was written. appendStage then writes the
		// first stage row at line 0 of the file.
		const { readLastStage } = await import("./state.js");
		const runId = "2026-05-23_13-05-38-abcd";
		mkdirSync(resolveWorkflowsDir(tmpDir), { recursive: true });
		const filePath = resolveStateFile(tmpDir, runId);
		const stageRow = {
			stageNumber: 1,
			skill: "research",
			artifact: ".rpiv/artifacts/research/r.md",
			status: "completed" as const,
			ts: "2026-05-23T13:06:00-0400",
		};
		appendFileSync(filePath, `${JSON.stringify(stageRow)}\n`, "utf-8");

		// Bug: readLastStage starts iteration at i=1, dropping the only row.
		// Expected: the row is returned because filtering is type-based, not
		// position-based.
		expect(readLastStage(tmpDir, runId)).toEqual(stageRow);
	});
});

// ---------------------------------------------------------------------------
// I6 — Predicate fires on un-validated frontmatter; missing severeIssueCount
//      must not silently route to commit. Surfacing validateDag warnings is
//      part of the same fix.
// ---------------------------------------------------------------------------

describe("[I6] code-review predicate must not silently route to commit on missing field", () => {
	it("WORKFLOW_DAG declares an outputSchema on the code-review node", () => {
		// Architectural fix: the predicate factory stays lenient (predicates.ts
		// callers like `predicateOnField` rely on `?? 0` semantics for optional
		// fields); the schema layer is what makes missing data impossible to
		// reach the predicate. `retryUntilValid` runs the schema before
		// `resolveNextStageId` consults the edge.
		const codeReview = WORKFLOW_DAG.nodes["code-review"];
		expect(codeReview?.outputSchema).toBeDefined();
	});

	it("the declared schema rejects an empty data object", async () => {
		// The schema is the active defense. Verify it actually catches the
		// "agent forgot the field" case at the validator boundary, so the
		// downstream predicate is never asked about absent data.
		const { validateManifestData } = await import("./validation.js");
		const schema = WORKFLOW_DAG.nodes["code-review"]?.outputSchema;
		if (!schema) throw new Error("code-review outputSchema missing — fix I6 first");
		const result = validateManifestData(schema, {});
		expect(result.valid).toBe(false);
	});

	it("validateDag reports no warnings for the default WORKFLOW_DAG", () => {
		// With the schema in place, the predicate-edge advisory no longer fires
		// for the built-in DAG. If a future built-in node grows a predicate edge
		// without a schema, this guardrail catches it.
		const { warnings } = validateDag(WORKFLOW_DAG);
		expect(warnings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// I7 — A `stopReason: "length"` reply on an agent-end stage must NOT be
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

	const singleAgentEndDag = (): WorkflowDag => {
		const node: DagNode = {
			kind: "skill",
			skill: "implement",
			completionStrategy: "agent-end",
			sessionPolicy: "fresh",
		};
		return { edges: [], presets: { tiny: ["implement"] }, nodes: { implement: node } };
	};

	const readStages = (cwd: string): Array<Record<string, unknown>> => {
		const dir = join(cwd, ".rpiv", "workflows");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		// Skip header (line 0); every other line is a stage or routing row.
		return lines.slice(1).map((l) => JSON.parse(l));
	};

	it("does not write status=completed for an implement stage that hit the length cap", async () => {
		// No artifact file needed — agent-end nodes inherit prior artifactPath.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("partial edit before output cap reached", "length")],
				},
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "tiny",
			input: "add dark mode",
			dag: singleAgentEndDag(),
		});

		// Bug: classifyStopOutcome returns "ok" for stopReason="length" and
		// sideEffectExtractor never returns fatal, so the stage records as
		// completed and the workflow reports success.
		expect(result.success).toBe(false);

		const stages = readStages(tmpDir);
		const recorded = stages.find((s) => s.skill === "implement");
		expect(recorded?.status).not.toBe("completed");
	});

	it("does not write status=completed for an agent-end stage that returned stopReason=toolUse", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("invoked a tool but never settled", "toolUse")],
				},
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "tiny",
			input: "add dark mode",
			dag: singleAgentEndDag(),
		});

		expect(result.success).toBe(false);
		const stages = readStages(tmpDir);
		const recorded = stages.find((s) => s.skill === "implement");
		expect(recorded?.status).not.toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// I3 — recordStage must signal write success/failure so stagesCompleted
//      stays aligned with on-disk rows, and stageNumbers never repeat
//      even when an append fails (advance the counter regardless).
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
		artifactPath: undefined,
		manifest: undefined,
		stagesCompleted: 0,
		lastStageNumber: 0,
		success: false,
		error: undefined,
		backwardJumps: 0,
	});

	it("returns the assigned stageNumber on a successful write", async () => {
		const { recordStage } = await import("./audit.js");
		const state = freshState();
		const assigned = recordStage(
			tmpDir,
			"run-1",
			{ skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
			state,
		);
		expect(assigned).toBe(1);
		expect(state.lastStageNumber).toBe(1);
	});

	it("returns undefined on a write failure but still advances lastStageNumber (no number reuse)", async () => {
		const { recordStage } = await import("./audit.js");
		const state = freshState();
		// First write — to an impossible path so appendStage fails.
		const failedAssignment = recordStage(
			"/dev/null/impossible",
			"run-1",
			{ skill: "research", status: "completed", ts: "2026-05-23T00:00:00Z" },
			state,
		);
		expect(failedAssignment).toBeUndefined();
		// Counter advances anyway — next stage must NOT reuse #1.
		expect(state.lastStageNumber).toBe(1);

		const nextAssignment = recordStage(
			tmpDir,
			"run-1",
			{ skill: "design", status: "completed", ts: "2026-05-23T00:00:01Z" },
			state,
		);
		expect(nextAssignment).toBe(2);
		expect(state.lastStageNumber).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Q7 — Non-first stages must NOT silently fall back to originalInput when
//      their upstream produced no artifactPath. The "first stage" semantics
//      should be guarded by stageIndex === 0 explicitly; anything else
//      should halt with a structured error.
// ---------------------------------------------------------------------------

describe("[Q7] non-first stage with no artifactPath halts instead of reusing originalInput", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-q7-repro-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("halts the chain when stage idx > 0 has no upstream artifactPath", async () => {
		// Two agent-end stages back-to-back. The first (commit) doesn't produce
		// an artifact; sideEffectExtractor inherits state.artifactPath which
		// starts undefined. The second stage then runs with artifactPath still
		// undefined — today it silently picks up state.originalInput.
		const dag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["commit", "annotate-guidance"] },
			nodes: {
				commit: { kind: "skill", skill: "commit", completionStrategy: "agent-end", sessionPolicy: "fresh" },
				"annotate-guidance": {
					kind: "skill",
					skill: "annotate-guidance",
					completionStrategy: "agent-end",
					sessionPolicy: "fresh",
				},
			},
		};

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("commit done")] },
				{ branch: [mockAssistantMessage("would never receive originalInput in a sane chain")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			preset: "tiny",
			input: "add dark mode",
			dag,
		});

		// Expected post-fix: chain halts at idx 1 with a structured error
		// referencing the missing input. Today: result.success is true and the
		// second stage was invoked with the user's original brief.
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/artifact|input/i);

		// The second stage's prompt must NOT have been issued with originalInput
		// substituted as if it were an artifact path.
		expect(chain.sentMessages).not.toContain("/skill:annotate-guidance add dark mode");
	});
});

// ---------------------------------------------------------------------------
// I9 — Phase fanout must label JSONL rows by node.skill, not by the node id.
//      Aliased implement nodes (e.g. implement-after-revise) currently show
//      up as `skill: "implement-after-revise (phase N/M)"`, while every
//      other audit row for the same skill body is labeled `implement`.
// ---------------------------------------------------------------------------

describe("[I9] phase fanout labels by skill name, not by aliased node id", () => {
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

	it("phase rows for an aliased implement node carry skill=implement, not the node id", async () => {
		// Pre-write a 2-phase plan at the path research will emit.
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, planRelPath), "# Plan\n\n## Phase 1: a\nbody\n## Phase 2: b\nbody\n");

		const dag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research", "implement-after-revise"] },
			nodes: {
				research: { kind: "skill", skill: "research", completionStrategy: "artifact-emit", sessionPolicy: "fresh" },
				"implement-after-revise": {
					kind: "skill",
					skill: "implement",
					completionStrategy: "agent-end",
					sessionPolicy: "fresh",
				},
			},
		};

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				{ branch: [mockAssistantMessage("phase 1 done")] },
				{ branch: [mockAssistantMessage("phase 2 done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { preset: "tiny", input: "x", dag });
		expect(result.success).toBe(true);

		// The phase prompts substitute node.skill rather than hardcoding the
		// literal "implement". Today's code happens to be correct here because
		// the alias's skill IS "implement"; the assertion locks in the contract
		// so a future alias with a different skill body breaks loudly.
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
