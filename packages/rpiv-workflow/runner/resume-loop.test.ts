/**
 * End-to-end loop-resume tests — drive `resumeWorkflow` with a mock session
 * chain over real `loop`-field workflows (fanout / iterate / assess), the ONE
 * driver + ONE fold path. Complements the pure-fold cases in `resume.test.ts`.
 *
 * Resumed trail rows carry the STRUCTURED unit identity
 * (`parent`/`role`/`unitId`/`unitIndex`); the decorated `stage` string is
 * display-only and never parsed. The fold reconstructs the driver's own
 * `LoopCursor` and verifies EVERY unit row against the recomputed expectation
 * (the full-row drift guard).
 *
 * A-class contracts ported here (verbatim intent from the retired
 * per-primitive resume suites):
 *   - re-run failed + remaining units only; finished-loop resume is a SILENT
 *     no-op (no onStageStart/onLoopStart re-fire, no per-unit/stage toast);
 *   - drift refusals: a recomputed unit differs from the recorded row, or a
 *     generator throws mid-fold → a parent-attributed terminal failure row,
 *     zero dispatch;
 *   - generation reset on a back-edge: only the trailing generation re-runs,
 *     `state.named` stays cumulative, generators legally read state produced
 *     outside the loop;
 *   - assess's four pending paths: pending judge, pending produce with a
 *     recovered verdict (feedForward, no re-grade), done-verdict fast advance,
 *     round-0 re-run (start + non-start), plus the missing-upstream refusal.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type FanoutFn, gate, type IterateFn, produces, type Workflow } from "../api.js";
import { assess, fanout, iterate } from "../control-flow.js";
import { fs as fsHandle } from "../handle.js";
import { judge } from "../judge.js";
import type { Output, OutputSpec } from "../output.js";
import { eq, gt } from "../predicates.js";
import { appendStage, readAllStages, type WorkflowHeader, type WorkflowStage, writeHeader } from "../state/index.js";
import { typeboxSchema } from "../typebox-adapter.js";
import { resumeWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-resume-loop-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const MD_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;
const JSON_PATTERN = /\.rpiv\/verdicts\/[\w.-]+\.json/g;

const writeFile = (rel: string, content = "") => {
	mkdirSync(join(tmpDir, ...rel.split("/").slice(0, -1)), { recursive: true });
	writeFileSync(join(tmpDir, rel), content);
};

/** Collect EVERY `.rpiv/artifacts/.../*.md` match across the branch as artifacts. */
const transcriptOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const matches: string[] = [];
			for (let i = Math.max(ctx.branchOffset ?? 0, 0); i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(MD_PATTERN);
						if (m) matches.push(...m);
					}
				}
			}
			if (matches.length === 0) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: matches.map((p) => ({ handle: fsHandle(p), role: "primary" as const })) };
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

/** Verdict outcome: scan for the last `.rpiv/verdicts/*.json`, parse to `{ done, feedback }`. */
const verdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			let path: string | undefined;
			for (let i = Math.max(ctx.branchOffset ?? 0, 0); i < ctx.branch.length; i++) {
				const entry = ctx.branch[i]!;
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const m = part.text.match(JSON_PATTERN);
						if (m) path = m[m.length - 1];
					}
				}
			}
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no verdict path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: {
		parse: (ctx) => {
			const primary = ctx.artifacts[0];
			const path = primary?.handle.kind === "fs" ? primary.handle.path : undefined;
			if (!path) return { kind: "ok", payload: { kind: "verdict", data: {} } };
			const abs = path.startsWith("/") ? path : join(ctx.cwd, path);
			return { kind: "ok", payload: { kind: "verdict", data: JSON.parse(readFileSync(abs, "utf-8")) } };
		},
	},
});

// ===========================================================================
// Fanout
// ===========================================================================

