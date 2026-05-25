/**
 * Tests for `nextNode` / `edgeIsDecision` — workflow-graph traversal.
 *
 * Each test builds a minimal Workflow by hand and asserts the resolved next
 * name (or null) for a given current-node + state combination.
 */

import { describe, expect, it } from "vitest";
import { type EdgeContext, threshold, type Workflow } from "./api.js";
import { edgeIsDecision, nextNode } from "./routing.js";
import type { RunState } from "./types.js";

const makeState = (manifestData?: Record<string, unknown>): RunState => ({
	originalInput: "",
	fallbackArtifactPath: undefined,
	manifest: manifestData
		? { kind: "artifact-md", data: manifestData, meta: { skill: "source", stageNumber: 1, ts: "", runId: "" } }
		: undefined,
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

const ctxOf = (manifestData?: Record<string, unknown>): EdgeContext => {
	const state = makeState(manifestData);
	return { manifest: state.manifest, state };
};

const node = (name: string) => ({
	name,
	skill: name,
	completionStrategy: "agent-end" as const,
	sessionPolicy: "fresh" as const,
});

const baseNodes = {
	a: node("a"),
	b: node("b"),
	c: node("c"),
	d: node("d"),
};

// ---------------------------------------------------------------------------
// nextNode
// ---------------------------------------------------------------------------

describe("nextNode", () => {
	it("follows a string edge to the named target", () => {
		const workflow: Workflow = {
			name: "linear",
			start: "a",
			nodes: baseNodes,
			edges: { a: "b", b: "c", c: "d", d: "stop" },
		};
		expect(nextNode(workflow, "a", ctxOf())).toBe("b");
		expect(nextNode(workflow, "b", ctxOf())).toBe("c");
		expect(nextNode(workflow, "c", ctxOf())).toBe("d");
	});

	it('returns null for the "stop" sentinel', () => {
		const workflow: Workflow = {
			name: "terminal",
			start: "a",
			nodes: baseNodes,
			edges: { a: "stop" },
		};
		expect(nextNode(workflow, "a", ctxOf())).toBeNull();
	});

	it("returns null for a node with no outgoing edge (implicit terminal)", () => {
		const workflow: Workflow = {
			name: "implicit",
			start: "a",
			nodes: baseNodes,
			edges: { a: "b" }, // b has no edge
		};
		expect(nextNode(workflow, "b", ctxOf())).toBeNull();
	});

	it("evaluates an EdgeFn against the supplied context", () => {
		const workflow: Workflow = {
			name: "pred",
			start: "a",
			nodes: baseNodes,
			edges: { a: threshold("count", 0, "c", "b") },
		};
		expect(nextNode(workflow, "a", ctxOf({ count: 5 }))).toBe("c");
		expect(nextNode(workflow, "a", ctxOf({ count: 0 }))).toBe("b");
	});

	it("an EdgeFn returning the stop sentinel terminates the chain", () => {
		const workflow: Workflow = {
			name: "pred-stop",
			start: "a",
			nodes: baseNodes,
			edges: { a: () => "stop" },
		};
		expect(nextNode(workflow, "a", ctxOf())).toBeNull();
	});

	it("throws when an EdgeFn returns a target that is not a declared node", () => {
		const workflow: Workflow = {
			name: "rogue",
			start: "a",
			nodes: baseNodes,
			edges: { a: () => "ghost" },
		};
		expect(() => nextNode(workflow, "a", ctxOf())).toThrow(/"ghost" which is not a declared node/);
	});

	it("throws when a string edge target is not a declared node (defensive)", () => {
		const workflow: Workflow = {
			name: "rogue-string",
			start: "a",
			nodes: baseNodes,
			edges: { a: "ghost" },
		};
		expect(() => nextNode(workflow, "a", ctxOf())).toThrow(/"ghost" which is not a declared node/);
	});

	it("wraps an EdgeFn that throws with a helpful message", () => {
		const workflow: Workflow = {
			name: "thrower",
			start: "a",
			nodes: baseNodes,
			edges: {
				a: () => {
					throw new Error("predicate exploded");
				},
			},
		};
		expect(() => nextNode(workflow, "a", ctxOf())).toThrow(/edge function at "a" threw: predicate exploded/);
	});
});

// ---------------------------------------------------------------------------
// edgeIsDecision
// ---------------------------------------------------------------------------

describe("edgeIsDecision", () => {
	const workflow: Workflow = {
		name: "mixed",
		start: "a",
		nodes: baseNodes,
		edges: {
			a: "b",
			b: threshold("count", 0, "c", "d"),
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

	it("is false for nodes with no outgoing edge", () => {
		expect(edgeIsDecision(workflow, "d")).toBe(false);
	});
});
