import { describe, expect, it } from "vitest";
import {
	createGoal,
	parseGoalCommand,
	parseTokenBudget,
	replayGoalFromEntries,
	STATE_ENTRY,
	transitionGoal,
} from "./state.js";

function custom(goal: unknown, id: string) {
	return {
		type: "custom",
		customType: STATE_ENTRY,
		data: { goal },
		id,
		parentId: null,
		timestamp: "2026-05-28T00:00:00.000Z",
	};
}

describe("parseGoalCommand", () => {
	it("parses a bare command as status", () => {
		expect(parseGoalCommand(" ")).toEqual({ kind: "show" });
	});

	it("parses a start command with a token budget", () => {
		expect(parseGoalCommand("--tokens 100k fix failing tests")).toEqual({
			kind: "start",
			objective: "fix failing tests",
			tokenBudget: 100_000,
		});
	});

	it("parses edit with an equals token budget", () => {
		expect(parseGoalCommand("edit --tokens=1.5m ship smaller fix")).toEqual({
			kind: "edit",
			objective: "ship smaller fix",
			tokenBudget: 1_500_000,
		});
	});

	it("rejects invalid token budgets", () => {
		expect(parseTokenBudget("nope")).toContain("Token budget");
	});
});

describe("replayGoalFromEntries", () => {
	it("returns the latest unfinished goal", () => {
		const oldGoal = createGoal("old", undefined, new Date("2026-05-28T00:00:00.000Z"));
		const newGoal = createGoal("new", undefined, new Date("2026-05-28T00:01:00.000Z"));
		expect(replayGoalFromEntries([custom(oldGoal, "1"), custom(newGoal, "2")])).toMatchObject({
			id: newGoal.id,
			objective: "new",
		});
	});

	it("treats null and complete entries as no active goal", () => {
		const goal = createGoal("done", undefined, new Date("2026-05-28T00:00:00.000Z"));
		const complete = transitionGoal(goal, "complete");
		expect(replayGoalFromEntries([custom(goal, "1"), custom(null, "2")])).toBeUndefined();
		expect(replayGoalFromEntries([custom(complete, "1")])).toBeUndefined();
	});
});
