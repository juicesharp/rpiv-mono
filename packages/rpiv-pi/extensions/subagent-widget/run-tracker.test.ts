import { describe, expect, it } from "vitest";
import {
	__resetState,
	hasAnyVisible,
	listRuns,
	onEnd,
	onStart,
	onTurnStart,
	onUpdate,
	runningCount,
} from "./run-tracker.js";
import type { SingleResult, SubagentDetails } from "./types.js";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "scout",
		agentSource: "user",
		task: "look around",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

function makeDetails(mode: "single" | "chain" | "parallel", results: SingleResult[]): SubagentDetails {
	return { mode, agentScope: "user", projectAgentsDir: null, results };
}

describe("run-tracker onStart", () => {
	it("infers single mode from {agent, task}", () => {
		onStart("t1", { agent: "scout", task: "probe auth module" });
		const [run] = listRuns();
		expect(run.mode).toBe("single");
		expect(run.displayName).toBe("scout");
		expect(run.description).toBe("probe auth module");
		expect(run.status).toBe("running");
		expect(run.results).toEqual([]);
	});

	it("infers parallel mode from tasks[]", () => {
		onStart("t1", {
			tasks: [
				{ agent: "a", task: "x" },
				{ agent: "b", task: "y" },
			],
		});
		const [run] = listRuns();
		expect(run.mode).toBe("parallel");
		expect(run.displayName).toBe("parallel (2 tasks)");
		expect(run.description).toBe("a");
	});

	it("infers chain mode from chain[]", () => {
		onStart("t1", {
			chain: [
				{ agent: "planner", task: "plan" },
				{ agent: "worker", task: "do {previous}" },
			],
		});
		const [run] = listRuns();
		expect(run.mode).toBe("chain");
		expect(run.displayName).toBe("chain (2 steps)");
		expect(run.description).toBe("planner → worker");
	});

	it("skips dispatch when args are empty (no valid mode)", () => {
		onStart("t1", {});
		expect(listRuns()).toEqual([]);
	});

	it("skips dispatch when only agent or only task is set", () => {
		onStart("t1", { agent: "scout" });
		onStart("t2", { task: "probe" });
		expect(listRuns()).toEqual([]);
	});

	it("defensive: null/undefined args do not throw and do not track", () => {
		expect(() => onStart("t1", undefined)).not.toThrow();
		expect(listRuns()).toEqual([]);
	});
});

describe("run-tracker onUpdate", () => {
	it("mutates mode + results in place, preserves reference identity", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const ref1 = listRuns()[0];
		onUpdate("t1", makeDetails("single", [makeResult({ task: "x" })]));
		const ref2 = listRuns()[0];
		expect(ref1).toBe(ref2);
		expect(ref2.results).toHaveLength(1);
	});

	it("is a no-op for unknown toolCallId", () => {
		onUpdate("missing", makeDetails("single", [makeResult()]));
		expect(listRuns()).toEqual([]);
	});

	it("ignores undefined details", () => {
		onStart("t1", { agent: "scout", task: "x" });
		expect(() => onUpdate("t1", undefined)).not.toThrow();
		expect(listRuns()[0].results).toEqual([]);
	});

	it("captures details.progress when present", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onUpdate("t1", {
			...makeDetails("single", [makeResult()]),
			progress: [{ status: "running", toolCount: 3, tokens: 1_234, durationMs: 500 }],
		});
		const [run] = listRuns();
		expect(run.progress).toEqual([{ status: "running", toolCount: 3, tokens: 1_234, durationMs: 500 }]);
	});
});

