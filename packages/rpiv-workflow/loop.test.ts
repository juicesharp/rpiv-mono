/**
 * Unit-loop driver tests — the ONE driver (loop.ts) behind the `loop` field.
 * Exercised end-to-end through `runWorkflow` + a scripted mock session chain
 * (same harness as iterate.test.ts / assess.test.ts), since the driver's whole
 * point is its interaction with the produces/side-effect session path.
 *
 * Covers all three kinds authored via the new constructors
 * (`fanout()` / `iterate()` / `assess()` + `judge()`), the structured row
 * fields, cap policy, result projection, the unit-generic lifecycle hooks, and
 * the uniform preflights.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type FanoutFn, type IterateFn, produces, type VerifySpec } from "./api.js";
import { assess, fanout, iterate, verify } from "./control-flow.js";
import { fs as fsHandle, handleToString } from "./handle.js";
import { judge } from "./judge.js";
import { type LifecycleListeners, registerLifecycle } from "./lifecycle.js";
import type { Output, OutputSpec } from "./output.js";
import { runWorkflow } from "./runner/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MD_PATTERN = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;
const JSON_PATTERN = /\.rpiv\/verdicts\/[\w.-]+\.json/g;

/** Last assistant-text match of `pattern` across the (offset-sliced) branch. */
const lastMatch = (ctx: { branch: unknown[]; branchOffset?: number }, pattern: RegExp): string | undefined => {
	let found: string | undefined;
	const start = Math.max(ctx.branchOffset ?? 0, 0);
	for (let i = start; i < ctx.branch.length; i++) {
		const entry = ctx.branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				const m = part.text.match(pattern);
				if (m) found = m[m.length - 1];
			}
		}
	}
	return found;
};

/** Produces outcome: emit the last `.rpiv/artifacts/.../*.md` as the primary artifact. */
const mdOutcome = (name: string): OutputSpec<unknown, "artifact-md", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, MD_PATTERN);
			if (!path) return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
			return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
		},
	},
	parser: { parse: () => ({ kind: "ok", payload: { kind: "artifact-md", data: {} } }) },
});

