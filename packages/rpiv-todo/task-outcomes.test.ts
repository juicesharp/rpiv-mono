import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, type vi } from "vitest";
import { isTransitionValid } from "./state/invariants.js";
import { replayFromBranch } from "./state/replay.js";
import { selectHasActive, selectOverlayLayout, selectTodoCounts } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { __resetState, registerTodosCommand, registerTodoTool } from "./todo.js";
import { formatContent } from "./tool/response-envelope.js";
import type { Task, TaskStatus } from "./tool/types.js";
import { formatOverlayTaskLine } from "./view/format.js";

function task(id: number, status: TaskStatus = "pending"): Task {
	return { id, subject: `task ${id}`, status };
}

const theme = makeTheme({
	fg: (color, text) => `<${color}>${text}</${color}>`,
	strikethrough: (text) => `<strike>${text}</strike>`,
}) as unknown as Theme;

describe("explicit failure and user-handoff outcomes", () => {
	for (const status of ["failed", "awaiting_user"] as const) {
		it(`requires an explanation before entering ${status}`, () => {
			const state = { tasks: [task(1, "in_progress")], nextId: 2 };
			const rejected = applyTaskMutation(state, "update", { id: 1, status });
			expect(rejected.op.kind).toBe("error");
			expect(rejected.state).toBe(state);
			const accepted = applyTaskMutation(state, "update", { id: 1, status, description: "Explain the result" });
			expect(accepted.state.tasks[0].status).toBe(status);
			expect(accepted.state.tasks[0].description).toBe("Explain the result");
		});

		it(`preserves ${status} across session replay without treating metadata as a status`, () => {
			const tasks = [
				{ ...task(1, status), description: "Explain the result" },
				{ ...task(2), metadata: { executionStatus: status } },
			];
			const ctx = {
				sessionManager: {
					getBranch: () => [
						{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 3 } } },
					],
				},
			};
			expect(replayFromBranch(ctx).tasks.map((entry) => entry.status)).toEqual([status, "pending"]);
		});

		it(`keeps ${status} distinct from pending and supports an explicit retry`, () => {
			expect(isTransitionValid("in_progress", status)).toBe(true);
			expect(isTransitionValid(status, "in_progress")).toBe(true);
			expect(isTransitionValid(status, "pending")).toBe(false);
			expect(isTransitionValid(status, status)).toBe(true);
			expect(isTransitionValid(status, "completed")).toBe(true);
			expect(isTransitionValid(status, "deleted")).toBe(true);
		});

		it(`renders ${status} with a visible label and sanitized explanation, never strikethrough`, () => {
			const entry = { ...task(1, status), description: "Check\u001b[2J failed\nsee logs" };
			const line = formatOverlayTaskLine(entry, theme, true);
			expect(line).toContain(status === "failed" ? "<error>✗</error>" : "<warning>◷</warning>");
			expect(line).toContain(status === "failed" ? "[failed]" : "[awaiting user]");
			expect(line).toContain("Check failed see logs");
			expect(line).not.toContain("<strike>");
		});

		it(`includes the explanation in list and get output for ${status}`, () => {
			const entry = { ...task(1, status), description: "Need follow-up" };
			const state = { tasks: [entry], nextId: 2 };
			expect(formatContent({ kind: "list", statusFilter: status, includeDeleted: false }, state)).toContain(
				`[${status}] #1 task 1 — Need follow-up`,
			);
			expect(formatContent({ kind: "get", task: entry }, state)).toContain("description: Need follow-up");
		});
	}

	it("counts failure and user handoff independently without inflating pending or completed", () => {
		const state = {
			tasks: [
				task(1),
				task(2, "in_progress"),
				task(3, "failed"),
				task(4, "awaiting_user"),
				task(5, "completed"),
				task(6, "deleted"),
			],
			nextId: 7,
		};
		expect(selectTodoCounts(state)).toEqual({
			total: 5,
			pending: 1,
			inProgress: 1,
			failed: 1,
			awaitingUser: 1,
			completed: 1,
		});
		expect(selectHasActive({ tasks: [task(1, "failed")], nextId: 2 })).toBe(true);
		expect(selectHasActive({ tasks: [task(1, "awaiting_user")], nextId: 2 })).toBe(true);
	});

	it("keeps failure and user handoff ahead of untouched backlog when the overlay overflows", () => {
		const tasks = [
			task(1),
			task(2),
			task(3, "failed"),
			task(4, "awaiting_user"),
			task(5, "completed"),
			task(6, "in_progress"),
		];
		const layout = selectOverlayLayout({ tasks, nextId: 7 }, 4);
		expect(layout.visible.map((entry) => entry.status)).toEqual(["in_progress", "failed", "awaiting_user"]);
		expect(layout.hiddenCompleted).toBe(1);
		expect(layout.truncatedTail).toBe(2);
	});

	it("exposes failure and user-handoff groups with explanations in /todos", async () => {
		__resetState();
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		registerTodosCommand(pi);
		const tool = captured.tools.get("todo")!;
		const ctx = createMockCtx({ hasUI: true });
		for (const params of [
			{ action: "create", subject: "Run checks" },
			{ action: "update", id: 1, status: "failed", description: "Two checks failed; not retried" },
			{ action: "create", subject: "Manual acceptance" },
			{ action: "update", id: 2, status: "awaiting_user", description: "Reload and confirm the UI" },
		])
			await tool.execute?.("call", params as never, undefined as never, undefined as never, ctx as never);
		await captured.commands.get("todos")!.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		const output = String(notify.mock.calls.at(-1)?.[0]);
		expect(output).toContain("── Failed ──");
		expect(output).toContain("── Awaiting User ──");
		expect(output).toContain("Two checks failed; not retried");
		expect(output).toContain("Reload and confirm the UI");
		expect(output).not.toContain("── Pending ──");
		__resetState();
	});
});