describe("loop-resume — fanout", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-03_07-30-00-ab12",
		workflow: "fanout-wf",
		input: "Ship it",
		ts: "2026-06-03T07:30:00Z",
	};

	/** Deterministic 3-unit fanout (blind to artifact, stable across re-call). */
	const threeUnits: FanoutFn = () =>
		[1, 2, 3].map((n) => ({ prompt: `phase ${n}`, label: `phase ${n}/3`, id: `phase-${n}` }));

	const fanoutWf: Workflow = {
		name: "fanout-wf",
		start: "impl",
		stages: { impl: produces({ outcome: transcriptOutcome("plans"), loop: fanout({ units: threeUnits }) }) },
		edges: { impl: "stop" },
	} as Workflow;

	function writeRun(stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	const unitRow = (n: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
		stageNumber: num,
		stage: `impl (phase-${n})`,
		skill: "impl",
		status,
		ts: `t${num}`,
		parent: "impl",
		role: "produce",
		unitId: `phase-${n}`,
		unitIndex: n - 1,
		...(status === "completed"
			? {
					output: {
						kind: "artifacts",
						artifacts: [{ handle: fsHandle(`.rpiv/artifacts/plans/p${n}.md`), role: "primary" }],
						data: {},
						meta: { stage: "impl", stageNumber: num, ts: "", runId: "" },
					} satisfies Output,
				}
			: { errMsg: "boom" }),
	});

	it("mid-fanout failure: re-runs only the failed unit + remaining, then chains to stop", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "failed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Only unit 3 re-ran → exactly one new dispatch.
		expect(chain.sentMessages).toEqual(["/skill:impl phase 3"]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows).toHaveLength(4);
		expect(rows[3]).toMatchObject({ stage: "impl (phase-3)", status: "completed", parent: "impl", unitIndex: 2 });
	});

	it("process died mid-fanout (no failure row): resumes at the next unit", async () => {
		writeRun([unitRow(1, 1, "completed")]); // only unit 1 recorded
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: fanoutWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["/skill:impl phase 2", "/skill:impl phase 3"]);
	});

	it("fully-completed fanout: SILENT no-op route-onward (no re-announce, no per-stage toast)", async () => {
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "completed"), unitRow(3, 3, "completed")]);
		const loopStarts: string[] = [];
		const stageStarts: string[] = [];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, {
			workflow: fanoutWf,
			header,
			ref: "@x",
			lifecycle: {
				onLoopStart: (stage) => {
					loopStarts.push(stage.name);
				},
				onStageStart: (stage) => {
					stageStarts.push(stage.name);
				},
			},
		});

		expect(result.success).toBe(true);
		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		expect(readAllStages(tmpDir, header.runId)).toHaveLength(3); // no new rows
		// The finished loop is NOT re-announced.
		expect(loopStarts).toEqual([]);
		expect(stageStarts).toEqual([]);
		// ...and the only completion toast is the workflow-level one.
		expect(chain.notifications.filter((n) => n.msg === "✓ impl completed")).toEqual([]);
		expect(chain.notifications.filter((n) => /workflow complete/.test(n.msg))).toHaveLength(1);
	});

	it("non-deterministic fanout: recorded terminal failure, refuses to re-run wrong units", async () => {
		// Recorded run had `phase-1` completed; the workflow now recomputes a different id.
		const drifted: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: produces({
					outcome: transcriptOutcome("plans"),
					loop: fanout({ units: () => [{ prompt: "x", label: "task 1", id: "task-1" }] }),
				}),
			},
			edges: { impl: "stop" },
		} as Workflow;
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: drifted, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		expect(result.runId).toBe(header.runId); // in-run failure → row written
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "impl", status: "failed" });
		expect(chain.sentMessages).toEqual([]); // no unit dispatched
	});

	it("generator throw mid-fold: recorded terminal failure, zero dispatch", async () => {
		const thrower: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: produces({
					outcome: transcriptOutcome("plans"),
					loop: fanout({
						units: () => {
							throw new Error("units-boom");
						},
					}),
				}),
			},
			edges: { impl: "stop" },
		} as Workflow;
		writeRun([unitRow(1, 1, "completed"), unitRow(2, 2, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: thrower, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/units-boom/);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "impl", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});
});

// ===========================================================================
// Iterate
// ===========================================================================

