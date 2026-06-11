/**
 * Unit tests for control flow as data: the `fanout()`/`iterate()`/`assess()`
 * constructors build the `LoopDef` a stage carries on its single `loop` field
 * (validated at construction), `loopSpecOf` projects the pure-data facet, and
 * `describeFlow` projects a workflow's structure from that attached metadata
 * alone — no probing.
 */

import { describe, expect, it } from "vitest";
import {
	acts,
	defineWorkflow,
	gate,
	type OutputSpec,
	produces,
	type StageDef,
	type VerifySpec,
	type Workflow,
} from "./api.js";
import {
	assess,
	DEFAULT_ASSESS_MAX,
	describeFlow,
	effectiveLoopOf,
	fanout,
	iterate,
	judgeSpecOf,
	loopSpecOf,
	synthesizeVerifyLoop,
	verify,
} from "./control-flow.js";
import { type Judge, judge } from "./judge.js";
import type { Output } from "./output.js";
import { eq, gt } from "./predicates.js";

const verdictOutcome = { name: "verdict" } as Judge["outcome"];

describe("describeFlow", () => {
	const fanoutLoop = fanout({
		source: "plans",
		unit: { by: "frontmatter-array", pattern: "phases" },
		max: 32,
		units: () => [{ prompt: "x", label: "1/1" }],
	});
	const iterateLoop = iterate({
		source: "architecture-reviews",
		unit: { by: "markdown-heading", pattern: "### Phase {n}" },
		max: 8,
		next: () => null,
	});
	const assessLoop = assess({
		judge: judge({ skill: "grade-breakdown", outcome: verdictOutcome }),
		done: () => true,
		feedForward: () => "again",
		max: 5,
	});

	const wf = defineWorkflow({
		name: "t",
		description: "d",
		start: "research",
		stages: {
			research: produces(),
			implement: acts({ loop: fanoutLoop, reads: ["plans"] }),
			blueprint: produces({
				loop: iterateLoop,
				outcome: { name: "plans", collector: { snapshot: false } } as never,
			}),
			breakdown: produces({ loop: assessLoop, outcome: { name: "tasks", collector: { snapshot: false } } as never }),
			"code-review": produces(),
			commit: acts(),
		},
		edges: {
			research: "implement",
			implement: "blueprint",
			blueprint: "breakdown",
			breakdown: "code-review",
			"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }),
			commit: "stop",
		},
	});

	const shapes = describeFlow(wf);
	const byStage = Object.fromEntries(shapes.map((s) => [s.stage, s]));

	it("reports control-flow mode per stage from the attached loop (assess included)", () => {
		expect(byStage.research?.control.mode).toBe("single");
		expect(byStage.implement?.control).toEqual({ mode: "fanout", spec: loopSpecOf(fanoutLoop) });
		expect(byStage.blueprint?.control).toEqual({ mode: "iterate", spec: loopSpecOf(iterateLoop) });
		expect(byStage.breakdown?.control).toEqual({ mode: "assess", spec: loopSpecOf(assessLoop) });
	});

	it("reports edge shape: linear, route (via .targets), terminal", () => {
		expect(byStage.research?.edge).toEqual({ mode: "linear", targets: ["implement"] });
		expect(byStage["code-review"]?.edge.mode).toBe("route");
		expect(byStage["code-review"]?.edge.targets).toEqual(["blueprint", "commit"]);
		expect(byStage.commit?.edge).toEqual({ mode: "terminal" });
	});
});

