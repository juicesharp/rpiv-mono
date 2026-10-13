import { describe, expect, it } from "vitest";
import { defineWorkflow, produces } from "../api.js";
import { MSG_BUDGET_INVALID } from "../messages.js";
import {
	buildRunContext,
	freshRunState,
	MAX_BACKWARD_JUMPS,
	MAX_ITERATIONS,
	MAX_LAPS,
	validateRunBudgets,
} from "./run-context.js";

const workflow = defineWorkflow({
	name: "budgets",
	start: "a",
	stages: { a: produces({ skill: "a" }) },
	edges: { a: "stop" },
});

const identity = () => ({
	runId: "r",
	state: freshRunState("x"),
	visited: new Set<string>(),
	trigger: { kind: "command" as const, name: "wf" },
});

describe("validateRunBudgets", () => {
	it("accepts absent budgets and non-negative integers (zero included)", () => {
		expect(validateRunBudgets({})).toBeUndefined();
		expect(validateRunBudgets({ maxBackwardJumps: 0, maxLaps: 0, maxIterations: 0 })).toBeUndefined();
		expect(validateRunBudgets({ maxBackwardJumps: 3, maxLaps: 8, maxIterations: 32 })).toBeUndefined();
	});

	it.each([
		["maxBackwardJumps", Number.NaN],
		["maxLaps", Number.NaN],
		["maxIterations", Number.NaN],
		["maxLaps", Number.POSITIVE_INFINITY],
		["maxLaps", -1],
		["maxLaps", 2.5],
	] as const)("refuses %s = %s with the option named", (key, value) => {
		expect(validateRunBudgets({ [key]: value })).toBe(MSG_BUDGET_INVALID(key, value));
	});

	it("reports the first offending option in declaration order", () => {
		expect(validateRunBudgets({ maxBackwardJumps: Number.NaN, maxLaps: -1 })).toBe(
			MSG_BUDGET_INVALID("maxBackwardJumps", Number.NaN),
		);
	});
});

describe("buildRunContext — budget backstop", () => {
	it("defaults every absent budget", () => {
		const run = buildRunContext("/tmp/x", workflow, {}, identity());
		expect(run.maxBackwardJumps).toBe(MAX_BACKWARD_JUMPS);
		expect(run.maxLaps).toBe(MAX_LAPS);
		expect(run.maxIterations).toBe(MAX_ITERATIONS);
	});

	it("applies every supplied budget (zero included — `??` must not treat it as absent)", () => {
		const run = buildRunContext(
			"/tmp/x",
			workflow,
			{ maxBackwardJumps: 5, maxLaps: 0, maxIterations: 7 },
			identity(),
		);
		expect(run.maxBackwardJumps).toBe(5);
		expect(run.maxLaps).toBe(0);
		expect(run.maxIterations).toBe(7);
	});

	it("throws on a NaN ceiling instead of building a context whose ceiling can never trip", () => {
		expect(() => buildRunContext("/tmp/x", workflow, { maxLaps: Number.NaN }, identity())).toThrow(
			MSG_BUDGET_INVALID("maxLaps", Number.NaN),
		);
	});
});
