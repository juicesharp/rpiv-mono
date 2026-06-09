/**
 * Unit tests for control-flow-as-data: the `fanoutOver`/`iterateOver` builders
 * attach an introspectable `.spec` to the SAME executable the runner consumes
 * (the `defineRoute`/`.targets` pattern), and `describeFlow` projects a
 * workflow's structure from that attached metadata alone — no probing.
 */

import { describe, expect, it } from "vitest";
import { acts, defineWorkflow, type FanoutFn, gate, produces } from "./api.js";
import { describeFlow, fanoutOver, fanoutSpecOf, iterateOver, iterateSpecOf } from "./control-flow.js";
import { eq, gt } from "./predicates.js";

const fanoutStub = fanoutOver({
	source: "plans",
	unit: { by: "frontmatter-array", pattern: "phases" },
	max: 32,
	run: () => [{ prompt: "x", label: "1/1" }],
});

const iterateStub = iterateOver({
	source: "architecture-reviews",
	unit: { by: "markdown-heading", pattern: "### Phase {n}" },
	max: 8,
	run: () => null,
});

describe("fanoutOver / iterateOver", () => {
	it("attaches a fanout spec while staying the executable FanoutFn", async () => {
		expect(fanoutStub.spec).toEqual({
			kind: "fanout",
			source: "plans",
			unit: { by: "frontmatter-array", pattern: "phases" },
			max: 32,
		});
		// still callable by the runner — the wrapped fn IS the detector
		expect(fanoutStub({ cwd: "/tmp", artifact: undefined, state: {} as never })).toEqual([
			{ prompt: "x", label: "1/1" },
		]);
	});

	it("attaches an iterate spec with dependsOnPrior fixed true", () => {
		expect(iterateStub.spec).toEqual({
			kind: "iterate",
			dependsOnPrior: true,
			source: "architecture-reviews",
			unit: { by: "markdown-heading", pattern: "### Phase {n}" },
			max: 8,
		});
	});
});

describe("fanoutSpecOf / iterateSpecOf", () => {
	it("reads a spec off a specced fn", () => {
		expect(fanoutSpecOf(fanoutStub)?.source).toBe("plans");
		expect(iterateSpecOf(iterateStub)?.dependsOnPrior).toBe(true);
	});

	it("returns undefined for a raw (opaque) fn or undefined", () => {
		const raw: FanoutFn = () => [];
		expect(fanoutSpecOf(raw)).toBeUndefined();
		expect(fanoutSpecOf(undefined)).toBeUndefined();
		expect(iterateSpecOf(undefined)).toBeUndefined();
	});
});

describe("describeFlow", () => {
	const wf = defineWorkflow({
		name: "t",
		description: "d",
		start: "research",
		stages: {
			research: produces(),
			implement: acts({ fanout: fanoutStub, reads: ["plans"] }),
			blueprint: produces({ iterate: iterateStub }),
			"code-review": produces(),
			commit: acts(),
		},
		edges: {
			research: "implement",
			implement: "blueprint",
			blueprint: "code-review",
			"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }),
			commit: "stop",
		},
	});

	const shapes = describeFlow(wf);
	const byStage = Object.fromEntries(shapes.map((s) => [s.stage, s]));

	it("reports control-flow mode per stage from attached specs", () => {
		expect(byStage.research?.control.mode).toBe("single");
		expect(byStage.implement?.control).toEqual({ mode: "fanout", spec: fanoutStub.spec });
		expect(byStage.blueprint?.control).toEqual({ mode: "iterate", spec: iterateStub.spec });
	});

	it("reports edge shape: linear, route (via .targets), terminal", () => {
		expect(byStage.research?.edge).toEqual({ mode: "linear", targets: ["implement"] });
		expect(byStage["code-review"]?.edge.mode).toBe("route");
		expect(byStage["code-review"]?.edge.targets).toEqual(["blueprint", "commit"]);
		expect(byStage.commit?.edge).toEqual({ mode: "terminal" });
	});
});
