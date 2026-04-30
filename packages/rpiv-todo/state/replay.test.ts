import { buildSessionEntries, createMockCtx, makeTodoToolResult, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { Task, TaskDetails } from "../tool/types.js";
import { replayFromBranch } from "./replay.js";

function buildBranch(snapshots: TaskDetails[]) {
	const messages = snapshots.map((s) => makeTodoToolResult(s));
	return buildSessionEntries([makeUserMessage("hi"), ...messages]);
}

const taskFixture = (id: number, subject: string, extra: Partial<Task> = {}): Task => ({
	id,
	subject,
	status: "pending",
	...extra,
});

describe("replayFromBranch", () => {
	it("returns empty TaskState when branch has no todo toolResults", () => {
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("hi")]) });
		const state = replayFromBranch(ctx);
		expect(state.tasks).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	it("replays the last snapshot (last-write-wins)", () => {
		const ctx = createMockCtx({
			branch: buildBranch([
				{ action: "create", params: {}, tasks: [taskFixture(1, "old")], nextId: 2 },
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "old"), taskFixture(2, "new")],
					nextId: 3,
				},
			]),
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(2);
		expect(state.nextId).toBe(3);
	});

	it("clones tasks so mutating the fixture does not mutate replayed state", () => {
		const fixture: Task = taskFixture(1, "original");
		const ctx = createMockCtx({
			branch: buildBranch([{ action: "create", params: {}, tasks: [fixture], nextId: 2 }]),
		});
		const state = replayFromBranch(ctx);
		const replayed = state.tasks[0];
		expect(replayed).not.toBe(fixture);
		expect(replayed.subject).toBe("original");
	});

	it("returns a fresh empty TaskState when called with an empty branch", () => {
		const ctx1 = createMockCtx({
			branch: buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "x")], nextId: 2 }]),
		});
		expect(replayFromBranch(ctx1).nextId).toBe(2);

		const ctx2 = createMockCtx({ branch: buildSessionEntries([makeUserMessage("hi")]) });
		const fresh = replayFromBranch(ctx2);
		expect(fresh.tasks).toEqual([]);
		expect(fresh.nextId).toBe(1);
	});
});
