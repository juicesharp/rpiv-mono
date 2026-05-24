import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import type { CompletionStrategy, EdgeTarget, NodeDef, Workflow } from "./api.js";
import { defineWorkflow, threshold } from "./api.js";
import { clearChildSession, isChildSession } from "./child-session.js";
import { countPhases } from "./implement-phases.js";
import { runWorkflow } from "./runner.js";
import { typeboxSchema } from "./standard-schema.js";
import { readRoutingDecisions } from "./state.js";
import { extractArtifactPath, hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";

// ---------------------------------------------------------------------------
// extractArtifactPath — pure scan over a synthetic branch (no I/O)
// ---------------------------------------------------------------------------

/** Helper: build an assistant message branch entry with array content. */
const asst = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("extractArtifactPath", () => {
	it("extracts artifact path from text content block", () => {
		const branch = [asst("Done!\n\nNext step: `/skill:plan .rpiv/artifacts/research/report.md`")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/report.md");
	});

	it("extracts last artifact when multiple text blocks present", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Wrote research to .rpiv/artifacts/research/res.md" },
						{ type: "text", text: "Also see .rpiv/artifacts/research/res2.md" },
					],
				},
			},
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/res2.md");
	});

	it("returns undefined when no artifact path found", () => {
		const branch = [asst("No artifacts here")];
		expect(extractArtifactPath(branch)).toBeUndefined();
	});

	it("skips non-message entries", () => {
		const branch = [{ type: "thinking_level_change" }, asst("Result: .rpiv/artifacts/designs/design.md")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/designs/design.md");
	});

	it("skips user messages", () => {
		const branch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "/skill:discover test" }] },
			},
			asst("Produced .rpiv/artifacts/discover/frd.md"),
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/discover/frd.md");
	});

	it("ignores non-text content blocks (thinking, tool_call)", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", text: ".rpiv/artifacts/research/ignored.md" },
						{ type: "text", text: ".rpiv/artifacts/research/kept.md" },
					],
				},
			},
		];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/kept.md");
	});

	it("finds artifact in last assistant message (reverse scan)", () => {
		const branch = [asst("First: .rpiv/artifacts/research/old.md"), asst("Final: .rpiv/artifacts/research/new.md")];
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/research/new.md");
	});
});

// ---------------------------------------------------------------------------
// countPhases — file-driven phase counter
// ---------------------------------------------------------------------------

