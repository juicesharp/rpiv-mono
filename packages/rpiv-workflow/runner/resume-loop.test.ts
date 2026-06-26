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
import { acts, type FanoutFn, fanin, gate, type IterateFn, produces, type Workflow } from "../api.js";
import { fs as fsHandle } from "../handle.js";
import { judge } from "../judge.js";
import { assess, fanout, iterate, majority, panel, verify } from "../loop-constructors.js";
import { failedOutput, type Output, outputMeta } from "../output.js";
import type { Outcome } from "../output-spec.js";
import { eq, gt } from "../predicates.js";
import {
	appendStage,
	readAllStages,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	type WorkflowStage,
	writeHeader,
} from "../state/index.js";
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
const transcriptOutcome = (name: string): Outcome<unknown, "artifact-md", Record<string, unknown>> => ({
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
const verdictOutcome = (name: string): Outcome<unknown, "verdict", Record<string, unknown>> & { name: string } => ({
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
		v: STATE_SCHEMA_VERSION,
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
		session: null,
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

	it("collected soft-halt row: rebuilds the failedOutput sentinel by index (skipped by fanin), no re-dispatch", async () => {
		// CONTRAST with the hard-failure case above: a `collected:true` row is a
		// non-terminal collect-all unit halt. The resume fold rebuilds a failedOutput
		// sentinel at the unit's declared index — FILLING the slot — so resume does NOT
		// re-dispatch it; fanin then skips the sentinel. A hard `status:"failed"` row
		// (no `collected`) leaves the slot unfilled and re-runs (see "mid-fanout failure").
		const synthWf: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: produces({ outcome: transcriptOutcome("plans"), loop: fanout({ units: threeUnits }) }),
				synthesize: acts({ reads: [fanin("plans")] }),
			},
			edges: { impl: "synthesize", synthesize: "stop" },
		} as Workflow;
		writeRun([
			unitRow(1, 1, "completed"),
			{ ...unitRow(2, 2, "failed"), collected: true, errMsg: "unit 2 boom" },
			unitRow(3, 3, "completed"),
		]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("synthesized")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: synthWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// No fanout unit re-dispatched — index 1's slot is filled by the rebuilt sentinel,
		// not left pending. The only dispatch is the synthesize stage, whose fanin read
		// skips the failed sentinel (p1 + p3, NOT p2).
		expect(chain.sentMessages).toEqual([
			"/skill:synthesize --plans .rpiv/artifacts/plans/p1.md --plans .rpiv/artifacts/plans/p3.md",
		]);
		// The collected row is NOT re-dispatched, so no new unit rows for impl land.
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.filter((r) => r.parent === "impl")).toHaveLength(3);
	});

	it("collected soft-halt row: the rebuilt sentinel's meta is byte-identical to a live failedOutput (both via outputMeta)", () => {
		// The resume fold rebuilds the sentinel through `outputMeta({ ts: row.ts })`;
		// the live `softHaltUnit` path mints `nowIso()`. Both now route through the
		// single `outputMeta` assembler, so when fed the same activation fields the
		// meta is structurally equal — a live-vs-resume divergence is unrepresentable.
		const rowFields = {
			stage: "impl (phase-2)",
			skill: "impl",
			stageNumber: 2,
			ts: "t2",
			runId: header.runId,
		};
		const rebuilt = failedOutput(outputMeta({ ...rowFields, ts: rowFields.ts }), "unit 2 boom");
		expect(rebuilt.meta).toStrictEqual(rowFields);
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
		expect(chain.ctx.spawnChild).not.toHaveBeenCalled();
		expect(readAllStages(tmpDir, header.runId)).toHaveLength(3); // no new rows
		// The finished loop is NOT re-announced.
		expect(loopStarts).toEqual([]);
		expect(stageStarts).toEqual([]);
		// ...loop completion is silent (no per-stage toast); only the workflow-level notice fires.
		expect(chain.notifications.filter((n) => n.msg.startsWith("✓"))).toEqual([]);
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

	it("resume mid-fanout then synthesize: the fan-in read sees the full byte-identical array", async () => {
		// impl (3-unit fanout, publishes "plans") → synthesize (reads fanin("plans")).
		const synthWf: Workflow = {
			name: "fanout-wf",
			start: "impl",
			stages: {
				impl: produces({ outcome: transcriptOutcome("plans"), loop: fanout({ units: threeUnits }) }),
				synthesize: acts({ reads: [fanin("plans")] }),
			},
			edges: { impl: "synthesize", synthesize: "stop" },
		} as Workflow;

		// Process died after unit 1 was recorded; units 2-3 re-run live, then synthesize.
		writeRun([unitRow(1, 1, "completed")]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p3.md")] },
				{ branch: [mockAssistantMessage("synthesized")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: synthWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// The replayed unit-1 append + the two live appends all land in state.named.plans,
		// so the synthesize barrier reads all three handles in run order.
		expect(chain.sentMessages).toEqual([
			"/skill:impl phase 2",
			"/skill:impl phase 3",
			"/skill:synthesize --plans .rpiv/artifacts/plans/p1.md --plans .rpiv/artifacts/plans/p2.md --plans .rpiv/artifacts/plans/p3.md",
		]);
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
		v: STATE_SCHEMA_VERSION,
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
		session: null,
		stageNumber: 1,
		stage: "review",
		skill: "review",
		status: "completed",
		ts: "t1",
		output: out("review", 1, ".rpiv/artifacts/reviews/rev.md"),
	};

	/** A recorded blueprint iterate-unit row. `phase` is the unit's phase number (== its id). */
	const planRow = (phase: number, num: number, status: "completed" | "failed"): WorkflowStage => ({
		session: null,
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
		v: STATE_SCHEMA_VERSION,
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

	const blockersOutcome = (name: string): Outcome<unknown, "artifact-md", Record<string, unknown>> => ({
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
		session: null,
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
				session: null,
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
				session: null,
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
				"code-review": gate("blockers_count", { blueprint: gt(0), consume: eq(0) }, "consume"),
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
		v: STATE_SCHEMA_VERSION,
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
		session: null,
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
		session: null,
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

	// --- NON-start assess stage — stageEntryArgs' recovered-primary branch (frozen at fold open) ---

	const seedOutput = (num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(".rpiv/artifacts/seed/s0.md"), role: "primary" }],
		data: {},
		meta: { stage: "review", stageNumber: num, ts: "", runId: "" },
	});

	const reviewRow = (num: number): WorkflowStage => ({
		session: null,
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

describe("loop-resume — assess × panel", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-03_11-00-00-cc33",
		workflow: "decompose",
		input: "decompose this",
		ts: "2026-06-03T11:00:00Z",
		v: STATE_SCHEMA_VERSION,
	};

	// The SITE's `done` reads the FOLDED verdict's `pass`; each member's `pred`
	// reads its own `{ done }` — the two predicates are deliberately distinct.
	const panelDone = (v: Output) => Boolean((v.data as { pass?: boolean }).pass);
	const panelFeed = ({ verdict, round }: { verdict: Output; round: number }) =>
		`refine round=${round} pass=${(verdict.data as { pass?: boolean }).pass}`;

	/** breakdown (assess × 3-judge panel; start) → consume. */
	const panelWf: Workflow = {
		name: "decompose",
		start: "breakdown",
		stages: {
			breakdown: produces({
				outcome: transcriptOutcome("tasks"),
				loop: assess({
					judge: panel({
						members: [
							judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
							judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
							judge({ skill: "grade-c", outcome: verdictOutcome("verdict-c") }),
						],
						fold: majority((v) => Boolean((v.data as { done?: boolean }).done)),
					}),
					done: panelDone,
					feedForward: panelFeed,
				}),
			}),
			consume: acts(),
		},
		edges: { breakdown: "consume", consume: "stop" },
	} as Workflow;

	const taskOutput = (round: number, num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(`.rpiv/artifacts/tasks/t${round}.md`), role: "primary" }],
		data: {},
		meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
	});

	const produceRow = (round: number, num: number, status: WorkflowStage["status"] = "completed"): WorkflowStage => ({
		session: null,
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

	const memberRow = (round: number, m: number, num: number, isDone: boolean): WorkflowStage => ({
		session: null,
		stageNumber: num,
		stage: `breakdown (r${round}·judge#${m})`,
		skill: `grade-${"abc"[m]}`,
		status: "completed",
		ts: `t${num}`,
		parent: "breakdown",
		role: "judge",
		unitId: `r${round}·judge#${m}`,
		unitIndex: round,
		output: {
			kind: "artifacts",
			artifacts: [{ handle: fsHandle(`.rpiv/verdicts/v${round}${"abc"[m]}.json`), role: "primary" }],
			data: { done: isDone },
			meta: { stage: "breakdown", stageNumber: num, ts: "", runId: "" },
		},
	});

	function writeRun(stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	it("mid-panel resume: re-runs ONLY the pending member, folds all three verdicts, advances on the folded pass", async () => {
		// Round 0: producer + members a, b graded; the process died before member c.
		writeRun([produceRow(0, 1), memberRow(0, 0, 2, true), memberRow(0, 1, 3, true)]);
		// Member c grades not-done → majority(2-of-3) still passes ⇒ done, no retry.
		writeFile(".rpiv/verdicts/v0c.json", JSON.stringify({ done: false }));
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] }, // ONLY member c re-runs
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: panelWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// Members a + b replayed from the trail (no re-grade); only c re-dispatched,
		// then the recomputed fold passed → straight to consume (no producer re-run).
		expect(chain.sentMessages).toEqual([
			"/skill:grade-c .rpiv/artifacts/tasks/t0.md",
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);
		// Member c's row landed after the two replayed members — one panel round total.
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.filter((r) => r.role === "judge").map((r) => r.unitId)).toEqual([
			"r0·judge#0",
			"r0·judge#1",
			"r0·judge#2",
		]);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("mid-panel resume drives a RETRY when the recomputed fold fails (unanimous veto via majority miss)", async () => {
		// Round 0: members a (done), b (not-done) graded; died before c. If c is also
		// not-done, majority is 1-of-3 → fail ⇒ feedForward + a round-1 producer.
		writeRun([produceRow(0, 1), memberRow(0, 0, 2, true), memberRow(0, 1, 3, false)]);
		writeFile(".rpiv/verdicts/v0c.json", JSON.stringify({ done: false })); // 1-of-3 → fold fails
		writeFile(".rpiv/verdicts/v1a.json", JSON.stringify({ done: true }));
		writeFile(".rpiv/verdicts/v1b.json", JSON.stringify({ done: true }));
		writeFile(".rpiv/verdicts/v1c.json", JSON.stringify({ done: true })); // unanimous → round 1 passes
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] }, // member c (round 0)
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] }, // round-1 producer
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1c.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: panelWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		// c re-runs and folds to fail → feedForward carries the FOLDED verdict into
		// round 1 (all three members re-grade), which passes → consume.
		expect(chain.sentMessages).toEqual([
			"/skill:grade-c .rpiv/artifacts/tasks/t0.md",
			"/skill:breakdown refine round=0 pass=false",
			"/skill:grade-a .rpiv/artifacts/tasks/t1.md",
			"/skill:grade-b .rpiv/artifacts/tasks/t1.md",
			"/skill:grade-c .rpiv/artifacts/tasks/t1.md",
			"/skill:consume .rpiv/artifacts/tasks/t1.md",
		]);
	});
});

describe("loop-resume — verify", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-10_22-00-00-bb22",
		workflow: "gated",
		input: "build it",
		ts: "2026-06-10T22:00:00Z",
		v: STATE_SCHEMA_VERSION,
	};

	const pass = (v: Output) => Boolean((v.data as { done?: boolean }).done);
	const vFeedForward = ({ verdict, round }: { verdict: Output; round: number }) =>
		`fix round=${round} fb=${(verdict.data as { feedback?: string }).feedback}`;

	const gatedWf = (max = 3): Workflow =>
		({
			name: "gated",
			start: "build",
			stages: {
				build: produces({
					outcome: transcriptOutcome("impl"),
					verify:
						max === 1
							? verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done: pass })
							: verify({
									judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
									done: pass,
									feedForward: vFeedForward,
									max,
								}),
				}),
				consume: acts(),
			},
			edges: { build: "consume", consume: "stop" },
		}) as Workflow;

	const writeVerdict = (n: number, isDone: boolean, feedback = `fb${n}`): string => {
		const rel = `.rpiv/verdicts/v${n}.json`;
		writeFile(rel, JSON.stringify({ done: isDone, feedback }));
		return rel;
	};

	const implOutput = (attempt: number, num: number): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(`.rpiv/artifacts/impl/i${attempt}.md`), role: "primary" }],
		data: {},
		meta: { stage: "build", stageNumber: num, ts: "", runId: "" },
	});

	const verdictOutput = (attempt: number, num: number, isDone: boolean): Output => ({
		kind: "artifacts",
		artifacts: [{ handle: fsHandle(`.rpiv/verdicts/v${attempt}.json`), role: "primary" }],
		data: { done: isDone, feedback: `fb${attempt}` },
		meta: { stage: "build", stageNumber: num, ts: "", runId: "" },
	});

	const attemptRow = (attempt: number, num: number, status: WorkflowStage["status"] = "completed"): WorkflowStage => ({
		session: null,
		stageNumber: num,
		stage: `build (a${attempt}·attempt)`,
		skill: "build",
		status,
		ts: `t${num}`,
		parent: "build",
		role: "produce",
		unitIndex: attempt,
		...(status === "completed" ? { output: implOutput(attempt, num) } : { errMsg: "boom" }),
	});

	const verdictRow = (attempt: number, num: number, isDone: boolean): WorkflowStage => ({
		session: null,
		stageNumber: num,
		stage: `build (a${attempt}·verify)`,
		skill: "grade",
		status: "completed",
		ts: `t${num}`,
		parent: "build",
		role: "verify",
		unitIndex: attempt,
		output: verdictOutput(attempt, num, isDone),
	});

	function writeRun(stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	it("pending verify: a completed-attempt trailer grades it, then advances on pass (no attempt re-run)", async () => {
		writeRun([attemptRow(0, 1)]); // died after the attempt, before the verify
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] }, // verify attempt 0
				{ branch: [mockAssistantMessage("consumed")] }, // consume
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: gatedWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "consume", status: "completed" });
	});

	it("recovered fail verdict: the next attempt runs with feedForward (no re-grade of attempt 0)", async () => {
		writeRun([attemptRow(0, 1), verdictRow(0, 2, false)]);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] }, // attempt 1
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] }, // verify attempt 1
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: gatedWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:build fix round=0 fb=fb0",
			"/skill:grade .rpiv/artifacts/impl/i1.md",
			"/skill:consume .rpiv/artifacts/impl/i1.md",
		]);
	});

	it("pass fast-advance: a passing verdict trailer goes straight downstream, zero re-runs", async () => {
		writeRun([attemptRow(0, 1), verdictRow(0, 2, true)]);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("consumed")] }],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: gatedWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual(["/skill:consume .rpiv/artifacts/impl/i0.md"]);
	});

	it("pass-predicate drift: a recorded fail followed by a retry row, with `pass` now true → terminal failure", async () => {
		const driftedWf = {
			...gatedWf(),
			stages: {
				build: produces({
					outcome: transcriptOutcome("impl"),
					verify: verify({
						judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
						done: () => true, // drifted — the run recorded a retry after this verdict
						feedForward: vFeedForward,
						max: 3,
					}),
				}),
				consume: acts(),
			},
		} as Workflow;
		writeRun([attemptRow(0, 1), verdictRow(0, 2, false), attemptRow(1, 3, "failed")]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: driftedWf, header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/deterministic/);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "build", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});

	it("gate-only recovered fail: max 1 + a failing verdict trailer → verification-failed halt, zero dispatch", async () => {
		writeRun([attemptRow(0, 1), verdictRow(0, 2, false)]);
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await resumeWorkflow(chain.ctx, { workflow: gatedWf(1), header, ref: "@x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Verification failed for "build"/);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows[rows.length - 1]).toMatchObject({ stage: "build", status: "failed" });
		expect(chain.sentMessages).toEqual([]);
	});

	it("verify × reads: a failed attempt-0 trailer re-runs with the FROZEN labelled-flag arg", async () => {
		const readsWf: Workflow = {
			name: "gated",
			start: "design",
			stages: {
				design: produces({ outcome: transcriptOutcome("design") }),
				build: produces({
					outcome: transcriptOutcome("impl"),
					reads: ["design"],
					verify: verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done: pass }),
				}),
				consume: acts(),
			},
			edges: { design: "build", build: "consume", consume: "stop" },
		} as Workflow;
		writeRun([
			{
				session: null,
				stageNumber: 1,
				stage: "design",
				skill: "design",
				status: "completed",
				ts: "t1",
				output: {
					kind: "artifacts",
					artifacts: [{ handle: fsHandle(".rpiv/artifacts/design/d0.md"), role: "primary" }],
					data: {},
					meta: { stage: "design", stageNumber: 1, ts: "", runId: "" },
				},
			},
			attemptRow(0, 2, "failed"), // attempt 0 died — resume re-runs it with the frozen entry arg
		]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: readsWf, header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:build --design .rpiv/artifacts/design/d0.md",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
	});
});

