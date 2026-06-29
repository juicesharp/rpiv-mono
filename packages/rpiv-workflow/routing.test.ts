/**
 * Tests for `nextStage` / `edgeIsDecision` — workflow-graph traversal.
 *
 * Each test builds a minimal Workflow by hand and asserts the resolved next
 * name (or null) for a given current-stage + state combination.
 */

import { describe, expect, it } from "vitest";
import { defineRoute, type EdgeContext, gate, marksReadsData, match, STOP, type Workflow } from "./api.js";
import type { Output } from "./output.js";
import { eq, gt } from "./predicates.js";
import { bypassedRecoveryArms, edgeIsDecision, nextStage } from "./routing.js";
import { takeRouteNote } from "./routing-dsl.js";
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
		droppedFailureRows: [],
	},
	termination: { status: "running" },
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
			edges: { a: gate("count", { c: gt(0), b: eq(0) }, "b") },
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
			b: gate("count", { c: gt(0), d: eq(0) }, "d"),
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

// ---------------------------------------------------------------------------
// match — the enum companion to gate
// ---------------------------------------------------------------------------

describe("match", () => {
	const channelOutput = (data: Record<string, unknown>): Output => ({
		kind: "artifact-md",
		artifacts: [],
		data,
		meta: { stage: "panel", skill: "panel", stageNumber: 1, ts: "", runId: "" },
	});

	// A ctx whose `state.named` carries a single channel — for the `from` source.
	const ctxWithChannel = (channel: string, data: Record<string, unknown>): EdgeContext => {
		const state = makeState();
		return { output: state.output, state: { ...state, named: { [channel]: [channelOutput(data)] } } };
	};

	it("routes a string enum field to the matching branch (strict ===, first match wins)", () => {
		const workflow: Workflow = {
			name: "severity",
			start: "a",
			stages: { a: stage("a"), escalate: stage("escalate"), fix: stage("fix"), backlog: stage("backlog") },
			edges: { a: match("severity", { escalate: "p0", fix: "p1", backlog: "p2" }, { fallback: "backlog" }) },
		};
		expect(nextStage(workflow, "a", ctxOf({ severity: "p0" }))).toEqual({ kind: "next", stage: "escalate" });
		expect(nextStage(workflow, "a", ctxOf({ severity: "p1" }))).toEqual({ kind: "next", stage: "fix" });
		expect(nextStage(workflow, "a", ctxOf({ severity: "p2" }))).toEqual({ kind: "next", stage: "backlog" });
	});

	it("matches a boolean field by strict equality", () => {
		const workflow: Workflow = {
			name: "tie",
			start: "a",
			stages: { a: stage("a"), b: stage("b"), c: stage("c") },
			edges: { a: match("tie", { b: true }, { fallback: "c" }) },
		};
		expect(nextStage(workflow, "a", ctxOf({ tie: true }))).toEqual({ kind: "next", stage: "b" });
		expect(nextStage(workflow, "a", ctxOf({ tie: false }))).toEqual({ kind: "next", stage: "c" });
	});

	it("falls back on no match and records a routing note", () => {
		const route = match("severity", { escalate: "p0" }, { fallback: "triage" });
		expect(route(ctxOf({ severity: "p9" }))).toBe("triage");
		expect(takeRouteNote(route)).toMatch(/matched no branch — fell back to "triage"/);
	});

	it("terminates (STOP) on no match when no fallback is declared, with a note", () => {
		const route = match("severity", { escalate: "p0" });
		expect(route(ctxOf({ severity: "p9" }))).toBe(STOP);
		expect(takeRouteNote(route)).toMatch(/matched no branch — terminated \(no fallback\)/);
	});

	it("a missing field is a no-match (routes to the fallback / STOP)", () => {
		expect(match("severity", { escalate: "p0" }, { fallback: "triage" })(ctxOf({}))).toBe("triage");
		expect(match("severity", { escalate: "p0" })(ctxOf({}))).toBe(STOP);
	});

	it("`from` sources the field from a NAMED CHANNEL instead of output.data (panel-verdict routing)", () => {
		const route = match("tie", { escalate: true }, { fallback: "keep", from: "review-panel" });
		// output.data has no `tie`; the channel does — the channel wins.
		expect(route(ctxWithChannel("review-panel", { tie: true, pass: false }))).toBe("escalate");
		expect(route(ctxWithChannel("review-panel", { tie: false, pass: true }))).toBe("keep");
		// Absent channel → no-match → fallback.
		expect(route(ctxOf({ tie: true }))).toBe("keep");
	});

	it("auto-marks READS_DATA for a stage-output match, but NOT for a channel-sourced one", () => {
		expect(marksReadsData(match("severity", { escalate: "p0" }, { fallback: "triage" }))).toBe(true);
		expect(marksReadsData(match("tie", { escalate: true }, { fallback: "keep", from: "review-panel" }))).toBe(false);
	});

	it("attaches `.targets` (branches + fallback) for reachability, and reads as a decision edge", () => {
		const workflow: Workflow = {
			name: "targets",
			start: "a",
			stages: { a: stage("a"), escalate: stage("escalate"), fix: stage("fix"), triage: stage("triage") },
			edges: { a: match("severity", { escalate: "p0", fix: "p1" }, { fallback: "triage" }) },
		};
		const edge = workflow.edges.a;
		expect(typeof edge === "function" && edge.targets).toEqual(["escalate", "fix", "triage"]);
		expect(edgeIsDecision(workflow, "a")).toBe(true);
	});

	it("includes STOP in `.targets` when no fallback is declared", () => {
		const edge = match("severity", { escalate: "p0", fix: "p1" });
		expect(edge.targets).toEqual(["escalate", "fix", STOP]);
	});

	it("rejects construction-time defects", () => {
		expect(() => match("f", {})).toThrow(/at least one possible return value/);
		expect(() => match("f", { "2": "x" })).toThrow(/integer-like/);
		expect(() => match("f", { a: "x", b: "x" })).toThrow(/each enum value must map to exactly one stage/);
		expect(() => match("f", { a: "x" }, { fallback: "" })).toThrow(/non-empty stage name/);
	});

	it('keeps distinct-typed values apart when deduping (0 ≠ "0" ≠ false)', () => {
		expect(() => match("f", { a: 0, b: "0", c: false })).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// bypassedRecoveryArms — which not-taken arm of a gate counts as "covered"
// ---------------------------------------------------------------------------

describe("bypassedRecoveryArms", () => {
	// A carve-shaped fragment: `slice-gate` is a decision edge to
	// {design (forward) | reslice (loop-back)}. `reslice` loops back to
	// `slice-structure`; `design` proceeds forward to `synth`.
	const wf: Workflow = {
		name: "frag",
		start: "research",
		stages: {
			research: stage("research"),
			slice: stage("slice"),
			"slice-structure": stage("slice-structure"),
			"slice-gate": stage("slice-gate"),
			design: stage("design"),
			synth: stage("synth"),
			reslice: stage("reslice"),
		},
		edges: {
			research: "slice",
			slice: "slice-structure",
			"slice-structure": "slice-gate",
			"slice-gate": defineRoute(["design", "reslice"], () => "design", { readsData: false }),
			reslice: "slice-structure", // loops back into visited territory
			design: "synth",
			synth: "stop",
		},
	};

	const visited = new Set(["research", "slice", "slice-structure", "slice-gate"]);

	it("credits a not-taken arm whose successor is already visited (loop-back recovery)", () => {
		// slice-gate passes → design; reslice (→ slice-structure, visited) is bypassed for good.
		expect(bypassedRecoveryArms(wf, "slice-gate", "design", visited)).toEqual(["reslice"]);
	});

	it("does NOT credit the forward arm on the fail path (successor not yet visited)", () => {
		// slice-gate fails → reslice; the not-taken arm `design` (→ synth, unvisited) is
		// merely DEFERRED, not bypassed — crediting it would run the numerator ahead.
		expect(bypassedRecoveryArms(wf, "slice-gate", "reslice", visited)).toEqual([]);
	});

	it("skips a not-taken arm that is already visited (idempotent)", () => {
		expect(bypassedRecoveryArms(wf, "slice-gate", "design", new Set([...visited, "reslice"]))).toEqual([]);
	});

	it("returns [] for a deterministic string edge (no alternatives to bypass)", () => {
		expect(bypassedRecoveryArms(wf, "slice-structure", "slice-gate", visited)).toEqual([]);
	});
});
