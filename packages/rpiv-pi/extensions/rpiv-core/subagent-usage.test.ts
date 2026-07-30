import { describe, expect, it } from "vitest";
import type { LaneUsage } from "./lane-usage.js";
import {
	__resetSubagentUsage,
	getSubagentUsageForRun,
	getSubagentUsageForStage,
	recordSubagentCompletion,
} from "./subagent-usage.js";

/** A `subagents:completed` payload shape — `{ …, tokens: { input, output, total } }`
 *  (pi-subagents `buildEventData`). `tokens` is omitted entirely when nothing was
 *  ever produced. */
function payload(
	input: number,
	output: number,
	total: number,
): { tokens: { input: number; output: number; total: number } } {
	return { tokens: { input, output, total } };
}

describe("recordSubagentCompletion — narrow + accumulate", () => {
	it("narrows a well-formed payload: cacheRead=0, cacheWrite=total-input-output", () => {
		// total (100) = input (10) + output (20) + cacheWrite (70) — cacheWrite recovered.
		recordSubagentCompletion("run-1", "research", payload(10, 20, 100));
		expect(getSubagentUsageForRun("run-1")).toEqual<LaneUsage>({
			input: 10,
			output: 20,
			cacheRead: 0, // forced 0 (pi-subagents issue #38)
			cacheWrite: 70, // max(0, 100 - 10 - 20)
			total: 100,
		});
	});

	it("clamps cacheWrite to 0 when total < input + output (never negative)", () => {
		// A malformed/inconsistent payload (total smaller than input+output) must not
		// record a negative cacheWrite.
		recordSubagentCompletion("run-1", "plan", payload(50, 50, 30));
		expect(getSubagentUsageForRun("run-1")).toEqual<LaneUsage>({
			input: 50,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0, // max(0, 30 - 50 - 50) → 0
			total: 30,
		});
	});

	it("accumulates across multiple completions for the SAME run+stage (sums, not overwrites)", () => {
		recordSubagentCompletion("run-1", "research", payload(10, 20, 100));
		// second completion: total 50 = input 5 + output 5 + cacheWrite 40
		recordSubagentCompletion("run-1", "research", payload(5, 5, 50));
		expect(getSubagentUsageForRun("run-1")).toEqual<LaneUsage>({
			input: 15, // 10 + 5
			output: 25, // 20 + 5
			cacheRead: 0,
			cacheWrite: 110, // 70 (first) + 40 (second)
			total: 150, // recomputed from the 4 dims: 15 + 25 + 0 + 110
		});
	});

	it("is a no-op on a missing tokens object", () => {
		recordSubagentCompletion("run-1", "research", { id: "x" });
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});

	it("is a no-op on a malformed tokens object", () => {
		recordSubagentCompletion("run-1", "research", { tokens: "nope" });
		recordSubagentCompletion("run-1", "research", { tokens: { input: 1, output: 2, total: "x" } });
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});

	it("is a no-op on non-finite token fields (no NaN recorded)", () => {
		recordSubagentCompletion("run-1", "research", { tokens: { input: NaN, output: 2, total: 3 } });
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});

	it("is a no-op on a non-object payload", () => {
		recordSubagentCompletion("run-1", "research", undefined);
		recordSubagentCompletion("run-1", "research", null);
		recordSubagentCompletion("run-1", "research", "stats");
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});

	it("records nothing when stageName is undefined (can't attribute before onStageStart)", () => {
		recordSubagentCompletion("run-1", undefined, payload(10, 20, 100));
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});
});

describe("getSubagentUsageForRun — run-level roll-up across stages", () => {
	it("sums every stage's recorded subagent usage", () => {
		// research: total 500 = input 100 + output 200 + cacheWrite 200
		recordSubagentCompletion("run-1", "research", payload(100, 200, 500));
		// implement: total 200 = input 50 + output 50 + cacheWrite 100
		recordSubagentCompletion("run-1", "implement", payload(50, 50, 200));
		expect(getSubagentUsageForRun("run-1")).toEqual<LaneUsage>({
			input: 150, // 100 + 50
			output: 250, // 200 + 50
			cacheRead: 0,
			cacheWrite: 300, // 200 + 100
			total: 700, // recomputed from the 4 dims: 150 + 250 + 0 + 300
		});
	});

	it("returns undefined for a run with no recorded completions", () => {
		expect(getSubagentUsageForRun("never")).toBeUndefined();
	});

	it("isolates runs (one run's completions never bleed into another)", () => {
		recordSubagentCompletion("run-1", "research", payload(10, 20, 100));
		recordSubagentCompletion("run-2", "research", payload(1, 2, 10));
		expect(getSubagentUsageForRun("run-1")?.input).toBe(10);
		expect(getSubagentUsageForRun("run-2")?.input).toBe(1);
	});
});

describe("getSubagentUsageForStage — per-stage read", () => {
	it("returns the accumulated subagent usage for a specific stage", () => {
		// research: total 500 = input 100 + output 200 + cacheWrite 200
		recordSubagentCompletion("run-1", "research", payload(100, 200, 500));
		// implement: total 200 = input 50 + output 50 + cacheWrite 100
		recordSubagentCompletion("run-1", "implement", payload(50, 50, 200));
		expect(getSubagentUsageForStage("run-1", "research")).toEqual<LaneUsage>({
			input: 100,
			output: 200,
			cacheRead: 0,
			cacheWrite: 200,
			total: 500,
		});
		expect(getSubagentUsageForStage("run-1", "implement")).toEqual<LaneUsage>({
			input: 50,
			output: 50,
			cacheRead: 0,
			cacheWrite: 100,
			total: 200,
		});
	});

	it("returns undefined for an unknown stage (no completion recorded)", () => {
		recordSubagentCompletion("run-1", "research", payload(10, 20, 100));
		expect(getSubagentUsageForStage("run-1", "nonexistent")).toBeUndefined();
	});

	it("returns undefined for an unknown run", () => {
		expect(getSubagentUsageForStage("never", "research")).toBeUndefined();
	});
});

describe("__resetSubagentUsage", () => {
	it("clears the accumulator so run-level reads return undefined", () => {
		recordSubagentCompletion("run-1", "research", payload(10, 20, 100));
		expect(getSubagentUsageForRun("run-1")).toBeDefined();
		__resetSubagentUsage();
		expect(getSubagentUsageForRun("run-1")).toBeUndefined();
	});

	it("preserves the process-global slot identity (re-records after reset land in the same slot)", () => {
		__resetSubagentUsage();
		// After a reset, a fresh record still resolves through the same global slot —
		// no "second registry" fragmentation across re-loaded instances.
		recordSubagentCompletion("run-1", "plan", payload(1, 1, 4));
		expect(getSubagentUsageForRun("run-1")?.input).toBe(1);
	});
});
