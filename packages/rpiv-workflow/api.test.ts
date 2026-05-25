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
	action,
	artifact,
	definePredicate,
	defineStatePredicate,
	defineWorkflow,
	type EdgeFn,
	type Extractor,
	threshold,
	type Workflow,
} from "./api.js";
import { typeboxSchema } from "./typebox-adapter.js";

// ---------------------------------------------------------------------------
// defineWorkflow
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
	it("returns the spec unchanged (identity passthrough)", () => {
		const spec: Workflow = {
			name: "tiny",
			start: "research",
			nodes: {
				research: artifact(),
				commit: action(),
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
			nodes: { a: artifact() },
			edges: { a: "stop" },
		});
		expect(w.description).toBe("for testing");
	});
});

// ---------------------------------------------------------------------------
// artifact — artifact-emitting nodes (artifact-emit + fresh)
// ---------------------------------------------------------------------------

describe("artifact", () => {
	it("applies artifact-emit + fresh defaults with no required args", () => {
		const n = artifact();
		expect(n).toMatchObject({
			completionStrategy: "artifact-emit",
			sessionPolicy: "fresh",
		});
		// `skill` defaults to the surrounding record key — the runner injects it.
		expect(n.skill).toBeUndefined();
	});

	it("respects overrides without mutating defaults for other calls", () => {
		const a = artifact({ sessionPolicy: "continue", maxValidationRetries: 3 });
		expect(a.sessionPolicy).toBe("continue");
		expect(a.maxValidationRetries).toBe(3);

		const b = artifact();
		expect(b.sessionPolicy).toBe("fresh");
		expect(b.maxValidationRetries).toBeUndefined();
	});

	it("override.skill wins when the node id and Pi skill differ", () => {
		const n = artifact({ skill: "code-review" });
		expect(n.skill).toBe("code-review");
	});

	it("accepts outputSchema for predicate-edge gating", () => {
		const schema = typeboxSchema(Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) }));
		const n = artifact({ outputSchema: schema });
		expect(n.outputSchema).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// action — side-effect nodes (agent-end + fresh)
// ---------------------------------------------------------------------------

describe("action", () => {
	it("applies agent-end + fresh defaults with no required args", () => {
		const n = action();
		expect(n).toMatchObject({
			completionStrategy: "agent-end",
			sessionPolicy: "fresh",
		});
		expect(n.skill).toBeUndefined();
	});

	it("attaches an Extractor when supplied (commit-style nodes)", () => {
		const captured: unknown[] = [];
		const extractor: Extractor = {
			before: () => "pre-state",
			extract: (ctx) => {
				captured.push(ctx.snapshot);
				return { payload: { kind: "test", data: {} } };
			},
		};
		const n = action({ extractor });
		expect(n.extractor).toBe(extractor);
	});
});

// ---------------------------------------------------------------------------
// threshold — predicate builder
// ---------------------------------------------------------------------------

describe("threshold", () => {
	const pick: EdgeFn = threshold("severeIssueCount", 0, "revise", "commit");

	const ctxWithCount = (n: number) =>
		({
			manifest: {
				kind: "artifact-md",
				data: { severeIssueCount: n },
				meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
			},
			state: {} as never,
		}) as const;

	it("picks ifAbove when value > threshold", () => {
		expect(pick(ctxWithCount(3))).toBe("revise");
	});

	it("picks ifBelow when value equals threshold (not strictly greater)", () => {
		expect(pick(ctxWithCount(0))).toBe("commit");
	});

	it("picks ifBelow when value is missing (treats as 0)", () => {
		expect(
			pick({
				manifest: {
					kind: "artifact-md",
					data: {},
					meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("commit");
	});

	it("picks ifBelow when manifest is undefined (treats as 0)", () => {
		expect(pick({ manifest: undefined, state: {} as never })).toBe("commit");
	});

	it("picks ifBelow when value coerces to NaN (non-numeric field)", () => {
		expect(
			pick({
				manifest: {
					kind: "artifact-md",
					data: { severeIssueCount: "not a number" },
					meta: { skill: "code-review", stageNumber: 1, ts: "", runId: "" },
				},
				state: {} as never,
			}),
		).toBe("commit");
	});

	it("threshold attaches .targets so validation can enumerate branches", () => {
		expect(pick.targets).toEqual(["revise", "commit"]);
	});
});

// ---------------------------------------------------------------------------
// definePredicate — structural enforcement of the .targets contract
// ---------------------------------------------------------------------------

describe("definePredicate", () => {
	it("attaches the declared targets to the returned function", () => {
		const fn = definePredicate(["good", "bad"], () => "good");
		expect(fn.targets).toEqual(["good", "bad"]);
	});

	it("preserves the underlying function's runtime behavior", () => {
		const fn = definePredicate(["good", "bad"], (ctx) =>
			(ctx.manifest?.data as { ok?: boolean })?.ok ? "good" : "bad",
		);
		expect(
			fn({
				manifest: { kind: "test", data: { ok: true }, meta: { skill: "x", stageNumber: 1, ts: "", runId: "" } },
				state: {} as never,
			}),
		).toBe("good");
	});

	it("throws when the targets array is empty", () => {
		expect(() => definePredicate([], () => "x")).toThrow(/at least one possible return value/);
	});
});

// ---------------------------------------------------------------------------
// defineStatePredicate — same .targets contract; no READS_FRONTMATTER marker
// ---------------------------------------------------------------------------

describe("defineStatePredicate", () => {
	it("attaches the declared targets to the returned function", () => {
		const fn = defineStatePredicate(["a", "b"], () => "a");
		expect(fn.targets).toEqual(["a", "b"]);
	});

	it("throws when the targets array is empty", () => {
		expect(() => defineStatePredicate([], () => "x")).toThrow(/at least one possible return value/);
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
			nodes: {
				research: artifact(),
				"code-review": artifact({
					outputSchema: typeboxSchema(Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) })),
				}),
				revise: artifact(),
				commit: action(),
			},
			edges: {
				research: "code-review",
				"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				revise: "commit",
				commit: "stop",
			},
		});

		expect(w.name).toBe("review-or-ship");
		expect(w.start).toBe("research");
		expect(Object.keys(w.nodes)).toEqual(["research", "code-review", "revise", "commit"]);
		expect(typeof w.edges["code-review"]).toBe("function");
		expect(w.edges.research).toBe("code-review");
		expect(w.edges.commit).toBe("stop");
	});
});
