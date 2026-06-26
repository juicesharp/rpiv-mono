import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeTarget, FanoutFn, ScriptContext, StageDef, StageKind, StageSchema, Workflow } from "./api.js";
import { defineRoute, defineWorkflow, gate, produces, terminal } from "./api.js";
import { registerBuiltIns } from "./built-ins.js";
import { fs as fsHandle } from "./handle.js";
import { fanout } from "./loop-constructors.js";
import type { Outcome } from "./output-spec.js";
import { eq, gt } from "./predicates.js";
import { runWorkflow, runWorkflowByName } from "./runner/index.js";
import type { CompositionComparator } from "./skill-contract.js";
import { registerCompositionComparator, registerSkillContracts } from "./skill-contracts/index.js";
import { appendRoutingDecision, readHeader, readNamesIndex, readRoutingDecisions, writeHeader } from "./state/index.js";
// Deep import: addNameToIndex is deliberately NOT on the state barrels
// (production code goes through claimName); tests seed collisions directly.
import { addNameToIndex } from "./state/names.js";
import { hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";
import { typeboxSchema } from "./typebox-adapter.js";

// Note: transcript-path scanning moved to rpiv-pi (`rpivArtifactCollector`)
// since the `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv
// convention, not a framework concern. Tests for that collector live
// alongside it in `packages/rpiv-pi/extensions/rpiv-core/`.

/** Helper: build an assistant message branch entry with array content. */
const asst = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

// ---------------------------------------------------------------------------
// Test fixture: a minimal phase-headings FanoutFn matching the rpiv-pi
// convention (`## Phase N:`). Mirrors what rpiv-pi declares inline in
// `built-in-workflows.ts` — kept local so rpiv-workflow tests don't reach
// for an rpiv-pi import.
// ---------------------------------------------------------------------------

const phaseHeadingsFanout: FanoutFn = ({ artifact, cwd }) => {
	if (artifact?.handle.kind !== "fs") return [];
	const path = artifact.handle.path;
	const abs = path.startsWith("/") ? path : join(cwd, path);
	const content = readFileSync(abs, "utf-8");
	const matches = [...content.matchAll(/^## Phase (\d+):/gm)];
	return matches.map((m, i) => ({
		prompt: `${path} Phase ${m[1]}`,
		label: `phase ${i + 1}/${matches.length}`,
	}));
};

// ---------------------------------------------------------------------------
// Test outcome: scan assistant text for `.rpiv/artifacts/<bucket>/<file>.md`
// paths (the rpiv-pi convention, inlined so this test file doesn't reach for
// an rpiv-pi import). Used as the default outcome on produces nodes
// built by `wf()` below.
// ---------------------------------------------------------------------------

const RPIV_ARTIFACT_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;

/** Minimal YAML-frontmatter parser for tests: `key: value` lines between `---` fences, scalar values only. */
const parseFmTestOnly = (content: string): Record<string, unknown> => {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const fm: Record<string, unknown> = {};
	for (const line of match[1]!.split("\n")) {
		const m = line.match(/^([\w.-]+)\s*:\s*(.+)$/);
		if (!m) continue;
		const v = m[2]!.trim();
		// Coerce numbers; keep everything else as string.
		const num = Number(v);
		fm[m[1]!] = Number.isFinite(num) && v !== "" && /^-?\d/.test(v) ? num : v;
	}
	return fm;
};

const transcriptArtifactMdOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
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
					message: `${ctx.skill} finished without producing a .rpiv/artifacts/<bucket>/<file>.md path`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: fsHandle(lastMatch), role: "primary" }] };
		},
	},
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			if (primary?.handle.kind !== "fs") {
				return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
			}
			const abs = primary.handle.path.startsWith("/") ? primary.handle.path : join(ctx.cwd, primary.handle.path);
			if (!existsSync(abs)) return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
			return {
				kind: "ok",
				payload: { kind: "artifact-md", data: parseFmTestOnly(readFileSync(abs, "utf-8")) },
			};
		},
	},
};

// ---------------------------------------------------------------------------
// runWorkflow — orchestration over a scripted session chain
// ---------------------------------------------------------------------------