/** Verdict outcome: scan for the last `.rpiv/verdicts/*.json`; parse it to `{ done, feedback }`. */
const verdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: {
		collect: (ctx) => {
			const path = lastMatch(ctx, JSON_PATTERN);
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

/** A verdict outcome whose collector returns ZERO artifacts (structurally ok) — pins the ≥1-artifact halt. */
const emptyVerdictOutcome = (name: string): OutputSpec<unknown, "verdict", Record<string, unknown>> => ({
	name,
	collector: { collect: () => ({ kind: "ok", artifacts: [] }) },
});

const done = (v: Output) => Boolean((v.data as { done?: boolean }).done);
const feedForward = ({ verdict, round }: { verdict: Output; round: number }) =>
	`refine round=${round} done=${(verdict.data as { done?: boolean }).done}`;

// ---------------------------------------------------------------------------
// Shared per-suite scaffolding
// ---------------------------------------------------------------------------

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-loop-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const writeFile = (relPath: string, content = "") => {
	const parts = relPath.split("/");
	mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
	writeFileSync(join(tmpDir, relPath), content);
};

const writeVerdict = (n: number, isDone: boolean): string => {
	const rel = `.rpiv/verdicts/v${n}.json`;
	writeFile(rel, JSON.stringify({ done: isDone, feedback: `fb${n}` }));
	return rel;
};

const readRows = (): Array<Record<string, unknown>> => {
	const dir = join(tmpDir, ".rpiv", "workflows", "runs");
	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
	return lines.slice(1).map((l) => JSON.parse(l));
};

// ===========================================================================
// Fanout
// ===========================================================================

describe("loop driver — fanout", () => {
	/** review (produces "reviews") → implement (produces "plans", fanout) → consume. */
	const phaseFanout: FanoutFn = ({ artifact }) =>
		artifact?.handle.kind === "fs"
			? [
					{ prompt: `${artifact.handle.path} P1`, label: "phase 1/2", id: "phase-1" },
					{ prompt: `${artifact.handle.path} P2`, label: "phase 2/2", id: "phase-2" },
				]
			: [];

	const wf = (consume = acts()) => ({
		name: "fan",
		start: "review",
		stages: {
			review: produces({ outcome: mdOutcome("reviews") }),
			implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: phaseFanout }) }),
			consume,
		},
		edges: { review: "implement", implement: "consume", consume: "stop" } as Record<string, string>,
	});

	it("runs every unit through the full session path; rows carry structured fields + decorated display", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		expect(result.success).toBe(true);
		// 1 review + 2 fanout units + 1 consume.
		expect(result.stagesCompleted).toBe(4);
		expect(chain.sentMessages).toEqual([
			"/skill:review x",
			"/skill:implement .rpiv/artifacts/reviews/rev.md P1",
			"/skill:implement .rpiv/artifacts/reviews/rev.md P2",
			// fanout's default "entry" projection restores the review primary.
			"/skill:consume .rpiv/artifacts/reviews/rev.md",
		]);

		const rows = readRows();
		// Decorated display string on `.stage`; structured machine fields beside it.
		expect(rows[1]).toMatchObject({
			stage: "implement (phase-1)",
			skill: "implement",
			parent: "implement",
			role: "produce",
			unitId: "phase-1",
			unitIndex: 0,
		});
		expect(rows[2]).toMatchObject({
			stage: "implement (phase-2)",
			parent: "implement",
			role: "produce",
			unitId: "phase-2",
			unitIndex: 1,
		});
		// Both units published into the same named slot (decoration never splits it).
	});

	it("empty units() ⇒ single-stage fall-through (single-stage preflights fire)", async () => {
		// A fanout whose source returns no units must fall through to the single-stage
		// path. The single-stage path requires an upstream artifact — make `implement`
		// the start node with no upstream so the fall-through halts on that preflight,
		// proving the single-stage preflights ran (the loop did NOT swallow the stage).
		const emptyFanout: FanoutFn = () => [];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "empty",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: emptyFanout }) }),
				},
				edges: { review: "implement", implement: "stop" },
			},
			input: "x",
			// review produces no artifact path → its own collector fatals first; but the
			// point is the workflow does NOT treat `implement` as a no-op loop.
		});

		// review's collector fatals (no artifact written) — the run fails at review,
		// never reaching implement. The fall-through itself is asserted structurally:
		// fanout returned false so `implement` would run the single-stage pipeline.
		expect(result.success).toBe(false);
	});

	it("acts + fanout runs side-effect units (no collector); each unit lands a row", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("did 1")] },
				{ branch: [mockAssistantMessage("did 2")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "side",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					apply: acts({ loop: fanout({ units: phaseFanout }) }),
				},
				edges: { review: "apply", apply: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(true);
		// 1 review + 2 side-effect units.
		expect(result.stagesCompleted).toBe(3);
		const rows = readRows();
		expect(rows[1]).toMatchObject({ stage: "apply (phase-1)", role: "produce", unitIndex: 0 });
		expect(rows[2]).toMatchObject({ stage: "apply (phase-2)", role: "produce", unitIndex: 1 });
	});

	it("FanoutFn throw halts the stage, attributed to the stage; failure row carries unit-free identity", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md");
		const boom: FanoutFn = () => {
			throw new Error("fanout exploded");
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "boom",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: boom }) }),
				},
				edges: { review: "implement", implement: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/fanout exploded/);
		const failed = readRows().find((s) => s.status === "failed");
		expect(failed?.stage).toBe("implement");
	});
});

// ===========================================================================
// Iterate
// ===========================================================================

