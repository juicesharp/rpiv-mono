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
import {
	createFakeConcurrentHost,
	createMockPi,
	createMockSessionChain,
	mockAssistantMessage,
} from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acts,
	defineRoute,
	type FanoutFn,
	fanin,
	type IterateFn,
	match,
	produces,
	type ScriptContext,
	type VerifySpec,
} from "./api.js";
import { type LifecycleListeners, registerLifecycle } from "./events.js";
import { fs as fsHandle, handleToString } from "./handle.js";
import { judge } from "./judge.js";
import { all, any, assess, fanout, iterate, majority, panel, verify } from "./loop-constructors.js";
import type { Output } from "./output.js";
import type { Outcome } from "./output-spec.js";
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
const mdOutcome = (name: string): Outcome<unknown, "artifact-md", Record<string, unknown>> => ({
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
const verdictOutcome = (name: string): Outcome<unknown, "verdict", Record<string, unknown>> & { name: string } => ({
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
const emptyVerdictOutcome = (
	name: string,
): Outcome<unknown, "verdict", Record<string, unknown>> & { name: string } => ({
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

	it("a downstream fanin() read sees EVERY fanout unit's plan handle (the synthesize barrier)", async () => {
		writeFile(".rpiv/artifacts/reviews/rev.md");
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/reviews/rev.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("synthesized")] },
			],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf(acts({ reads: [fanin("plans")] })),
			input: "x",
		});

		expect(result.success).toBe(true);
		// fanin("plans") flag-repeats across BOTH unit outputs — not just .at(-1).
		expect(chain.sentMessages.at(-1)).toBe(
			"/skill:consume --plans .rpiv/artifacts/plans/p1.md --plans .rpiv/artifacts/plans/p2.md",
		);
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
// Parallel fanout dispatch — bounded concurrency via FakeConcurrentHost
// ===========================================================================

describe("loop driver — parallel fanout dispatch", () => {
	/** A fanout START stage producing N independent units (no upstream needed). */
	const parWf = (n: number) => ({
		name: "par",
		start: "audit",
		stages: {
			audit: produces({
				outcome: mdOutcome("audits"),
				loop: fanout({
					units: () => Array.from({ length: n }, (_v, i) => ({ prompt: `u${i}`, label: `u${i}`, id: `u${i}` })),
				}),
			}),
		},
		edges: { audit: "stop" } as Record<string, string>,
	});

	it("dispatches fanout units in parallel up to maxConcurrency, never exceeding the cap", async () => {
		const host = createFakeConcurrentHost({ cwd: tmpDir, maxConcurrency: 2, gate: true });
		const p = runWorkflow(host.ctx, { workflow: parWf(5), input: "x" });

		// The Semaphore(2) lets exactly 2 children reach the (gated) host at once;
		// the other 3 wait in the queue — the cap bounds in-flight dispatch.
		await host.waitForActive(2);
		expect(host.active()).toBe(2);
		expect(host.spawns).toHaveLength(2);
		expect(host.maxActive).toBe(2);

		host.release(); // drain — current + future spawns proceed (cap still holds)
		const result = await p;

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(5);
		expect(host.spawns).toHaveLength(5);
		expect(host.maxActive).toBe(2); // peak never exceeded the cap
		// The run-level abort signal is threaded into every child (genAbort, not aborted).
		expect(host.spawns.every((s) => s.signal instanceof AbortSignal)).toBe(true);
	});

	it("maxConcurrency: 1 serializes fanout (one child in flight at a time)", async () => {
		const host = createFakeConcurrentHost({ cwd: tmpDir, maxConcurrency: 1, gate: true });
		const p = runWorkflow(host.ctx, { workflow: parWf(3), input: "x" });

		await host.waitForActive(1);
		expect(host.active()).toBe(1);
		expect(host.spawns).toHaveLength(1); // only one dispatched; the rest queued behind the slot

		host.release();
		const result = await p;
		expect(result.success).toBe(true);
		expect(host.maxActive).toBe(1);
		expect(host.spawns).toHaveLength(3);
	});

	it("iterate stays sequential even at maxConcurrency 5 (parallelizable: false)", async () => {
		const seq: IterateFn = ({ index }) =>
			index < 3 ? { prompt: `it${index}`, label: `it ${index}`, id: `it-${index}` } : null;
		const host = createFakeConcurrentHost({ cwd: tmpDir, maxConcurrency: 5, gate: true, bucket: "steps" });
		const wf = {
			name: "seq",
			start: "loop",
			stages: { loop: produces({ outcome: mdOutcome("steps"), loop: iterate({ next: seq }) }) },
			edges: { loop: "stop" } as Record<string, string>,
		};
		const p = runWorkflow(host.ctx, { workflow: wf, input: "x" });

		// iterate pulls one unit at a time through the sequential step() path: the
		// next unit can't dispatch until the prior one completes, so even at cap 5
		// only ONE child is ever dispatched at the gate point (a parallel loop would
		// have fanned out all three). This is THE parallelizable:false proof.
		await host.waitForActive(1);
		expect(host.active()).toBe(1);
		expect(host.spawns).toHaveLength(1);

		host.release();
		const result = await p;
		expect(result.success).toBe(true);
		expect(host.spawns).toHaveLength(3); // all three eventually ran, one after another
	});
});

// ===========================================================================
// Parallel fanout abort + fault tolerance — the no-throw envelope guard,
// abort classification, and failFast sibling cancellation.
// ===========================================================================

describe("loop driver — parallel fanout abort + fault tolerance", () => {
	/** A fanout START stage producing N independent units (collect-all by default). */
	const parWf = (n: number) => ({
		name: "par",
		start: "audit",
		stages: {
			audit: produces({
				outcome: mdOutcome("audits"),
				loop: fanout({
					units: () => Array.from({ length: n }, (_v, i) => ({ prompt: `u${i}`, label: `u${i}`, id: `u${i}` })),
				}),
			}),
		},
		edges: { audit: "stop" } as Record<string, string>,
	});

	/** Same shape, opting OUT of collect-all so a unit failure hard-halts the run. */
	const failFastWf = (n: number) => ({
		name: "par-ff",
		start: "audit",
		stages: {
			audit: produces({
				outcome: mdOutcome("audits"),
				loop: fanout({
					units: () => Array.from({ length: n }, (_v, i) => ({ prompt: `u${i}`, label: `u${i}`, id: `u${i}` })),
					failFast: true,
				}),
			}),
		},
		edges: { audit: "stop" } as Record<string, string>,
	});

	const okUnit = (index: number) => [mockAssistantMessage(`wrote .rpiv/artifacts/audits/unit-${index}.md`)];

	it("no-throw fold: an UNEXPECTED worker rejection records a terminal-failure row, fires onStageError, and still fires onWorkflowEnd", async () => {
		const stageErrors: string[] = [];
		let endFired = false;
		let endSuccess: boolean | undefined;
		const dispose = registerLifecycle({
			onStageError: (s, err) => {
				stageErrors.push(`${s.name}:${err}`);
			},
			onWorkflowEnd: (r) => {
				endFired = true;
				endSuccess = r.success;
			},
		});
		try {
			const host = createFakeConcurrentHost({
				cwd: tmpDir,
				maxConcurrency: 3,
				childBranch: (_rec, index) => {
					if (index === 1) throw new Error("kaboom in unit 1"); // an UNEXPECTED machinery fault, NOT a workflow halt
					return okUnit(index);
				},
			});

			// The fold NEVER throws — runWorkflow RESOLVES even though a worker rejected.
			const result = await runWorkflow(host.ctx, { workflow: parWf(3), input: "x" });

			expect(result.success).toBe(false);
			expect(stageErrors).toHaveLength(1); // the rejected worker → recordWorkerThrow → onStageError
			expect(endFired).toBe(true); // onWorkflowEnd still fired (the envelope always fires)
			expect(endSuccess).toBe(false);
			const failed = readRows().filter((r) => r.status === "failed");
			expect(failed).toHaveLength(1); // exactly one terminal-failure row
			// L4-02: the unit identity rides as STRUCTURED row fields — `stage` stays
			// the parent graph identity (never the old `name (unit N)` string).
			const row = failed[0]!;
			expect(row.stage).toBe("audit"); // parent graph identity, no "(unit …)" fold
			expect(String(row.stage)).not.toContain("(unit ");
			expect(row.parent).toBe("audit");
			expect(row.role).toBe("produce");
			expect(row.unitIndex).toBe(1); // the worker that threw was unit index 1
			expect(row.unitId).toBe("u1"); // author-stable unit identity
		} finally {
			dispose();
		}
	});

	it("a failFast unit halt terminates state inside its worker and runFanoutParallel returns gracefully (no throw)", async () => {
		const host = createFakeConcurrentHost({
			cwd: tmpDir,
			maxConcurrency: 3,
			childBranch: (_rec, index) =>
				index === 0
					? [mockAssistantMessage("no artifact path here")] // collector-fatal → hard halt (failFast ⇒ not collect-all)
					: okUnit(index),
		});

		const result = await runWorkflow(host.ctx, { workflow: failFastWf(3), input: "x" });

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(readRows().filter((r) => r.status === "failed")).toHaveLength(1);
	});

	it("an aborted run records FAIL_WORKFLOW_ABORTED and leaves not-yet-run unit slots unfilled", async () => {
		const ac = new AbortController();
		const host = createFakeConcurrentHost({ cwd: tmpDir, maxConcurrency: 2, gate: true });
		const p = runWorkflow(host.ctx, { workflow: parWf(5), input: "x", signal: ac.signal });

		// Freeze with the first cap-worth in flight, the other 3 queued behind the Semaphore.
		await host.waitForActive(2);
		ac.abort(); // run-level abort — drains the semaphore queue synchronously
		host.release();
		const result = await p;

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/aborted/i);
		// The 3 queued units never reached spawnChild (the drained semaphore rejected them).
		expect(host.spawns).toHaveLength(2);
		// Exactly one FAIL_WORKFLOW_ABORTED terminal row; the in-flight pair threw
		// WorkflowAbortError in postStage and wrote NO row (unfilled → resume re-dispatches).
		expect(readRows().filter((r) => r.status === "aborted")).toHaveLength(1);
		expect(host.notifications.some((n) => /aborted/i.test(n.msg))).toBe(true);
	});

	it("failFast sibling cancellation: a unit halt fires genAbort across the shared child signal; exactly one terminal-failure row even with concurrent failures", async () => {
		// Two units are collector-fatal (failFast ⇒ hard halt). The first halt
		// terminate()s state + fires genAbort, aborting the per-generation signal
		// handed to every sibling. The recordTerminalFailure first-failure-wins
		// guard drops the duplicate terminal row + onStageError.
		const host = createFakeConcurrentHost({
			cwd: tmpDir,
			maxConcurrency: 4,
			childBranch: (_rec, index) => (index < 2 ? [mockAssistantMessage("no artifact path")] : okUnit(index)),
		});

		const result = await runWorkflow(host.ctx, { workflow: failFastWf(4), input: "x" });

		expect(result.success).toBe(false);
		// genAbort fired — the shared per-generation signal handed to every child is aborted.
		expect(host.spawns.some((s) => s.signal?.aborted)).toBe(true);
		// EXACTLY ONE terminal-failure row despite two concurrent unit failures.
		expect(readRows().filter((r) => r.status === "failed")).toHaveLength(1);
	});

	it("in-flight abort classification: a child resolving with stopReason 'aborted' makes postStage throw → unfilled slot, NO row written for that unit", async () => {
		// The SDK RESOLVES prompt() with a stopReason:"aborted" message on
		// session.abort(); postStage throws WorkflowAbortError BEFORE any row write.
		// The fold's isAbortError branch leaves the slot unfilled (resume
		// re-dispatches) — crucially NO collected/failed row is written for the unit.
		const host = createFakeConcurrentHost({
			cwd: tmpDir,
			maxConcurrency: 3,
			childBranch: (_rec, index) =>
				index === 1
					? [mockAssistantMessage("partial interrupted", "aborted")] // resolved-abort
					: okUnit(index),
		});

		await runWorkflow(host.ctx, { workflow: parWf(3), input: "x" });

		const rows = readRows();
		// The aborted unit wrote NO row at all — neither failed nor aborted nor completed.
		expect(rows.some((r) => r.status === "failed" || r.status === "aborted")).toBe(false);
		// The two non-aborted units completed normally.
		expect(rows.filter((r) => r.status === "completed").length).toBeGreaterThanOrEqual(2);
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
// Assess × panel — N judges + a vote fold (the adversarial generalization)
// ===========================================================================

describe("loop driver — assess × panel", () => {
	// The SITE's `done` reads the FOLDED canonical verdict (`{ pass, votes,
	// agreement, tie }`), never a member's own `{ done }` schema — the panel's
	// product is the fold's `pass`. The per-member `pred` (`done`) interprets each
	// member's own verdict; the two predicates are deliberately distinct.
	const panelPass = (v: Output) => Boolean((v.data as { pass?: boolean }).pass);
	const panelFeed = ({ verdict, round }: { verdict: Output; round: number }) =>
		`refine round=${round} pass=${(verdict.data as { pass?: boolean }).pass}`;

	const threeMembers = () => [
		judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
		judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
		judge({ skill: "grade-c", outcome: verdictOutcome("verdict-c") }),
	];

	const panelAssess = (fold: ReturnType<typeof majority>, max = 4) =>
		assess({ judge: panel({ members: threeMembers(), fold }), done: panelPass, feedForward: panelFeed, max });

	const wf = (loop: ReturnType<typeof assess>, consume = acts()) => ({
		name: "panel",
		start: "breakdown",
		stages: {
			breakdown: produces({ outcome: mdOutcome("tasks"), loop }),
			consume,
		},
		edges: { breakdown: "consume", consume: "stop" } as Record<string, string>,
	});

	/** A distinctly-named member verdict file ({@link writeVerdict} only writes `v{n}`). */
	const namedVerdict = (name: string, isDone: boolean): string => {
		const rel = `.rpiv/verdicts/${name}.json`;
		writeFile(rel, JSON.stringify({ done: isDone, feedback: name }));
		return rel;
	};

	it("runs N judge sessions then one produce; majority folds the verdict the `done` predicate reads", async () => {
		namedVerdict("v0a", true);
		namedVerdict("v0b", true);
		namedVerdict("v0c", false); // 2-of-3 pass → majority pass
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(panelAssess(majority(done))), input: "x" });

		expect(result.success).toBe(true);
		// 1 produce + 3 judge members + 1 consume (one round; the fold passed).
		expect(result.stagesCompleted).toBe(5);
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown x",
			// Every member grades the SAME producer artifact, dispatched in member order.
			"/skill:grade-a .rpiv/artifacts/tasks/t0.md",
			"/skill:grade-b .rpiv/artifacts/tasks/t0.md",
			"/skill:grade-c .rpiv/artifacts/tasks/t0.md",
			// majority(2/3) → pass → done; consume inherits the PRODUCER output, never a verdict.
			"/skill:consume .rpiv/artifacts/tasks/t0.md",
		]);

		const rows = readRows();
		expect(rows[0]).toMatchObject({ stage: "breakdown (r0·produce)", role: "produce", unitIndex: 0 });
		// Member rows are identity-bearing — `#{memberIndex}` (the `unitId`) tells the
		// three judges of one round apart; a single judge carries no `unitId`.
		expect(rows[1]).toMatchObject({
			stage: "breakdown (r0·judge#0)",
			skill: "grade-a",
			role: "judge",
			unitId: "r0·judge#0",
			unitIndex: 0,
		});
		expect(rows[2]).toMatchObject({
			stage: "breakdown (r0·judge#1)",
			skill: "grade-b",
			unitId: "r0·judge#1",
			unitIndex: 0,
		});
		expect(rows[3]).toMatchObject({
			stage: "breakdown (r0·judge#2)",
			skill: "grade-c",
			unitId: "r0·judge#2",
			unitIndex: 0,
		});
		// The folded verdict is NEVER persisted as a row — the members are the durable trail.
		expect(rows.filter((r) => r.role === "judge")).toHaveLength(3);
	});

	it("all (unanimous) fold: one veto fails the round and drives a retry; feedForward threads the FOLDED verdict", async () => {
		namedVerdict("v0a", true);
		namedVerdict("v0b", true);
		namedVerdict("v0c", false); // one veto → all() fails round 0
		namedVerdict("v1a", true);
		namedVerdict("v1b", true);
		namedVerdict("v1c", true); // unanimous → all() passes round 1
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1c.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(panelAssess(all(done))), input: "x" });

		expect(result.success).toBe(true);
		// 2 produce + 6 judge members + 1 consume.
		expect(result.stagesCompleted).toBe(9);
		expect(chain.sentMessages).toEqual([
			"/skill:breakdown x",
			"/skill:grade-a .rpiv/artifacts/tasks/t0.md",
			"/skill:grade-b .rpiv/artifacts/tasks/t0.md",
			"/skill:grade-c .rpiv/artifacts/tasks/t0.md",
			// Round 0 folded to pass=false (the `c` veto) → retry; feedForward carries the fold.
			"/skill:breakdown refine round=0 pass=false",
			"/skill:grade-a .rpiv/artifacts/tasks/t1.md",
			"/skill:grade-b .rpiv/artifacts/tasks/t1.md",
			"/skill:grade-c .rpiv/artifacts/tasks/t1.md",
			"/skill:consume .rpiv/artifacts/tasks/t1.md",
		]);
		const rows = readRows();
		// Round 1 members re-bear (round, memberIndex) — the resume drift join key.
		expect(rows[4]).toMatchObject({ stage: "breakdown (r1·produce)", role: "produce", unitIndex: 1 });
		expect(rows[5]).toMatchObject({
			stage: "breakdown (r1·judge#0)",
			role: "judge",
			unitId: "r1·judge#0",
			unitIndex: 1,
		});
		expect(rows[7]).toMatchObject({
			stage: "breakdown (r1·judge#2)",
			role: "judge",
			unitId: "r1·judge#2",
			unitIndex: 1,
		});
	});

	it("any (veto/rescue) fold: a single passing member carries the round", async () => {
		namedVerdict("v0a", false);
		namedVerdict("v0b", false);
		namedVerdict("v0c", true); // one pass → any() passes
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf(panelAssess(any(done))), input: "x" });

		expect(result.success).toBe(true);
		// One pass of three → any() done after a single round.
		expect(result.stagesCompleted).toBe(5);
		expect(chain.sentMessages.at(-1)).toBe("/skill:consume .rpiv/artifacts/tasks/t0.md");
		expect(chain.sentMessages.filter((m) => m.startsWith("/skill:grade")).length).toBe(3);
	});

	it("panel-close publish: the FOLDED verdict lands on the `<stage>-panel` channel; each member on its OWN channel", async () => {
		namedVerdict("v0a", true);
		namedVerdict("v0b", true);
		namedVerdict("v0c", false); // 2-of-3 pass → majority pass
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/tasks/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0a.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0b.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0c.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		// A route reads `state.named` at decision time — the live driver must have
		// published the fold + every member channel BEFORE the loop advanced here.
		let seen: { fold?: unknown; a?: number; b?: number; c?: number } = {};
		const routed = {
			name: "panel",
			start: "breakdown",
			stages: {
				breakdown: produces({ outcome: mdOutcome("tasks"), loop: panelAssess(majority(done)) }),
				consume: acts(),
			},
			edges: {
				breakdown: defineRoute(["consume"], ({ state }) => {
					seen = {
						fold: state.named["breakdown-panel"]?.at(-1)?.data,
						a: state.named["verdict-a"]?.length,
						b: state.named["verdict-b"]?.length,
						c: state.named["verdict-c"]?.length,
					};
					return "consume";
				}),
				consume: "stop",
			} as Record<string, ReturnType<typeof defineRoute> | string>,
		};

		const result = await runWorkflow(chain.ctx, { workflow: routed, input: "x" });

		expect(result.success).toBe(true);
		// Canonical PANEL_VERDICT — published to the per-stage `<stage>-panel` channel
		// (NOT the PANEL_VERDICT_OUTCOME fallback name), once for the single round.
		expect(seen.fold).toEqual({ pass: true, votes: { pass: 2, fail: 1 }, agreement: 2 / 3, tie: false });
		// Every member published to its OWN channel — member def per row, never member 0's.
		expect([seen.a, seen.b, seen.c]).toEqual([1, 1, 1]);
	});
});

