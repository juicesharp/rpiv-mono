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
	fanin,
	gate,
	type Outcome,
	produces,
	type StageDef,
	type VerifySpec,
	type Workflow,
} from "./api.js";
import { type Judge, judge, marksCanonicalFold, type NamedOutcome } from "./judge.js";
import {
	all,
	any,
	assess,
	DEFAULT_ASSESS_MAX,
	describeFlow,
	effectiveLoopOf,
	fanout,
	iterate,
	judgeSlotSpecOf,
	judgeSpecOf,
	loopSpecOf,
	majority,
	type PanelSpec,
	panel,
	panelShapeIssues,
	panelSpecOf,
	synthesizeVerifyLoop,
	verify,
} from "./loop-constructors.js";
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
			"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
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

	it("exposes a reads facet: bare string → all:false, fanin() → all:true, declared order; omitted when no reads", () => {
		const w = defineWorkflow({
			name: "fanin-flow",
			description: "d",
			start: "plan",
			stages: {
				plan: produces({
					loop: fanout({ units: () => [{ prompt: "x", label: "1/1" }] }),
					outcome: { name: "plans", collector: { snapshot: false } } as never,
				}),
				rubric: produces({ outcome: { name: "rubric", collector: { snapshot: false } } as never }),
				synthesize: produces({ reads: [fanin("plans"), "rubric"] }),
			},
			edges: { plan: "rubric", rubric: "synthesize", synthesize: "stop" },
		});
		const by = Object.fromEntries(describeFlow(w).map((s) => [s.stage, s]));
		expect(by.synthesize?.reads).toEqual([
			{ name: "plans", all: true },
			{ name: "rubric", all: false },
		]);
		// A stage with no reads omits the facet entirely.
		expect(by.plan?.reads).toBeUndefined();
		expect(by.rubric?.reads).toBeUndefined();
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
	} as unknown as Outcome["collector"];
	const outcomeOf = (name: string): Outcome & { name: string } => ({ name, collector: noopCollector });
	const skillJudge = () => judge({ skill: "grade", outcome: outcomeOf("verdict") });
	const pass = (v: Output) => Boolean((v.data as { ok?: boolean }).ok);

	it("accepts a well-formed gate-only verify (judge + pass)", () => {
		const v = verify({ judge: skillJudge(), done: pass });
		expect(v.done).toBe(pass);
		expect(v.max).toBeUndefined();
	});

	it("accepts a retrying verify (feedForward + max)", () => {
		const feedForward = () => "again";
		const v = verify({ judge: skillJudge(), done: pass, feedForward, max: 3 });
		expect(v.feedForward).toBe(feedForward);
		expect(v.max).toBe(3);
	});

	it("throws on a judge that sets both skill and prompt", () => {
		expect(() =>
			verify({
				judge: { skill: "grade", prompt: "rate it", outcome: outcomeOf("verdict") } as unknown as Judge,
				done: pass,
			}),
		).toThrow(/skill XOR prompt/);
	});

	it("throws on a judge whose outcome has no name", () => {
		expect(() =>
			verify({ judge: { skill: "grade", outcome: { collector: noopCollector } as Judge["outcome"] }, done: pass }),
		).toThrow(/judge\.outcome must carry a `name`/);
	});

	it("throws when `done` is not a function", () => {
		expect(() => verify({ judge: skillJudge(), done: true as unknown as VerifySpec["done"] })).toThrow(
			/`done` to be a function/,
		);
	});

	it.each([0, -1, 1.5])("throws on max %s (must be an integer >= 1)", (max) => {
		expect(() => verify({ judge: skillJudge(), done: pass, feedForward: () => "x", max })).toThrow(
			/max.*must be an integer >= 1/,
		);
	});

	it("throws when max > 1 without feedForward", () => {
		expect(() => verify({ judge: skillJudge(), done: pass, max: 2 })).toThrow(/max > 1 requires `feedForward`/);
	});

	it("throws when feedForward is present but not a function", () => {
		expect(() =>
			verify({
				judge: skillJudge(),
				done: pass,
				feedForward: "again" as unknown as VerifySpec["feedForward"],
				max: 2,
			}),
		).toThrow(/`feedForward` must be a function/);
	});
});