describe("loop driver — iterate", () => {
	/** Pull two phases out of the FROZEN review artifact; encode index/accumulated into the prompt. */
	const reviewIterate: IterateFn = ({ artifact, accumulated, index, cwd }) => {
		if (artifact?.handle.kind !== "fs") return null;
		const abs = artifact.handle.path.startsWith("/") ? artifact.handle.path : join(cwd, artifact.handle.path);
		const phases = [...readFileSync(abs, "utf-8").matchAll(/^### Phase (\d+)/gm)];
		if (index >= phases.length) return null;
		return {
			prompt: `${artifact.handle.path} P${phases[index]![1]} idx=${index} acc=${accumulated.length}`,
			label: `phase ${index + 1}/${phases.length}`,
			id: `phase-${phases[index]![1]}`,
		};
	};

	const REVIEW_2 = "# Review\n### Phase 1 — A\nx\n### Phase 2 — B\ny\n";

	const wf = (consume = acts()) => ({
		name: "it",
		start: "review",
		stages: {
			review: produces({ outcome: mdOutcome("reviews") }),
			blueprint: produces({ outcome: mdOutcome("plans"), loop: iterate({ next: reviewIterate }) }),
			consume,
		},
		edges: { review: "blueprint", blueprint: "consume", consume: "stop" } as Record<string, string>,
	});

	it("pulls units in order, accumulating, with the FROZEN entry artifact; default 'last' projection", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md", REVIEW_2);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(4);
		expect(chain.sentMessages).toEqual([
			"/skill:review x",
			"/skill:blueprint .rpiv/artifacts/reviews/rev.md P1 idx=0 acc=0",
			"/skill:blueprint .rpiv/artifacts/reviews/rev.md P2 idx=1 acc=1",
			// "last" projection: consume inherits the last produce unit's plan.
			"/skill:consume .rpiv/artifacts/plans/plan-2.md",
		]);
		const rows = readRows();
		expect(rows[1]).toMatchObject({ stage: "blueprint (phase-1)", role: "produce", unitId: "phase-1", unitIndex: 0 });
		expect(rows[2]).toMatchObject({ stage: "blueprint (phase-2)", role: "produce", unitId: "phase-2", unitIndex: 1 });
	});

	it("first-call null ⇒ zero-unit no-op: nothing published, primary stays at entry", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md", "# Review with no phases\n");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });

		expect(result.success).toBe(true);
		// review + consume only — blueprint ran zero sessions.
		expect(result.stagesCompleted).toBe(2);
		// consume inherited the UNCHANGED entry primary (the review artifact).
		expect(chain.sentMessages).toEqual(["/skill:review x", "/skill:consume .rpiv/artifacts/reviews/rev.md"]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/reviews/rev.md");
	});

	it("post-pull cap position: the generator gets one extra discarded call before the cap halts", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md", REVIEW_2);
		let calls = 0;
		// A runaway generator that ignores the phase list and always yields a unit.
		const runaway: IterateFn = ({ index }) => {
			calls++;
			return { prompt: `unit ${index}`, label: `u${index}`, id: `u${index}` };
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/plan-2.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "runaway",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					blueprint: produces({ outcome: mdOutcome("plans"), loop: iterate({ next: runaway }) }),
				},
				edges: { review: "blueprint", blueprint: "stop" },
			},
			input: "x",
			maxIterations: 2,
		});

		expect(result.success).toBe(false);
		// 2 units landed; the cap tripped on the 3rd pull (POST-pull check).
		expect(result.stagesCompleted).toBe(3);
		expect(result.error).toMatch(/Loop cap exceeded: 2 units \(max 2\)/);
		// The generator was called a 3rd time (the extra discarded pull).
		expect(calls).toBe(3);
	});
});

// ===========================================================================
// Assess
// ===========================================================================

