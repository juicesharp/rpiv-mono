import {
	buildSessionEntries,
	createMockCtx,
	makeCustomEntry,
	makeMessageEntry,
	makeTodoToolResult,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { STATE_ENTRY_TYPE, type Task, type TaskDetails } from "../tool/types.ts";
import { isTaskDetails, replayFromBranch } from "./replay.ts";

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

describe("isTaskDetails — defensive type guard", () => {
	it("rejects null and undefined", () => {
		expect(isTaskDetails(null)).toBe(false);
		expect(isTaskDetails(undefined)).toBe(false);
	});

	it("rejects primitives (string, number, boolean)", () => {
		expect(isTaskDetails("oops")).toBe(false);
		expect(isTaskDetails(42)).toBe(false);
		expect(isTaskDetails(true)).toBe(false);
	});

	it("rejects objects missing tasks[] or nextId", () => {
		expect(isTaskDetails({})).toBe(false);
		expect(isTaskDetails({ tasks: "x", nextId: 1 })).toBe(false);
		expect(isTaskDetails({ tasks: [], nextId: "1" })).toBe(false);
	});

	it("accepts well-formed snapshot envelopes", () => {
		expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(true);
		expect(isTaskDetails({ action: "create", params: {}, tasks: [], nextId: 1 })).toBe(true);
	});
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

	it("skips non-message entries in the branch (defensive type guard)", () => {
		const ctx = createMockCtx({
			branch: [
				{ type: "tool_call", call: { id: "x" } } as never,
				...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "kept")], nextId: 2 }]),
			] as never,
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("kept");
		expect(state.nextId).toBe(2);
	});

	it("skips toolResult entries whose details fail isTaskDetails (corrupt-snapshot guard)", () => {
		// Construct a toolResult with toolName=todo but malformed details — must be ignored.
		const corrupt = {
			type: "message" as const,
			message: { role: "toolResult", toolName: "todo", details: { tasks: "not-an-array" } },
		};
		const ctx = createMockCtx({
			branch: [
				...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "good")], nextId: 2 }]),
				corrupt as never,
			] as never,
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("good");
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

// ---------------------------------------------------------------------------
// State entries — the snapshot persisted for every state-changing call,
// including calls made through another tool (codemode) that leave no toolResult.
// ---------------------------------------------------------------------------

const snap = (tasks: Task[], nextId: number): TaskDetails => ({ action: "update", params: {}, tasks, nextId });
const stateEntry = (details: unknown) => makeCustomEntry(STATE_ENTRY_TYPE, details);
const todoResult = (details: TaskDetails) => makeMessageEntry(makeTodoToolResult(details));

describe("replayFromBranch — state entries", () => {
	it("matches the STATE_ENTRY_TYPE the tool writes (replay.ts keeps the literal)", () => {
		expect(STATE_ENTRY_TYPE).toBe("rpiv-todo-state");
	});

	it("replays a branch whose only snapshots are state entries (codemode-only session)", () => {
		const ctx = createMockCtx({
			branch: [
				...buildSessionEntries([makeUserMessage("hi")]),
				stateEntry(snap([taskFixture(1, "A")], 2)),
				stateEntry(snap([taskFixture(1, "A"), taskFixture(2, "B")], 3)),
			],
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks.map((t) => t.subject)).toEqual(["A", "B"]);
		expect(state.nextId).toBe(3);
	});

	it("a later state entry wins over an earlier toolResult (nested completion after a direct call)", () => {
		const ctx = createMockCtx({
			branch: [
				todoResult(snap([taskFixture(1, "T", { status: "in_progress" })], 2)),
				stateEntry(snap([taskFixture(1, "T", { status: "completed" })], 2)),
			],
		});
		expect(replayFromBranch(ctx).tasks[0]?.status).toBe("completed");
	});

	it("state entries are authoritative over a toolResult that lands after them", () => {
		// A direct call's entry is appended during execute(), before its toolResult message;
		// a read (list/get) result carries no entry. Neither may override the entry trail.
		const ctx = createMockCtx({
			branch: [
				stateEntry(snap([taskFixture(1, "T", { status: "completed" })], 2)),
				todoResult(snap([taskFixture(1, "T", { status: "in_progress" })], 2)),
			],
		});
		expect(replayFromBranch(ctx).tasks[0]?.status).toBe("completed");
	});

	it("falls back to toolResult snapshots on a branch with no state entries (older sessions)", () => {
		const ctx = createMockCtx({ branch: [todoResult(snap([taskFixture(1, "legacy")], 2))] });
		expect(replayFromBranch(ctx).tasks[0]?.subject).toBe("legacy");
	});

	it("restores a cleared list from its empty snapshot instead of resurrecting tasks", () => {
		const ctx = createMockCtx({
			branch: [stateEntry(snap([taskFixture(1, "gone")], 2)), stateEntry(snap([], 1))],
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	it("ignores malformed state entries and other custom entry types", () => {
		const ctx = createMockCtx({
			branch: [
				stateEntry(snap([taskFixture(1, "good")], 2)),
				stateEntry({ tasks: "corrupt", nextId: 9 }),
				makeCustomEntry("codemode-store", { tasks: [], nextId: 1 }),
			],
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks.map((t) => t.subject)).toEqual(["good"]);
		expect(state.nextId).toBe(2);
	});

	it("clones tasks from a state entry so replayed state never aliases branch data", () => {
		const fixture = taskFixture(1, "original");
		const ctx = createMockCtx({ branch: [stateEntry(snap([fixture], 2))] });
		expect(replayFromBranch(ctx).tasks[0]).not.toBe(fixture);
	});
});