describe("fanout() / iterate() / assess() constructors", () => {
	it("fanout() fills kind defaults (onCap halt, result entry)", () => {
		const loop = fanout({ units: () => [{ prompt: "x", label: "1/1" }] });
		expect(loop.kind).toBe("fanout");
		expect(loop.onCap).toBe("halt");
		expect(loop.result).toBe("entry");
		expect(loop.max).toBeUndefined();
	});

	it("iterate() fills kind defaults (onCap halt, result last)", () => {
		const loop = iterate({ next: () => null });
		expect(loop.kind).toBe("iterate");
		expect(loop.onCap).toBe("halt");
		expect(loop.result).toBe("last");
	});

	it("assess() fills kind defaults (onCap advance, result last, max → 8)", () => {
		const loop = assess({
			judge: judge({ skill: "grade", outcome: verdictOutcome }),
			done: (v) => (v.data as { done?: boolean }).done === true,
			feedForward: () => "again",
		});
		expect(loop.kind).toBe("assess");
		expect(loop.onCap).toBe("advance");
		expect(loop.result).toBe("last");
		expect(loop.max).toBe(DEFAULT_ASSESS_MAX);
		expect(loop.max).toBe(8);
	});

	it("honours explicit onCap / result / max overrides", () => {
		const loop = fanout({ units: () => [], onCap: "advance", result: "last", max: 4 });
		expect(loop.onCap).toBe("advance");
		expect(loop.result).toBe("last");
		expect(loop.max).toBe(4);
	});

	it("checkedMax throws on non-integer / < 1", () => {
		expect(() => fanout({ units: () => [], max: 0 })).toThrow(/max must be an integer >= 1/);
		expect(() => iterate({ next: () => null, max: 1.5 })).toThrow(/max must be an integer >= 1/);
		expect(() =>
			assess({
				judge: judge({ skill: "grade", outcome: verdictOutcome }),
				done: () => true,
				feedForward: () => "x",
				max: -2,
			}),
		).toThrow(/max must be an integer >= 1/);
	});

	it("assess() throws on a non-function done / feedForward", () => {
		expect(() =>
			assess({
				judge: judge({ skill: "grade", outcome: verdictOutcome }),
				done: undefined as never,
				feedForward: () => "x",
			}),
		).toThrow(/`done` must be a function/);
		expect(() =>
			assess({
				judge: judge({ skill: "grade", outcome: verdictOutcome }),
				done: () => true,
				feedForward: undefined as never,
			}),
		).toThrow(/`feedForward` must be a function/);
	});

	it("assess() throws on an invalid judge", () => {
		expect(() =>
			assess({
				judge: { outcome: verdictOutcome } as Judge,
				done: () => true,
				feedForward: () => "x",
			}),
		).toThrow(/assess\(\):.*one is required to dispatch/);
	});
});

describe("loopSpecOf", () => {
	it("returns undefined for a non-loop stage", () => {
		expect(loopSpecOf(undefined)).toBeUndefined();
	});

	it("projects a fanout loop without a judge", () => {
		const loop = fanout({
			source: "plans",
			unit: { by: "frontmatter-array", pattern: "phases" },
			max: 32,
			units: () => [],
		});
		expect(loopSpecOf(loop)).toEqual({
			kind: "fanout",
			source: "plans",
			unit: { by: "frontmatter-array", pattern: "phases" },
			max: 32,
			onCap: "halt",
			result: "entry",
		});
	});

	it("projects an iterate loop", () => {
		const loop = iterate({ next: () => null });
		expect(loopSpecOf(loop)?.kind).toBe("iterate");
		expect(loopSpecOf(loop)?.judge).toBeUndefined();
	});

	it("projects an assess loop with the judge summarised (prompt: boolean)", () => {
		const loop = assess({
			judge: judge({ skill: "grade-breakdown", outcome: verdictOutcome }),
			done: () => true,
			feedForward: () => "x",
		});
		expect(loopSpecOf(loop)?.judge).toEqual({ skill: "grade-breakdown", prompt: false, outcome: "verdict" });
	});

	it("marks a prompt judge with prompt: true and no skill", () => {
		const loop = assess({
			judge: judge({ prompt: "grade this", outcome: verdictOutcome }),
			done: () => true,
			feedForward: () => "x",
		});
		expect(loopSpecOf(loop)?.judge).toEqual({ skill: undefined, prompt: true, outcome: "verdict" });
	});
});