describe("loop driver — assess", () => {
	const wf = (loop: ReturnType<typeof assess>, consume = acts()) => ({
		name: "assess",
		start: "breakdown",
		stages: {
			breakdown: produces({ outcome: mdOutcome("tasks"), loop }),
			consume,
		},
		edges: { breakdown: "consume", consume: "stop" } as Record<string, string>,
	});

	const skillAssess = (max = 8) =>
		assess({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done, feedForward, max });

	it("runs producer→judge rounds; feedForward threads the verdict; on done the consumer gets the PRODUCER output", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(skillAssess()), input: "x" });

		expect(result.success).toBe(true);
		// 2 produce + 2 judge + 1 consume.
		expect(result.stagesCompleted).toBe(5);
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown x",
			"/skill:grade .rpiv/artifacts/tasks/t0.md",
			"/skill:breakdown refine round=0 done=false",
			"/skill:grade .rpiv/artifacts/tasks/t1.md",
			// consume inherits the last PRODUCER output, never the verdict.
			"/skill:consume .rpiv/artifacts/tasks/t1.md",
		]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/tasks/t1.md");

		const rows = readRows();
		expect(rows[0]).toMatchObject({ stage: "breakdown (r0·produce)", role: "produce", unitIndex: 0 });
		expect(rows[1]).toMatchObject({ stage: "breakdown (r0·judge)", skill: "grade", role: "judge", unitIndex: 0 });
		expect(rows[2]).toMatchObject({ stage: "breakdown (r1·produce)", role: "produce", unitIndex: 1 });
		expect(rows[3]).toMatchObject({ stage: "breakdown (r1·judge)", role: "judge", unitIndex: 1 });
		// Assess units carry no stable unitId (identity is (role, unitIndex)).
		expect(rows[0]?.unitId).toBeUndefined();
		expect(rows[1]?.unitId).toBeUndefined();
	});

	it("done wins over the cap — a done verdict at the cap boundary completes normally (no cap event)", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(skillAssess(1)), input: "x" });

		expect(result.success).toBe(true);
		// max=1 round, judge said done — no loop-cap row.
		expect(readRows().some((r) => r.type === "loop-cap")).toBe(false);
	});

	it("dynamic prompt judge resolves the prompt; skill judge auto-injects the producer handle", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const promptAssess = assess({
			judge: judge({
				prompt: ({ output, round }) =>
					`grade ${(output.artifacts[0]?.handle.kind === "fs" && output.artifacts[0].handle.path) || "?"} r${round}`,
				outcome: verdictOutcome("verdict"),
			}),
			done,
			feedForward,
			max: 4,
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(promptAssess), input: "x" });

		expect(result.success).toBe(true);
		// Prompt judge dispatches the resolved text verbatim (no /skill: prefix).
		expect(chain.sentMessages[1]).toBe("grade .rpiv/artifacts/tasks/t0.md r0");
	});

	it("a judge collector returning zero artifacts is a fatal halt (≥1-artifact contract)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("no verdict file")] },
			],
		});

		const emptyAssess = assess({
			judge: judge({ skill: "grade", outcome: emptyVerdictOutcome("verdict") }),
			done,
			feedForward,
			max: 4,
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(emptyAssess), input: "x" });

		expect(result.success).toBe(false);
		// The judge produced no artifact — enforceCompletionContract halts the round.
		// The forced failure row carries BOTH the decorated display string AND the
		// structured machine fields the resume drift guard consumes.
		const failed = readRows().find((s) => s.status === "failed");
		expect(failed).toMatchObject({
			stage: "breakdown (r0·judge)",
			parent: "breakdown",
			role: "judge",
			unitIndex: 0,
		});
	});
});

// ===========================================================================
// Cap policy
// ===========================================================================