// ===========================================================================
// Prompt dispatch — assess/verify × prompt resume paths
// ===========================================================================

describe("loop-resume — prompt dispatch", () => {
	const header: WorkflowHeader = {
		runId: "2026-06-10_23-30-00-cc33",
		workflow: "gated-prompt",
		input: "build it",
		ts: "2026-06-10T23:30:00Z",
		v: STATE_SCHEMA_VERSION,
	};

	const pass = (v: Output) => Boolean((v.data as { done?: boolean }).done);

	const promptWf = (max = 3): Workflow =>
		({
			name: "gated-prompt",
			start: "kickoff",
			stages: {
				kickoff: acts(),
				build: produces({
					outcome: transcriptOutcome("impl"),
					prompt: "draft the impl",
					verify:
						max === 1
							? verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done: pass })
							: verify({
									judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
									done: pass,
									feedForward: ({ verdict, round }) =>
										`rewrite attempt=${round + 1} fb=${(verdict.data as { feedback?: string }).feedback}`,
									max,
								}),
				}),
				consume: acts(),
			},
			edges: { kickoff: "build", build: "consume", consume: "stop" },
		}) as Workflow;

	const writeVerdict = (n: number, isDone: boolean, feedback = `fb${n}`): void => {
		writeFile(`.rpiv/verdicts/v${n}.json`, JSON.stringify({ done: isDone, feedback }));
	};

	const kickoffRow = (): WorkflowStage => ({
		session: null,
		stageNumber: 1,
		stage: "kickoff",
		skill: "kickoff",
		status: "completed",
		ts: "t1",
		output: {
			kind: "side-effect",
			artifacts: [],
			data: {},
			meta: { stage: "kickoff", stageNumber: 1, ts: "", runId: "" },
		},
	});

	const attemptRow = (attempt: number, num: number, status: WorkflowStage["status"] = "completed"): WorkflowStage => ({
		session: null,
		stageNumber: num,
		stage: `build (a${attempt}·attempt)`,
		skill: "build",
		status,
		ts: `t${num}`,
		parent: "build",
		role: "produce",
		unitIndex: attempt,
		...(status === "completed"
			? {
					output: {
						kind: "artifacts",
						artifacts: [{ handle: fsHandle(`.rpiv/artifacts/impl/i${attempt}.md`), role: "primary" }],
						data: {},
						meta: { stage: "build", stageNumber: num, ts: "", runId: "" },
					} as Output,
				}
			: { errMsg: "boom" }),
	});

	const verdictRow = (attempt: number, num: number, isDone: boolean): WorkflowStage => ({
		session: null,
		stageNumber: num,
		stage: `build (a${attempt}·verify)`,
		skill: "grade",
		status: "completed",
		ts: `t${num}`,
		parent: "build",
		role: "verify",
		unitIndex: attempt,
		output: {
			kind: "artifacts",
			artifacts: [{ handle: fsHandle(`.rpiv/verdicts/v${attempt}.json`), role: "primary" }],
			data: { done: isDone, feedback: `fb${attempt}` },
			meta: { stage: "build", stageNumber: num, ts: "", runId: "" },
		} as Output,
	});

	function writeRun(stages: WorkflowStage[]): void {
		writeHeader(tmpDir, header);
		for (const s of stages) appendStage(tmpDir, header.runId, s);
	}

	it("pending verify on a prompt stage: grades the recovered attempt, advances on pass", async () => {
		writeRun([kickoffRow(), attemptRow(0, 2)]); // died after attempt 0, before its verdict
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: promptWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
	});

	it("recovered fail verdict on a prompt stage: attempt 1's message is feedForward's output RAW", async () => {
		writeRun([kickoffRow(), attemptRow(0, 2), verdictRow(0, 3, false)]);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: promptWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"rewrite attempt=1 fb=fb0",
			"/skill:grade .rpiv/artifacts/impl/i1.md",
			"/skill:consume .rpiv/artifacts/impl/i1.md",
		]);
	});

	it("attempt-0 re-run with NO upstream primary: re-resolves the stage prompt — no false refusal", async () => {
		// `kickoff` is an acts stage with no outcome — the rolling primary is
		// UNSET when `build` (non-start, prompt-dispatch) re-enters at attempt 0.
		// The entryArgs authority freezes "" for prompt stages, so the fold must
		// NOT refuse with the missing-artifact message; the driver re-resolves
		// the stage's own prompt instead.
		writeRun([kickoffRow(), attemptRow(0, 2, "failed")]);
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await resumeWorkflow(chain.ctx, { workflow: promptWf(), header, ref: "@x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"draft the impl",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
	});
});
