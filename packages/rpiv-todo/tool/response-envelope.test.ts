import { describe, expect, it } from "vitest";
import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { buildToolResult, formatContent } from "./response-envelope.js";
import type { Task } from "./types.js";

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const t = (over: Partial<Task> & { id: number; subject: string }): Task => ({ status: "pending", ...over });

describe("formatContent", () => {
	it("create — 'Created #id: subject (pending)'", () => {
		const state = stateWith(t({ id: 1, subject: "alpha" }));
		expect(formatContent({ kind: "create", taskId: 1 }, state)).toBe("Created #1: alpha (pending)");
	});

	it("update — emits transition tuple when statuses differ", () => {
		const state = stateWith(t({ id: 1, subject: "x", status: "in_progress" }));
		const op: Op = { kind: "update", id: 1, fromStatus: "pending", toStatus: "in_progress" };
		expect(formatContent(op, state)).toBe("Updated #1 (pending → in_progress)");
	});

	it("update — omits transition when from === to (e.g. blockedBy-only update)", () => {
		const state = stateWith(t({ id: 1, subject: "x" }));
		const op: Op = { kind: "update", id: 1, fromStatus: "pending", toStatus: "pending" };
		expect(formatContent(op, state)).toBe("Updated #1");
	});

	it("delete — 'Deleted #id: subject'", () => {
		const state = stateWith(t({ id: 1, subject: "ship", status: "deleted" }));
		expect(formatContent({ kind: "delete", id: 1, subject: "ship" }, state)).toBe("Deleted #1: ship");
	});

	it("clear — emits prior count", () => {
		expect(formatContent({ kind: "clear", count: 4 }, stateWith())).toBe("Cleared 4 tasks");
	});

	it("list — 'No tasks' when filtered view is empty", () => {
		const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe("No tasks");
	});

	it("list — joins per-task '[status] #id subject' lines", () => {
		const state = stateWith(
			t({ id: 1, subject: "a" }),
			t({ id: 2, subject: "b", status: "in_progress", activeForm: "Building" }),
		);
		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe(
			"[pending] #1 a\n[in_progress] #2 b (Building)",
		);
	});

	it("get — multi-line task block with description/blockedBy/owner", () => {
		const state = stateWith(
			t({ id: 1, subject: "root" }),
			t({ id: 2, subject: "leaf", description: "details", blockedBy: [1], owner: "Sergii" }),
		);
		const op: Op = { kind: "get", task: state.tasks[1]! };
		expect(formatContent(op, state)).toBe(
			"#2 [pending] leaf\n  description: details\n  blockedBy: #1\n  owner: Sergii",
		);
	});

	it("error — 'Error: <message>'", () => {
		expect(formatContent({ kind: "error", message: "subject required for create" }, stateWith())).toBe(
			"Error: subject required for create",
		);
	});
});

describe("buildToolResult", () => {
	it("envelope.details mirrors the canonical TaskDetails shape on success", () => {
		const state = stateWith(t({ id: 1, subject: "alpha" }));
		const env = buildToolResult("create", { subject: "alpha" }, state, { kind: "create", taskId: 1 });
		expect(env).toEqual({
			content: [{ type: "text", text: "Created #1: alpha (pending)" }],
			details: { action: "create", params: { subject: "alpha" }, tasks: state.tasks, nextId: state.nextId },
		});
	});

	it("envelope.details carries error message on op.kind === 'error'", () => {
		const env = buildToolResult("create", { subject: "" }, stateWith(), {
			kind: "error",
			message: "subject required for create",
		});
		expect(env.details.error).toBe("subject required for create");
		expect(env.content[0].text).toBe("Error: subject required for create");
	});
});