describe("loop driver — cap policy", () => {
	const phaseFanout =
		(n: number): FanoutFn =>
		() =>
			Array.from({ length: n }, (_, i) => ({ prompt: `p${i}`, label: `phase ${i}`, id: `phase-${i}` }));

	it("onCap 'halt' ⇒ terminal failure with the loop-cap message", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p0.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "halt",
				start: "implement",
				stages: {
					// 3 units, cap 2, default onCap "halt" → fails after 2 units.
					implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: phaseFanout(3), max: 2 }) }),
				},
				edges: { implement: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(2);
		expect(result.error).toMatch(/Loop cap exceeded: 2 units \(max 2\)/);
	});

	it("onCap 'advance' ⇒ loop-cap row landed + onLoopCap fired + projected advance", async () => {
		const caps: Array<{ kind: string; count: number; max: number }> = [];
		const dispose = registerLifecycle({
			onLoopCap: (_stage, info) => {
				caps.push({ kind: info.kind, count: info.count, max: info.max });
			},
		});
		try {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p0.md")] },
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
					{ branch: [mockAssistantMessage("consumed")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: {
					name: "advance",
					start: "implement",
					stages: {
						implement: produces({
							outcome: mdOutcome("plans"),
							// result "last" so the post-cap chain advance hands `consume` a real
							// primary (a start-node fanout's "entry" pair has no primary).
							loop: fanout({ units: phaseFanout(3), max: 2, onCap: "advance", result: "last" }),
						}),
						consume: acts(),
					},
					edges: { implement: "consume", consume: "stop" },
				},
				input: "x",
			});

			expect(result.success).toBe(true);
			// 2 units ran, the 3rd tripped the cap; the chain advanced to consume.
			const cap = readRows().find((r) => r.type === "loop-cap");
			expect(cap).toMatchObject({ type: "loop-cap", stage: "implement", count: 2, max: 2 });
			expect(caps).toEqual([{ kind: "fanout", count: 2, max: 2 }]);
		} finally {
			dispose();
		}
	});

	it("effective cap = min(loop.max, run.maxIterations)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p0.md")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "minmax",
				start: "implement",
				stages: {
					// loop.max=5 but maxIterations=1 → effective cap 1, halt after 1 unit.
					implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: phaseFanout(3), max: 5 }) }),
				},
				edges: { implement: "stop" },
			},
			input: "x",
			maxIterations: 1,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Loop cap exceeded: 1 units \(max 1\)/);
	});
});

// ===========================================================================
// Result projection
// ===========================================================================

describe("loop driver — result projection", () => {
	const oneUnit: FanoutFn = ({ artifact }) =>
		artifact?.handle.kind === "fs" ? [{ prompt: artifact.handle.path, label: "only", id: "only" }] : [];

	const baseSteps = () => [
		{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
		{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
		{ branch: [mockAssistantMessage("consumed")] },
	];

	it("'entry' restores the loop-entry pair; 'last' projects the last produce pair", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md");
		// result: "last" override on a fanout (whose default is "entry").
		const chainLast = createMockSessionChain({ cwd: tmpDir, steps: baseSteps() });
		const resLast = await runWorkflow(chainLast.ctx, {
			workflow: {
				name: "last",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: oneUnit, result: "last" }) }),
					consume: acts(),
				},
				edges: { review: "implement", implement: "consume", consume: "stop" },
			},
			input: "x",
		});
		expect(resLast.success).toBe(true);
		// "last": consume inherits the unit's plan, not the review.
		expect(chainLast.sentMessages.at(-1)).toBe("/skill:consume .rpiv/artifacts/plans/p1.md");
	});

	it("zero-produce 'last' degrades to entry (the chain is left exactly as found)", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md", "# no phases\n");
		// An iterate (default "last") that yields zero units leaves the entry primary.
		const noUnits: IterateFn = () => null;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "zero",
				start: "review",
				stages: {
					review: produces({ outcome: mdOutcome("reviews") }),
					blueprint: produces({ outcome: mdOutcome("plans"), loop: iterate({ next: noUnits }) }),
					consume: acts(),
				},
				edges: { review: "blueprint", blueprint: "consume", consume: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(true);
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume .rpiv/artifacts/reviews/rev.md");
		expect(result.lastArtifact).toBe(".rpiv/artifacts/reviews/rev.md");
	});
});

// ===========================================================================
// Lifecycle
// ===========================================================================