describe("run-tracker onEnd", () => {
	it("sets status='completed' on clean exit", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd("t1", { details: makeDetails("single", [makeResult({ exitCode: 0 })]) }, false);
		const [run] = listRuns();
		expect(run.status).toBe("completed");
		expect(typeof run.completedAt).toBe("number");
	});

	it("sets status='error' when isError=true without terminal stopReason", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd("t1", { details: makeDetails("single", [makeResult({ exitCode: 1, errorMessage: "boom" })]) }, true);
		const [run] = listRuns();
		expect(run.status).toBe("error");
		expect(run.errorMessage).toBe("boom");
	});

	it.each(["aborted", "steered", "stopped"] as const)(
		"derives status from stopReason='%s' even when isError=true",
		(stopReason) => {
			onStart("t1", { agent: "scout", task: "x" });
			onEnd("t1", { details: makeDetails("single", [makeResult({ stopReason })]) }, true);
			const [run] = listRuns();
			expect(run.status).toBe(stopReason);
		},
	);

	it("is a no-op for unknown toolCallId", () => {
		expect(() => onEnd("missing", { details: makeDetails("single", []) }, false)).not.toThrow();
		expect(listRuns()).toEqual([]);
	});
});

describe("run-tracker onTurnStart (turn-based linger)", () => {
	it("evicts completed runs on the first turn boundary", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		expect(listRuns()).toHaveLength(1);
		const evicted = onTurnStart();
		expect(evicted).toBe(true);
		expect(listRuns()).toHaveLength(0);
	});

	it("keeps error runs through two turn boundaries", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd("t1", { details: makeDetails("single", [makeResult({ exitCode: 1 })]) }, true);
		expect(onTurnStart()).toBe(false);
		expect(listRuns()).toHaveLength(1);
		expect(onTurnStart()).toBe(true);
		expect(listRuns()).toHaveLength(0);
	});

	it("does not age running runs", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onTurnStart();
		onTurnStart();
		onTurnStart();
		expect(listRuns()).toHaveLength(1);
	});
});

describe("run-tracker queries", () => {
	it("hasAnyVisible reflects tracked run count", () => {
		expect(hasAnyVisible()).toBe(false);
		onStart("t1", { agent: "scout", task: "x" });
		expect(hasAnyVisible()).toBe(true);
	});

	it("runningCount excludes finished runs", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onStart("t2", { agent: "worker", task: "y" });
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		expect(runningCount()).toBe(1);
	});
});

describe("run-tracker __resetState", () => {
	it("clears runs and finishedAge maps", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		__resetState();
		expect(listRuns()).toEqual([]);
		expect(hasAnyVisible()).toBe(false);
	});
});

describe("run-tracker newline sanitization", () => {
	it("collapses embedded newlines in single-mode task descriptions", () => {
		__resetState();
		onStart("t1", {
			agent: "peer-comparator",
			task: "Peer-mirror check.\n\nPeerPairs (orchestrator-computed):\n[list of tuples]\n\nFor each pair, Read BOTH files.",
		});
		const [run] = listRuns();
		expect(run.description).not.toMatch(/[\r\n]/);
		expect(run.description.startsWith("Peer-mirror check.")).toBe(true);
		expect(run.description).toContain("PeerPairs (orchestrator-computed):");
	});

	it("collapses newlines in displayName too (defensive)", () => {
		__resetState();
		onStart("t1", { agent: "weird\nname", task: "x" });
		const [run] = listRuns();
		expect(run.displayName).not.toMatch(/[\r\n]/);
		expect(run.displayName).toBe("weird name");
	});

	it("sanitizes errorMessage on terminal state", () => {
		__resetState();
		onStart("t1", { agent: "x", task: "t" });
		onEnd(
			"t1",
			{
				details: makeDetails("single", [
					makeResult({
						exitCode: 1,
						stopReason: "error",
						errorMessage: "boom\nat foo\nat bar",
					}),
				]),
			},
			true,
		);
		const [run] = listRuns();
		expect(run.errorMessage).not.toMatch(/[\r\n]/);
		expect(run.errorMessage).toBe("boom at foo at bar");
	});

	it("preserves single-line descriptions unchanged", () => {
		__resetState();
		onStart("t1", { agent: "scout", task: "probe auth module" });
		const [run] = listRuns();
		expect(run.description).toBe("probe auth module");
	});
});