describe("runWorkflow", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-run-workflow-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Workflow factory for tests.
	 *
	 * Builds a linear `Workflow` from an ordered stage list. Each stage
	 * becomes a StageDef + an auto-edge to the next stage; the final stage's
	 * edge is `"stop"`. Two skill names get special defaults that align
	 * with built-in `WORKFLOW_DAG` settings so tests don't have to spell
	 * them out:
	 *   - `implement` → `kind: "side-effect"` (action skill)
	 *   - `commit`    → `kind: "side-effect"` (action skill)
	 *
	 * Override per-stage via `stageOverrides`, or replace specific edges
	 * (predicates, back-edges) via `edgeOverrides`.
	 *
	 *   wf("tiny", ["research"])
	 *   wf("rev", ["research", "code-review", "revise", "commit"], {}, {
	 *     "code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
	 *   })
	 */
	const wf = (
		name: string,
		stages: string[],
		stageOverrides: Record<string, Partial<StageDef>> = {},
		edgeOverrides: Record<string, EdgeTarget> = {},
	): Workflow => {
		const stageMap: Record<string, StageDef> = {};
		const edges: Record<string, EdgeTarget> = {};
		for (let i = 0; i < stages.length; i++) {
			const id = stages[i]!;
			const next = stages[i + 1];
			const defaultStrategy: StageKind = id === "implement" || id === "commit" ? "side-effect" : "produces";
			// `skill` omitted — runner defaults it from the record key, matching
			// the same convention real authors use via `produces()` / `acts()`.
			const base: StageDef = {
				kind: defaultStrategy,
				sessionPolicy: "fresh",
			};
			const merged = { ...base, ...(stageOverrides[id] ?? {}) } as StageDef;
			// produces stages get a test-local transcript-scan outcome (the
			// framework no longer ships a default). Decide based on the FINAL
			// strategy after overrides — if a test overrides to side-effect, we
			// don't want to attach the artifact-md outcome and force a path scan.
			if (merged.kind === "produces" && !merged.outcome) {
				merged.outcome = transcriptArtifactMdOutcome;
			}
			stageMap[id] = merged;
			edges[id] = edgeOverrides[id] ?? next ?? "stop";
		}
		return defineWorkflow({ name, start: stages[0] ?? "__missing__", stages: stageMap, edges });
	};

	/** Read the single JSONL state file produced for a run, as parsed objects. */
	const readState = (cwd: string): { header: Record<string, unknown>; stages: Array<Record<string, unknown>> } => {
		const dir = join(cwd, ".rpiv", "workflows", "runs");
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

	it("returns an error result for a workflow whose start stage is not declared", async () => {
		// The post-format-change equivalent of "unknown preset": the caller
		// (command.ts) resolves names to Workflow objects; runWorkflow only
		// sees the object. A workflow with start ∉ stages is the proximal
		// invalid-input case — it short-circuits BEFORE writeHeader so a
		// typo doesn't pollute the audit trail.
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			workflow: { name: "broken", start: "ghost", stages: {}, edges: {} },
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toMatch(/start stage "ghost" is not declared/);
		expect(chain.ctx.spawnChild).not.toHaveBeenCalled();
		expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
	});

	it("rejects an invalid --name before writing any JSONL (defense-in-depth for programmatic callers)", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "x",
			name: "1-bad-start",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/invalid name/);
		expect(chain.ctx.spawnChild).not.toHaveBeenCalled();
		expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
	});

	it("rejects a name already claimed in the index, without starting a session", async () => {
		// The holder must exist on disk — claimName treats an entry whose run
		// file is gone as stale (re-claimable), not as a collision.
		writeHeader(tmpDir, {
			runId: "prior-run",
			workflow: "tiny",
			input: "x",
			ts: "2026-06-11T00:00:00Z",
			name: "auth",
		});
		addNameToIndex(tmpDir, "auth", "prior-run");
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "x",
			name: "auth",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/already used by run prior-run/);
		expect(chain.ctx.spawnChild).not.toHaveBeenCalled();
	});

	it("claims the name in the index and stamps it on the header on a successful run", async () => {
		writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "add dark mode",
			name: "auth",
		});

		expect(result.success).toBe(true);
		// `readState` asserts a single file in runs/ — the named run also drops
		// names.json there, so read the header directly by runId instead.
		expect(readHeader(tmpDir, result.runId!)?.name).toBe("auth");
		expect(readNamesIndex(tmpDir)).toEqual({ auth: result.runId });
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
			runId: expect.stringMatching(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{4}$/),
			success: true,
			stagesCompleted: 1,
			lastArtifact: ".rpiv/artifacts/research/r.md",
			error: undefined,
			termination: { status: "completed" },
		});
		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1);
		expect(chain.sentMessages).toEqual(["/skill:research add dark mode"]);

		const { header, stages } = readState(tmpDir);
		expect(header.workflow).toBe("tiny");
		expect(header.input).toBe("add dark mode");
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({
			stageNumber: 1,
			skill: "research",
			status: "completed",
		});
		expect((stages[0]?.output as { artifacts: Array<{ handle: { path: string } }> }).artifacts[0]?.handle.path).toBe(
			".rpiv/artifacts/research/r.md",
		);
	});

	it("chains the second step by spawning a fresh child — the parent ctx is reused, never swapped", async () => {
		// The runner contract: each fresh stage spawns one child off the SAME
		// parent ctx (no swap, no re-derivation). Two fresh stages ⇒ two
		// spawnChild calls on the parent.
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
		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(2);
		// Step 2's prompt uses the artifact produced by step 1 — not the
		// original user input. This is the artifact-handoff invariant.
		expect(chain.sentMessages).toEqual(["/skill:research x", "/skill:design .rpiv/artifacts/research/r.md"]);
		expect(chain.remaining()).toBe(0);

		const { stages } = readState(tmpDir);
		expect(stages.map((s) => s.status)).toEqual(["completed", "completed"]);
		expect((stages[1]?.output as { artifacts: Array<{ handle: { path: string } }> }).artifacts[0]?.handle.path).toBe(
			".rpiv/artifacts/designs/d.md",
		);
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
		expect(stages[0]?.output).toBeUndefined();
	});

	it("a rejecting spawnChild is recorded as a stage failure — no throw escapes the run", async () => {
		// The detached replacement for the old `{cancelled}` return: a child that
		// rejects (e.g. cancelled before any work) propagates to the single catch
		// site (runStageOrRecordFailure → recordEntryThrow) as a recorded failure
		// row, never an uncaught throw out of runWorkflow.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ cancelled: true }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("tiny", ["research"]),
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.stagesCompleted).toBe(0);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(1);
		expect(stages[0]).toMatchObject({ skill: "research", status: "failed" });
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
			workflow: wf("rip", ["research", "implement"], {
				implement: { loop: fanout({ units: phaseHeadingsFanout }) },
			}),
			input: "x",
		});

		expect(result.success).toBe(true);
		// 1 research + 3 phase rows
		expect(result.stagesCompleted).toBe(4);
		expect(chain.remaining()).toBe(0);
		// The parent ctx spawns every child (no swap): 1 research + 3 phases.
		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(4);
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
		expect(stages[0]).toMatchObject({ stage: "research", skill: "research", status: "completed" });
		// Fanout-unit identity prefix lives on `.stage`; `.skill` carries the raw skill body.
		expect(stages[1]?.stage).toBe("implement (phase 1/3)");
		expect(stages[2]?.stage).toBe("implement (phase 2/3)");
		expect(stages[3]?.stage).toBe("implement (phase 3/3)");
		expect(stages.slice(1).every((s) => s.skill === "implement")).toBe(true);
		expect(stages.slice(1).every((s) => s.status === "completed")).toBe(true);
	});

	it("uses the unit's id in the row's stage decoration when set, falling back to label otherwise", async () => {
		// Mixed-id units: phase 1 has an id, phase 2 does not. The decorated
		// `stage` string should prefer `id` per-unit so post-hoc tooling joins
		// on a stable key when one was supplied.
		const planRelPath = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, planRelPath), "# Plan\n\n## Phase 1: alpha\n## Phase 2: beta\n");

		const mixedIdFanout: FanoutFn = () => [
			{ prompt: `${planRelPath} Phase 1`, label: "phase 1/2", id: "phase-1" },
			{ prompt: `${planRelPath} Phase 2`, label: "phase 2/2" },
		];

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage(`Plan ready: ${planRelPath}`)] },
				{ branch: [mockAssistantMessage("phase 1 done")] },
				{ branch: [mockAssistantMessage("phase 2 done")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("rip", ["research", "implement"], {
				implement: { loop: fanout({ units: mixedIdFanout }) },
			}),
			input: "x",
		});

		expect(result.success).toBe(true);

		const { stages } = readState(tmpDir);
		expect(stages[1]?.stage).toBe("implement (phase-1)");
		expect(stages[2]?.stage).toBe("implement (phase 2/2)");
		expect(stages[1]?.skill).toBe("implement");
		expect(stages[2]?.skill).toBe("implement");
	});

	it("aliased skill stage: .stage carries the record key, .skill carries the overridden skill body", async () => {
		// Regression for the stage/skill field split: previously the JSONL
		// row carried a single `.skill` field that conflated workflow-graph
		// identity (record key) with the Pi skill body. An aliased stage like:
		//   stages: { "implement-after-revise": acts({ skill: "implement" }) }
		// recorded `.skill === "implement"` and silently lost the record key.
		// The row now pins both — record key on `.stage`, skill body on `.skill`.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("Plan ready: .rpiv/artifacts/plans/p.md")] },
				{ branch: [mockAssistantMessage("implement done")] },
			],
		});

		const workflow = defineWorkflow({
			name: "aliased",
			start: "research",
			stages: {
				research: { kind: "produces", sessionPolicy: "fresh", outcome: transcriptArtifactMdOutcome },
				"implement-after-revise": { kind: "side-effect", sessionPolicy: "fresh", skill: "implement" },
			},
			edges: { research: "implement-after-revise", "implement-after-revise": "stop" },
		});

		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv", "artifacts", "plans", "p.md"), "# Plan\n");

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(true);

		const { stages } = readState(tmpDir);
		expect(stages).toHaveLength(2);
		// Common-case stage (non-aliased): record key === skill body, both equal.
		expect(stages[0]?.stage).toBe("research");
		expect(stages[0]?.skill).toBe("research");
		// Aliased stage: record key and skill body diverge — both preserved.
		expect(stages[1]?.stage).toBe("implement-after-revise");
		expect(stages[1]?.skill).toBe("implement");
		// The dispatched message uses the skill body, not the record key.
		expect(chain.sentMessages[1]).toMatch(/^\/skill:implement /);
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
		expect(stages[0]?.output).toBeUndefined();

		// User-visible error notification surfaces the stage-failed verdict.
		// The outcome's fatal message flows through recordTerminalFailure's
		// notifyMsg (MSG_STAGE_FAILED), not the legacy MSG_STAGE_NO_ARTIFACT.
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
			workflow: wf("rip", ["research", "implement"], {
				implement: { loop: fanout({ units: phaseHeadingsFanout }) },
			}),
			input: "x",
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(3); // research + 2 phases
	});

	describe("per-node kind dispatch", () => {
		it("side-effect nodes complete cleanly without producing an artifact (e.g. commit at end of preset)", async () => {
			// `commit` defaults to kind "side-effect" via the dagWith factory.
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

		it("side-effect node mid-chain inherits the prior stage's artifact for downstream stages", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			// research (produces) → commit (side-effect, no artifact) → design (produces).
			// Design must see research's artifact path as its input — commit
			// doesn't reset currentArtifactPath(state) when it produces nothing.
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

		it("override: forcing kind to side-effect via dagWith node overrides skips artifact check", async () => {
			// Same skill that would normally require an artifact (research),
			// but the DAG declares kind "side-effect" — the runner must
			// honor the DAG, not the skill identity.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Question asked, no artifact.")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"], { research: { kind: "side-effect" } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
		});
	});

	// Focused regression for `terminal.script` clearing the rolling primary
	// artifact slot in a [produces, terminal.script, produces] chain. The
	// adjacent `acts.script` test covers the same surface downstream;
	// this pin uses `produces.script` downstream so a future runner refactor
	// that re-introduces inheritance through terminal stages on the produces
	// path trips the test rather than silently feeding stage 3 the wrong
	// upstream handle. Lives next to `per-node kind dispatch` because the
	// invariant is a per-kind concern (terminal.script === side-effect with
	// `inheritsArtifacts: false`).
	describe("terminal.script — artifact isolation regression", () => {
		it("clears the rolling primary slot between two produces.script stages", async () => {
			const upstreamHandle = fsHandle("/tmp/upstream.md");
			let stage3InputKind: string | undefined;
			let stage3InputArtifacts: number | undefined;

			const workflow = defineWorkflow({
				name: "terminal-script-isolation",
				start: "upstream",
				stages: {
					upstream: produces.script({
						run: () => ({
							kind: "artifact",
							artifacts: [{ handle: upstreamHandle, role: "primary" }],
							data: { source: "upstream" },
						}),
					}),
					cleanup: terminal.script({ run: () => {} }),
					verify: produces.script({
						run: (ctx: ScriptContext) => {
							stage3InputKind = ctx.input?.kind;
							stage3InputArtifacts = ctx.input?.artifacts?.length;
							return { kind: "report", artifacts: [], data: { ok: true } };
						},
					}),
				},
				edges: { upstream: "cleanup", cleanup: "verify", verify: "stop" },
			});

			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(3);

			// The downstream produces.script must observe cleanup's row as its
			// upstream Output — NOT the original `upstream` artifact envelope.
			expect(stage3InputKind).toBe("side-effect");
			expect(stage3InputArtifacts).toBe(0);

			// The cleared primary slot is observable only via `ctx.input` and
			// `result.lastArtifact` — `RunView` (T3) doesn't leak the slot itself.

			// Final run.lastArtifact reflects whatever stage 3 produced (nothing
			// here) — confirms terminal.script's clear isn't sticky once a
			// downstream produces stage that actually emits an artifact runs.
			expect(result.lastArtifact).toBeUndefined();
		});
	});

	describe("sessionPolicy: continue", () => {
		it("chains fresh → continue: continue FORKS the predecessor's persisted session (offset re-derived)", async () => {
			// Under detachment a `continue` stage forks its predecessor's persisted
			// child session — carrying the prior transcript as context — instead of
			// running fresh (the prior-session lineage survives detachment via
			// SessionManager.forkFrom; OQ1 resolved). Stage 1's recorded
			// SessionRef.file must point at a REAL file so `locateSessionFile`
			// resolves it; stage 2 then spawns with `fork:{sessionFile}`, sends its
			// turn via sendUserMessage (NOT a host prompt replay), and re-derives the
			// branch offset from the forked branch (never the launcher's).
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			const s1File = join(tmpDir, "s1-session.jsonl");
			writeFileSync(s1File, `${JSON.stringify({ type: "session", id: "s1" })}\n`);

			// Stage 2's forked child starts as the inherited prior transcript; the
			// continuation turn (carrying the artifact) is appended when the body
			// sends it — exactly as a real sendUserMessage grows the branch.
			const forkBranch: unknown[] = [mockAssistantMessage("earlier research discussion")];
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")], sessionFile: s1File },
					{ branch: forkBranch },
				],
			});
			chain.sendUserMessageFn.mockImplementation(async (content: unknown) => {
				chain.sentMessages.push(String(content));
				forkBranch.push(mockAssistantMessage("Designed .rpiv/artifacts/designs/d.md"));
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("fc", ["research", "design"], { design: { sessionPolicy: "continue" } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
			expect(result.lastArtifact).toBe(".rpiv/artifacts/designs/d.md");
			expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(2);

			// Stage 2 FORKED stage 1's persisted session — not a fresh child, not an
			// in-place reattach.
			const secondSpawn = (chain.ctx.spawnChild as ReturnType<typeof vi.fn>).mock.calls[1]![0];
			expect(secondSpawn.fork).toEqual({ sessionFile: s1File });
			expect(secondSpawn.reattach).toBeUndefined();

			// Stage 1's prompt was host-sent; stage 2's continuation was body-sent
			// (sendUserMessage) — yet the handoff arg still consumes stage 1's artifact.
			expect(chain.sentMessages).toEqual(["/skill:research x", "/skill:design .rpiv/artifacts/research/r.md"]);

			// The continue row records the offset re-derived from the forked branch
			// (1 inherited prior entry), proving the outcome skipped the prefix.
			const { stages } = readState(tmpDir);
			expect(stages[1]).toMatchObject({ skill: "design", status: "completed" });
			expect((stages[1]!.session as { branchOffset?: number }).branchOffset).toBe(1);
		});

		it("continue with no prior session degrades to a fresh dispatch with a fallback notice", async () => {
			// A `continue` stage at the START has no predecessor to fork — it degrades
			// to a fresh dispatch (no `fork`/`reattach`, host-sent prompt) and emits a
			// one-line fallback notice rather than refusing.
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cstart", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
			const spawn = (chain.ctx.spawnChild as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			expect(spawn.fork).toBeUndefined();
			expect(spawn.reattach).toBeUndefined();
			expect(chain.sentMessages).toEqual(["/skill:research x"]); // host-sent (fresh path)
			expect(chain.notifications.some((n) => /no prior session to continue/.test(n.msg))).toBe(true);
		});

		it("continue stage abort halts the chain", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("interrupted", "aborted")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
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
				steps: [{ branch: [] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe("research produced no assistant message");
			expect(result.stagesCompleted).toBe(0);
		});

		it("continue stage with no artifact (requireArtifact) fails", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("I asked a clarifying question")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["research"], { research: { sessionPolicy: "continue" } }),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/without producing/i);
			expect(result.stagesCompleted).toBe(0);
		});

		it("continue stage with side-effect stop strategy completes without artifact", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Committed 3 files.")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("cont", ["commit"], { commit: { sessionPolicy: "continue" } }),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
			expect(result.lastArtifact).toBeUndefined();
		});

		// Invariant throws used to escape runWorkflow uncaught, leaving a
		// header-only JSONL file invisible to every shape-filtered reader.
		// runStageOrRecordFailure now translates them into a recorded failure row
		// + a populated error envelope, so the result describes the failure
		// rather than the caller having to catch a stack trace.
		it("records a failure row when fanout node has sessionPolicy continue (no throw escapes)", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi().pi,
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("ic", ["implement"], {
					implement: { sessionPolicy: "continue", loop: fanout({ units: phaseHeadingsFanout }) },
				}),
				input: "x",
				host: chain.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/cannot combine loop with sessionPolicy.*continue/);

			// JSONL now carries a row attributed to the failing stage —
			// no orphan header-only file.
			const { stages } = readState(tmpDir);
			const failedRows = stages.filter((s) => s.status === "failed");
			expect(failedRows).toHaveLength(1);
			expect(failedRows[0]?.skill).toBe("implement");
		});

		// -------------------------------------------------------------------
		// When a mid-chain stage throws (here: stage 2 hits the
		// continue-without-pi invariant), the recorded failure must be
		// attributed to the *failing* stage, not to the prior stage whose
		// success triggered advanceChain. Before runStageOrRecordFailure, the
		// advanceChain catch recorded `skill: currentName` (the prior, already-
		// completed stage), producing two rows for stage 1 (completed +
		// failed) and zero rows for stage 2.
		// -------------------------------------------------------------------
		it("attributes a mid-chain runStage throw to the failing stage, not to the prior one", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const mockPi = createMockPi({ skills: ["research", "implement"] });
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
				pi: mockPi.pi,
			});

			// research succeeds (fresh policy). implement opts into fanout and
			// uses sessionPolicy: continue — a separate invariant (fanout can't
			// combine with continue) that throws inside enforceSessionInvariants
			// when stage 2 is invoked. pi is provided so the preflight (which
			// gates only on missing pi) lets the run reach the mid-chain throw.
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("midthrow", ["research", "implement"], {
					implement: { sessionPolicy: "continue", loop: fanout({ units: phaseHeadingsFanout }) },
				}),
				input: "x",
				host: mockPi.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/cannot combine loop with sessionPolicy.*continue/);

			const { stages } = readState(tmpDir);
			const completedRows = stages.filter((s) => s.status === "completed");
			const failedRows = stages.filter((s) => s.status === "failed");

			// Stage 1 completed and was recorded once. Stage 2 failed and was
			// recorded once, keyed by ITS OWN skill name — not by "research".
			expect(completedRows).toHaveLength(1);
			expect(completedRows[0]?.skill).toBe("research");
			expect(failedRows).toHaveLength(1);
			expect(failedRows[0]?.skill).toBe("implement");
		});

		it("a detached continue child sees no prior-stage artifact (no false positive)", async () => {
			// In the detached model the continue stage runs in its OWN child — its
			// branch never contains the prior stage's artifact announcement, so a
			// continue stage that produces no artifact of its own fails cleanly (no
			// false positive from the fresh stage's prior `.md`).
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("I analyzed the design but didn't write a plan")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("fc", ["research", "design"], { design: { sessionPolicy: "continue" } }),
				input: "x",
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

	describe("input validation", () => {
		it("halts chain when prior output fails consumer's inputSchema", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			// Stage 1 (research) produces an artifact. Stage 2 (design) has an
			// inputSchema that rejects the output data from stage 1.
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

		it("passes when output data satisfies the consumer's inputSchema", async () => {
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
		});

		// inputSchema mirrors outputSchema's async-safety posture: an async
		// schema whose Promise never settles must halt the stage within the
		// configured budget rather than hang the preflight pipeline.
		it("halts when an async inputSchema's Promise never settles within validateTimeoutMs", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const hangingSchema: StageSchema<unknown, unknown> = {
				"~standard": {
					version: 1,
					vendor: "test-async",
					validate: () => new Promise<never>(() => {}),
				},
			};

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], {
					design: { inputSchema: hangingSchema, validateTimeoutMs: 1_000 },
				}),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/inputSchema validation exceeded 1000ms/);
			const { stages } = readState(tmpDir);
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });
		}, 5_000);
	});

	describe("contract input validation (ensureContractInputValid)", () => {
		it("halts chain when upstream output fails declared consumes.data contract", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			// Register a declared contract: design consumes { requiredField: string }
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: {
							data: {
								type: "object",
								properties: { requiredField: { type: "string" } },
								required: ["requiredField"],
							},
						},
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			// design has NO inputSchema — contract mirror should catch the violation
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			expect(result.success).toBe(false);
			expect(result.stagesCompleted).toBe(1); // research completed
			expect(result.error).toMatch(/input validation failed/i);
			expect(result.error).toMatch(/design/); // consumer

			const { stages } = readState(tmpDir);
			expect(stages[0]).toMatchObject({ skill: "research", status: "completed" });
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });
		});

		it("passes when upstream output satisfies the declared consumes.data contract", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nrequiredField: hello\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: {
							data: {
								type: "object",
								properties: { requiredField: { type: "string" } },
								required: ["requiredField"],
							},
						},
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("degrades (no halt) when no declared contract exists", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			// No registerSkillContracts — no contract to validate against

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("degrades (no halt) when consumes.data is a non-object (malformed contract)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: { data: "not-a-schema" as unknown as Record<string, unknown> },
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			// Malformed contract — degrade, not halt
			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("skips contract check when stage has its own inputSchema (no double validation)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			// Register a contract that would fail, but the stage also has an inputSchema
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: {
							data: {
								type: "object",
								properties: { neverPresent: { type: "string" } },
								required: ["neverPresent"],
							},
						},
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			// inputSchema that also rejects — the inputSchema path (ensureInputValid) should fire,
			// NOT the contract mirror
			const schema = typeboxSchema(Type.Object({ mustExist: Type.String() }));
			await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], { design: { inputSchema: schema } }),
				input: "x",
			});

			const { stages } = readState(tmpDir);
			expect(stages[1]).toMatchObject({ skill: "design", status: "failed" });
		});

		it("degrades when no consumes.data on the contract", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						// No consumes.data — contract check degrades
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/designs/d.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		it("skips contract check when stage reads from named channels (reads:)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: {
							data: {
								type: "object",
								properties: { neverPresent: { type: "string" } },
								required: ["neverPresent"],
							},
						},
					},
				],
			]);

			// The stage reads from named channels — its input comes from state.named,
			// NOT the linear output.data, so the contract check must skip.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], {
					design: { reads: ["priorOutput"] },
				}),
				input: "x",
			});

			// reads: stage should skip the contract check entirely
			// (it will fail on ensureNamedReads, which is fine — we just need
			// to verify the contract check didn't halt it)
			expect(result.success).toBe(false);
			expect(result.error).not.toMatch(/input validation failed.*consumes\.data/i);
		});

		it("skips contract check for prompt-dispatch stages", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nfoo: 1\n---\n\nContent");
			registerSkillContracts([
				[
					"design",
					{
						source: "declared",
						consumes: {
							data: {
								type: "object",
								properties: { neverPresent: { type: "string" } },
								required: ["neverPresent"],
							},
						},
					},
				],
			]);

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Done")] },
				],
			});

			// prompt stage — side-effect kind, no outcome; should skip contract check
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"], {
					design: { kind: "side-effect", prompt: "Just do it" },
				}),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
		});

		describe("named-channel (reads) compatibility", () => {
			const kindComparator: CompositionComparator = (produces, consumes, ch) => {
				const want = (consumes.reads?.[ch]?.meta as { artifactKind?: string } | undefined)?.artifactKind;
				const got = (produces.meta as { artifactKind?: string } | undefined)?.artifactKind;
				return !want || !got || want === got ? { ok: true } : { ok: false, reason: "artifactKind mismatch" };
			};
			const plansOutcome = { ...transcriptArtifactMdOutcome, name: "plans" };
			const registerKinds = (producerKind: string, consumerKind: string) =>
				registerSkillContracts([
					[
						"research",
						{ source: "declared", produces: { kind: "produces", meta: { artifactKind: producerKind } } },
					],
					[
						"revise",
						{ source: "declared", consumes: { reads: { plans: { meta: { artifactKind: consumerKind } } } } },
					],
				]);
			const readsWf = () =>
				wf("two", ["research", "revise"], { research: { outcome: plansOutcome }, revise: { reads: ["plans"] } });

			// Reads validity is a complete LOAD-TIME guarantee (`checkReadsChannelCompat`);
			// the runner does NOT adjudicate reads. This locks that decision: even a
			// disjoint channel with a registered comparator runs to completion at runtime.
			it("does NOT halt at runtime on a disjoint reads channel — reads validity is load-time", async () => {
				writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nstatus: ready\n---\n");
				writeArtifact(tmpDir, ".rpiv/artifacts/plans/p.md", "---\nstatus: ready\n---\n");
				registerCompositionComparator("plans", kindComparator);
				registerKinds("design", "plan"); // disjoint at the channel — yet must not halt the run
				const chain = createMockSessionChain({
					cwd: tmpDir,
					steps: [
						{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
						{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/plans/p.md")] },
					],
				});
				const result = await runWorkflow(chain.ctx, { workflow: readsWf(), input: "x" });
				expect(result.success).toBe(true);
				expect(result.stagesCompleted).toBe(2);
			});

			// Regression for the reads-guard gap in `ensureContractInputValid`: a
			// `reads:` stage that ALSO declares `consumes.data` must NOT validate the
			// rolling primary (`output.data`) against that contract — its input comes
			// from `state.named`, not the primary. The named read here is SATISFIED
			// (research publishes "plans"), so the run reaches POST_PROMPT_CHECKS;
			// without the guard, ensureContractInputValid would validate research's
			// {status:"ready"} against revise's `requiredField`-requiring schema and
			// HALT. The guard skips it, so the run completes.
			it("skips consumes.data validation for a reads: stage even when the named read is satisfied", async () => {
				writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "---\nstatus: ready\n---\n");
				writeArtifact(tmpDir, ".rpiv/artifacts/plans/p.md", "---\nstatus: ready\n---\n");
				registerSkillContracts([
					["research", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "plan" } } }],
					[
						"revise",
						{
							source: "declared",
							consumes: {
								reads: { plans: {} },
								// A linear contract that the rolling primary {status:"ready"} does NOT satisfy —
								// would HALT if (incorrectly) adjudicated against the primary.
								data: {
									type: "object",
									properties: { requiredField: { type: "string" } },
									required: ["requiredField"],
								},
							},
						},
					],
				]);
				const chain = createMockSessionChain({
					cwd: tmpDir,
					steps: [
						{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
						{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/plans/p.md")] },
					],
				});
				// Without the reads guard this HALTS (success=false) on a consumes.data
				// mismatch; the guard lets the run complete.
				const result = await runWorkflow(chain.ctx, { workflow: readsWf(), input: "x" });
				expect(result.success).toBe(true);
				expect(result.stagesCompleted).toBe(2);
			});
		});
	});

	describe("predicate routing", () => {
		it("routes to commit when severeIssueCount is 0 (no severe issues)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\nsevereIssueCount: 0\n---\n\nContent");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/code-review/cr.md")] },
					// commit (side-effect)
					{ branch: [mockAssistantMessage("Committed.")] },
				],
			});

			const workflow = wf(
				"flow",
				["research", "code-review", "revise", "commit"],
				{},
				{
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				},
			);

			await runWorkflow(chain.ctx, { workflow, input: "x" });

			const dir = join(tmpDir, ".rpiv", "workflows", "runs");
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
				fromStageIndex: 2, // code-review is stage 2
				fromStage: "code-review",
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				},
			);

			await runWorkflow(chain.ctx, { workflow, input: "x" });

			const dir = join(tmpDir, ".rpiv", "workflows", "runs");
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
			expect(result.success).toBe(true);
			// Happy path: no dropped rows means the envelope omits the field.
			// Consumers checking `result.droppedRoutingRows?.length` see undefined,
			// not an empty array — keeps the absent-vs-present distinction crisp.
			expect(result.droppedRoutingRows).toBeUndefined();

			// Find the runId from the JSONL file
			const dir = join(tmpDir, ".rpiv", "workflows", "runs");
			const files = readdirSync(dir);
			const runId = files[0]!.replace(".jsonl", "");

			const routingDecisions = readRoutingDecisions(tmpDir, runId);
			expect(routingDecisions).toHaveLength(1);
			expect(routingDecisions[0]).toMatchObject({
				type: "routing",
				fromStage: "code-review",
				decision: "commit",
			});
			// Matched branch (eq(0) hit) — no fallback, so no note (C12).
			expect(routingDecisions[0]!.note).toBeUndefined();
		});

		it("routing row carries gate's fallback note when no branch matched (C12)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			// No severeIssueCount in the frontmatter → Number(undefined) = NaN →
			// no branch matches → gate takes `otherwise` and attaches the note.
			writeArtifact(tmpDir, ".rpiv/artifacts/code-review/cr.md", "---\ntitle: review\n---\n\nContent");
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
			expect(result.success).toBe(true);

			const dir = join(tmpDir, ".rpiv", "workflows", "runs");
			const runId = readdirSync(dir)[0]!.replace(".jsonl", "");
			const routingDecisions = readRoutingDecisions(tmpDir, runId);
			expect(routingDecisions).toHaveLength(1);
			expect(routingDecisions[0]).toMatchObject({ decision: "commit" });
			expect(routingDecisions[0]!.note).toMatch(/no branch matched value NaN.*"commit"/);
		});

		// -------------------------------------------------------------------
		// Routing-write failure is fail-soft (run continues) but MUST be
		// observable: appendRoutingDecision returns false so the
		// runner can notify + surface a droppedRoutingRows entry in the
		// envelope. Asymmetric with appendStage (which halts on failure)
		// because routing rows are pure telemetry — no in-memory state
		// mirrors them, so halting would discard a correct in-memory
		// decision to recover from transient disk weather.
		// -------------------------------------------------------------------
		it("appendRoutingDecision returns false when the JSONL write cannot land", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				// `/dev/null/...` cannot host a directory — mkdirSync throws ENOTDIR,
				// the catch fires, the function returns false. Same trick the
				// recordStage failure test uses.
				const wrote = appendRoutingDecision("/dev/null/impossible", "run-1", {
					type: "routing",
					fromStageIndex: 1,
					fromStage: "code-review",
					decision: "commit",
					ts: "2026-05-23T00:00:00Z",
				});
				expect(wrote).toBe(false);
				expect(warnSpy).toHaveBeenCalled();
			} finally {
				warnSpy.mockRestore();
			}
		});

		it("appendRoutingDecision returns true on a successful write", () => {
			const wrote = appendRoutingDecision(tmpDir, "run-1", {
				type: "routing",
				fromStageIndex: 1,
				fromStage: "code-review",
				decision: "commit",
				ts: "2026-05-23T00:00:00Z",
			});
			expect(wrote).toBe(true);
			const rows = readRoutingDecisions(tmpDir, "run-1");
			expect(rows).toHaveLength(1);
		});
	});

	describe("backward-jump cycle guard", () => {
		it("halts the chain when decision-edge retries exceed MAX_BACKWARD_JUMPS", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a3.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b3.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a3.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b3.md")] },
				],
			});

			// b → a via a decision-edge predicate (always picks "a"). `c` is
			// declared but unreachable — exercised to confirm the runner halts
			// via the backward-jump guard, not via running into `c`. Decision-edge
			// (vs deterministic literal) so the new semantic counts the retry.
			const workflow = wf(
				"cycle",
				["a", "b", "c"],
				{},
				{ b: defineRoute(["a", "c"], () => "a", { readsData: false }) },
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.error).toMatch(/3.*max 2/);
			// Per-decision counting: each b→a is one decision retry. With cap=2:
			// pass 1 (a→b, no retry yet) → b→a (retry 1) → pass 2 → b→a (retry 2) →
			// pass 3 → b→a (retry 3 > 2) HALT before re-entering a.
			// 6 stages completed: a, b, a, b, a, b. Trip fires at b's 3rd
			// decision attempting to revisit a.
			expect(result.stagesCompleted).toBe(6);
			expect(chain.remaining()).toBe(0);

			const { stages } = readState(tmpDir);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			// 6 completed + 1 failed row.
			expect(stageRows).toHaveLength(7);
			expect(stageRows.filter((s) => s.status === "completed")).toHaveLength(6);
			expect(stageRows.filter((s) => s.status === "failed")).toHaveLength(1);
			// Trip attribution: failure row blames `a` (the would-be revisit
			// target), not `b` (the just-completed stage).
			expect(stageRows.filter((s) => s.status === "failed")[0]?.skill).toBe("a");

			const exhaustionNotice = chain.notifications.find((n) => /backward-jump limit exceeded/i.test(n.msg));
			expect(exhaustionNotice?.level).toBe("error");
		});

		it("allows decision-edge retries within limit before halting on next exceedance", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b2.md")] },
				],
			});

			const workflow = wf(
				"cycle",
				["a", "b", "c"],
				{},
				{ b: defineRoute(["a", "c"], () => "a", { readsData: false }) },
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			// cap=1: pass 1 (a→b) → b→a (retry 1, allowed) → pass 2 (a→b) →
			// b→a (retry 2 > 1) HALT before re-entering a.
			// 4 stages: a, b, a, b completed.
			expect(result.stagesCompleted).toBe(4);
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
					"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
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
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b2.md")] },
				],
			});

			const workflow = wf(
				"cycle",
				["a", "b", "c"],
				{},
				{ b: defineRoute(["a", "c"], () => "a", { readsData: false }) },
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.error).toMatch(/2.*max 1/);
			// cap=1: 4 stages (a, b, a, b) before the 2nd b→a decision trips.
			expect(result.stagesCompleted).toBe(4);
		});

		it("counts a decision self-edge as backward-jump from the first hop", async () => {
			// A self-loop authored as a *decision* predicate (a → a or stop). The
			// `visited.add(currentName)` at the top of advanceChain happens BEFORE
			// the backward-jump check, so the very first decision-to-self counts.
			// cap=1 → exactly two executions of `a` before the guard halts.
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
				],
			});

			const workflow = wf(
				"self-loop",
				["a"],
				{},
				{ a: defineRoute(["a", "stop"], () => "a", { readsData: false }) },
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			expect(result.stagesCompleted).toBe(2);
		});

		it("records a failure row on backward-jump exhaustion (co-extensive with state.termination.error)", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
				],
			});

			const workflow = wf(
				"cycle",
				["a", "b", "c"],
				{},
				{ b: defineRoute(["a", "c"], () => "a", { readsData: false }) },
			);

			await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 0 });

			// 2 completed stages (a, b) + 1 status:"failed" row marking where the
			// guard halted the chain. Each row carries its own stageNumber — no
			// stageNumber is reused, no completed row is rewritten in place.
			// Filter on `stageNumber` to skip routing-decision rows.
			const { stages } = readState(tmpDir);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			expect(stageRows).toHaveLength(3);
			expect(stageRows.filter((s) => s.status === "completed")).toHaveLength(2);
			expect(stageRows.filter((s) => s.status === "failed")).toHaveLength(1);
			const stageNumbers = stageRows.map((s) => s.stageNumber).sort((a, b) => (a as number) - (b as number));
			expect(stageNumbers).toEqual([1, 2, 3]);
		});

		// -------------------------------------------------------------------
		// The core fix: an N-node decision-mediated loop must allow
		// MAX_BACKWARD_JUMPS retry iterations, not trip mid-iteration on the
		// deterministic hops within the cycle body. Previously a 3-node loop
		// burned the budget on two deterministic forward hops INSIDE the
		// first retry; now only the decision edge counts.
		// -------------------------------------------------------------------
		it("counts decisions only — deterministic hops through a 3-node cycle don't drain the budget", async () => {
			// 3-node loop: a → b → c → (decide: a or stop). With cap=1, two
			// full passes complete (initial + 1 retry); 3rd decision trips.
			// Under the OLD per-hop semantic, the 2nd pass's a→b deterministic
			// hop would have ticked the counter to 2 (>cap=1) mid-iteration,
			// halting the run with only 4 stages completed instead of 6.
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/c/c1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/a/a2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/b/b2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/c/c2.md");

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/c/c1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/a/a2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/b/b2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/c/c2.md")] },
				],
			});

			const workflow = wf(
				"3loop",
				["a", "b", "c"],
				{},
				{ c: defineRoute(["a", "stop"], () => "a", { readsData: false }) },
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/backward-jump limit exceeded/i);
			// 6 stages: a,b,c,a,b,c. Then c's 3rd decision (retry 2 > cap=1) trips.
			expect(result.stagesCompleted).toBe(6);
		});

		it("resets the counter when a decision escapes the current loop", async () => {
			// Two sequential decision loops: A↔B then C↔D, joined by a
			// decision-edge escape from B → C. Each loop should get its own
			// retry budget; without the escape-reset, loop 2's first retry
			// would inherit loop 1's exhausted counter and trip immediately.
			writeArtifact(tmpDir, ".rpiv/artifacts/A/A1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/B/B1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/A/A2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/B/B2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/C/C1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/D/D1.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/C/C2.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/D/D2.md");

			let bDecisionCount = 0;
			let dDecisionCount = 0;
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/A/A1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/B/B1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/A/A2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/B/B2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/C/C1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/D/D1.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/C/C2.md")] },
					{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/D/D2.md")] },
				],
			});

			const workflow = wf(
				"twoloops",
				["A", "B", "C", "D"],
				{},
				{
					// B → A twice, then B → C (escape to loop 2)
					B: defineRoute(["A", "C"], () => {
						bDecisionCount++;
						return bDecisionCount <= 1 ? "A" : "C";
					}),
					// D → C twice, then D → stop. With cap=1 and NO reset, this
					// trips on the first D→C because B's prior retry already
					// burned the budget.
					D: defineRoute(["C", "stop"], () => {
						dDecisionCount++;
						return dDecisionCount <= 1 ? "C" : "stop";
					}),
				},
			);

			const result = await runWorkflow(chain.ctx, { workflow, input: "x", maxBackwardJumps: 1 });

			// Loop 1: A → B (decide A, retry 1) → A → B (decide C, escape — counter resets to 0)
			// Loop 2: C → D (decide C, retry 1 — counter started at 0, so within cap) → C → D (decide stop)
			// All 8 stages complete; run succeeds. Without reset, loop 2's
			// first retry would be retry 2 > cap=1 → trip.
			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(8);
		});
	});

	// -----------------------------------------------------------------------
	// The workflow runner emits `/skill:<name>` via sendUserMessage, which
	// goes through `prompt({expandPromptTemplates: false})` — Pi's built-in
	// `_expandSkillCommand` is skipped, so `rpiv-args` is the only expander.
	// If the skill isn't registered, `rpiv-args` returns `{action:"continue"}`
	// and the raw text reaches the LLM as a bare imperative outside the
	// `<skill>...</skill>` contract. ensureSkillRegistered catches this at
	// the dispatch seam, halting the stage cleanly with attribution + a
	// MSG_SKILL_NOT_REGISTERED notification.
	// -----------------------------------------------------------------------
	describe("skill-registry pre-dispatch check", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-skill-registry-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("halts the stage when stage.skill is not in pi.getCommands()", async () => {
			// pi registers "research" but the workflow tries to invoke "typo".
			// Without the check, "/skill:typo x" would dispatch via
			// sendUserMessage and leak to the LLM verbatim.
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [],
				pi: createMockPi({ skills: ["research"] }).pi,
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("typo-wf", ["typo"]),
				input: "x",
				host: chain.pi,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/Pi skill "typo".*no skill by that name is registered/);
			expect(result.stagesCompleted).toBe(0);

			// Critically: no /skill:typo text reached sendUserMessage. The
			// halt fired BEFORE dispatch, so the LLM never sees the raw text.
			expect(chain.sentMessages).toEqual([]);
			expect(chain.pi!.sendUserMessage).not.toHaveBeenCalled();

			// JSONL row attributed to the failing stage's skill.
			const { stages } = readState(tmpDir);
			const stageRows = stages.filter((s) => typeof s.stageNumber === "number");
			expect(stageRows).toHaveLength(1);
			expect(stageRows[0]?.skill).toBe("typo");
			expect(stageRows[0]?.status).toBe("failed");

			// User-facing notification carries the right error class.
			const notice = chain.notifications.find((n) => /not a registered Pi skill/i.test(n.msg));
			expect(notice?.level).toBe("error");
		});

		it("passes when pi recognizes the skill", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
				pi: createMockPi({ skills: ["research"] }).pi,
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("ok-wf", ["research"]),
				input: "x",
				host: chain.pi,
			});

			expect(result.success).toBe(true);
		});

		it("snapshots the skill registry once at workflow start (host.getCommands not called per-stage)", async () => {
			// Regression: pre-fix, ensureSkillRegistered called host.getCommands()
			// for every downstream stage's preflight. Pi marks the host handle
			// stale once the first child session opens, so the second call threw
			// "extension ctx is stale" — a research → blueprint chain halted on
			// stage 2 with no toast (the throw was caught by
			// runStageOrRecordFailure and the user-visible error never surfaced).
			//
			// Post-fix, runWorkflow snapshots the registry ONCE before any
			// session opens and ensureSkillRegistered consults the snapshot.
			// This test simulates Pi's stale-ctx behavior by making getCommands
			// throw on every call after the first, then asserts the workflow
			// completes both stages and getCommands was invoked exactly once.
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			writeArtifact(tmpDir, ".rpiv/artifacts/designs/d.md");

			const mockPi = createMockPi({ skills: ["research", "design"] });
			const getCommandsSpy = mockPi.pi.getCommands as unknown as ReturnType<typeof vi.fn> &
				(() => ReturnType<typeof mockPi.pi.getCommands>);
			// Capture the default-mocked return value before installing the
			// throwing implementation — calling the spy first counts as a
			// non-runner invocation, so we reset its call history afterwards.
			const firstResult = getCommandsSpy();
			getCommandsSpy.mockReset();
			let callCount = 0;
			getCommandsSpy.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return firstResult;
				throw new Error("This extension ctx is stale after session replacement or reload.");
			});

			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("step 1 → .rpiv/artifacts/research/r.md")] },
					{ branch: [mockAssistantMessage("step 2 → .rpiv/artifacts/designs/d.md")] },
				],
				pi: mockPi.pi,
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
				host: chain.pi,
			});

			// Both stages completed — the stale-host throw never fired because
			// getCommands was called exactly once, at workflow start.
			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
			expect(getCommandsSpy).toHaveBeenCalledTimes(1);

			// Both stages landed completed rows; neither carries the stale-ctx
			// errMsg (which would be present if the snapshot regressed).
			const { stages } = readState(tmpDir);
			expect(stages.map((s) => s.status)).toEqual(["completed", "completed"]);
			expect(stages.some((s) => /stale/.test(String(s.errMsg ?? "")))).toBe(false);
		});

		it("a throwing outcome snapshot warns ONCE per run and the stages still complete (C19)", async () => {
			// Pre-fix the bare `catch {}` silently disabled diffing for the whole
			// run with zero diagnostics. The stage must still run (snapshot is
			// best-effort) but the FIRST failure surfaces a warning.
			const throwingSnapshotOutcome: Outcome = {
				collector: {
					snapshot: () => {
						throw new Error("custom snapshot bug");
					},
					collect: () => ({ kind: "ok", artifacts: [{ handle: fsHandle("out.md"), role: "primary" }] }),
				},
			};
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("one")] }, { branch: [mockAssistantMessage("two")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("snap", ["research", "design"], {
					research: { outcome: throwingSnapshotOutcome },
					design: { outcome: throwingSnapshotOutcome },
				}),
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(2);
			const warns = chain.notifications.filter(
				(n) => n.level === "warning" && /outcome snapshot for research threw/.test(n.msg),
			);
			expect(warns).toHaveLength(1);
			expect(warns[0]?.msg).toContain("custom snapshot bug");
			// Second stage's identical failure stays silent — one warning per run.
			expect(chain.notifications.filter((n) => /outcome snapshot/.test(n.msg))).toHaveLength(1);
		});

		it("skips the check when pi is not provided (no registry to consult)", async () => {
			// Pi-less programmatic invocation opts out of this defense layer —
			// same fail-soft posture the rest of the pi-optional surface uses.
			// Run still proceeds; the dispatch-time behavior is whatever the
			// caller's environment provides.
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("nopi-wf", ["research"]),
				input: "x",
				// No pi provided
			});

			// Run completes — the check was skipped because run.pi is undefined.
			expect(result.success).toBe(true);
		});
	});

	// =======================================================================
	// Lifecycle callbacks — per-call `options.lifecycle`
	// =======================================================================

	describe("lifecycle callbacks", () => {
		/** Capture every fired event in order. Each entry: [eventName, ...payload]. */
		const recorder = () => {
			const calls: Array<[string, unknown[]]> = [];
			const lifecycle = {
				onWorkflowStart: (ctx: unknown) => void calls.push(["onWorkflowStart", [ctx]]),
				onStageStart: (stage: unknown, ctx: unknown) => void calls.push(["onStageStart", [stage, ctx]]),
				onStageEnd: (stage: unknown, output: unknown, ctx: unknown) =>
					void calls.push(["onStageEnd", [stage, output, ctx]]),
				onStageRetry: (stage: unknown, attempt: unknown, ctx: unknown) =>
					void calls.push(["onStageRetry", [stage, attempt, ctx]]),
				onStageError: (stage: unknown, error: unknown, ctx: unknown) =>
					void calls.push(["onStageError", [stage, error, ctx]]),
				onRoute: (from: unknown, to: unknown, ctx: unknown) => void calls.push(["onRoute", [from, to, ctx]]),
				onLoopStart: (stage: unknown, info: unknown, ctx: unknown) =>
					void calls.push(["onLoopStart", [stage, info, ctx]]),
				onUnitStart: (stage: unknown, unit: unknown, ctx: unknown) =>
					void calls.push(["onUnitStart", [stage, unit, ctx]]),
				onUnitEnd: (stage: unknown, unit: unknown, output: unknown, ctx: unknown) =>
					void calls.push(["onUnitEnd", [stage, unit, output, ctx]]),
				onWorkflowEnd: (result: unknown, ctx: unknown) => void calls.push(["onWorkflowEnd", [result, ctx]]),
			};
			return { calls, lifecycle };
		};
		const names = (calls: Array<[string, unknown[]]>) => calls.map(([n]) => n);

		it("onWorkflowStart fires once before first stage; ctx carries correct identity", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const { calls, lifecycle } = recorder();
			const result = await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			expect(result.success).toBe(true);
			const starts = calls.filter(([n]) => n === "onWorkflowStart");
			expect(starts).toHaveLength(1);
			const ctx = starts[0]![1][0] as { cwd: string; runId: string; workflow: string; totalStages: number };
			expect(ctx.cwd).toBe(tmpDir);
			expect(ctx.runId).toBe(result.runId);
			expect(ctx.workflow).toBe("tiny");
			expect(ctx.totalStages).toBe(1);
			// onWorkflowStart must precede onStageStart.
			expect(names(calls).indexOf("onWorkflowStart")).toBeLessThan(names(calls).indexOf("onStageStart"));
		});

		it("onStageStart fires once per stage with a StageRef matching name + number + skill", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage(`Plan: ${".rpiv/artifacts/research/r.md"}`)] },
					{ branch: [mockAssistantMessage("done")] },
				],
			});
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const { calls, lifecycle } = recorder();
			await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
				lifecycle,
			});
			const starts = calls.filter(([n]) => n === "onStageStart");
			expect(starts).toHaveLength(2);
			expect(starts[0]![1][0]).toMatchObject({ kind: "skill", name: "research", stageNumber: 1, skill: "research" });
			expect(starts[1]![1][0]).toMatchObject({ kind: "skill", name: "design", stageNumber: 2, skill: "design" });
		});

		it("onStageEnd fires only on success and carries the validated Output", async () => {
			const planRel = ".rpiv/artifacts/research/r.md";
			writeArtifact(tmpDir, planRel, "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage(`Plan: ${planRel}`)] }],
			});
			const { calls, lifecycle } = recorder();
			await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			const ends = calls.filter(([n]) => n === "onStageEnd");
			expect(ends).toHaveLength(1);
			const [stage, output] = ends[0]![1] as [{ name: string }, { artifacts: unknown[] }];
			expect(stage.name).toBe("research");
			expect(output.artifacts.length).toBe(1);
		});

		it("onStageError fires on terminal failure (aborted stop); onStageEnd does NOT fire", async () => {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("partial", "aborted")] }],
			});
			const { calls, lifecycle } = recorder();
			const result = await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			expect(result.success).toBe(false);
			expect(calls.filter(([n]) => n === "onStageError")).toHaveLength(1);
			expect(calls.filter(([n]) => n === "onStageEnd")).toHaveLength(0);
			const [stage, error] = calls.find(([n]) => n === "onStageError")![1] as [{ name: string }, string];
			expect(stage.name).toBe("research");
			expect(error).toMatch(/aborted/i);
		});

		it("onRoute fires after the routing decision; `to` is the next stage name (or 'stop')", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const { calls, lifecycle } = recorder();
			await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			const routes = calls.filter(([n]) => n === "onRoute");
			expect(routes).toHaveLength(1);
			const [from, to] = routes[0]![1] as [{ name: string }, string];
			expect(from.name).toBe("research");
			expect(to).toBe("stop");
		});

		it("onLoopStart + onUnitStart/End fire in correct order for a 3-unit fanout loop", async () => {
			const planRel = ".rpiv/artifacts/plans/p.md";
			writeArtifact(tmpDir, planRel, "# Plan\n## Phase 1:\n## Phase 2:\n## Phase 3:\n");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage(`Plan: ${planRel}`)] },
					{ branch: [mockAssistantMessage("phase 1")] },
					{ branch: [mockAssistantMessage("phase 2")] },
					{ branch: [mockAssistantMessage("phase 3")] },
				],
			});
			const phaseFanout: FanoutFn = ({ artifact, cwd }) => {
				if (artifact?.handle.kind !== "fs") return [];
				const abs = artifact.handle.path.startsWith("/") ? artifact.handle.path : join(cwd, artifact.handle.path);
				const matches = [...readFileSync(abs, "utf-8").matchAll(/^## Phase (\d+):/gm)];
				return matches.map((m, i) => ({
					prompt: `Phase ${m[1]}`,
					label: `phase ${i + 1}/${matches.length}`,
				}));
			};
			const { calls, lifecycle } = recorder();
			await runWorkflow(chain.ctx, {
				workflow: wf("rip", ["research", "implement"], { implement: { loop: fanout({ units: phaseFanout }) } }),
				input: "x",
				lifecycle,
			});
			const loopNames = names(calls).filter(
				(n) => n === "onLoopStart" || n === "onUnitStart" || n === "onUnitEnd" || n === "onStageStart",
			);
			// Expected loop sequence within the implement stage:
			//   onStageStart(implement) → onLoopStart → (onUnitStart → onUnitEnd) × 3.
			const impl = loopNames.slice(loopNames.indexOf("onLoopStart") - 1);
			expect(impl[0]).toBe("onStageStart");
			expect(impl[1]).toBe("onLoopStart");
			// Three unit-start + unit-end pairs after loop start.
			expect(impl.filter((n) => n === "onUnitStart")).toHaveLength(3);
			expect(impl.filter((n) => n === "onUnitEnd")).toHaveLength(3);
			// Units pair start-before-end: the first post-loopStart event is a unit start.
			expect(impl[2]).toBe("onUnitStart");
			expect(impl[3]).toBe("onUnitEnd");
		});

		it("onWorkflowEnd fires exactly once as the last event with the result envelope", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const { calls, lifecycle } = recorder();
			const result = await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			const ends = calls.filter(([n]) => n === "onWorkflowEnd");
			expect(ends).toHaveLength(1);
			expect(names(calls).at(-1)).toBe("onWorkflowEnd");
			const passedResult = ends[0]![1][0];
			expect(passedResult).toEqual(result);
		});

		it("listener throws are caught and logged, run still completes, other events still fire", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const seen: string[] = [];
			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"]),
				input: "x",
				lifecycle: {
					onStageStart: () => {
						throw new Error("listener boom");
					},
					onStageEnd: () => void seen.push("end"),
					onWorkflowEnd: () => void seen.push("workflowEnd"),
				},
			});
			expect(result.success).toBe(true);
			expect(seen).toEqual(["end", "workflowEnd"]);
			expect(chain.notifications.some((n) => /lifecycle listener/.test(n.msg))).toBe(true);
		});

		it("pre-flight rejection (workflow.start undeclared) fires ZERO lifecycle events", async () => {
			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
			const { calls, lifecycle } = recorder();
			const result = await runWorkflow(chain.ctx, {
				workflow: { name: "bad", start: "missing", stages: {}, edges: {} },
				input: "x",
				lifecycle,
			});
			expect(result.success).toBe(false);
			expect(calls).toEqual([]);
		});

		it("LifecycleContext.trigger defaults to programmatic; ctx round-trips to JSONL header", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const { calls, lifecycle } = recorder();
			await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle });
			const startCtx = calls.find(([n]) => n === "onWorkflowStart")![1][0] as { trigger: { kind: string } };
			expect(startCtx.trigger).toEqual({ kind: "programmatic" });
			const { header } = readState(tmpDir);
			expect(header.trigger).toEqual({ kind: "programmatic" });
		});

		it("explicit trigger flows through every event and the JSONL header", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
			});
			const { calls, lifecycle } = recorder();
			const trigger = { kind: "external" as const, source: "github-webhook", ref: "deadbeef" };
			await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x", lifecycle, trigger });
			for (const [, payload] of calls) {
				// Every event's LifecycleContext (last positional arg for stage events, also workflow events) carries trigger.
				const lastArg = payload[payload.length - 1];
				if (lastArg && typeof lastArg === "object" && "trigger" in lastArg) {
					expect((lastArg as { trigger: unknown }).trigger).toEqual(trigger);
				}
			}
			const { header } = readState(tmpDir);
			expect(header.trigger).toEqual(trigger);
		});

		// =======================================================================
		// Global registry (registerLifecycle)
		// =======================================================================

		describe("registerLifecycle (global registry)", () => {
			const setupSingleStageRun = () => {
				writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
				return createMockSessionChain({
					cwd: tmpDir,
					steps: [{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] }],
				});
			};

			it("two registered bundles both receive every event in registration order", async () => {
				const { registerLifecycle } = await import("./events.js");
				const order: string[] = [];
				const bundleA = { onStageEnd: () => void order.push("A") };
				const bundleB = { onStageEnd: () => void order.push("B") };
				const dispA = registerLifecycle(bundleA);
				const dispB = registerLifecycle(bundleB);
				try {
					const chain = setupSingleStageRun();
					await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x" });
					expect(order).toEqual(["A", "B"]);
				} finally {
					dispA();
					dispB();
				}
			});

			it("registerLifecycle returns a disposer that removes the bundle", async () => {
				const { registerLifecycle } = await import("./events.js");
				const seen: string[] = [];
				const dispose = registerLifecycle({ onStageEnd: () => void seen.push("registered") });
				dispose();
				const chain = setupSingleStageRun();
				await runWorkflow(chain.ctx, { workflow: wf("tiny", ["research"]), input: "x" });
				expect(seen).toEqual([]);
			});

			it("per-call options.lifecycle fires AFTER globally-registered bundles", async () => {
				const { registerLifecycle } = await import("./events.js");
				const order: string[] = [];
				const disposeGlobal = registerLifecycle({ onStageEnd: () => void order.push("global") });
				try {
					const chain = setupSingleStageRun();
					await runWorkflow(chain.ctx, {
						workflow: wf("tiny", ["research"]),
						input: "x",
						lifecycle: { onStageEnd: () => void order.push("per-call") },
					});
					expect(order).toEqual(["global", "per-call"]);
				} finally {
					disposeGlobal();
				}
			});

			it("a throw in one bundle doesn't stop other bundles or the run", async () => {
				const { registerLifecycle } = await import("./events.js");
				const seen: string[] = [];
				const dispose = registerLifecycle({
					onStageEnd: () => {
						throw new Error("global boom");
					},
				});
				try {
					const chain = setupSingleStageRun();
					const result = await runWorkflow(chain.ctx, {
						workflow: wf("tiny", ["research"]),
						input: "x",
						lifecycle: { onStageEnd: () => void seen.push("per-call-still-fires") },
					});
					expect(result.success).toBe(true);
					expect(seen).toEqual(["per-call-still-fires"]);
					expect(chain.notifications.some((n) => /lifecycle listener \(onStageEnd\) threw/.test(n.msg))).toBe(
						true,
					);
				} finally {
					dispose();
				}
			});

			it("registration made mid-run does NOT receive the in-flight event but DOES receive the next", async () => {
				const { registerLifecycle } = await import("./events.js");
				const seen: string[] = [];
				let lateDispose: (() => void) | undefined;
				const dispose = registerLifecycle({
					onStageStart: () => {
						// Register a second bundle from inside the FIRST stage's onStageStart.
						// The new bundle should NOT see this onStageStart (snapshot semantics)
						// but SHOULD see the NEXT onStageStart (stage 2).
						lateDispose ??= registerLifecycle({
							onStageStart: (stage: unknown) => {
								void seen.push(`late-saw-${(stage as { name: string }).name}`);
							},
						});
					},
				});
				try {
					writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md", "");
					const chain = createMockSessionChain({
						cwd: tmpDir,
						steps: [
							{ branch: [mockAssistantMessage("Plan: .rpiv/artifacts/research/r.md")] },
							{ branch: [mockAssistantMessage("done")] },
						],
					});
					await runWorkflow(chain.ctx, {
						workflow: wf("two", ["research", "design"]),
						input: "x",
					});
					// Only stage 2 ("design") should appear — stage 1's onStageStart was the in-flight event.
					expect(seen).toEqual(["late-saw-design"]);
				} finally {
					dispose();
					lateDispose?.();
				}
			});
		});
	});

	// -------------------------------------------------------------------------
	// runWorkflowByName — convenience one-shot over loadWorkflows + findWorkflow
	// + runWorkflow. Workflows are surfaced via the `built-in` layer
	// (registerBuiltIns); the global test setup resets that registry per test,
	// and tmpDir is a fresh cwd with no project overlay, so each case sees only
	// what it registers.
	// -------------------------------------------------------------------------
	describe("runWorkflowByName", () => {
		it("loads the named workflow and runs it to success", async () => {
			registerBuiltIns([wf("byname-tiny", ["research"])]);
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflowByName(chain.ctx, "byname-tiny", "add dark mode");

			expect(result).toEqual({
				runId: expect.stringMatching(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{4}$/),
				success: true,
				stagesCompleted: 1,
				lastArtifact: ".rpiv/artifacts/research/r.md",
				error: undefined,
				termination: { status: "completed" },
			});
			expect(chain.sentMessages).toEqual(["/skill:research add dark mode"]);
			// A JSONL run file was written under the resolved runId.
			expect(readState(tmpDir).header.workflow).toBe("byname-tiny");
		});

		it("returns a failure envelope (never throws) when the name is unknown", async () => {
			registerBuiltIns([wf("present", ["research"])]);
			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

			const result = await runWorkflowByName(chain.ctx, "ghost", "x");

			expect(result.success).toBe(false);
			expect(result.stagesCompleted).toBe(0);
			expect(result.runId).toBeUndefined();
			expect(result.error).toMatch(/workflow "ghost" not found/);
			// Surfaces what IS available so the caller can recover.
			expect(result.error).toContain("present");
			// Nothing ran: no session opened, no run file written.
			expect(chain.ctx.spawnChild).not.toHaveBeenCalled();
			expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
		});

		it("forwards options (trigger) through to runWorkflow", async () => {
			registerBuiltIns([wf("byname-tiny", ["research"])]);
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflowByName(chain.ctx, "byname-tiny", "add dark mode", {
				trigger: { kind: "command", name: "wf" },
			});

			expect(result.success).toBe(true);
			// The trigger reached the JSONL header via runWorkflow.
			expect(readState(tmpDir).header.trigger).toEqual({ kind: "command", name: "wf" });
		});
	});

	describe("cooperative cancellation (signal)", () => {
		it("a pre-aborted signal records an 'aborted' start-stage row and never opens a session", async () => {
			const controller = new AbortController();
			controller.abort();
			const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"]),
				input: "x",
				signal: controller.signal,
			});

			expect(result.success).toBe(false);
			expect(result.stagesCompleted).toBe(0);
			expect(result.error).toMatch(/aborted before stage "research"/);
			// A JSONL file IS written (header + aborted row), so runId is present —
			// distinguishing an abort from a pre-flight rejection (no file, no runId).
			expect(result.runId).toBeTruthy();
			expect(chain.ctx.spawnChild).not.toHaveBeenCalled();

			const { stages } = readState(tmpDir);
			expect(stages).toHaveLength(1);
			expect(stages[0]).toMatchObject({ stage: "research", status: "aborted" });
		});

		it("aborting after stage 1 stops the chain: stage 2 is recorded 'aborted', its session never opens", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const controller = new AbortController();
			const chain = createMockSessionChain({
				cwd: tmpDir,
				// Only one step — stage 2 must never run.
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("two", ["research", "design"]),
				input: "x",
				signal: controller.signal,
				// onStageEnd fires after stage 1's success row, before advanceChain
				// routes to stage 2 — abort here halts at the next-stage seam.
				lifecycle: {
					onStageEnd: (stage) => {
						if (stage.name === "research") controller.abort();
					},
				},
			});

			expect(result.success).toBe(false);
			expect(result.stagesCompleted).toBe(1);
			expect(result.error).toMatch(/aborted before stage "design"/);
			// Stage 1 streamed; stage 2 never opened a session.
			expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1);
			expect(chain.remaining()).toBe(0);

			const { stages } = readState(tmpDir);
			expect(stages.map((s) => [s.stage, s.status])).toEqual([
				["research", "completed"],
				["design", "aborted"],
			]);
		});

		it("a never-aborted signal does not affect a normal run", async () => {
			writeArtifact(tmpDir, ".rpiv/artifacts/research/r.md");
			const controller = new AbortController();
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: wf("tiny", ["research"]),
				input: "x",
				signal: controller.signal,
			});

			expect(result.success).toBe(true);
			expect(result.stagesCompleted).toBe(1);
		});
	});
});

