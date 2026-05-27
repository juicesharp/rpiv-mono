/**
 * Tests for `nextStage` / `edgeIsDecision` — workflow-graph traversal.
 *
 * Each test builds a minimal Workflow by hand and asserts the resolved next
 * name (or null) for a given current-stage + state combination.
 */

import { describe, expect, it } from "vitest";
import { type EdgeContext, gate, type Workflow } from "./api.js";
import { eq, gt } from "./predicates.js";
import { edgeIsDecision, nextStage } from "./routing.js";
import type { RunState } from "./types.js";

const makeState = (outputData?: Record<string, unknown>): RunState => ({
	originalInput: "",
	primaryArtifact: undefined,
	output: outputData
		? {
				kind: "artifact-md",
				artifacts: [],
				data: outputData,
				meta: { stage: "source", skill: "source", stageNumber: 1, ts: "", runId: "" },
			}
		: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: {
		backwardJumps: 0,
		droppedRoutingRows: [],
	},
	termination: {
		success: false,
		error: undefined,
	},
});

const ctxOf = (outputData?: Record<string, unknown>): EdgeContext => {
	const state = makeState(outputData);
	return { output: state.output, state };
};

const stage = (name: string) => ({
	name,
	skill: name,
	kind: "side-effect" as const,
	sessionPolicy: "fresh" as const,
});

const baseStages = {
	a: stage("a"),
	b: stage("b"),
	c: stage("c"),
	d: stage("d"),
};

// ---------------------------------------------------------------------------
// nextStage
// ---------------------------------------------------------------------------

describe("nextStage", () => {
	it("follows a string edge to the named target", () => {
		const workflow: Workflow = {
			name: "linear",
			start: "a",
			stages: baseStages,
			edges: { a: "b", b: "c", c: "d", d: "stop" },
		};
		expect(nextStage(workflow, "a", ctxOf())).toEqual({ kind: "next", stage: "b" });
		expect(nextStage(workflow, "b", ctxOf())).toEqual({ kind: "next", stage: "c" });
		expect(nextStage(workflow, "c", ctxOf())).toEqual({ kind: "next", stage: "d" });
	});

	it('returns { kind: "stop" } for the "stop" sentinel', () => {
		const workflow: Workflow = {
			name: "terminal",
			start: "a",
			stages: baseStages,
			edges: { a: "stop" },
		};
		expect(nextStage(workflow, "a", ctxOf())).toEqual({ kind: "stop" });
	});

	it('returns { kind: "stop" } for a stage with no outgoing edge (implicit terminal)', () => {
		const workflow: Workflow = {
			name: "implicit",
			start: "a",
			stages: baseStages,
			edges: { a: "b" }, // b has no edge
		};
		expect(nextStage(workflow, "b", ctxOf())).toEqual({ kind: "stop" });
	});

	it("evaluates an EdgeFn against the supplied context", () => {
		const workflow: Workflow = {
			name: "pred",
			start: "a",
			stages: baseStages,
			edges: { a: gate("count", { c: gt(0), b: eq(0) }) },
		};
		expect(nextStage(workflow, "a", ctxOf({ count: 5 }))).toEqual({ kind: "next", stage: "c" });
		expect(nextStage(workflow, "a", ctxOf({ count: 0 }))).toEqual({ kind: "next", stage: "b" });
	});

	it("an EdgeFn returning the stop sentinel terminates the chain", () => {
		const workflow: Workflow = {
			name: "pred-stop",
			start: "a",
			stages: baseStages,
			edges: { a: () => "stop" },
		};
		expect(nextStage(workflow, "a", ctxOf())).toEqual({ kind: "stop" });
	});

	it('returns { kind: "err" } when an EdgeFn returns a target that is not a declared stage', () => {
		const workflow: Workflow = {
			name: "rogue",
			start: "a",
			stages: baseStages,
			edges: { a: () => "ghost" },
		};
		const result = nextStage(workflow, "a", ctxOf());
		expect(result.kind).toBe("err");
		if (result.kind === "err") expect(result.reason).toMatch(/"ghost" which is not a declared stage/);
	});

	it('returns { kind: "err" } when a string edge target is not a declared stage (defensive)', () => {
		const workflow: Workflow = {
			name: "rogue-string",
			start: "a",
			stages: baseStages,
			edges: { a: "ghost" },
		};
		const result = nextStage(workflow, "a", ctxOf());
		expect(result.kind).toBe("err");
		if (result.kind === "err") expect(result.reason).toMatch(/"ghost" which is not a declared stage/);
	});

	it('returns { kind: "err" } with a helpful message when an EdgeFn throws', () => {
		const workflow: Workflow = {
			name: "thrower",
			start: "a",
			stages: baseStages,
			edges: {
				a: () => {
					throw new Error("predicate exploded");
				},
			},
		};
		const result = nextStage(workflow, "a", ctxOf());
		expect(result.kind).toBe("err");
		if (result.kind === "err") expect(result.reason).toMatch(/edge function at "a" threw: predicate exploded/);
	});
});

// ---------------------------------------------------------------------------
// edgeIsDecision
// ---------------------------------------------------------------------------

describe("edgeIsDecision", () => {
	const workflow: Workflow = {
		name: "mixed",
		start: "a",
		stages: baseStages,
		edges: {
			a: "b",
			b: gate("count", { c: gt(0), d: eq(0) }),
			c: "stop",
		},
	};

	it("is true for EdgeFn edges (a routing decision)", () => {
		expect(edgeIsDecision(workflow, "b")).toBe(true);
	});

	it("is false for string edges (deterministic auto-edge)", () => {
		expect(edgeIsDecision(workflow, "a")).toBe(false);
	});

	it('is false for the "stop" sentinel', () => {
		expect(edgeIsDecision(workflow, "c")).toBe(false);
	});

	it("is false for stages with no outgoing edge", () => {
		expect(edgeIsDecision(workflow, "d")).toBe(false);
	});
});
