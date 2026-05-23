import { describe, expect, it } from "vitest";
import type { DagNode, WorkflowDag } from "./dag.js";
import { predicateThreshold } from "./predicates.js";
import { resolveNextStageId } from "./routing.js";
import type { RunState } from "./types.js";

const nodeOf = (overrides: Partial<DagNode> = {}): DagNode => ({
	kind: "skill",
	skill: "test",
	completionStrategy: "agent-end",
	sessionPolicy: "fresh",
	...overrides,
});

const makeState = (manifestData?: Record<string, unknown>): RunState => ({
	originalInput: "",
	artifactPath: undefined,
	manifest: manifestData
		? { kind: "artifact-md", data: manifestData, meta: { skill: "source", stageNumber: 1, ts: "", runId: "" } }
		: undefined,
	stagesCompleted: 0,
	lastStageNumber: 0,
	success: false,
	error: undefined,
	backwardJumps: 0,
});

describe("resolveNextStageId", () => {
	const preset = ["a", "b", "c", "d"];
	const baseDag: WorkflowDag = {
		edges: [],
		presets: { test: preset },
		nodes: {
			a: nodeOf({ skill: "a" }),
			b: nodeOf({ skill: "b" }),
			c: nodeOf({ skill: "c" }),
			d: nodeOf({ skill: "d" }),
		},
	};

	it("returns preset[idx + 1] when no outgoing edge", () => {
		const result = resolveNextStageId(baseDag, "a", preset, 0, makeState());
		expect(result).toBe("b");
	});

	it("returns undefined when idx + 1 >= preset.length (chain end)", () => {
		const result = resolveNextStageId(baseDag, "d", preset, 3, makeState());
		expect(result).toBeUndefined();
	});

	it("auto edge returns edge.to[0]", () => {
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["c"], condition: "auto" }],
		};
		const result = resolveNextStageId(dag, "a", preset, 0, makeState());
		expect(result).toBe("c");
	});

	it("predicate edge evaluates predicate and returns the chosen id", () => {
		const predicate = predicateThreshold("count", 0, "c", "b");
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["c", "b"], condition: "predicate", predicate }],
		};
		// count > 0 → "c"
		const state1 = makeState({ count: 5 });
		expect(resolveNextStageId(dag, "a", preset, 0, state1)).toBe("c");

		// count <= 0 → "b"
		const state2 = makeState({ count: 0 });
		expect(resolveNextStageId(dag, "a", preset, 0, state2)).toBe("b");
	});

	it("predicate that throws propagates an error (caller halts)", () => {
		const badPredicate = () => {
			throw new Error("predicate exploded");
		};
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["b", "c"], condition: "predicate", predicate: badPredicate }],
		};
		expect(() => resolveNextStageId(dag, "a", preset, 0, makeState())).toThrow(/predicate on edge.*threw an error/);
	});

	it("strict-preset rejects predicate target not in preset at idx + 1 or later", () => {
		// "a" is at idx 0 — target "a" would be backwards (idx 0 < idx + 1)
		const predicate = predicateThreshold("count", 0, "a", "b");
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["a", "b"], condition: "predicate", predicate }],
		};
		// count > 0 → "a", which is at idx 0 (before current idx + 1 = 1)
		expect(() => resolveNextStageId(dag, "a", preset, 0, makeState({ count: 5 }))).toThrow(
			/not a valid forward target/,
		);
	});

	it("strict-preset rejects predicate target not in preset at all", () => {
		const predicate = predicateThreshold("count", 0, "nonexistent", "b");
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["nonexistent", "b"], condition: "predicate", predicate }],
		};
		expect(() => resolveNextStageId(dag, "a", preset, 0, makeState({ count: 5 }))).toThrow(
			/not a valid forward target/,
		);
	});

	it("choice edge falls back to linear advance (user-prompt not wired)", () => {
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["b", "c"], condition: "choice" }],
		};
		const result = resolveNextStageId(dag, "a", preset, 0, makeState());
		expect(result).toBe("b");
	});

	it("predicate can skip forward (target at idx + 2)", () => {
		const predicate = predicateThreshold("count", 0, "d", "b");
		const dag: WorkflowDag = {
			...baseDag,
			edges: [{ from: "a", to: ["d", "b"], condition: "predicate", predicate }],
		};
		// count > 0 → "d" at idx 3, which is >= idx + 1 (1)
		const result = resolveNextStageId(dag, "a", preset, 0, makeState({ count: 5 }));
		expect(result).toBe("d");
	});
});
