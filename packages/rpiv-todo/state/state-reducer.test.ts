import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { applyTaskMutation } from "./state-reducer.js";

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

describe("applyTaskMutation — create", () => {
	it("rejects empty subject", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "" });
		expect(result.op).toEqual({ kind: "error", message: "subject required for create" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("rejects dangling blockedBy", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "x", blockedBy: [99] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #99 not found" });
		expect(result.state.nextId).toBe(1);
	});

	it("rejects deleted blockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
		const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is deleted" });
	});

	it("creates with next id and preserves immutability", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "create", { subject: "write tests" });
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toMatchObject({ id: 1, subject: "write tests", status: "pending" });
		expect(result.state.nextId).toBe(2);
		expect(result.state.tasks).not.toBe(state.tasks);
		expect(result.op).toEqual({ kind: "create", taskIds: [1] });
	});

	it("rejects subject and tasks[] together", () => {
		const result = applyTaskMutation(emptyState(), "create", {
			subject: "one",
			tasks: [{ subject: "two" }],
		});
		expect(result.op).toEqual({ kind: "error", message: "create requires subject or tasks[], not both" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("rejects an empty tasks[] batch", () => {
		const result = applyTaskMutation(emptyState(), "create", { tasks: [] });
		expect(result.op).toEqual({ kind: "error", message: "tasks[] must be non-empty" });
		expect(result.state.nextId).toBe(1);
	});

	it("rejects a blank subject inside tasks[] and creates nothing", () => {
		const result = applyTaskMutation(emptyState(), "create", {
			tasks: [{ subject: "ok" }, { subject: "  " }],
		});
		expect(result.op).toEqual({ kind: "error", message: "tasks[1]: subject required for create" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("creates consecutive ids and preserves per-item fields", () => {
		const result = applyTaskMutation(emptyState(), "create", {
			tasks: [
				{ subject: "Inspect existing implementation" },
				{
					subject: "Add tests for batch create",
					description: "reducer + envelope",
					owner: "rpiv-todo",
				},
			],
		});
		expect(result.op).toEqual({ kind: "create", taskIds: [1, 2] });
		expect(result.state.nextId).toBe(3);
		expect(result.state.tasks).toEqual([
			{ id: 1, subject: "Inspect existing implementation", status: "pending" },
			{
				id: 2,
				subject: "Add tests for batch create",
				status: "pending",
				description: "reducer + envelope",
				owner: "rpiv-todo",
			},
		]);
	});

	it("allows batch blockedBy on a task that already exists", () => {
		const state = stateWith(task({ id: 1, subject: "root" }));
		const result = applyTaskMutation(state, "create", {
			tasks: [{ subject: "leaf", blockedBy: [1] }],
		});
		expect(result.op).toEqual({ kind: "create", taskIds: [2] });
		expect(result.state.tasks[1]).toMatchObject({ id: 2, subject: "leaf", blockedBy: [1] });
	});

	it("rejects sibling blockedBy and leaves state unchanged", () => {
		const result = applyTaskMutation(emptyState(), "create", {
			tasks: [{ subject: "first" }, { subject: "second", blockedBy: [1] }],
		});
		expect(result.op).toEqual({
			kind: "error",
			message:
				"blockedBy: #1 is another item in this batch; create the prerequisite first, then the dependent with blockedBy",
		});
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("rejects a dangling blockedBy in a batch and creates nothing", () => {
		const result = applyTaskMutation(emptyState(), "create", {
			tasks: [{ subject: "ok" }, { subject: "bad", blockedBy: [99] }],
		});
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #99 not found" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("rejects a deleted blockedBy in a batch and creates nothing", () => {
		const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
		const result = applyTaskMutation(state, "create", {
			tasks: [{ subject: "ok" }, { subject: "bad", blockedBy: [1] }],
		});
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is deleted" });
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.nextId).toBe(2);
	});
});

describe("applyTaskMutation — update", () => {
	it("rejects id-only update", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1 });
		expect(result.op).toEqual({
			kind: "error",
			message:
				"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
		});
	});

	it("rejects illegal transition completed → in_progress", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
		expect(result.op).toEqual({
			kind: "error",
			message: "illegal transition completed → in_progress",
		});
	});

	it("allows completed → deleted transition", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "completed", toStatus: "deleted", changed: true });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("flags a no-effect status update (status set to its current value) as changed:false", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "pending" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "pending" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: false });
	});

	it("flags a re-sent identical field as changed:false", () => {
		const state = stateWith(task({ id: 1, subject: "x", description: "d" }));
		const result = applyTaskMutation(state, "update", { id: 1, subject: "x", description: "d" });
		expect(result.op).toMatchObject({ kind: "update", changed: false });
	});

	it("flags a blockedBy-only update as changed:true even when status is unchanged", () => {
		const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
	});

	it("flags a subject-only update on a task with existing deps as changed:true (blockedBy unchanged)", () => {
		// Equal-length blockedBy on both sides — the changed signal comes from subject,
		// not the dependency list, which round-trips identically.
		const state = stateWith(task({ id: 1, subject: "old", blockedBy: [2] }), task({ id: 2, subject: "dep" }));
		const result = applyTaskMutation(state, "update", { id: 1, subject: "new" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
		expect(result.state.tasks[0].blockedBy).toEqual([2]);
	});

	it("flags swapping one dependency for another (same length) as changed:true", () => {
		const state = stateWith(
			task({ id: 1, subject: "a", blockedBy: [2] }),
			task({ id: 2, subject: "b" }),
			task({ id: 3, subject: "c" }),
		);
		const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2], addBlockedBy: [3] });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
		expect(result.state.tasks[0].blockedBy).toEqual([3]);
	});

	it("rejects self-block via addBlockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "cannot block #1 on itself" });
	});

	it("rejects cycle in blockedBy graph", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
		expect(result.op).toEqual({
			kind: "error",
			message: "addBlockedBy would create a cycle in the blockedBy graph",
		});
	});

	it("drops blockedBy field when merged set becomes empty", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2] });
		const updated = result.state.tasks[0];
		expect("blockedBy" in updated).toBe(false);
	});

	it("drops metadata key when value is null", () => {
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect(result.state.tasks[0].metadata).toEqual({ b: 2 });
	});

	it("sets and overwrites metadata keys when value is non-null", () => {
		// Covers the merged[k] = v branch (non-null partial merge): a is overwritten,
		// b is preserved, c is added.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: 99, c: 3 } });
		expect(result.state.tasks[0].metadata).toEqual({ a: 99, b: 2, c: 3 });
	});

	it("collapses metadata to undefined when every key is deleted", () => {
		// Covers the Object.keys(merged).length ? merged : undefined branch where
		// every existing key gets nulled out.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect("metadata" in result.state.tasks[0]).toBe(false);
	});
});