describe("countPhases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-count-phases-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("counts ## Phase N: headings in an absolute-path plan file", () => {
		const planPath = join(tmpDir, "plan.md");
		writeFileSync(planPath, "## Phase 1: a\n## Phase 2: b\n## Phase 3: c\n");
		// cwd is irrelevant for absolute paths but the signature requires it.
		expect(countPhases(planPath, tmpDir)).toBe(3);
	});

	it("resolves a relative path against the provided cwd", () => {
		mkdirSync(join(tmpDir, "plans"), { recursive: true });
		writeFileSync(join(tmpDir, "plans", "p.md"), "## Phase 1: a\n## Phase 2: b\n");
		expect(countPhases("plans/p.md", tmpDir)).toBe(2);
	});

	it("returns 0 for a missing file", () => {
		expect(countPhases(join(tmpDir, "nope.md"), tmpDir)).toBe(0);
	});

	it("returns 0 for a file with no ## Phase N: headings", () => {
		const p = join(tmpDir, "empty.md");
		writeFileSync(p, "# Title\n## Summary\n## Not a Phase\n### Phase 1: sub-heading not matched\n");
		expect(countPhases(p, tmpDir)).toBe(0);
	});

	it("ignores headings without a numeric phase index", () => {
		const p = join(tmpDir, "weird.md");
		writeFileSync(p, "## Phase A: not a number\n## Phase 1: real\n");
		expect(countPhases(p, tmpDir)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runWorkflow — orchestration over a scripted session chain
// ---------------------------------------------------------------------------

describe("runWorkflow", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-run-workflow-"));
		clearChildSession();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		clearChildSession();
	});

	/**
	 * Workflow factory for tests.
	 *
	 * Builds a linear `Workflow` from an ordered stage list. Each stage
	 * becomes a node + an auto-edge to the next stage; the final stage's
	 * edge is `"stop"`. Two skill names get special defaults that align
	 * with built-in `WORKFLOW_DAG` settings so tests don't have to spell
	 * them out:
	 *   - `implement` → `completionStrategy: "agent-end"` (action skill)
	 *   - `commit`    → `completionStrategy: "agent-end"` (action skill)
	 *
	 * Override per-node via `nodeOverrides`, or replace specific edges
	 * (predicates, back-edges) via `edgeOverrides`.
	 *
	 *   wf("tiny", ["research"])
	 *   wf("rev", ["research", "code-review", "revise", "commit"], {}, {
	 *     "code-review": threshold("severeIssueCount", 0, "revise", "commit"),
	 *   })
	 */
	const wf = (
		name: string,
		stages: string[],
		nodeOverrides: Record<string, Partial<NodeDef>> = {},
		edgeOverrides: Record<string, EdgeTarget> = {},
	): Workflow => {
		const nodes: Record<string, NodeDef> = {};
		const edges: Record<string, EdgeTarget> = {};
		for (let i = 0; i < stages.length; i++) {
			const id = stages[i]!;
			const next = stages[i + 1];
			const defaultStrategy: CompletionStrategy =
				id === "implement" || id === "commit" ? "agent-end" : "artifact-emit";
			// `skill` omitted — runner defaults it from the record key, matching
			// the same convention real authors use via `artifact()` / `action()`.
			nodes[id] = {
				completionStrategy: defaultStrategy,
				sessionPolicy: "fresh",
				...(nodeOverrides[id] ?? {}),
			};
			edges[id] = edgeOverrides[id] ?? next ?? "stop";
		}
		return defineWorkflow({ name, start: stages[0] ?? "__missing__", nodes, edges });
	};

	/** Read the single JSONL state file produced for a run, as parsed objects. */
	const readState = (cwd: string): { header: Record<string, unknown>; stages: Array<Record<string, unknown>> } => {
		const dir = join(cwd, ".rpiv", "workflows");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
		return {
			header: JSON.parse(lines[0]!),
			stages: lines.slice(1).map((l) => JSON.parse(l)),
		};
	};

	/** Write an artifact file at the given relative path under cwd. */
	const writeArtifact = (cwd: string, relPath: string, content = "") => {
		const parts = relPath.split("/");
		const dir = join(cwd, ...parts.slice(0, -1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(cwd, relPath), content);
	};

	it("returns an error result for a workflow whose start node is not declared", async () => {
		// The post-format-change equivalent of "unknown preset": the caller
		// (command.ts) resolves names to Workflow objects; runWorkflow only
		// sees the object. A workflow with start ∉ nodes is the proximal
		// invalid-input case — it short-circuits BEFORE writeHeader so a
		// typo doesn't pollute the audit trail.
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			workflow: { name: "broken", start: "ghost", nodes: {}, edges: {} },
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toMatch(/start node "ghost" is not declared/);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		expect(existsSync(join(tmpDir, ".rpiv", "workflows"))).toBe(false);
	});

	describe("child-session marker lifecycle", () => {
		it("clears the marker after a successful run", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});
			expect(isChildSession()).toBe(false);

			await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"]),
				input: "x",
			});

			expect(isChildSession()).toBe(false);
		});

		it("clears the marker after a failed stage (no assistant message)", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"]),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(isChildSession()).toBe(false);
		});

		it("clears the marker when the chain throws mid-run (finally guarantee)", async () => {
			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
			// Empty step queue → second newSession will throw inside the chain.
			// We expect runWorkflow to propagate, but still clear the marker.
			const workflow = wf("tiny", ["research", "plan"]);

			let threw = false;
			try {
				await runWorkflow(chain.ctx, { workflow, input: "x" });
			} catch {
				threw = true;
			}

			// The first newSession has no scripted step either — chain throws on first call.
			expect(threw).toBe(true);
			expect(isChildSession()).toBe(false);
		});

		it("does NOT set the marker when the workflow has no declared start (early return before mark)", async () => {
			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
			await runWorkflow(chain.ctx, {
				workflow: { name: "broken", start: "ghost", nodes: {}, edges: {} },
				input: "x",
			});
			expect(isChildSession()).toBe(false);
		});
	});

	it("completes a single-step workflow on success and records header + completed step", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "add dark mode",
		});

		expect(result).toEqual({
			success: true,
			stagesCompleted: 1,
			lastArtifact: ".rpiv/artifacts/research/r.md",
			error: undefined,
		});
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		expect(chain.sentMessages).toEqual(["/skill:research add dark mode"]);

		const { header, stages } = readState(tmpDir);
		expect(header.preset).toBe("tiny");
		expect(header.input).toBe("add dark mode");
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({
			stageNumber: 1,
			skill: "research",
			artifact: ".rpiv/artifacts/research/r.md",
			status: "completed",
		});
	});

	it("chains the second step on freshCtx — outer.newSession is called exactly once", async () => {
		// The runner contract: every newSession after the first MUST be invoked
		// on the freshCtx handed to the previous withSession callback. If the
		// runner ever regressed to capturing the outer ctx, this assertion
		// would fire (outer.newSession.calls would be 2).
		writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
		writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("step 1 → .rpiv/artifacts/research/r.md")] },
				{ branch: [mockAssistantMessage("step 2 → .rpiv/artifacts/designs/d.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(2);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/designs/d.md");
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		// Step 2's prompt uses the artifact produced by step 1 — not the
		// original user input. This is the artifact-handoff invariant.
		expect(chain.sentMessages).toEqual(["/skill:research x", "/skill:design .rpiv/artifacts/research/r.md"]);
		expect(chain.remaining()).toBe(0);

		const { stages } = readState(tmpDir);
		expect(stages.map((s) => s.status)).toEqual(["completed", "completed"]);
		expect(stages[1]?.artifact).toBe(".rpiv/artifacts/designs/d.md");

		// The persistent status line updates exactly once per stage (in order),
		// then clears on workflow completion. Pi's `notify` channel gets
		// repainted by `newSession` transitions; the status line survives them,
		// which is why we use `setStatus` for "currently running X."
		expect(chain.statusUpdates).toEqual([
			{ key: "rpiv-workflow", value: "rpiv: stage 1/2 — research" },
			{ key: "rpiv-workflow", value: "rpiv: stage 2/2 — design" },
			{ key: "rpiv-workflow", value: undefined },
		]);
	});

	it("stops on step failure, records a failed entry, and never consumes later steps", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [] }, // No assistant message → runner classifies as failure
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		// Empty branch → StopSignal "noResponse" → distinct from generic "failed".
		expect(result.error).toBe("research produced no assistant message");
		expect(result.stagesCompleted).toBe(0);
		// Second scripted step must still be in the queue
		expect(chain.remaining()).toBe(1);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "failed" });
		expect(stages[0]?.artifact).toBeUndefined();
	});

	it("records skipped + emits cancelled notification when outer newSession resolves cancelled", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ cancelled: true }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		// User-cancelled returns a populated error string — distinguishes from
		// "workflow never started" (which also has success: false).
		expect(result.error).toMatch(/cancelled by user/i);
		expect(result.stagesCompleted).toBe(0);
		expect(chain.notifications.some((n) => /cancelled/i.test(n.msg))).toBe(true);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "skipped" });

		// Status was set on entry and cleared once the user dismissed the
		// newSession confirm dialog — same teardown contract as abort/failure.
		expect(chain.statusUpdates.at(-1)).toEqual({ key: "rpiv-workflow", value: undefined });
	});

	it("expands an implement step into N phases when its plan artifact has ## Phase headings", async () => {
		// Pre-write a plan artifact at the path step 1 will emit. The runner
		// reads it from disk during the implement-step multi-phase check.
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(
			join(tmpDir, planRelPath),
			"# Plan\n\n## Phase 1: alpha\nbody\n## Phase 2: beta\nbody\n## Phase 3: gamma\nbody\n",
		);

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				// research → emits plan path
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				// three implement phases
				{ branch: [mockAssistantMessage("phase 1 done")] },
				{ branch: [mockAssistantMessage("phase 2 done")] },
				{ branch: [mockAssistantMessage("phase 3 done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("rip", ["research", "implement"]),
			input: "x",
		});

		expect(result.success).toBe(true);
		// 1 research + 3 phase rows
		expect(result.stagesCompleted).toBe(4);
		expect(chain.remaining()).toBe(0);
		// Outer ctx still only initiates the very first step
		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		// Each phase's prompt suffixes the plan path with "Phase N"
		expect(chain.sentMessages).toEqual([
			"/skill:research x",
			`/skill:implement ${planRelPath} Phase 1`,
			`/skill:implement ${planRelPath} Phase 2`,
			`/skill:implement ${planRelPath} Phase 3`,
		]);

		const { stages } = readState(tmpDir);
		// header + research + 3 phase rows = 4 stage entries
		expect(stages).toHaveLength(4);
		expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
		expect(stages[1]?.skill).toBe("implement (phase 1/3)");
		expect(stages[2]?.skill).toBe("implement (phase 2/3)");
		expect(stages[3]?.skill).toBe("implement (phase 3/3)");
		expect(stages.slice(1).every((s) => s.status === "completed")).toBe(true);
	});

	it("halts the chain when the agent ends with stopReason: aborted (user pressed ESC)", async () => {
		// The bug this guards against: a partial assistant response from an
		// ESC-interrupted agent satisfies hasAssistantMessage, so without the
		// stopReason check the runner would silently advance to the next stage.
		// Matches the canonical Pi subagent halt-on-aborted pattern.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("partial response interrupted by user", "aborted")] },
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/aborted/i);
		expect(result.stagesCompleted).toBe(0);
		// Second scripted step must remain in the queue — chain halted.
		expect(chain.remaining()).toBe(1);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "aborted" });

		// A warning-level notification surfaces the abort.
		const abortNotice = chain.notifications.find((n) => /aborted/i.test(n.msg));
		expect(abortNotice?.level).toBe("warning");

		// The status line was set when stage 1 began and cleared when the abort
		// halted the chain — no stale "stage 1/2 — research" left behind.
		expect(chain.statusUpdates).toEqual([
			{ key: "rpiv-workflow", value: "rpiv: stage 1/2 — research" },
			{ key: "rpiv-workflow", value: undefined },
		]);
	});

	it("abort mid-chain surfaces partial artifacts produced by earlier stages", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
		// User ESCs at stage 2 of a 3-stage chain. Stage 1 already wrote an
		// artifact — the user should see it listed instead of having to grep
		// the JSONL. This mirrors the error-path symmetry: an error at stage 2
		// already calls notifyPartialArtifacts; an abort at stage 2 must too.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
				{ branch: [mockAssistantMessage("partial interrupted by user", "aborted")] },
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("three", ["research", "design", "plan"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/aborted/i);
		expect(result.stagesCompleted).toBe(1); // stage 1 did complete

		// The partial-artifacts recap must include the research artifact.
		const partial = chain.notifications.find((n) => /Artifacts produced before failure/i.test(n.msg));
		expect(partial).toBeDefined();
		expect(partial?.msg).toMatch(/research:.*\.rpiv\/artifacts\/research\/r\.md/);
	});

	it("halts the chain when the agent ends with stopReason: error (records failed)", async () => {
		// LLM/provider error is treated like a failure (not an abort) — same
		// failure-path bookkeeping, same partial-artifacts recap, but logged
		// under status "failed" not "aborted" so the audit trail distinguishes
		// "user stopped this" from "the model errored out."
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("internal error from provider", "error")] },
				{ branch: [mockAssistantMessage("never reached")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("research failed");
		expect(result.stagesCompleted).toBe(0);
		expect(chain.remaining()).toBe(1);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "failed" });
	});

	it("halts the chain when a stage finishes cleanly but writes no artifact (plain-text question guard)", async () => {
		// Failure mode this guards: agent stops with stopReason "stop" but no
		// `.rpiv/artifacts/...` path in the transcript (e.g. it asked a plain-
		// text clarifying question instead of using ask_user_question). Without
		// the requireArtifact guard the runner would record completed, advance
		// to stage 2, and silently re-send the *previous* (or original) input.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("What framework should I use?")] },
				{ branch: [mockAssistantMessage("never reached .rpiv/artifacts/designs/d.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "describe the thing",
		});

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toMatch(/without producing|no artifact/i);
		// Stage 2 must NOT have been spawned — second scripted step still queued.
		expect(chain.remaining()).toBe(1);
		// Only the first prompt went out (no silent re-send of original input).
		expect(chain.sentMessages).toEqual(["/skill:research describe the thing"]);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "failed" });
		expect(stages[0]?.artifact).toBeUndefined();

		// User-visible error notification surfaces the stage-failed verdict.
		// The extractor's fatal message flows through recordTerminalFailure's
		// notifyMsg (MSG_STAGE_FAILED), not the pre-Phase-3 MSG_STAGE_NO_ARTIFACT.
		const failureNotice = chain.notifications.find((n) => /failed.*stopping workflow/i.test(n.msg));
		expect(failureNotice?.level).toBe("error");
	});

	it("implement phases still complete without per-phase artifacts (artifact handoff already happened at plan stage)", async () => {
		// requireArtifact=true is for regular stages only. Implement phases
		// iterate over `## Phase N:` headings, not over per-phase outputs —
		// asserting the negative here so a future refactor doesn't unify the
		// two paths and accidentally break phase progression.
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, planRelPath), "# Plan\n\n## Phase 1: a\nx\n## Phase 2: b\ny\n");

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				{ branch: [mockAssistantMessage("phase 1 done — no artifact path here")] },
				{ branch: [mockAssistantMessage("phase 2 done — also no artifact")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("rip", ["research", "implement"]),
			input: "x",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(3); // research + 2 phases
	});

	describe("per-node completionStrategy dispatch", () => {
		it("agent-end nodes complete cleanly without producing an artifact (e.g. commit at end of preset)", async () => {
			// `commit` defaults to completionStrategy "agent-end" via the dagWith factory.
			// The branch contains no .rpiv/artifacts/... path; the runner must
			// still treat the stage as completed and finish the workflow.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Committed 3 files.")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tail", ["commit"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
			expect(result.lastArtifact).toBeUndefined();
		});

		it("agent-end node mid-chain inherits the prior stage's artifact for downstream stages", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			// research (artifact-emit) → commit (agent-end, no artifact) → design (artifact-emit).
			// Design must see research's artifact path as its input — commit
			// doesn't reset state.artifactPath when it produces nothing.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Committed.")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("rcd", ["research", "commit", "design"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(3);
			expect(result.lastArtifact).toBe(".rpiv/artifacts/designs/d.md");
			// Design received research's artifact as input — commit didn't blank it.
			expect(chain.sentMessages).toEqual([
				"/skill:research x",
				"/skill:commit .rpiv/artifacts/research/r.md",
				"/skill:design .rpiv/artifacts/research/r.md",
			]);
		});

		it("override: forcing completionStrategy to agent-end via dagWith node overrides skips artifact check", async () => {
			// Same skill that would normally require an artifact (research),
			// but the DAG declares completionStrategy "agent-end" — the runner must
			// honor the DAG, not the skill identity.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Question asked, no artifact.")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"], { research: { completionStrategy: "agent-end" } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
		});
	});

	describe("sessionPolicy: continue", () => {
		it("completes a single continue stage via pi.sendUserMessage", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
				outerBranch: [],
			});

			// Simulate branch growth: getBranch returns a reference to the
			// internal array, so pushing makes new entries visible to the runner.
			const branch = chain.ctx.sessionManager.getBranch() as unknown[];
			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				branch.push(mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md"));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
			expect(result.lastArtifact).toBe(".rpiv/artifacts/research/r.md");
			// No newSession called — the continue path reuses the outer session
			expect(chain.ctx.newSession).not.toHaveBeenCalled();
			// Message sent via pi.sendUserMessage (sync)
			expect(chain.pi!.sendUserMessage).toHaveBeenCalledWith("/skill:research x");
		});

		it("chains fresh → continue with correct branch offset", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			const priorArtifact = ".rpiv/artifacts/research/r.md";
			const designArtifact = ".rpiv/artifacts/designs/d.md";

			// Shared mutable branch — the fresh stage reads it as-is; the
			// continue stage's sendUserMessage appends its entries.
			const sharedBranch: unknown[] = [mockAssistantMessage(`Wrote ${priorArtifact}`)];

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: sharedBranch }],
				pi: createMockPi().pi,
			});

			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				sharedBranch.push(mockAssistantMessage(`Designed ${designArtifact}`));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("fc", ["research", "design"], { design: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
			expect(result.lastArtifact).toBe(designArtifact);
			// Stage 1 used newSession; stage 2 used pi.sendUserMessage
			expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
			expect(chain.sentMessages).toEqual(["/skill:research x", `/skill:design ${priorArtifact}`]);
		});

		it("continue stage abort halts the chain", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
				outerBranch: [],
			});

			const branch = chain.ctx.sessionManager.getBranch() as unknown[];
			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				branch.push(mockAssistantMessage("interrupted", "aborted"));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/aborted/i);
			expect(result.stagesCompleted).toBe(0);

			const { stages } = readState(tmpDir);
			expect(stages[0]).toMatchObject({ skill: "research", status: "aborted" });
		});

		it("continue stage with no assistant message fails", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
				outerBranch: [],
			});

			// Don't override sendUserMessage — branch stays empty after the call.
			// The runner sees branchOffset=0, slice gives [], no assistant message.

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe("research produced no assistant message");
			expect(result.stagesCompleted).toBe(0);
		});

		it("continue stage with no artifact (requireArtifact) fails", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
				outerBranch: [],
			});

			const branch = chain.ctx.sessionManager.getBranch() as unknown[];
			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				branch.push(mockAssistantMessage("I asked a clarifying question"));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/without producing/i);
			expect(result.stagesCompleted).toBe(0);
		});

		it("continue stage with agent-end stop strategy completes without artifact", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
				outerBranch: [],
			});

			const branch = chain.ctx.sessionManager.getBranch() as unknown[];
			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				branch.push(mockAssistantMessage("Committed 3 files."));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["commit"], { commit: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
			expect(result.lastArtifact).toBeUndefined();
		});

		it("throws when implement node has sessionPolicy continue", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
			});

			await expect(
				runWorkflow(chain.ctx, {
					workflow: wf("ic", ["implement"], { implement: { sessionPolicy: "continue" } }),
					input: "x",
					pi: chain.pi,
				}),
			).rejects.toThrow(/cannot use sessionPolicy.*continue/);
		});

		it("throws when continue node runs without pi", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
			});

			await expect(
				runWorkflow(chain.ctx, {
					workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
					input: "x",
					// No pi provided
				}),
			).rejects.toThrow(/no pi.*ExtensionAPI/);
		});

		it("branch offset prevents false positive from prior stage artifact", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			// Fresh stage produces artifact, continue stage fails to produce its own.
			// Without offset, extractArtifactPath would return the prior artifact.
			const priorArtifact = ".rpiv/artifacts/research/r.md";

			// Shared mutable branch: pre-populated with the fresh stage's entry.
			const sharedBranch: unknown[] = [mockAssistantMessage(`Wrote ${priorArtifact}`)];

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: sharedBranch }],
				pi: createMockPi().pi,
			});

			// Continue stage produces a message but no artifact
			(chain.pi!.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: unknown) => {
				chain.sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
				sharedBranch.push(mockAssistantMessage("I analyzed the design but didn't write a plan"));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("fc", ["research", "design"], { design: { sessionPolicy: "continue" } }),
				input: "x",
				pi: chain.pi,
			});

			// Stage 2 failed — no artifact produced by the continue stage
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/without producing/i);
			expect(result.stagesCompleted).toBe(1); // Only stage 1 completed
			expect(chain.remaining()).toBe(0);

			const { stages } = readState(tmpDir);
			expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });
		});
	});

	describe("input validation (Phase 5)", () => {
		it("halts chain when prior manifest fails consumer's inputSchema", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			// Stage 1 (research) produces an artifact. Stage 2 (design) has an
			// inputSchema that rejects the manifest data from stage 1.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					// Stage 2 is never reached — input validation halts before executeSession
				],
			});

			const schema = typeboxSchema(Type.Object({ requiredField: Type.String() }));
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], { design: { inputSchema: schema } }),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.stagesCompleted).toBe(1); // research completed
			expect(result.error).toMatch(/input validation failed/i);
			expect(result.error).toMatch(/research/); // names the producer
			expect(result.error).toMatch(/design/); // names the consumer
			// Stage 2 never reached executeSession — no step consumed for it.
			// Only stage 1's step was queued and consumed.

			const { stages } = readState(tmpDir);
			expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });
		});

		it("error notification names both producing and consuming skill", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const schema = typeboxSchema(Type.Object({ version: Type.Integer() }));
			await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], { design: { inputSchema: schema } }),
				input: "x",
			});

			const inputFailNotice = chain.notifications.find((n) => /input validation failed/i.test(n.msg));
			expect(inputFailNotice).toBeDefined();
			expect(inputFailNotice?.level).toBe("error");
			expect(inputFailNotice?.msg).toMatch(/design/); // consumer
			expect(inputFailNotice?.msg).toMatch(/research/); // producer
		});

		it("stages without inputSchema are unaffected", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			// Neither node has inputSchema — both should pass through.
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("passes when manifest data satisfies the consumer's inputSchema", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nrequiredField: hello\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const schema = typeboxSchema(Type.Object({ requiredField: Type.String() }));
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], { design: { inputSchema: schema } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("halt path does not require ExecuteSessionParams (inline halt confirmed)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const schema = typeboxSchema(Type.Object({ mustExist: Type.String() }));
			await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], { design: { inputSchema: schema } }),
				input: "x",
			});

			// The failed row is still recorded in JSONL (inline halt writes it)
			const { stages } = readState(tmpDir);
			expect(stages).toHaveLength(2);
			expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });

			// Status line cleared
			expect(chain.statusUpdates.at(-1)).toEqual({ key: "rpiv-workflow", value: undefined });
		});
	});

	describe("predicate routing (Phase 6)", () => {
		it("routes to commit when severeIssueCount is 0 (no severe issues)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					// commit (agent-end)
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(3); // research + code-review + commit (revise skipped)
			expect(chain.sentMessages).toEqual([
				"/skill:research x",
				"/skill:code-review .rpiv/artifacts/research/r.md",
				"/skill:commit .rpiv/artifacts/code-review/cr.md",
			]);
		});

		it("routes to revise when severeIssueCount > 0", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 3\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/revise/rev.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					// revise (linear next after code-review)
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/revise/rev.md")] },
					// commit — after revise, the runner continues linear to commit
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(4); // research + code-review + revise + commit
			expect(chain.sentMessages).toEqual([
				"/skill:research x",
				"/skill:code-review .rpiv/artifacts/research/r.md",
				"/skill:revise .rpiv/artifacts/code-review/cr.md",
				"/skill:commit .rpiv/artifacts/revise/rev.md",
			]);
		});

		it("routing decision appears in JSONL as type: routing row", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					// Predicate routes to commit (skipping revise) — non-linear routing
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			await runWorkflow(chain.ctx, { workflow, input: "x" });

			const dir = join(tmpDir, ".rpiv", "workflows");
			const files = readdirSync(dir);
			const content = readFileSync(join(dir, files[0]!), "utf-8").trim();
			const lines = content.split("\n");

			// Find routing rows
			const routingRows = lines
				.slice(1)
				.map((l) => JSON.parse(l))
				.filter((r) => r.type === "routing");

			expect(routingRows).toHaveLength(1);
			expect(routingRows[0]).toMatchObject({
				type: "routing",
				fromStage: 2, // code-review is stage 2
				fromNode: "code-review",
				decision: "commit",
			});
		});

		it("routing row emitted when predicate skips a node (non-linear advance)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			// Threshold routes code-review → "commit" when severeIssueCount === 0,
			// skipping the otherwise-linear "revise" — the routing layer audits
			// this decision as a `type: routing` row.
			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			await runWorkflow(chain.ctx, { workflow, input: "x" });

			const dir = join(tmpDir, ".rpiv", "workflows");
			const files = readdirSync(dir);
			const content = readFileSync(join(dir, files[0]!), "utf-8").trim();
			const lines = content.split("\n");

			const routingRows = lines
				.slice(1)
				.map((l) => JSON.parse(l))
				.filter((r) => r.type === "routing");

			// Predicate routes to commit (idx 3), linear would be revise (idx 2)
			// So a routing row IS emitted
			expect(routingRows).toHaveLength(1);
			expect(routingRows[0]?.decision).toBe("commit");
		});

		it("readAllStages ignores routing rows (filters on stageNumber)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
			expect(result.success).toBe(true);

			const { stages } = readState(tmpDir);
			// 4 rows total: 3 stage rows + 1 routing row
			// The routing row is mixed in but lacks stageNumber
			expect(stages).toHaveLength(4);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			expect(stageRows).toHaveLength(3); // research + code-review + commit
			expect(stageRows.every((s) => typeof s.stageNumber === "number")).toBe(true);
		});

		it("readRoutingDecisions returns only routing rows", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
			expect(result.success).toBe(true);

			// Find the runId from the JSONL file
			const dir = join(tmpDir, ".rpiv", "workflows");
			const files = readdirSync(dir);
			const runId = files[0]!.replace(".jsonl", "");

			const routingDecisions = readRoutingDecisions(tmpDir, runId);
			expect(routingDecisions).toHaveLength(1);
			expect(routingDecisions[0]).toMatchObject({
				type: "routing",
				fromNode: "code-review",
				decision: "commit",
			});
		});
	});

	describe("backward-jump cycle guard", () => {
		it("halts the chain when re-entries exceed MAX_BACKWARD_JUMPS", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					// a first visit — advances to b (b not visited yet → forward).
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					// b first visit — advances to a (a visited → re-entry 1).
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					// a second visit — advances to b (b visited → re-entry 2).
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
					// b second visit — advances to a (a visited → re-entry 3, exceeds MAX=2). HALT.
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b2.md")] },
				],
			});

			// a→b inherited from linear order; b→a override creates the cycle. `c`
			// is declared but unreachable — exercised to confirm the runner halts
			// via the backward-jump guard, not via running into `c`.
			const workflow = wf("cycle", ["a", "b", "c"], {}, { b: "a" });

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.error).toMatch(/3.*max 2/);
			// Re-entry counter (visited-set semantics): 4 stages run (a, b, a, b)
			// before the would-be 3rd entry into `a` exceeds MAX=2 and halts.
			expect(result.stagesCompleted).toBe(4);
			expect(chain.remaining()).toBe(0);

			const { stages } = readState(tmpDir);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			expect(stageRows).toHaveLength(4);
			expect(stageRows.every((s) => s.status === "completed")).toBe(true);
			expect(stageRows.filter((s) => s.status === "failed")).toHaveLength(0);

			const exhaustionNotice = chain.notifications.find((n) => /backward-jump limit exceeded/i.test(n.msg));
			expect(exhaustionNotice?.level).toBe("error");
		});

		it("allows re-entries within limit before halting on next exceedance", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					// a first visit — advances to b (forward).
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					// b first visit — advances to a (re-entry 1, ≤ MAX=1).
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					// a second visit — advances to b (re-entry 2 > MAX=1). HALT.
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
				],
			});

			const workflow = wf("cycle", ["a", "b", "c"], {}, { b: "a" });

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			// First re-entry allowed (a→b→a). Second re-entry attempt halts.
			expect(result.stagesCompleted).toBe(3);
			expect(result.success).toBe(false);
		});

		it("does not count forward jumps as backward jumps", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(3);
		});

		it("respects custom maxBackwardJumps from RunWorkflowOptions", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
				],
			});

			const workflow = wf("cycle", ["a", "b", "c"], {}, { b: "a" });

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.error).toMatch(/2.*max 1/);
			expect(result.stagesCompleted).toBe(3);
		});

		it("counts a self-edge as backward-jump from the first hop", async () => {
			// SB5 contract: `visited.add(currentName)` happens BEFORE the
			// backward-jump check on `nextName`. For a self-loop (a → a), that
			// means the very first re-entry counts. With maxBackwardJumps=0 we
			// halt after one execution; with maxBackwardJumps=1 we get exactly
			// two executions before halting.
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
				],
			});

			// Single-node workflow with a self-loop. `wf` builds nodes in order;
			// override the edge to point a → a explicitly.
			const workflow = wf("self-loop", ["a"], {}, { a: "a" });

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.stagesCompleted).toBe(2);
		});

		it("clears status line on backward-jump exhaustion", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
				],
			});

			// a→b inherited from linear order; b→a override creates the cycle. `c`
			// is declared but unreachable — exercised to confirm the runner halts
			// via the backward-jump guard, not via running into `c`.
			const workflow = wf("cycle", ["a", "b", "c"], {}, { b: "a" });

			await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 0 });

			expect(chain.statusUpdates.at(-1)).toEqual({ key: "rpiv-workflow", value: undefined });
		});

		it("does not write a duplicate JSONL row on backward-jump exhaustion", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
				],
			});

			// a→b inherited from linear order; b→a override creates the cycle. `c`
			// is declared but unreachable — exercised to confirm the runner halts
			// via the backward-jump guard, not via running into `c`.
			const workflow = wf("cycle", ["a", "b", "c"], {}, { b: "a" });

			await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 0 });

			// Both stages completed successfully before the guard halted the
			// chain — no phantom "failed" row for the same skill that just
			// recorded "completed". (Filter on `stageNumber` to skip the
			// routing-decision row interleaved into the JSONL.)
			const { stages } = readState(tmpDir);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			expect(stageRows).toHaveLength(2);
			expect(stageRows.every((s) => s.status === "completed")).toBe(true);
			expect(stageRows.filter((s) => s.status === "failed")).toHaveLength(0);
		});
	});
});