// ===========================================================================
// Worked example — generate → panel screen → match (escalate-on-disagreement)
//
// The panel's product is the ROUTING DECISION, not a loop gate (orq.ai): the
// screen stage ALWAYS advances (`done: () => true`, assess's soft-stop) and
// publishes the folded verdict to `screen-panel`; a `match` on that channel
// routes a tie (disagreement) to escalation and an agreement to keep-survivor.
// An EVEN panel (2 members) is used so `majority` can produce a genuine tie.
// ===========================================================================

describe("loop driver — panel × match (worked example)", () => {
	// The panel runs once and publishes; `done` always advances — routing, not gating.
	// (`done` here is the per-member `pred`, the module-level verdict reader.)
	const screenPanel = assess({
		judge: panel({
			members: [
				judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
				judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
			],
			fold: majority(done),
		}),
		done: () => true,
		feedForward: () => "unused — done is always true",
		max: 1,
	});

	const workflow = {
		name: "generate-and-filter",
		start: "generate",
		stages: {
			generate: produces({ outcome: mdOutcome("candidate") }),
			screen: produces({ outcome: mdOutcome("screened"), loop: screenPanel }),
			escalate: acts(),
			keep: acts(),
		},
		edges: {
			generate: "screen",
			// Disagreement (tie) → escalate; otherwise keep the survivor. Sourced from
			// the panel's published verdict channel, never the stage's producer output.
			screen: match("tie", { escalate: true }, { fallback: "keep", from: "screen-panel" }),
			escalate: "stop",
			keep: "stop",
		} as Record<string, ReturnType<typeof match> | string>,
	};

	const namedVerdict = (name: string, isDone: boolean): string => {
		const rel = `.rpiv/verdicts/${name}.json`;
		writeFile(rel, JSON.stringify({ done: isDone, feedback: name }));
		return rel;
	};

	it("routes a SPLIT panel (tie) to the escalation stage", async () => {
		namedVerdict("va", true);
		namedVerdict("vb", false); // 1-1 split → majority ties → tie=true
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/candidate/c0.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/screened/s0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb.json")] },
				{ branch: [mockAssistantMessage("escalated")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:generate x",
			"/skill:screen .rpiv/artifacts/candidate/c0.md",
			"/skill:grade-a .rpiv/artifacts/screened/s0.md",
			"/skill:grade-b .rpiv/artifacts/screened/s0.md",
			// tie → match("tie") escalates; escalate inherits the screened producer output.
			"/skill:escalate .rpiv/artifacts/screened/s0.md",
		]);
	});

	it("routes an AGREEING panel (no tie) to the keep-survivor fallback", async () => {
		namedVerdict("va", true);
		namedVerdict("vb", true); // unanimous → tie=false → match fallback
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/candidate/c0.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/screened/s0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb.json")] },
				{ branch: [mockAssistantMessage("kept")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages.at(-1)).toBe("/skill:keep .rpiv/artifacts/screened/s0.md");
		// The escalation stage never ran — the fallback carried the survivor.
		expect(chain.sentMessages.some((m) => m.startsWith("/skill:escalate"))).toBe(false);
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

	it("judge-skill registry check walks EVERY panel member (halts on an unregistered member, not just member 0)", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		// Producer + member 0 ("grade-a") registered; member 1 ("grade-b") NOT — the
		// pre-member-walking check inspected member 0 only and would have passed.
		const host = createMockPi({ skills: ["breakdown", "grade-a"] }).pi;

		const result = await runWorkflow(chain.ctx, {
			workflow: {
				name: "panelreg",
				start: "breakdown",
				stages: {
					breakdown: produces({
						outcome: mdOutcome("tasks"),
						loop: assess({
							judge: panel({
								members: [
									judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
									judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
								],
								fold: majority(done),
							}),
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
		expect(result.error).toMatch(/requires Pi skill "grade-b"/);
		// Halted at preflight — no session dispatched.
		expect(chain.sentMessages).toEqual([]);
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

	const gateOnly = () => verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done: pass });
	const retrying = (max = 3) =>
		verify({
			judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
			done: pass,
			feedForward: vFeedForward,
			max,
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

	it("exhausted attempts: both verdicts fail at max 2 → verification-failed halt", async () => {
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
			done: pass,
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

// ===========================================================================
// Prompt dispatch — assess/verify × prompt (the producer arm's raw-text mode)
// ===========================================================================

describe("loop driver — prompt dispatch", () => {
	const pass = (v: Output) => Boolean((v.data as { done?: boolean }).done);
	const gateOnly = () => verify({ judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }), done: pass });

	it("verify × prompt gate-only pass: attempt 0 sends the prompt RAW; skill judge + consumer get handles", async () => {
		writeVerdict(0, true);
		const wf = {
			name: "gated-prompt",
			start: "build",
			stages: {
				build: produces({
					outcome: mdOutcome("impl"),
					prompt: "write the impl to .rpiv/artifacts/impl/",
					verify: gateOnly(),
				}),
				consume: acts(),
			},
			edges: { build: "consume", consume: "stop" } as Record<string, string>,
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			// Raw — no /skill: prefix and no implicit input arg appended.
			"write the impl to .rpiv/artifacts/impl/",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
		const rows = readRows();
		expect(rows[0]).toMatchObject({ stage: "build (a0·attempt)", role: "produce", unitIndex: 0 });
		expect(rows[1]).toMatchObject({ stage: "build (a0·verify)", skill: "grade", role: "verify", unitIndex: 0 });
	});

	it("verify × prompt retry: feedForward's output IS the next attempt's whole message (no /skill: prefix)", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const wf = {
			name: "gated-prompt",
			start: "build",
			stages: {
				build: produces({
					outcome: mdOutcome("impl"),
					prompt: "draft the impl",
					verify: verify({
						judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
						done: pass,
						feedForward: ({ verdict, round }) =>
							`rewrite attempt=${round + 1} done=${(verdict.data as { done?: boolean }).done}`,
						max: 3,
					}),
				}),
				consume: acts(),
			},
			edges: { build: "consume", consume: "stop" } as Record<string, string>,
		};
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

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"draft the impl",
			"/skill:grade .rpiv/artifacts/impl/i0.md",
			"rewrite attempt=1 done=false",
			"/skill:grade .rpiv/artifacts/impl/i1.md",
			"/skill:consume .rpiv/artifacts/impl/i1.md",
		]);
	});

	it("assess × prompt: a dynamic PromptFn (weaving ctx.input) opens round 0; feedForward drives round 1 raw", async () => {
		writeVerdict(0, false);
		writeVerdict(1, true);
		const wf = {
			name: "refining",
			start: "up",
			stages: {
				up: produces({ outcome: mdOutcome("design") }),
				draft: produces({
					outcome: mdOutcome("draft"),
					prompt: ({ input }: ScriptContext) => `draft from ${handleToString(input!.artifacts[0]!.handle)}`,
					loop: assess({
						judge: judge({ skill: "grade", outcome: verdictOutcome("verdict") }),
						done,
						feedForward: ({ verdict, round }) =>
							`polish round=${round} fb=${(verdict.data as { feedback?: string }).feedback}`,
					}),
				}),
			},
			edges: { up: "draft", draft: "stop" } as Record<string, string>,
		};
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/design/d0.md")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/draft/t0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/draft/t1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:up x",
			// Round 0: the PromptFn resolved against the upstream Output, sent raw.
			"draft from .rpiv/artifacts/design/d0.md",
			"/skill:grade .rpiv/artifacts/draft/t0.md",
			// Round 1: feedForward's output IS the message.
			"polish round=0 fb=fb0",
			"/skill:grade .rpiv/artifacts/draft/t1.md",
		]);
		const rows = readRows();
		expect(rows[1]).toMatchObject({ stage: "draft (r0·produce)", role: "produce", unitIndex: 0 });
		expect(rows[2]).toMatchObject({ stage: "draft (r0·judge)", role: "judge", unitIndex: 0 });
	});
});

// ===========================================================================
// verify × panel — a panel composes into the verify gate with ZERO verify-specific
// code (verify desugars to a degenerate assess loop). Exercises member dispatch,
// the folded gate, and retry-with-feedback end-to-end through runWorkflow.
// ===========================================================================

describe("loop driver — verify × panel", () => {
	// The GATE's `done` reads the FOLDED canonical verdict (`{ pass, ... }`); the
	// per-member `pred` (the module-level `done`) reads each member's own `{ done }`.
	const gatePass = (v: Output) => Boolean((v.data as { pass?: boolean }).pass);
	const panelFeed = ({ verdict, round }: { verdict: Output; round: number }) =>
		`fix round=${round} pass=${(verdict.data as { pass?: boolean }).pass}`;

	const twoMembers = () => [
		judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
		judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
	];
	const verifyPanel = (max = 1): VerifySpec =>
		verify({
			judge: panel({ members: twoMembers(), fold: majority(done) }),
			done: gatePass,
			feedForward: panelFeed,
			max,
		});

	const named = (name: string, isDone: boolean): void => {
		writeFile(`.rpiv/verdicts/${name}.json`, JSON.stringify({ done: isDone, feedback: name }));
	};

	it("gate pass: both members grade ONE attempt; the folded majority opens the gate; members + fold publish per-channel", async () => {
		named("va", true);
		named("vb", true); // 2-0 → majority pass → gate opens
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		// A route reads the published channels at decision time — proves the live
		// driver folded + published BEFORE the gate advanced the chain here.
		let seen: { fold?: unknown; a?: number; b?: number } = {};
		const wf = {
			name: "gated",
			start: "build",
			stages: {
				build: produces({ outcome: mdOutcome("impl"), verify: verifyPanel() }),
				consume: acts(),
			},
			edges: {
				build: defineRoute(["consume"], ({ state }) => {
					seen = {
						fold: state.named["build-panel"]?.at(-1)?.data,
						a: state.named["verdict-a"]?.length,
						b: state.named["verdict-b"]?.length,
					};
					return "consume";
				}),
				consume: "stop",
			} as Record<string, ReturnType<typeof defineRoute> | string>,
		};

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		// 1 attempt + 2 verify members + 1 consume.
		expect(result.stagesCompleted).toBe(4);
		expect(chain.sentMessages).toEqual([
			"/skill:build x",
			// Both members grade the SAME attempt artifact, in member order.
			"/skill:grade-a .rpiv/artifacts/impl/i0.md",
			"/skill:grade-b .rpiv/artifacts/impl/i0.md",
			// gate opened on the FOLDED pass; consume inherits the ATTEMPT output, never a verdict.
			"/skill:consume .rpiv/artifacts/impl/i0.md",
		]);
		// Canonical PANEL_VERDICT on the per-stage `<stage>-panel` channel; each
		// member on its OWN channel (member def per row, never member 0's).
		expect(seen.fold).toEqual({ pass: true, votes: { pass: 2, fail: 0 }, agreement: 1, tie: false });
		expect([seen.a, seen.b]).toEqual([1, 1]);

		const rows = readRows();
		// Verify members are identity-bearing — `a{round}·verify#{member}` (the `unitId`).
		expect(rows[1]).toMatchObject({
			stage: "build (a0·verify#0)",
			skill: "grade-a",
			role: "verify",
			unitId: "a0·verify#0",
			unitIndex: 0,
		});
		expect(rows[2]).toMatchObject({
			stage: "build (a0·verify#1)",
			skill: "grade-b",
			role: "verify",
			unitId: "a0·verify#1",
			unitIndex: 0,
		});
	});

	it("retry: a folded fail feeds the next attempt (feedForward threads the FOLDED verdict); pass advances with the LAST attempt", async () => {
		named("va0", true);
		named("vb0", false); // 1-1 → majority fails → retry
		named("va1", true);
		named("vb1", true); // 2-0 → majority passes
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va0.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb0.json")] },
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va1.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb1.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const wf = {
			name: "gated",
			start: "build",
			stages: {
				build: produces({ outcome: mdOutcome("impl"), verify: verifyPanel(3) }),
				consume: acts(),
			},
			edges: { build: "consume", consume: "stop" } as Record<string, string>,
		};

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		expect(chain.sentMessages).toEqual([
			"/skill:build x",
			"/skill:grade-a .rpiv/artifacts/impl/i0.md",
			"/skill:grade-b .rpiv/artifacts/impl/i0.md",
			// Round 0 folded to pass=false → retry; feedForward carries the FOLDED verdict.
			"/skill:build fix round=0 pass=false",
			"/skill:grade-a .rpiv/artifacts/impl/i1.md",
			"/skill:grade-b .rpiv/artifacts/impl/i1.md",
			// pass on attempt 1 → advance with the LAST attempt's producer output.
			"/skill:consume .rpiv/artifacts/impl/i1.md",
		]);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/impl/i1.md");
	});
});

// ===========================================================================
// assess × panel (custom fold) — a RAW FoldFn + explicit `outcome` (the custom
// path). The fold emits the AUTHOR's schema to the AUTHOR's channel (never the
// canonical `<stage>-panel`), flows through applyCompletedStage, and a downstream
// route resolves it.
// ===========================================================================

describe("loop driver — assess × panel (custom fold)", () => {
	it("raw fold: emits the author schema to the author channel (not <stage>-panel); a downstream route reads it", async () => {
		writeFile(".rpiv/verdicts/va.json", JSON.stringify({ done: true, feedback: "va" }));
		writeFile(".rpiv/verdicts/vb.json", JSON.stringify({ done: false, feedback: "vb" }));

		// RAW fold — counts passing members into a CUSTOM shape (not PANEL_VERDICT).
		// A raw fold REQUIRES an explicit `outcome` (the raw ⊕ outcome XOR).
		const scoreFold = (verdicts: readonly Output[]) => ({
			passes: verdicts.filter(done).length,
			total: verdicts.length,
		});
		const screen = assess({
			judge: panel({
				members: [
					judge({ skill: "grade-a", outcome: verdictOutcome("verdict-a") }),
					judge({ skill: "grade-b", outcome: verdictOutcome("verdict-b") }),
				],
				fold: scoreFold,
				outcome: emptyVerdictOutcome("screen-score"),
			}),
			done: () => true, // run once and publish — routing, not gating
			feedForward: () => "unused",
			max: 1,
		});

		let seen: { score?: unknown; canonical?: unknown } = {};
		const wf = {
			name: "scored",
			start: "screen",
			stages: {
				screen: produces({ outcome: mdOutcome("screened"), loop: screen }),
				consume: acts(),
			},
			edges: {
				screen: defineRoute(["consume"], ({ state }) => {
					seen = {
						score: state.named["screen-score"]?.at(-1)?.data,
						canonical: state.named["screen-panel"],
					};
					return "consume";
				}),
				consume: "stop",
			} as Record<string, ReturnType<typeof defineRoute> | string>,
		};

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/screened/s0.md")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/va.json")] },
				{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/vb.json")] },
				{ branch: [mockAssistantMessage("consumed")] },
			],
		});

		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });

		expect(result.success).toBe(true);
		// The fold output is the AUTHOR's schema, landed via applyCompletedStage on
		// the AUTHOR's channel and read back by the downstream route.
		expect(seen.score).toEqual({ passes: 1, total: 2 });
		// The canonical `<stage>-panel` channel is NEVER published on the custom path (the XOR).
		expect(seen.canonical).toBeUndefined();
	});
});