describe("synthesizeVerifyLoop / effectiveLoopOf", () => {
	const noopCollector = {
		collect: () => {
			throw new Error("collector unused");
		},
	} as unknown as Outcome["collector"];
	const outcomeOf = (name: string): Outcome & { name: string } => ({ name, collector: noopCollector });
	const skillJudge = () => judge({ skill: "grade", outcome: outcomeOf("verdict") });
	const pass = (v: Output) => Boolean((v.data as { ok?: boolean }).ok);

	it("gate-only synthesis: degenerate assess — max 1, onCap halt, result last, done IS pass", () => {
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), done: pass }));
		expect(loop.kind).toBe("assess");
		expect(loop.max).toBe(1);
		expect(loop.onCap).toBe("halt");
		expect(loop.result).toBe("last");
		expect(loop.done).toBe(pass);
	});

	it("retrying synthesis: max = max, feedForward IS the author's", () => {
		const feedForward = () => "again";
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), done: pass, feedForward, max: 3 }));
		expect(loop.max).toBe(3);
		expect(loop.feedForward).toBe(feedForward);
	});

	it("the gate-only feedForward stub throws when invoked (driver invariant tripwire)", () => {
		const loop = synthesizeVerifyLoop(verify({ judge: skillJudge(), done: pass }));
		expect(() => loop.feedForward({} as unknown as Parameters<typeof loop.feedForward>[0])).toThrow(
			/driver invariant violated/,
		);
	});

	it("effectiveLoopOf: loop wins over verify; verify synthesizes; neither → undefined", () => {
		const v = verify({ judge: skillJudge(), done: pass });
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
					verify: verify({ judge: skillJudge(), done: pass, feedForward: () => "x", max: 2 }),
				},
			},
			edges: { build: "stop" },
		};
		const [shape] = describeFlow(w);
		expect(shape?.control.mode).toBe("single");
		expect(shape?.verify).toEqual({ skill: "grade", prompt: false, outcome: "verdict", max: 2 });
	});

	it("loopSpecOf's assess judge summary equals judgeSpecOf's output (no drift)", () => {
		const j = skillJudge();
		const loop = assess({ judge: j, done: () => true, feedForward: () => "x" });
		expect(loopSpecOf(loop)?.judge).toEqual(judgeSpecOf(j));
	});
});

// === Panel — Phase 2: construction + sugar folds (no execution) ============

/** A minimal member verdict — sugar folds only read what `pred` interprets. */
const verdict = (ok: boolean) => ({ data: { ok } }) as unknown as Output;
const isOk = (v: Output) => (v.data as { ok: boolean }).ok;
const memberA = judge({ skill: "grade-a", outcome: { name: "va" } as Judge["outcome"] });
const memberB = judge({ skill: "grade-b", outcome: { name: "vb" } as Judge["outcome"] });
const customOutcome = { name: "score" } as NamedOutcome;

describe("sugar folds (majority / all / any)", () => {
	it("majority passes on a strict majority and reports the split", () => {
		const v = majority(isOk)([verdict(true), verdict(true), verdict(false)]) as {
			pass: boolean;
			votes: { pass: number; fail: number };
			agreement: number;
			tie: boolean;
		};
		expect(v).toEqual({ pass: true, votes: { pass: 2, fail: 1 }, agreement: 2 / 3, tie: false });
	});

	it("majority fails an even split and flags the tie", () => {
		const v = majority(isOk)([verdict(true), verdict(false)]) as { pass: boolean; tie: boolean; agreement: number };
		expect(v.pass).toBe(false);
		expect(v.tie).toBe(true);
		expect(v.agreement).toBe(0.5);
	});

	it("all passes only when every member passes (one fail vetoes)", () => {
		expect((all(isOk)([verdict(true), verdict(true)]) as { pass: boolean }).pass).toBe(true);
		expect((all(isOk)([verdict(true), verdict(false)]) as { pass: boolean }).pass).toBe(false);
	});

	it("any passes when at least one member passes; fails only when all fail", () => {
		expect((any(isOk)([verdict(false), verdict(true)]) as { pass: boolean }).pass).toBe(true);
		expect((any(isOk)([verdict(false), verdict(false)]) as { pass: boolean }).pass).toBe(false);
	});

	it("brands sugar folds canonical (and leaves raw folds unbranded)", () => {
		expect(marksCanonicalFold(majority(isOk))).toBe(true);
		expect(marksCanonicalFold(all(isOk))).toBe(true);
		expect(marksCanonicalFold(any(isOk))).toBe(true);
		expect(marksCanonicalFold((vs) => vs)).toBe(false);
	});
});