describe("loop-resume — iterate", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-03_08-00-00-cd34",
		workflow: "polish",
		input: "Ship it",
		ts: "2026-06-03T08:00:00Z",
	};
	const REVIEW_3_PHASES = "# Review\n\n### Phase 1 — Alpha\nx\n### Phase 2 — Beta\ny\n### Phase 3 — Gamma\nz\n";

	/** Deterministic per-phase generator keyed off the FROZEN review file. */
	const reviewPhaseIterate: IterateFn = ({ artifact, index, cwd }) => {
		if (artifact?.handle.kind !== "fs") return null;
		const abs = artifact.handle.path.startsWith("/") ? artifact.handle.path : join(cwd, artifact.handle.path);
		const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
		if (index >= phases.length) return null;
		const num = phases[index]![1];
		return { prompt: `plan phase ${num}`, label: `phase ${index + 1}/${phases.length}`, id: `phase-${num}` };
	};

	const polishWf = (gen: IterateFn = reviewPhaseIterate): Workflow =>
		({
			name: "polish",
			start: "review",
			stages: {
				review: produces({ outcome: transcriptOutcome("reviews") }),
				blueprint: produces({ outcome: transcriptOutcome("plans"), loop: iterate({ next: gen }) }),
				consume: acts(),
			},
			edges: { review: "blueprint", blueprint: "consume", consume: "stop" },
		}) as Workflow;

	const out = (stage: string, num: number, rel: string): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		data: {},
		meta: { stage, stageNumber: num, ts: "", runId: "" },
	});

	const reviewRow: WorkflowStage = {
		stageNumber: 1,
		stage: "review",
		skill: "review",
		status: "completed",
		ts: "t1",
		output: out("review", 1, ".rpiv/artifacts/reviews/rev.md"),
	};

	/** A recorded blueprint iterate-unit row. `phase` is the unit's phase number (== its id). */
	const planRow = (phase: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
		stageNumber: num,
		stage: `blueprint (phase-${phase})`,
		skill: "blueprint",
		status,
		ts: `t${num}`,
		parent: "blueprint",
		role: "produce",
		unitId: `phase-${phase}`,
		unitIndex: phase - 1,
		...(status === "completed"
			? { output: out("blueprint", num, `.rpiv/artifacts/plans/p${phase}.md`) }
			: { errMsg: "boom" }),
	});

	function writeRun(stages: WorkflowStage[]): void {
		writeFile(".rpiv/artifacts/reviews/rev.md", REVIEW_3_PHASES);
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	it("mid-iterate failure: re-pulls + re-runs the failed unit + remaining, then chains to consume/stop", async () => {
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "failed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] }, // phase-2 re-run
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] }, // phase-3
				{ branch: [mockAssistantMessage("consumed")] }, // consume
			],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		// phase-2 (re-run), phase-3, consume — phase-1 NOT re-run.
		expect(chain.sentMessages).toEqual([
			"/skill:blueprint plan phase 2",
			"/skill:blueprint plan phase 3",
			expect.stringContaining("consume"),
		]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("fully-completed iterate trailer: no-op, routes onward; the probe pull dispatches nothing", async () => {
		// All 3 phases done; trailer is the last completed unit (process died before advanceChain).
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "completed"), planRow(3, 4, "completed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("consumed")] }],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		// Only `consume` ran; the probe pull (next→null) re-ran no blueprint unit.
		expect(chain.sentMessages).toEqual([expect.stringContaining("consume")]);
	});

	it("non-deterministic IterateFn: boundary mismatch records terminal failure, runs no unit", async () => {
		const drifted: IterateFn = ({ index }) =>
			index >= 3 ? null : { prompt: "x", label: `task ${index}`, id: `task-${index}` };
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(drifted), header, ref: "@x" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		expect(result.runId).toBe(header.runId);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "blueprint", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});

	it("generator throw AFTER the fold: recorded terminal failure envelope, not an escaped rejection", async () => {
		// Deterministic through the fold's two verification pulls, then throws —
		// exercises the post-fold re-entry (the `hasPendingUnit` probe + the
		// driver's pull), which runs outside the fold's guarded() wrapper.
		let calls = 0;
		const throwsAfterFold: IterateFn = (ctx) => {
			calls++;
			if (calls > 2) throw new Error("probe boom");
			return reviewPhaseIterate(ctx);
		};
		writeRun([reviewRow, planRow(1, 2, "completed"), planRow(2, 3, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await resumeWorkflow(chain.ctx, { workflow: polishWf(throwsAfterFold), header, ref: "@x" });
		expect(result.success).toBe(false);
		expect(result.error).toBe("probe boom");
		expect(result.runId).toBe(header.runId);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "blueprint", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});
});

// ===========================================================================
// Iterate — corrective back-edge (generation reset + generator reads state)
// ===========================================================================

describe("loop-resume — iterate corrective back-edge", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-03_09-00-00-ef56",
		workflow: "polish-loop",
		input: "Ship it",
		ts: "2026-06-03T09:00:00Z",
	};
	const REVIEW_2_PHASES = "# Review\n\n### Phase 1 — A\nx\n### Phase 2 — B\ny\n";

	/** Sources the review from state.named (robust to the rolling primary being the code-review doc on re-entry). */
	const reviewFromState: IterateFn = ({ state, index, cwd }) => {
		const review = state.named.architecture_reviews?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");
		if (review?.handle.kind !== "fs") return null;
		const abs = review.handle.path.startsWith("/") ? review.handle.path : join(cwd, review.handle.path);
		const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+) — (.+)$/gm)];
		if (index >= phases.length) return null;
		const num = phases[index]![1];
		return {
			prompt: `${review.handle.path} Phase ${num}`,
			label: `phase ${index + 1}/${phases.length}`,
			id: `phase-${num}`,
		};
	};

	const blockersOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
		name,
		collector: transcriptOutcome(name).collector,
		parser: {
			parse: (ctx) => {
				const primary = ctx.artifacts[0];
				if (primary?.handle.kind !== "fs") return { kind: "ok", payload: { kind: "artifact-md", data: {} } };
				const abs = primary.handle.path.startsWith("/") ? primary.handle.path : join(ctx.cwd, primary.handle.path);
				const m = readFileSync(abs, "utf-8").match(/blockers_count:\s*(\d+)/);
				return { kind: "ok", payload: { kind: "artifact-md", data: { blockers_count: Number(m?.[1] ?? 0) } } };
			},
		},
	});

	const plansFanout: FanoutFn = ({ state }) =>
		(state.named.plans ?? [])
			.flatMap((o) => o.artifacts)
			.filter((a) => a.handle.kind === "fs")
			.map((a, i) => ({ prompt: a.handle.kind === "fs" ? a.handle.path : "", label: `plan ${i + 1}` }));

	const out = (stage: string, num: number, rel: string): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		data: {},
		meta: { stage, stageNumber: num, ts: "", runId: "" },
	});

	const planRow = (phase: number, num: number, rel: string, status: "completed" | "failed"): WorkflowStage => ({
		stageNumber: num,
		stage: `blueprint (phase-${phase})`,
		skill: "blueprint",
		status,
		ts: `t${num}`,
		parent: "blueprint",
		role: "produce",
		unitId: `phase-${phase}`,
		unitIndex: phase - 1,
		...(status === "completed" ? { output: out("blueprint", num, rel) } : { errMsg: "boom" }),
	});

	it("resumes the trailing generation only; state.named.plans keeps both generations", async () => {
		writeFile(".rpiv/artifacts/architecture_reviews/rev.md", REVIEW_2_PHASES);

		writeHeader(tmpDir, header);
		const rows: WorkflowStage[] = [
			{
				stageNumber: 1,
				stage: "review",
				skill: "review",
				status: "completed",
				ts: "t1",
				output: out("review", 1, ".rpiv/artifacts/architecture_reviews/rev.md"),
			},
			planRow(1, 2, ".rpiv/artifacts/plans/g1p1.md", "completed"),
			planRow(2, 3, ".rpiv/artifacts/plans/g1p2.md", "completed"),
			{
				stageNumber: 4,
				stage: "code-review",
				skill: "code-review",
				status: "completed",
				ts: "t4",
				output: out("code-review", 4, ".rpiv/artifacts/reviews/cr1.md"),
			},
			// gen 2 — non-contiguous with gen 1 (the code-review row broke contiguity).
			planRow(1, 5, ".rpiv/artifacts/plans/g2p1.md", "completed"),
			planRow(2, 6, "", "failed"),
		];
		for (const s of rows) appendStage(tmpDir, header.runId, s);

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/g2p2.md")] }, // gen-2 phase-2 re-run
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/cr2.md")] }, // code-review → blockers=0
				{ branch: [mockAssistantMessage("impl 1")] },
				{ branch: [mockAssistantMessage("impl 2")] },
				{ branch: [mockAssistantMessage("impl 3")] },
				{ branch: [mockAssistantMessage("impl 4")] },
			],
		});

		writeFile(".rpiv/artifacts/reviews/cr2.md", "---\nblockers_count: 0\n---\n");

		const wf: Workflow = {
			name: "polish-loop",
			start: "review",
			stages: {
				review: produces({ outcome: transcriptOutcome("architecture_reviews") }),
				blueprint: produces({ outcome: transcriptOutcome("plans"), loop: iterate({ next: reviewFromState }) }),
				"code-review": produces({
					outcome: blockersOutcome("reviews"),
					outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Number() })),
				}),
				consume: acts({ loop: fanout({ units: plansFanout }) }),
			},
			edges: {
				review: "blueprint",
				blueprint: "code-review",
				"code-review": gate("blockers_count", { blueprint: gt(0), consume: eq(0) }),
				consume: "stop",
			},
		} as Workflow;

		const result = await resumeWorkflow(chain.ctx, { workflow: wf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Only the trailing generation's remaining unit (phase-2) re-ran — phase-1 of gen 2 did NOT.
		const blueprintMsgs = chain.sentMessages.filter((m) => m.startsWith("/skill:blueprint"));
		expect(blueprintMsgs).toEqual(["/skill:blueprint .rpiv/artifacts/architecture_reviews/rev.md Phase 2"]);
		// The consume fanout saw ALL FOUR plans — state.named["plans"] carried both generations.
		expect(chain.sentMessages.slice(-4)).toEqual([
			"/skill:consume .rpiv/artifacts/plans/g1p1.md",
			"/skill:consume .rpiv/artifacts/plans/g1p2.md",
			"/skill:consume .rpiv/artifacts/plans/g2p1.md",
			"/skill:consume .rpiv/artifacts/plans/g2p2.md",
		]);
	});
});