describe("transcript offset helpers", () => {
	it("extractArtifactPath with offsetStart skips prior entries", () => {
		const branch = [asst("First: .rpiv/artifacts/research/old.md"), asst("Second: .rpiv/artifacts/designs/new.md")];
		// Without offset, returns the last artifact
		expect(extractArtifactPath(branch)).toBe(".rpiv/artifacts/designs/new.md");
		// With offset=1, skips the first entry
		expect(extractArtifactPath(branch, 1)).toBe(".rpiv/artifacts/designs/new.md");
		// With offset=2, no entries to scan
		expect(extractArtifactPath(branch, 2)).toBeUndefined();
	});

	it("hasAssistantMessage with offsetStart skips prior entries", () => {
		const branch = [asst("prior stage"), { type: "user_message" }];
		// Full branch has assistant
		expect(hasAssistantMessage(branch)).toBe(true);
		// From offset 2, no assistant
		expect(hasAssistantMessage(branch, 2)).toBe(false);
	});

	it("lastAssistantStopReason with offsetStart skips prior entries", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop" as const,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "err" }],
					stopReason: "error" as const,
				},
			},
		];
		// Full branch returns last stop reason
		expect(lastAssistantStopReason(branch)).toBe("error");
		// From offset 1, returns only the second entry's stop reason
		expect(lastAssistantStopReason(branch, 1)).toBe("error");
		// From offset 2, no entries
		expect(lastAssistantStopReason(branch, 2)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// totalStages (countReachableNodes) — observed through the status-line denominator
// ---------------------------------------------------------------------------

describe("totalStages denominator (countReachableNodes)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-total-stages-"));
		clearChildSession();
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		clearChildSession();
	});

	const stageDenominator = (statusUpdates: Array<{ key: string; value: string | undefined }>): number | undefined => {
		const first = statusUpdates.find((u) => u.value !== undefined);
		const match = first?.value?.match(/stage \d+\/(\d+)/);
		return match ? Number(match[1]) : undefined;
	};

	it("counts every reachable node along a linear chain", async () => {
		writeFileSync(join(tmpDir, ".rpiv-stub"), ""); // ensure cwd exists
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// 3-node linear chain — denominator should be 3.
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "linear",
				start: "a",
				nodes: {
					a: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					b: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					c: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
				},
				edges: { a: "b", b: "c", c: "stop" },
			},
			input: "x",
		});
		expect(stageDenominator(chain.statusUpdates)).toBe(3);
	});

	it("counts both branches when an edge is a threshold (with .targets)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "branching",
				start: "a",
				nodes: {
					a: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					b: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					c: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
				},
				// Threshold attaches .targets = ["b", "c"]; BFS reaches both.
				edges: { a: threshold("count", 0, "b", "c"), b: "stop", c: "stop" },
			},
			input: "x",
		});
		expect(stageDenominator(chain.statusUpdates)).toBe(3);
	});

	it("excludes orphan (unreachable) nodes from the count", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// `orphan` is declared but never reachable from start.
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "with-orphan",
				start: "a",
				nodes: {
					a: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					b: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					orphan: { skill: "orphan", completionStrategy: "agent-end", sessionPolicy: "fresh" },
				},
				edges: { a: "b", b: "stop", orphan: "stop" },
			},
			input: "x",
		});
		// BFS reaches {a, b} — denominator is 2, not 3.
		expect(stageDenominator(chain.statusUpdates)).toBe(2);
	});

	it("falls back to the declared-node total when an EdgeFn has no .targets", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// A bare EdgeFn skips definePredicate/threshold and carries no .targets
		// metadata. Validate would reject this at load time, but runWorkflow can
		// still receive it from a test or programmatic embedder. The defensive
		// fallback in countReachableNodes returns Object.keys(nodes).length so
		// the status-line denominator stays a valid upper bound (never undercounts).
		const bareEdge = () => "b";
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "naked",
				start: "a",
				nodes: {
					a: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
					b: { completionStrategy: "agent-end", sessionPolicy: "fresh" },
				},
				edges: { a: bareEdge, b: "stop" },
			},
			input: "x",
		});
		expect(stageDenominator(chain.statusUpdates)).toBe(2);
	});
});