describe("panelShapeIssues / panel()", () => {
	it("accepts a canonical panel (sugar fold, no outcome)", () => {
		expect(panelShapeIssues({ kind: "panel", members: [memberA, memberB], fold: majority(isOk) })).toEqual([]);
		const p = panel({ members: [memberA, memberB], fold: majority(isOk) });
		expect(p.kind).toBe("panel");
		expect(p.members).toEqual([memberA, memberB]);
		expect(p.outcome).toBeUndefined();
	});

	it("accepts a custom panel (raw fold + outcome)", () => {
		const spec: PanelSpec = { members: [memberA, memberB], fold: (vs) => vs.length, outcome: customOutcome };
		expect(panel(spec).outcome).toBe(customOutcome);
	});

	it("rejects a sugar fold paired with an explicit outcome (sugar ⊕ outcome)", () => {
		expect(() => panel({ members: [memberA, memberB], fold: majority(isOk), outcome: customOutcome })).toThrow(
			/sugar ⊕ outcome/,
		);
	});

	it("rejects a raw fold with no outcome (raw ⊕ outcome)", () => {
		expect(() => panel({ members: [memberA, memberB], fold: (vs) => vs })).toThrow(/raw ⊕ outcome/);
	});

	it("rejects a nested panel member (no nesting)", () => {
		const inner = panel({ members: [memberA, memberB], fold: majority(isOk) });
		expect(() => panel({ members: [inner as unknown as Judge], fold: majority(isOk) })).toThrow(/may not nest/);
	});

	it("rejects a member with a bad judge shape", () => {
		const bad = { outcome: { name: "x" } } as unknown as Judge; // neither skill nor prompt
		expect(() => panel({ members: [bad], fold: majority(isOk) })).toThrow(/panel member:.*one is required/);
	});

	it("rejects an empty members array", () => {
		expect(() => panel({ members: [], fold: majority(isOk) })).toThrow(/non-empty/);
	});

	it("flags a missing panel object", () => {
		expect(panelShapeIssues(undefined)).toEqual(["a panel object is required"]);
	});
});

// === Panel — Phase 4: member-walking at introspection sites ================

describe("panel introspection (panelSpecOf / judgeSlotSpecOf / loopSpecOf / describeFlow)", () => {
	const memberSpecs = [
		{ skill: "grade-a", prompt: false, outcome: "va" },
		{ skill: "grade-b", prompt: false, outcome: "vb" },
	];

	it("summarises members + the sugar fold name; canonical panel has an empty outcome", () => {
		expect(panelSpecOf(panel({ members: [memberA, memberB], fold: majority(isOk) }))).toEqual({
			panel: memberSpecs,
			fold: "majority",
			outcome: "",
		});
	});

	it("reports the specific sugar fold (all / any)", () => {
		expect(panelSpecOf(panel({ members: [memberA, memberB], fold: all(isOk) })).fold).toBe("all");
		expect(panelSpecOf(panel({ members: [memberA, memberB], fold: any(isOk) })).fold).toBe("any");
	});

	it("summarises a custom panel as fold:'custom' carrying its outcome channel", () => {
		const p = panel({ members: [memberA, memberB], fold: (vs) => vs.length, outcome: customOutcome });
		expect(panelSpecOf(p)).toEqual({ panel: memberSpecs, fold: "custom", outcome: "score" });
	});

	it("judgeSlotSpecOf routes a single judge through judgeSpecOf and a panel through panelSpecOf", () => {
		expect(judgeSlotSpecOf(memberA)).toEqual(judgeSpecOf(memberA));
		const p = panel({ members: [memberA, memberB], fold: majority(isOk) });
		expect(judgeSlotSpecOf(p)).toEqual(panelSpecOf(p));
	});

	it("loopSpecOf projects an assess panel through the judge-slot summary", () => {
		const p = panel({ members: [memberA, memberB], fold: majority(isOk) });
		const loop = assess({ judge: p, done: () => true, feedForward: () => "x" });
		expect(loopSpecOf(loop)?.judge).toEqual(panelSpecOf(p));
	});

	it("describeFlow renders a verify panel stage (control stays 'single'; verify carries the panel spec + max)", () => {
		const w: Workflow = {
			name: "paneled",
			start: "build",
			stages: {
				build: {
					kind: "produces",
					sessionPolicy: "fresh",
					outcome: { name: "impl" } as Outcome & { name: string },
					verify: verify({
						judge: panel({ members: [memberA, memberB], fold: majority(isOk) }),
						done: () => true,
					}),
				},
			},
			edges: { build: "stop" },
		};
		const [shape] = describeFlow(w);
		expect(shape?.control.mode).toBe("single");
		expect(shape?.verify).toEqual({ panel: memberSpecs, fold: "majority", outcome: "", max: 1 });
	});
});
