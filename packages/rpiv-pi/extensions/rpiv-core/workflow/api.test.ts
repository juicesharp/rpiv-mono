/**
 * Tests for the TS-native workflow authoring surface — factories from api.ts.
 *
 * Pure-function tests: each factory applies defaults, respects overrides,
 * and returns the canonical shape. No consumer of `api.ts` exists yet
 * (Phase 1 is additive); these tests are the contract.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { action, custom, defineWorkflow, type EdgeFn, type Extractor, skill, threshold, type Workflow } from "./api.js";

// ---------------------------------------------------------------------------
// defineWorkflow
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
	it("returns the spec unchanged (identity passthrough)", () => {
		const spec: Workflow = {
			name: "tiny",
			start: "research",
			nodes: {
				research: skill("research"),
				commit: action("commit"),
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
			nodes: { a: skill("a") },
			edges: { a: "stop" },
		});
		expect(w.description).toBe("for testing");
	});
});

// ---------------------------------------------------------------------------
// skill — protocol nodes (artifact-emit + fresh)
// ---------------------------------------------------------------------------

describe("skill", () => {
	it("applies artifact-emit + fresh defaults", () => {
		const n = skill("research");
		expect(n).toMatchObject({
			name: "research",
			skill: "research",
			completionStrategy: "artifact-emit",
			sessionPolicy: "fresh",
		});
	});

	it("respects overrides without mutating defaults for other calls", () => {
		const a = skill("a", { sessionPolicy: "continue", maxValidationRetries: 3 });
		expect(a.sessionPolicy).toBe("continue");
		expect(a.maxValidationRetries).toBe(3);

		const b = skill("b");
		expect(b.sessionPolicy).toBe("fresh");
		expect(b.maxValidationRetries).toBeUndefined();
	});

	it("lets overrides redirect to a different skill body than the node name", () => {
		const n = skill("code-review-large", { skill: "code-review" });
		expect(n.name).toBe("code-review-large");
		expect(n.skill).toBe("code-review");
	});

	it("accepts outputSchema for predicate-edge gating", () => {
		const schema = Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) });
		const n = skill("code-review", { outputSchema: schema });
		expect(n.outputSchema).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// action — side-effect nodes (agent-end + fresh)
// ---------------------------------------------------------------------------

describe("action", () => {
	it("applies agent-end + fresh defaults", () => {
		const n = action("implement");
		expect(n).toMatchObject({
			name: "implement",
			skill: "implement",
			completionStrategy: "agent-end",
			sessionPolicy: "fresh",
		});
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
		const n = action("commit", { extractor });
		expect(n.extractor).toBe(extractor);
	});
});

// ---------------------------------------------------------------------------
// custom — explicit-everything
// ---------------------------------------------------------------------------

describe("custom", () => {
	it("returns the spec unchanged — no defaulting", () => {
		const spec = {
			name: "deploy",
			skill: "deploy",
			completionStrategy: "agent-end" as const,
			sessionPolicy: "fresh" as const,
		};
		expect(custom(spec)).toBe(spec);
	});

	it("permits any sessionPolicy / completionStrategy combination explicitly", () => {
		const n = custom({
			name: "audit",
			skill: "audit",
			completionStrategy: "artifact-emit",
			sessionPolicy: "continue",
		});
		expect(n.completionStrategy).toBe("artifact-emit");
		expect(n.sessionPolicy).toBe("continue");
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
				research: skill("research"),
				"code-review": skill("code-review", {
					outputSchema: Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) }),
				}),
				revise: skill("revise"),
				commit: action("commit"),
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