describe("verify() constructor", () => {
	// Collector is never invoked in constructor tests — minimal stub.
	const noopCollector = {
		collect: () => {
			throw new Error("collector unused in constructor tests");
		},
	} as unknown as OutputSpec["collector"];
	const outcomeOf = (name: string): OutputSpec => ({ name, collector: noopCollector });
	const skillJudge = () => judge({ skill: "grade", outcome: outcomeOf("verdict") });
	const pass = (v: Output) => Boolean((v.data as { ok?: boolean }).ok);

	it("accepts a well-formed gate-only verify (judge + pass)", () => {
		const v = verify({ judge: skillJudge(), pass });
		expect(v.pass).toBe(pass);
		expect(v.maxAttempts).toBeUndefined();
	});

	it("accepts a retrying verify (feedForward + maxAttempts)", () => {
		const feedForward = () => "again";
		const v = verify({ judge: skillJudge(), pass, feedForward, maxAttempts: 3 });
		expect(v.feedForward).toBe(feedForward);
		expect(v.maxAttempts).toBe(3);
	});

	it("throws on a judge that sets both skill and prompt", () => {
		expect(() =>
			verify({ judge: { skill: "grade", prompt: "rate it", outcome: outcomeOf("verdict") }, pass }),
		).toThrow(/skill XOR prompt/);
	});

	it("throws on a judge whose outcome has no name", () => {
		expect(() =>
			verify({ judge: { skill: "grade", outcome: { collector: noopCollector } as OutputSpec }, pass }),
		).toThrow(/judge\.outcome must carry a `name`/);
	});

	it("throws when `pass` is not a function", () => {
		expect(() => verify({ judge: skillJudge(), pass: true as unknown as VerifySpec["pass"] })).toThrow(
			/`pass` to be a function/,
		);
	});

	it.each([0, -1, 1.5])("throws on maxAttempts %s (must be an integer >= 1)", (maxAttempts) => {
		expect(() => verify({ judge: skillJudge(), pass, feedForward: () => "x", maxAttempts })).toThrow(
			/maxAttempts.*must be an integer >= 1/,
		);
	});

	it("throws when maxAttempts > 1 without feedForward", () => {
		expect(() => verify({ judge: skillJudge(), pass, maxAttempts: 2 })).toThrow(
			/maxAttempts > 1 requires `feedForward`/,
		);
	});

	it("throws when feedForward is present but not a function", () => {
		expect(() =>
			verify({
				judge: skillJudge(),
				pass,
				feedForward: "again" as unknown as VerifySpec["feedForward"],
				maxAttempts: 2,
			}),
		).toThrow(/`feedForward` must be a function/);
	});
});

describe("synthesizeVerifyLoop / effectiveLoopOf", () => {
	const noopCollector = {
		collect: () => {
			throw new Error("collector unused");
		},
	} as unknown as OutputSpec["collector"];
	const outcomeOf = (name: string): OutputSpec => ({ name, collector: noopCollector });
	const skillJudge = () => judge({ skill: "grade", outcome: outcomeOf("verdict") });
	const pass = (v: Output) => Boolean((v.data as { ok?: boolean }).ok);

	it("gate-only synthesis: degenerate assess — max 1, onCap halt, result last, done IS pass", () => {
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), pass }));
		expect(loop.kind).toBe("assess");
		expect(loop.max).toBe(1);
		expect(loop.onCap).toBe("halt");
		expect(loop.result).toBe("last");
		expect(loop.done).toBe(pass);
	});

	it("retrying synthesis: max = maxAttempts, feedForward IS the author's", () => {
		const feedForward = () => "again";
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), pass, feedForward, maxAttempts: 3 }));
		expect(loop.max).toBe(3);
		expect(loop.feedForward).toBe(feedForward);
	});

	it("the gate-only feedForward stub throws when invoked (driver invariant tripwire)", () => {
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), pass }));
		expect(() => loop.feedForward({} as unknown as Parameters<typeof loop.feedForward>[0])).toThrow(
			/driver invariant violated/,
		);
	});

	it("effectiveLoopOf: loop wins over verify; verify synthesizes; neither → undefined", () => {
		const v = verify({ judge: skillJudge(), pass });
		const explicit = iterate({ next: () => null });
		const base: StageDef = { kind: "produces", sessionPolicy: "fresh" };
		expect(effectiveLoopOf({ ...base, loop: explicit, verify: v })).toBe(explicit);
		expect(effectiveLoopOf({ ...base, verify: v })?.kind).toBe("assess");
		expect(effectiveLoopOf(base)).toBeUndefined();
	});

	it("describeFlow: a verify stage stays control.mode 'single' and carries the verify projection", () => {
		const w: Workflow = {
			name: "gated",
			start: "build",
			stages: {
				build: {
					kind: "produces",
					sessionPolicy: "fresh",
					outcome: outcomeOf("impl"),
					verify: verify({ judge: skillJudge(), pass, feedForward: () => "x", maxAttempts: 2 }),
				},
			},
			edges: { build: "stop" },
		};
		const [shape] = describeFlow(w);
		expect(shape?.control.mode).toBe("single");
		expect(shape?.verify).toEqual({ skill: "grade", prompt: false, outcome: "verdict", maxAttempts: 2 });
	});

	it("loopSpecOf's assess judge summary equals judgeSpecOf's output (no drift)", () => {
		const j = skillJudge();
		const loop = assess({ judge: j, done: () => true, feedForward: () => "x" });
		expect(loopSpecOf(loop)?.judge).toEqual(judgeSpecOf(j));
	});
});