describe("transcript offset helpers", () => {
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
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// The denominator is the `totalStages` the runner computes via
	// countReachableStages and surfaces on the lifecycle context (it was formerly
	// read off the now-removed status line).
	const captureTotalStages = (): {
		lifecycle: { onWorkflowStart: (ctx: { totalStages: number }) => void };
		get: () => number | undefined;
	} => {
		let total: number | undefined;
		return {
			lifecycle: {
				onWorkflowStart: (ctx) => {
					total = ctx.totalStages;
				},
			},
			get: () => total,
		};
	};

	it("counts every reachable node along a linear chain", async () => {
		writeFileSync(join(tmpDir, ".rpiv-stub"), ""); // ensure cwd exists
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// 3-node linear chain — denominator should be 3.
		const cap = captureTotalStages();
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "linear",
				start: "a",
				stages: {
					a: { kind: "side-effect", sessionPolicy: "fresh" },
					b: { kind: "side-effect", sessionPolicy: "fresh" },
					c: { kind: "side-effect", sessionPolicy: "fresh" },
				},
				edges: { a: "b", b: "c", c: "stop" },
			},
			input: "x",
			lifecycle: cap.lifecycle,
		});
		expect(cap.get()).toBe(3);
	});

	it("counts both branches when an edge is a gate (with .targets)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const cap = captureTotalStages();
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "branching",
				start: "a",
				stages: {
					a: { kind: "side-effect", sessionPolicy: "fresh" },
					b: { kind: "side-effect", sessionPolicy: "fresh" },
					c: { kind: "side-effect", sessionPolicy: "fresh" },
				},
				// gate attaches .targets = ["b", "c"]; BFS reaches both.
				edges: { a: gate("count", { b: gt(0), c: eq(0) }, "c"), b: "stop", c: "stop" },
			},
			input: "x",
			lifecycle: cap.lifecycle,
		});
		expect(cap.get()).toBe(3);
	});

	it("excludes orphan (unreachable) nodes from the count", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// `orphan` is declared but never reachable from start.
		const cap = captureTotalStages();
		await runWorkflow(chain.ctx, {
			workflow: {
				name: "with-orphan",
				start: "a",
				stages: {
					a: { kind: "side-effect", sessionPolicy: "fresh" },
					b: { kind: "side-effect", sessionPolicy: "fresh" },
					orphan: { skill: "orphan", kind: "side-effect", sessionPolicy: "fresh" },
				},
				edges: { a: "b", b: "stop", orphan: "stop" },
			},
			input: "x",
			lifecycle: cap.lifecycle,
		});
		// BFS reaches {a, b} — denominator is 2, not 3.
		expect(cap.get()).toBe(2);
	});

	it("throws when an EdgeFn has no .targets — validation should have rejected the workflow", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// A bare EdgeFn skips defineRoute/gate and carries no .targets
		// metadata. validateWorkflow rejects this at load time; if a test bypasses
		// validation and feeds it to runWorkflow, the runner surfaces the broken
		// invariant loudly instead of silently miscounting the denominator.
		const bareEdge = () => "b";
		await expect(
			runWorkflow(chain.ctx, {
				workflow: {
					name: "naked",
					start: "a",
					stages: {
						a: { kind: "side-effect", sessionPolicy: "fresh" },
						b: { kind: "side-effect", sessionPolicy: "fresh" },
					},
					edges: { a: bareEdge, b: "stop" },
				},
				input: "x",
			}),
		).rejects.toThrow(/countReachableStages: edge from "a" is an EdgeFn without \.targets/);
	});
});
