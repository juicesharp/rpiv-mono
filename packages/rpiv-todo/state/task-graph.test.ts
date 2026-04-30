import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { deriveBlocks, detectCycle } from "./task-graph.js";

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

describe("detectCycle", () => {
	it("detects direct cycle", () => {
		const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
		expect(detectCycle(tasks, 1, [2])).toBe(true);
	});

	it("returns false for acyclic graph", () => {
		const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
		expect(detectCycle(tasks, 2, [1])).toBe(false);
	});
});

describe("deriveBlocks", () => {
	it("returns an empty map when no task has blockedBy", () => {
		const tasks: Task[] = [
			{ id: 1, subject: "a", status: "pending" },
			{ id: 2, subject: "b", status: "pending" },
		];
		expect(deriveBlocks(tasks).size).toBe(0);
	});

	it("inverts blockedBy into a blocks map", () => {
		const tasks: Task[] = [
			{ id: 1, subject: "root", status: "pending" },
			{ id: 2, subject: "dep", status: "pending", blockedBy: [1] },
			{ id: 3, subject: "dep2", status: "pending", blockedBy: [1, 2] },
		];
		const blocks = deriveBlocks(tasks);
		expect(blocks.get(1)).toEqual([2, 3]);
		expect(blocks.get(2)).toEqual([3]);
		expect(blocks.get(3)).toBeUndefined();
	});
});
