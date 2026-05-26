/**
 * Tests for the TS-native workflow authoring surface — factories from api.ts.
 *
 * Pure-function tests: each factory applies defaults, respects overrides,
 * and returns the canonical shape. No consumer of `api.ts` exists yet
 * (Phase 1 is additive); these tests are the contract.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	gate,
	type OutputSpec,
	produces,
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

	it("attaches an OutputSpec when supplied (commit-style stages)", () => {
		const outcome: OutputSpec = {
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
// gate — route builder
// ---------------------------------------------------------------------------

describe("gate", () => {
	const pick: EdgeFn = gate("severeIssueCount", { revise: gt(0), commit: eq(0) });

	const ctxWithCount = (n: number) =>
		({
			output: {
				kind: "artifact-md",
				artifacts: [],
				data: { severeIssueCount: n },
				meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
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
					meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
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
					meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("commit");
	});

	it("attaches .targets so validation can enumerate branches", () => {
		expect(pick.targets).toEqual(["revise", "commit"]);
	});

	it("throws when branches is an empty object", () => {
		expect(() => gate("count", {})).toThrow(/at least one possible return value/);
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
					meta: { skill: "x", stageNumber: 1, ts: "", runId: "" },
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
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
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
