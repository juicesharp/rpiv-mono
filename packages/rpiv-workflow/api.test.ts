/**
 * Tests for the TS-native workflow authoring surface — factories from api.ts.
 *
 * Pure-function tests: each factory applies defaults, respects overrides,
 * and returns the canonical shape. The factories define the contract for
 * any future consumer.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type ActsScriptFn,
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	gate,
	marksReadsData,
	type Outcome,
	type ProducesScriptFn,
	produces,
	type ScriptContext,
	type StageDef,
	takeRouteNote,
	terminal,
	type Workflow,
} from "./api.js";
import { eq, gt } from "./predicates.js";
import { typeboxSchema } from "./typebox-adapter.js";

// ---------------------------------------------------------------------------
// defineWorkflow
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
	it("returns the spec unchanged (identity passthrough)", () => {
		const spec: Workflow = {
			name: "tiny",
			start: "research",
			stages: {
				research: produces(),
				commit: acts(),
			},
			edges: { research: "commit", commit: "stop" },
		};
		expect(defineWorkflow(spec)).toBe(spec);
	});

	it("preserves optional description", () => {
		const w = defineWorkflow({
			name: "demo",
			description: "for testing",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop" },
		});
		expect(w.description).toBe("for testing");
	});
});

// ---------------------------------------------------------------------------
// produces — artifact-emitting stages (kind: "produces" + fresh)
// ---------------------------------------------------------------------------

describe("produces", () => {
	it('applies kind="produces" + fresh defaults with no required args', () => {
		const n = produces();
		expect(n).toMatchObject({
			kind: "produces",
			sessionPolicy: "fresh",
		});
		// `skill` defaults to the surrounding record key — the runner injects it.
		expect(n.skill).toBeUndefined();
	});

	it("respects overrides without mutating defaults for other calls", () => {
		const a = produces({ sessionPolicy: "continue", maxRetries: 3 });
		expect(a.sessionPolicy).toBe("continue");
		expect(a.maxRetries).toBe(3);

		const b = produces();
		expect(b.sessionPolicy).toBe("fresh");
		expect(b.maxRetries).toBeUndefined();
	});

	it("override.skill wins when the stage id and Pi skill differ", () => {
		const n = produces({ skill: "code-review" });
		expect(n.skill).toBe("code-review");
	});

	it("accepts outputSchema for predicate-edge gating", () => {
		const schema = typeboxSchema(Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) }));
		const n = produces({ outputSchema: schema });
		expect(n.outputSchema).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// acts — side-effect stages (kind: "side-effect" + fresh)
// ---------------------------------------------------------------------------

describe("acts", () => {
	it('applies kind="side-effect" + fresh defaults with no required args', () => {
		const n = acts();
		expect(n).toMatchObject({
			kind: "side-effect",
			sessionPolicy: "fresh",
		});
		expect(n.skill).toBeUndefined();
	});

	it("attaches an Outcome when supplied (commit-style stages)", () => {
		const outcome: Outcome = {
			collector: {
				snapshot: () => "pre-state",
				collect: () => ({ kind: "ok", artifacts: [] }),
			},
		};
		const n = acts({ outcome });
		expect(n.outcome).toBe(outcome);
	});
});

// ---------------------------------------------------------------------------
// terminal — opt-out-of-inheritance side-effect stages
// ---------------------------------------------------------------------------

describe("terminal", () => {
	it("desugars to acts() with inheritsArtifacts: false", () => {
		const n = terminal();
		expect(n).toMatchObject({
			kind: "side-effect",
			sessionPolicy: "fresh",
			inheritsArtifacts: false,
		});
	});

	it("preserves overrides while keeping inheritsArtifacts: false", () => {
		const n = terminal({ skill: "cleanup", sessionPolicy: "continue" });
		expect(n.skill).toBe("cleanup");
		expect(n.sessionPolicy).toBe("continue");
		expect(n.inheritsArtifacts).toBe(false);
	});

	it("a caller passing inheritsArtifacts: true via overrides cannot reverse the opt-out", () => {
		// The factory's identity IS the opt-out — `inheritsArtifacts: false`
		// is applied after the spread so a caller-supplied `true` is
		// overwritten. Authors wanting inheritance should call `acts()`.
		const n = terminal({ inheritsArtifacts: true as unknown as false });
		expect(n.inheritsArtifacts).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// produces.script / acts.script / terminal.script — skillless TS stages
// ---------------------------------------------------------------------------

describe("produces.script", () => {
	const noopProducesScript: ProducesScriptFn = (_ctx: ScriptContext) => ({
		kind: "noop",
		artifacts: [],
		data: {},
	});

	it('returns { kind: "produces", sessionPolicy: "fresh", run }', () => {
		const n = produces.script({ run: noopProducesScript });
		expect(n).toMatchObject({
			kind: "produces",
			sessionPolicy: "fresh",
		});
		expect(n.run).toBe(noopProducesScript);
		// No skill / outcome / loop on script stages.
		expect(n.skill).toBeUndefined();
		expect(n.outcome).toBeUndefined();
		expect(n.loop).toBeUndefined();
	});

	it("threads validation knobs through to the StageDef", () => {
		const schema = typeboxSchema(Type.Object({ count: Type.Integer({ minimum: 0 }) }));
		const n = produces.script({
			run: noopProducesScript,
			outputSchema: schema,
			onInvalid: "halt",
			maxRetries: 5,
			validateTimeoutMs: 2000,
			inheritsArtifacts: false,
		});
		expect(n.outputSchema).toBe(schema);
		expect(n.onInvalid).toBe("halt");
		expect(n.maxRetries).toBe(5);
		expect(n.validateTimeoutMs).toBe(2000);
		expect(n.inheritsArtifacts).toBe(false);
	});
});

describe("acts.script", () => {
	const noopActsScript: ActsScriptFn = (_ctx: ScriptContext) => {};

	it('returns { kind: "side-effect", sessionPolicy: "fresh", run }', () => {
		const n = acts.script({ run: noopActsScript });
		expect(n).toMatchObject({
			kind: "side-effect",
			sessionPolicy: "fresh",
		});
		expect(n.run).toBe(noopActsScript);
		expect(n.skill).toBeUndefined();
		expect(n.outcome).toBeUndefined();
		expect(n.loop).toBeUndefined();
	});

	it("preserves inputSchema + inheritsArtifacts overrides", () => {
		const schema = typeboxSchema(Type.Object({ ok: Type.Boolean() }));
		const n = acts.script({ run: noopActsScript, inputSchema: schema, inheritsArtifacts: false });
		expect(n.inputSchema).toBe(schema);
		expect(n.inheritsArtifacts).toBe(false);
	});
});

describe("terminal.script", () => {
	const noopActsScript: ActsScriptFn = (_ctx: ScriptContext) => {};

	it('returns { kind: "side-effect", inheritsArtifacts: false, run } — opt-out is structural', () => {
		const n = terminal.script({ run: noopActsScript });
		expect(n).toMatchObject({
			kind: "side-effect",
			sessionPolicy: "fresh",
			inheritsArtifacts: false,
		});
		expect(n.run).toBe(noopActsScript);
	});

	it("a caller-supplied inheritsArtifacts: true cannot reverse the opt-out", () => {
		const n = terminal.script({ run: noopActsScript, inheritsArtifacts: true as unknown as false });
		expect(n.inheritsArtifacts).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// gate — route builder
// ---------------------------------------------------------------------------

describe("gate", () => {
	const pick: EdgeFn = gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit");

	const ctxWithCount = (n: number) =>
		({
			output: {
				kind: "artifact-md",
				artifacts: [],
				data: { severeIssueCount: n },
				meta: { stage: "code-review", skill: "code-review", stageNumber: 1, ts: "", runId: "" },
			},
			state: {} as never,
		}) as const;

	it("picks the first matching branch (value > 0 → revise)", () => {
		expect(pick(ctxWithCount(3))).toBe("revise");
	});

	it("picks an exact match when its predicate matches (value === 0 → commit)", () => {
		expect(pick(ctxWithCount(0))).toBe("commit");
	});

	it("falls back to the last branch when value is missing (treats as NaN)", () => {
		expect(
			pick({
				output: {
					kind: "artifact-md",
					artifacts: [],
					data: {},
					meta: { stage: "code-review", skill: "code-review", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("commit");
	});

	it("falls back to the last branch when output is undefined", () => {
		expect(pick({ output: undefined, state: {} as never })).toBe("commit");
	});

	it("falls back to the last branch when value coerces to NaN (non-numeric field)", () => {
		expect(
			pick({
				output: {
					kind: "artifact-md",
					artifacts: [],
					data: { severeIssueCount: "not a number" },
					meta: { stage: "code-review", skill: "code-review", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("commit");
	});

	it("attaches .targets so validation can enumerate branches", () => {
		expect(pick.targets).toEqual(["revise", "commit"]);
	});

	it("throws when branches is an empty object", () => {
		expect(() => gate("count", {}, "x")).toThrow(/at least one possible return value/);
	});

	it("throws when `otherwise` is missing or empty — the fallback must be deliberate", () => {
		// Hand-rolled literals (jiti configs) bypass TS, so the runtime guard matters.
		expect(() => (gate as unknown as (f: string, b: object) => unknown)("count", { a: gt(0) })).toThrow(
			/explicit `otherwise`/,
		);
		expect(() => gate("count", { a: gt(0) }, "")).toThrow(/explicit `otherwise`/);
	});

	it("throws on integer-like branch keys — JS reorders them ahead of declaration order", () => {
		expect(() => gate("count", { "2": eq(2), other: gt(0) }, "other")).toThrow(/integer-like/);
	});

	it("includes `otherwise` in .targets when it is not also a branch", () => {
		const fn = gate("count", { high: gt(10) }, "low");
		expect(fn.targets).toEqual(["high", "low"]);
	});

	it("records a fallback note readable via takeRouteNote — and only on no-match", () => {
		const fn = gate("count", { high: gt(10) }, "low");
		const ctx = (n: unknown) =>
			({
				output: {
					kind: "x",
					artifacts: [],
					data: { count: n },
					meta: { stage: "s", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}) as const;

		// Matched branch: no note.
		expect(fn(ctx(11))).toBe("high");
		expect(takeRouteNote(fn)).toBeUndefined();

		// No match: fallback + note; takeRouteNote clears it.
		expect(fn(ctx(3))).toBe("low");
		expect(takeRouteNote(fn)).toMatch(/no branch matched value 3.*"low"/);
		expect(takeRouteNote(fn)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// defineRoute — structural enforcement of the .targets contract
// ---------------------------------------------------------------------------

describe("defineRoute", () => {
	it("attaches the declared targets to the returned function", () => {
		const fn = defineRoute(["good", "bad"], () => "good");
		expect(fn.targets).toEqual(["good", "bad"]);
	});

	it("preserves the underlying function's runtime behavior", () => {
		const fn = defineRoute(["good", "bad"], (ctx) => ((ctx.output?.data as { ok?: boolean })?.ok ? "good" : "bad"));
		expect(
			fn({
				output: {
					kind: "test",
					artifacts: [],
					data: { ok: true },
					meta: { stage: "x", skill: "x", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("good");
	});

	it("throws when the targets array is empty", () => {
		expect(() => defineRoute([], () => "x")).toThrow(/at least one possible return value/);
	});

	it("accepts readsData: false to opt out of the outputSchema lint", () => {
		const fn = defineRoute(["a", "b"], () => "a", { readsData: false });
		expect(fn.targets).toEqual(["a", "b"]);
	});

	it("never mutates the caller's function — reusing one predicate keeps each route's targets", () => {
		const predicate = () => "x";
		const first = defineRoute(["x", "y"], predicate);
		const second = defineRoute(["x"], predicate);
		// Pre-fix the second call overwrote the first's targets (same object).
		expect(first.targets).toEqual(["x", "y"]);
		expect(second.targets).toEqual(["x"]);
		expect((predicate as { targets?: readonly string[] }).targets).toBeUndefined();
	});

	it("readsData: false does not inherit a marker a prior call attached", () => {
		const predicate = () => "a";
		const marked = defineRoute(["a"], predicate); // default readsData: true
		const unmarked = defineRoute(["a"], predicate, { readsData: false });
		expect(marksReadsData(marked)).toBe(true);
		expect(marksReadsData(unmarked)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Composition smoke — a tiny end-to-end Workflow built from the factories
// ---------------------------------------------------------------------------

describe("composition smoke", () => {
	it("composes a small graph with mixed edge target kinds", () => {
		const w = defineWorkflow({
			name: "review-or-ship",
			start: "research",
			stages: {
				research: produces(),
				"code-review": produces({
					outputSchema: typeboxSchema(Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) })),
				}),
				revise: produces(),
				commit: acts(),
			},
			edges: {
				research: "code-review",
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		});

		expect(w.name).toBe("review-or-ship");
		expect(w.start).toBe("research");
		expect(Object.keys(w.stages)).toEqual(["research", "code-review", "revise", "commit"]);
		expect(typeof w.edges["code-review"]).toBe("function");
		expect(w.edges.research).toBe("code-review");
		expect(w.edges.commit).toBe("stop");
	});
});

// ---------------------------------------------------------------------------
// StageDef discriminated union — illegal dispatch combos unrepresentable
// ---------------------------------------------------------------------------

describe("StageDef union", () => {
	const scriptBody: ActsScriptFn = () => {};

	it("legal arms assign cleanly (skill / script / prompt)", () => {
		const skillArm: StageDef = {
			kind: "produces",
			sessionPolicy: "fresh",
			outcome: { collector: (() => null) as never },
		};
		const scriptArm: StageDef = { kind: "side-effect", sessionPolicy: "fresh", run: scriptBody };
		const promptArm: StageDef = { kind: "side-effect", sessionPolicy: "fresh", prompt: "say hi" };
		expect([skillArm, scriptArm, promptArm].every((s) => s.kind.length > 0)).toBe(true);
	});

	it("type-level: mixed dispatches fail assignability (verified by tsc — the runtime values here are never used)", () => {
		// @ts-expect-error script + skill — the run function IS the work
		const a: StageDef = { kind: "produces", sessionPolicy: "fresh", run: scriptBody, skill: "x" };
		// @ts-expect-error script + outcome — the run function IS the Outcome
		const b: StageDef = { kind: "produces", sessionPolicy: "fresh", run: scriptBody, outcome: {} };
		// @ts-expect-error script + prompt — one dispatch only
		const c: StageDef = { kind: "side-effect", sessionPolicy: "fresh", run: scriptBody, prompt: "x" };
		// @ts-expect-error prompt + skill — raw text, not /skill:<skill>
		const d: StageDef = { kind: "side-effect", sessionPolicy: "fresh", prompt: "x", skill: "implement" };
		// @ts-expect-error prompt + reads — read state.named from the PromptFn instead
		const e: StageDef = { kind: "side-effect", sessionPolicy: "fresh", prompt: "x", reads: ["plans"] };
		expect([a, b, c, d, e].length).toBe(5);
	});
});
