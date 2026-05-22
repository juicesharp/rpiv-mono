import { describe, expect, it } from "vitest";
import {
	type DagNode,
	getEdge,
	isValidNode,
	resolvePreset,
	validateDag,
	WORKFLOW_DAG,
	type WorkflowDag,
} from "./dag.js";

describe("DAG types and constants", () => {
	it("WORKFLOW_DAG has 12 edges (9 auto + 3 choice)", () => {
		expect(WORKFLOW_DAG.edges).toHaveLength(12);
		expect(WORKFLOW_DAG.edges.filter((e) => e.condition === "auto")).toHaveLength(9);
		expect(WORKFLOW_DAG.edges.filter((e) => e.condition === "choice")).toHaveLength(3);
	});

	it("WORKFLOW_DAG has 3 presets", () => {
		const presetNames = Object.keys(WORKFLOW_DAG.presets);
		expect(presetNames).toEqual(["small", "mid", "large"]);
	});

	it("large preset has 7 nodes (longest chain — includes code-review)", () => {
		expect(WORKFLOW_DAG.presets.large).toHaveLength(7);
	});

	it("every preset includes validate as its final verification stage", () => {
		// small/mid end at validate; large continues into code-review after validate.
		for (const [name, stageIds] of Object.entries(WORKFLOW_DAG.presets)) {
			expect(stageIds, `preset ${name} should include validate`).toContain("validate");
		}
	});

	it("every preset reaches implement before validate (so there is code to validate)", () => {
		for (const [name, stageIds] of Object.entries(WORKFLOW_DAG.presets)) {
			expect(stageIds, `preset ${name} should include implement`).toContain("implement");
		}
	});

	it("every auto edge has exactly one target; every choice edge has >= 2", () => {
		for (const edge of WORKFLOW_DAG.edges) {
			if (edge.condition === "auto") {
				expect(edge.to).toHaveLength(1);
			} else {
				expect(edge.to.length).toBeGreaterThanOrEqual(2);
			}
		}
	});

	it("no duplicate edge sources", () => {
		const froms = WORKFLOW_DAG.edges.map((e) => e.from);
		expect(new Set(froms).size).toBe(froms.length);
	});
});

describe("getEdge", () => {
	it("returns edge for known source", () => {
		const edge = getEdge(WORKFLOW_DAG, "discover");
		expect(edge).toBeDefined();
		expect(edge!.to).toEqual(["research"]);
		expect(edge!.condition).toBe("auto");
	});

	it("returns undefined for leaf node", () => {
		expect(getEdge(WORKFLOW_DAG, "commit")).toBeUndefined();
	});

	it("returns choice edge for research", () => {
		const edge = getEdge(WORKFLOW_DAG, "research");
		expect(edge).toBeDefined();
		expect(edge!.condition).toBe("choice");
		expect(edge!.to).toEqual(["design", "blueprint"]);
	});
});

describe("resolvePreset", () => {
	it("resolves small to research → blueprint → implement → validate", () => {
		expect(resolvePreset(WORKFLOW_DAG, "small")).toEqual(["research", "blueprint", "implement", "validate"]);
	});

	it("resolves mid to correct sequence", () => {
		expect(resolvePreset(WORKFLOW_DAG, "mid")).toEqual([
			"discover",
			"research",
			"blueprint",
			"implement",
			"validate",
		]);
	});

	it("resolves large to correct sequence", () => {
		expect(resolvePreset(WORKFLOW_DAG, "large")).toEqual([
			"discover",
			"research",
			"design",
			"plan",
			"implement",
			"validate",
			"code-review",
		]);
	});

	it("returns undefined for unknown preset", () => {
		expect(resolvePreset(WORKFLOW_DAG, "nonexistent")).toBeUndefined();
	});
});

describe("validateDag", () => {
	const nodeOf = (skill: string, overrides: Partial<DagNode> = {}): DagNode => ({
		kind: "skill",
		skill,
		stopStrategy: "agent-end",
		sessionPolicy: "fresh",
		...overrides,
	});

	it("returns no errors for the default WORKFLOW_DAG", () => {
		expect(validateDag(WORKFLOW_DAG)).toEqual([]);
	});

	it("reports edge source that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "nonexistent", to: ["commit"], condition: "auto" }],
			presets: {},
			nodes: { commit: nodeOf("commit") },
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([expect.stringContaining(`Edge source "nonexistent" has no entry in nodes`)]);
	});

	it("reports edge target that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "discover", to: ["nonexistent"], condition: "auto" }],
			presets: {},
			nodes: { discover: nodeOf("discover") },
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Edge target "nonexistent" (from "discover") has no entry in nodes`),
		]);
	});

	it("reports preset entry that's not in nodes map", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { small: ["nonexistent", "implement"] },
			nodes: { implement: nodeOf("implement") },
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Preset "small" references "nonexistent" which has no entry in nodes`),
		]);
	});

	it("reports skill-kind node referencing a non-bundled skill", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["custom"] },
			nodes: { custom: nodeOf("not-a-real-skill") },
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Node "custom" (kind=skill) references unknown bundled skill: "not-a-real-skill"`),
		]);
	});

	it("rejects sessionPolicy: 'continue' as not-yet-supported at runtime", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: { research: nodeOf("research", { sessionPolicy: "continue" }) },
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([
			expect.stringContaining(`Node "research" uses sessionPolicy "continue" which is not yet supported at runtime`),
		]);
	});

	it("rejects invalid stopStrategy value", () => {
		const badDag: WorkflowDag = {
			edges: [],
			presets: { tiny: ["research"] },
			nodes: {
				research: { ...nodeOf("research"), stopStrategy: "garbage" as never },
			},
		};
		const errors = validateDag(badDag);
		expect(errors).toEqual([expect.stringContaining(`Node "research" has invalid stopStrategy: "garbage"`)]);
	});

	it("reports multiple errors at once", () => {
		const badDag: WorkflowDag = {
			edges: [{ from: "nonexistent", to: ["also-bad"], condition: "auto" }],
			presets: {},
			nodes: {},
		};
		expect(validateDag(badDag).length).toBeGreaterThanOrEqual(2);
	});
});

describe("isValidNode", () => {
	it("returns true for known skills", () => {
		expect(isValidNode("discover")).toBe(true);
		expect(isValidNode("research")).toBe(true);
		expect(isValidNode("commit")).toBe(true);
	});

	it("returns false for unknown skills", () => {
		expect(isValidNode("nonexistent-skill")).toBe(false);
		expect(isValidNode("")).toBe(false);
	});
});