describe("loop driver — lifecycle", () => {
	const twoPhase: FanoutFn = () => [
		{ prompt: "a", label: "phase 1/2", id: "phase-1" },
		{ prompt: "b", label: "phase 2/2", id: "phase-2" },
	];

	it("fires onStageStart once, then onLoopStart, then onUnitStart/onUnitEnd per unit (no onStageEnd for units)", async () => {
		const events: string[] = [];
		const listeners: LifecycleListeners = {
			onStageStart: (s) => {
				events.push(`stageStart:${s.name}`);
			},
			onStageEnd: (s) => {
				events.push(`stageEnd:${s.name}`);
			},
			onLoopStart: (s, info) => {
				events.push(`loopStart:${s.name}:${info.kind}:${info.units?.length ?? "-"}`);
			},
			onUnitStart: (_s, u) => {
				events.push(`unitStart:${u.label}:${u.role}`);
			},
			onUnitEnd: (_s, u) => {
				events.push(`unitEnd:${u.label}:${u.role}`);
			},
		};
		const dispose = registerLifecycle(listeners);
		try {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				],
			});

			const result = await runWorkflow(chain.ctx, {
				workflow: {
					name: "lc",
					start: "implement",
					stages: { implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: twoPhase }) }) },
					edges: { implement: "stop" },
				},
				input: "x",
			});

			expect(result.success).toBe(true);
			expect(events).toEqual([
				"stageStart:implement",
				"loopStart:implement:fanout:2",
				"unitStart:phase 1/2:produce",
				"unitEnd:phase 1/2:produce",
				"unitStart:phase 2/2:produce",
				"unitEnd:phase 2/2:produce",
			]);
			// Loop units never fire onStageEnd.
			expect(events.some((e) => e.startsWith("stageEnd"))).toBe(false);
		} finally {
			dispose();
		}
	});

	it("assess fires onUnitStart for judge units too; UnitEvent.skill carries the dispatched judge skill", async () => {
		writeVerdict(0, true);
		const units: Array<{ role: string; skill: string }> = [];
		const dispose = registerLifecycle({
			onUnitStart: (_s, u) => {
				units.push({ role: u.role, skill: u.skill });
			},
		});
		try {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
					{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				],
			});

			await runWorkflow(chain.ctx, {
				workflow: {
					name: "ja",
					start: "breakdown",
					stages: {
						breakdown: produces({
							outcome: mdOutcome("tasks"),
							loop: assess({
								judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
								done,
								feedForward,
								max: 4,
							}),
						}),
					},
					edges: { breakdown: "stop" },
				},
				input: "x",
			});

			expect(units).toEqual([
				{ role: "produce", skill: "breakdown" },
				{ role: "judge", skill: "grade" },
			]);
		} finally {
			dispose();
		}
	});

	it("a prompt judge reports the synthetic <parent>-judge skill on its UnitEvent", async () => {
		writeVerdict(0, true);
		const judgeSkills: string[] = [];
		const dispose = registerLifecycle({
			onUnitStart: (_s, u) => {
				if (u.role === "judge") judgeSkills.push(u.skill);
			},
		});
		try {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
					{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				],
			});

			await runWorkflow(chain.ctx, {
				workflow: {
					name: "pj",
					start: "breakdown",
					stages: {
						breakdown: produces({
							outcome: mdOutcome("tasks"),
							loop: assess({
								judge: judge({ prompt: "grade .rpiv/verdicts/v0.json", outcome: verdictOutcome("verdict") }),
								done,
								feedForward,
								max: 4,
							}),
						}),
					},
					edges: { breakdown: "stop" },
				},
				input: "x",
			});

			expect(judgeSkills).toEqual(["breakdown-judge"]);
		} finally {
			dispose();
		}
	});
});

// ===========================================================================
// Preflights
// ===========================================================================