// ===========================================================================
// Assess — the four pending sub-step paths + refusals
// ===========================================================================

describe("loop-resume — assess", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-03_10-00-00-aa11",
		workflow: "decompose",
		input: "decompose this",
		ts: "2026-06-03T10:00:00Z",
	};

	const done = (v: Output) => Boolean((v.data as { done?: boolean }).done);
	const feedForward = ({ verdict, round }: { verdict: Output; round: number }) =>
		`refine round=${round} fb=${(verdict.data as { feedback?: string }).feedback}`;

	/** breakdown (assess; start) → consume. */
	const assessWf: Workflow = {
		name: "decompose",
		start: "breakdown",
		stages: {
			breakdown: produces({
				outcome: transcriptOutcome("tasks"),
				loop: assess({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done, feedForward }),
			}),
			consume: acts(),
		},
		edges: { breakdown: "consume", consume: "stop" },
	} as Workflow;

	const writeVerdict = (n: number, isDone: boolean, feedback = `fb${n}`): string => {
		const rel = `.rpiv/verdicts/v${n}.json`;
		writeFile(rel, JSON.stringify({ done: isDone, feedback }));
		return rel;
	};

	const taskOutput = (round: number, num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(`.rpiv/artifacts/tasks/t${round}.md`), role: "primary" }],
		data: {},
		meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
	});

	const verdictOutput = (round: number, num: number, isDone: boolean): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(`.rpiv/verdicts/v${round}.json`), role: "primary" }],
		data: { done: isDone, feedback: `fb${round}` },
		meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
	});

	const produceRow = (round: number, num: number, status: WorkflowStage["status"] = "completed"): WorkflowStage => ({
		stageNumber: num,
		stage: `breakdown (r${round}·produce)`,
		skill: "breakdown",
		status,
		ts: `t${num}`,
		parent: "breakdown",
		role: "produce",
		unitIndex: round,
		...(status === "completed" ? { output: taskOutput(round, num) } : { errMsg: "boom" }),
	});

	const judgeRow = (round: number, num: number, isDone: boolean): WorkflowStage => ({
		stageNumber: num,
		stage: `breakdown (r${round}·judge)`,
		skill: "grade",
		status: "completed",
		ts: `t${num}`,
		parent: "breakdown",
		role: "judge",
		unitIndex: round,
		output: verdictOutput(round, num, isDone),
	});

	function writeRun(stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	it("resume-at-judge: a completed-producer trailer grades round n, then advances on done", async () => {
		writeRun([produceRow(0, 1, "completed")]); // died after the round-0 producer
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] }, // consume
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("resume-at-produce: a not-done judge trailer runs produce n+1, feedForward sees the recovered verdict (no re-grade)", async () => {
		writeRun([produceRow(0, 1, "completed"), judgeRow(0, 2, false)]);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] }, // produce round 1
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] }, // judge round 1
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// No re-grade of round 0 — the recovered verdict (fb0) feeds straight into feedForward.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown refine round=0 fb=fb0",
			"/skill:grade .rpiv/artifacts/tasks/t1.md",
			"/skill:consume .rpiv/artifacts/tasks/t1.md",
		]);
	});

	it("resume-after-done: a done judge trailer advances downstream with no re-run", async () => {
		writeRun([produceRow(0, 1, "completed"), judgeRow(0, 2, true)]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("consumed")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// No breakdown/grade re-run — straight to consume with the last producer output.
		expect(chain.sentMessages).toEqual(["/skill:consume .rpiv/artifacts/tasks/t0.md"]);
	});

	it("resume-at-produce-0: a failed round-0 producer re-runs produce 0 from the entry arg (start stage → original input)", async () => {
		writeRun([produceRow(0, 1, "failed")]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // re-run produce 0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: assessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown decompose this",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
	});

	// --- NON-start assess stage — entryArgsFor's recovered-primary branch ---

	const seedOutput = (num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(".rpiv/artifacts/seed/s0.md"), role: "primary" }],
		data: {},
		meta: { stage: "review", stageNumber: num, ts: "", runId: "" },
	});

	const reviewRow = (num: number): WorkflowStage => ({
		stageNumber: num,
		stage: "review",
		skill: "review",
		status: "completed",
		ts: `t${num}`,
		output: seedOutput(num),
	});

	const nonStartAssessWf: Workflow = {
		name: "decompose",
		start: "review",
		stages: {
			review: produces({ outcome: transcriptOutcome("seed") }),
			breakdown: produces({
				outcome: transcriptOutcome("tasks"),
				loop: assess({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done, feedForward }),
			}),
			consume: acts(),
		},
		edges: { review: "breakdown", breakdown: "consume", consume: "stop" },
	} as Workflow;

	it("resume-at-produce-0 of a NON-start assess stage re-runs produce 0 from the recovered upstream primary handle", async () => {
		writeRun([reviewRow(1), produceRow(0, 2, "failed")]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] }, // re-run produce 0
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // judge round 0
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: nonStartAssessWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Entry arg is review's recovered primary handle, NOT the original input.
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown .rpiv/artifacts/seed/s0.md",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
	});

	it("refuses with a recorded failure when the trail lacks the upstream primary a non-start assess re-entry needs", async () => {
		// Corrupted/truncated trail: the round-0 producer row exists but the upstream review row is gone.
		writeRun([produceRow(0, 1, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: nonStartAssessWf, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no upstream artifactPath/i);
		expect(chain.sentMessages).toEqual([]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "breakdown", status: "failed" });
	});

	it("done-predicate drift: a produce row for round n>0 whose recorded verdict now reads done → terminal failure", async () => {
		// Recorded: round 0 judged not-done (so a round-1 producer ran). The workflow's
		// `done` now returns true for that verdict — the predicate drifted.
		const driftedWf: Workflow = {
			name: "decompose",
			start: "breakdown",
			stages: {
				breakdown: produces({
					outcome: transcriptOutcome("tasks"),
					loop: assess({
						judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
						done: () => true,
						feedForward,
					}),
				}),
				consume: acts(),
			},
			edges: { breakdown: "consume", consume: "stop" },
		} as Workflow;
		writeRun([produceRow(0, 1, "completed"), judgeRow(0, 2, false), produceRow(1, 3, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: driftedWf, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "breakdown", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});
});