describe("applyTaskMutation — list/get/delete/clear", () => {
	it("list emits Op with includeDeleted flag and optional statusFilter", () => {
		const state = stateWith(
			task({ id: 1, subject: "a", status: "pending" }),
			task({ id: 2, subject: "b", status: "deleted" }),
		);
		const result = applyTaskMutation(state, "list", { includeDeleted: true, status: "deleted" });
		expect(result.op).toEqual({ kind: "list", includeDeleted: true, statusFilter: "deleted" });
		expect(result.state).toBe(state);
	});

	it("delete on already-deleted task errors", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "deleted" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "error", message: "#1 is already deleted" });
	});

	it("delete emits Op with id + subject", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "delete", id: 1, subject: "x" });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("clear emits Op with prior count and resets nextId to 1", () => {
		const state = stateWith(task({ id: 5, subject: "x" }));
		const result = applyTaskMutation(state, "clear", {});
		expect(result.op).toEqual({ kind: "clear", count: 1 });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("get emits Op with the resolved task", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.op).toEqual({ kind: "get", task: state.tasks[0] });
	});
});

describe("isTransitionValid", () => {
	it("is idempotent on same→same", () => {
		expect(isTransitionValid("completed", "completed")).toBe(true);
	});

	it("rejects completed → in_progress", () => {
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
	});

	it("allows completed → deleted", () => {
		expect(isTransitionValid("completed", "deleted")).toBe(true);
	});
});