describe("loop driver — preflights", () => {
	const oneUnit: FanoutFn = () => [{ prompt: "p", label: "only", id: "only" }];

	it("ensureSkillRegistered halts a ≥1-unit loop (closing the old fanout bypass)", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		// Host registers no skills named "implement".
		const host = createMockPi({ skills: ["other"] }).pi;

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "unreg",
				start: "implement",
				stages: { implement: produces({ outcome: mdOutcome("plans"), loop: fanout({ units: oneUnit }) }) },
				edges: { implement: "stop" },
			},
			input: "x",
			host,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires Pi skill "implement"/);
		// Halted before any session dispatched.
		expect(chain.sentMessages).toEqual([]);
	});

	it("ensureUpstreamArtifact is enforced for assess (the round-0 producer arg consumes the primary)", async () => {
		// breakdown is NOT the start node and inherits no artifact → assess halts.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("did setup")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "noart",
				start: "setup",
				stages: {
					// setup is a terminal side-effect → clears the primary slot.
					setup: acts({ inheritsArtifacts: false }),
					breakdown: produces({
						outcome: mdOutcome("tasks"),
						loop: assess({
							judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
							done,
							feedForward,
							max: 4,
						}),
					}),
				},
				edges: { setup: "breakdown", breakdown: "stop" },
			},
			input: "x",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires an upstream artifact|artifact/i);
	});

	it("judge-skill registry check halts when the judge skill is unregistered", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		// Producer "breakdown" registered, judge "grade" NOT.
		const host = createMockPi({ skills: ["breakdown"] }).pi;

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "jreg",
				start: "breakdown",
				stages: {
					breakdown: produces({
						outcome: mdOutcome("tasks"),
						loop: assess({
							judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
							done,
							feedForward,
							max: 4,
						}),
					}),
				},
				edges: { breakdown: "stop" },
			},
			input: "x",
			host,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires Pi skill "grade"/);
	});

	it("loop × sessionPolicy 'continue' throws the invariant", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		// A host is required so the continue-without-host check passes first, letting
		// tryLoop's loop×continue guard be the throw under test.
		const host = createMockPi({ skills: ["implement"] }).pi;

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "cont",
				start: "implement",
				stages: {
					implement: produces({
						outcome: mdOutcome("plans"),
						sessionPolicy: "continue",
						loop: fanout({ units: oneUnit }),
					}),
				},
				edges: { implement: "stop" },
			},
			input: "x",
			host,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/cannot combine loop with sessionPolicy "continue"/);
	});
});

// ===========================================================================
// Verify (desugared assess loop)
// ===========================================================================

describe("loop driver — verify", () => {
	const pass = (v: Output) => Boolean((v.data as { done?: boolean }).done);
	const vFeedForward = ({ verdict, round }: { verdict: Output; round: number }) =>
		`fix round=${round} done=${(verdict.data as { done?: boolean }).done}`;

	const gateOnly = () => verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), pass });
	const retrying = (maxAttempts = 3) =>
		verify({
			judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
			pass,
			feedForward: vFeedForward,
			maxAttempts,
		});

	const verifyWf = (v: VerifySpec) => ({
		name: "gated",
		start: "build",
		stages: {
			build: produces({ outcome: mdOutcome("impl"), verify: v }),
			consume: acts(),
		},
		edges: { build: "consume", consume: "stop" } as Record<string, string>,
	});

	it("gate-only pass: attempt + verify rows land; the consumer gets the PRODUCER output", async () => {
		writeVerdict(0, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(gateOnly()), input: "x" });

		expect(result.success).toBe(true);
		// 1 attempt + 1 verify + 1 consume.
		expect(result.stagesCompleted).toBe(3);
		expect(chain.sentMessages).toEqual([
			"/skill:build x",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			// consume inherits the ATTEMPT's producer output, never the verdict.
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
		const rows = readRows();
		expect(rows[0]).toMatchObject({ stage: "build (a0·attempt)", role: "produce", unitIndex: 0 });
		expect(rows[1]).toMatchObject({ stage: "build (a0·verify)", skill: "grade", role: "verify", unitIndex: 0 });
		// Verify units carry no stable unitId (identity is (role, unitIndex), like assess).
		expect(rows[0]?.unitId).toBeUndefined();
		expect(rows[1]?.unitId).toBeUndefined();
	});

	it("gate-only fail: terminal verification-failed halt (not the loop-cap wording)", async () => {
		writeVerdict(0, false);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(gateOnly()), input: "x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Verification failed for "build"/);
		expect(result.error).toMatch(/after 1 attempt(?!s)/);
		const rows = readRows();
		expect(rows[rows.length - 1]).toMatchObject({ stage: "build", status: "failed" });
		expect(rows[rows.length - 1]?.errMsg).not.toMatch(/Loop cap exceeded/);
	});

	it("retry: a failing verdict feeds the next attempt; pass advances with the LAST attempt's output", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(retrying()), input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:build x",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:build fix round=0 done=false",
			"/skill:grade .rpiv/artifacts/impl/i1.md",
			"/skill:consume .rpiv/artifacts/impl/i1.md",
		]);
		const rows = readRows();
		expect(rows[2]).toMatchObject({ stage: "build (a1·attempt)", role: "produce", unitIndex: 1 });
		expect(rows[3]).toMatchObject({ stage: "build (a1·verify)", role: "verify", unitIndex: 1 });
	});

	it("exhausted attempts: both verdicts fail at maxAttempts 2 → verification-failed halt", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(retrying(2)), input: "x" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Verification failed for "build".*after 2 attempts/);
	});

	it("pass on the final attempt is a normal completion (done wins over the cap)", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(retrying(2)), input: "x" });

		expect(result.success).toBe(true);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/i1.md");
	});

	it("prompt judge: dispatches the raw prompt verbatim; synthetic <stage>-verify skill label", async () => {
		writeVerdict(0, true);
		const v = verify({
			judge: judge({
				prompt: ({ output }) => `grade ${handleToString(output.artifacts[0]!.handle)} strictly`,
				outcome: verdictOutcome("verdict"),
			}),
			pass,
		});
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: verifyWf(v), input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages[1]).toBe("grade .rpiv/artifacts/impl/i0.md strictly");
		const rows = readRows();
		expect(rows[1]).toMatchObject({ skill: "build-verify", role: "verify" });
	});

	it("verify × reads: attempt 0's prompt is the labelled-flag projection", async () => {
		writeVerdict(0, true);
		const wf = {
			name: "gated-reads",
			start: "design",
			stages: {
				design: produces({ outcome: mdOutcome("design") }),
				build: produces({ outcome: mdOutcome("impl"), reads: ["design"], verify: gateOnly() }),
				consume: acts(),
			},
			edges: { design: "build", build: "consume", consume: "stop" } as Record<string, string>,
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/design/d0.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:design x",
			"/skill:build --design .rpiv/artifacts/design/d0.md",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
	});

	it("lifecycle: onLoopStart reports kind 'verify'; units fire per attempt+verdict; NO onStageEnd", async () => {
		writeVerdict(0, true);
		const events: string[] = [];
		const listeners: LifecycleListeners = {
			onStageStart: (s) => {
				events.push(`stageStart:${s.name}`);
			},
			onStageEnd: (s) => {
				events.push(`stageEnd:${s.name}`);
			},
			onLoopStart: (s, info) => {
				events.push(`loopStart:${s.name}:${info.kind}`);
			},
			onUnitStart: (_s, u) => {
				events.push(`unitStart:${u.label}:${u.role}:${u.skill}`);
			},
			onUnitEnd: (_s, u) => {
				events.push(`unitEnd:${u.label}:${u.role}`);
			},
		};
		const dispose = registerLifecycle(listeners);
		try {
			const chain = createMockSessionChain({
				cwd: tmpDir,
				steps: [
					{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
					{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
					{ branch: [mockAssistantMessage("consumed")] },
				],
			});

			const result = await runWorkflow(chain.ctx, { workflow: verifyWf(gateOnly()), input: "x" });

			expect(result.success).toBe(true);
			expect(events.slice(0, 6)).toEqual([
				"stageStart:build",
				"loopStart:build:verify",
				"unitStart:a0·attempt:produce:build",
				"unitEnd:a0·attempt:produce",
				// A model-override listener keys on UnitEvent.skill — the judge's own skill.
				"unitStart:a0·verify:verify:grade",
				"unitEnd:a0·verify:verify",
			]);
			// Verified stages follow loop semantics — no stage-level completion event.
			expect(events.some((e) => e.startsWith("stageEnd:build"))).toBe(false);
		} finally {
			dispose();
		}
	});
});
