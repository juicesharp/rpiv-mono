import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../tool/types.js";
import { selectOverlayLayout, selectOverlayTasks } from "./selectors.js";
import type { TaskState } from "./state.js";

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const task = (id: number, status: TaskStatus = "pending"): Task => ({
	id,
	subject: `t${id}`,
	status,
});

const visibleIds = (layout: ReturnType<typeof selectOverlayLayout>): number[] => layout.visible.map((t) => t.id);

describe("selectOverlayLayout — focus window", () => {
	it("returns everything when the list fits the budget exactly", () => {
		const layout = selectOverlayLayout(stateWith(task(1), task(2), task(3), task(4), task(5)), 5);
		expect(visibleIds(layout)).toEqual([1, 2, 3, 4, 5]);
		expect(layout.hiddenBefore).toBe(0);
		expect(layout.hiddenAfter).toBe(0);
	});

	it("anchors at the top when the first task is unfinished (focusIndex = 0)", () => {
		const layout = selectOverlayLayout(stateWith(...Array.from({ length: 10 }, (_, i) => task(i + 1))), 5);
		expect(visibleIds(layout)).toEqual([1, 2, 3, 4]);
		expect(layout.hiddenBefore).toBe(0);
		expect(layout.hiddenAfter).toBe(6);
	});

	it("reserves both marker rows when the anchor hides tasks on both sides", () => {
		// 3 completed + 10 pending = 13, budget 6 → two markers → 4 task rows.
		const tasks = [task(1, "completed"), task(2, "completed"), task(3, "completed")];
		for (let i = 4; i <= 13; i++) tasks.push(task(i));
		const layout = selectOverlayLayout(stateWith(...tasks), 6);
		expect(visibleIds(layout)).toEqual([4, 5, 6, 7]);
		expect(layout.hiddenBefore).toBe(3);
		expect(layout.hiddenAfter).toBe(6);
	});

	it("anchors on an in_progress task the same as a pending one", () => {
		const tasks = [task(1, "completed"), task(2, "completed"), task(3, "completed"), task(4, "completed")];
		tasks.push(task(5, "in_progress"));
		for (let i = 6; i <= 12; i++) tasks.push(task(i));
		const layout = selectOverlayLayout(stateWith(...tasks), 5);
		// budget 5 → both markers → 3 task rows starting at the in_progress anchor.
		expect(visibleIds(layout)).toEqual([5, 6, 7]);
		expect(layout.hiddenBefore).toBe(4);
		expect(layout.hiddenAfter).toBe(5);
	});

	it("backfills from earlier tasks when the anchor is near the end", () => {
		const tasks: Task[] = [];
		for (let i = 1; i <= 8; i++) tasks.push(task(i, "completed"));
		tasks.push(task(9), task(10));
		const layout = selectOverlayLayout(stateWith(...tasks), 5);
		// Window shifts back to stay full; only the earlier side hides tasks.
		expect(visibleIds(layout)).toEqual([7, 8, 9, 10]);
		expect(layout.hiddenBefore).toBe(6);
		expect(layout.hiddenAfter).toBe(0);
	});

	it("does not reserve a second marker when the window exactly reaches the end", () => {
		// 3 completed + 4 pending = 7, budget 5 → slots 4, start 3, 3+4 == 7.
		const tasks = [task(1, "completed"), task(2, "completed"), task(3, "completed")];
		for (let i = 4; i <= 7; i++) tasks.push(task(i));
		const layout = selectOverlayLayout(stateWith(...tasks), 5);
		expect(visibleIds(layout)).toEqual([4, 5, 6, 7]);
		expect(layout.hiddenBefore).toBe(3);
		expect(layout.hiddenAfter).toBe(0);
	});

	it("shows the final window when every task is completed", () => {
		const tasks: Task[] = [];
		for (let i = 1; i <= 8; i++) tasks.push(task(i, "completed"));
		const layout = selectOverlayLayout(stateWith(...tasks), 5);
		expect(visibleIds(layout)).toEqual([5, 6, 7, 8]);
		expect(layout.hiddenBefore).toBe(4);
		expect(layout.hiddenAfter).toBe(0);
	});

	it("anchors over the visible (non-deleted) list, ignoring tombstones", () => {
		const tasks = [task(1, "completed"), task(2, "deleted"), task(3), task(4), task(5), task(6), task(7)];
		// Visible list has 6 entries; first unfinished sits at visible index 1.
		const layout = selectOverlayLayout(stateWith(...tasks), 4);
		expect(visibleIds(layout)).toEqual([3, 4]);
		expect(layout.hiddenBefore).toBe(1);
		expect(layout.hiddenAfter).toBe(3);
	});

	it("keeps a one-task window at budget=2 with a single hidden side", () => {
		const layout = selectOverlayLayout(stateWith(...Array.from({ length: 5 }, (_, i) => task(i + 1))), 2);
		expect(visibleIds(layout)).toEqual([1]);
		expect(layout.hiddenBefore).toBe(0);
		expect(layout.hiddenAfter).toBe(4);
	});

	it("reports both hidden counts truthfully at budget=2 (renderer folds them)", () => {
		// 2 completed + 3 pending = 5, budget 2 → no room for two markers; the
		// selector must not pretend the earlier side is empty.
		const tasks = [task(1, "completed"), task(2, "completed"), task(3), task(4), task(5)];
		const layout = selectOverlayLayout(stateWith(...tasks), 2);
		expect(visibleIds(layout)).toEqual([3]);
		expect(layout.hiddenBefore).toBe(2);
		expect(layout.hiddenAfter).toBe(2);
	});

	it("spends both marker rows at budget=3 when both sides hide tasks", () => {
		// 2 completed + 5 pending = 7, budget 3 → markers eat 2 rows, 1 task row.
		const tasks = [task(1, "completed"), task(2, "completed")];
		for (let i = 3; i <= 7; i++) tasks.push(task(i));
		const layout = selectOverlayLayout(stateWith(...tasks), 3);
		expect(visibleIds(layout)).toEqual([3]);
		expect(layout.hiddenBefore).toBe(2);
		expect(layout.hiddenAfter).toBe(4);
	});
});

describe("selectOverlayTasks — stale completed fading (keep-last-K)", () => {
	const done = (id: number, seq?: number): Task => ({ id, subject: `c${id}`, status: "completed", completedSeq: seq });

	it("keeps all completed when at most K exist", () => {
		const layout = selectOverlayTasks(stateWith(done(1, 1), done(2, 2), done(3, 3), task(4)), 3);
		expect(layout.map((t) => t.id)).toEqual([1, 2, 3, 4]);
	});

	it("drops the oldest stamped completions beyond K", () => {
		const layout = selectOverlayTasks(stateWith(done(1, 1), done(2, 2), done(3, 3), done(4, 4), task(5)), 3);
		expect(layout.map((t) => t.id)).toEqual([2, 3, 4, 5]);
	});

	it("keeps the newest by seq, not by list position", () => {
		// seq order differs from id order — rank must follow the stamp.
		const layout = selectOverlayTasks(stateWith(done(1, 4), done(2, 1), done(3, 2), done(4, 3), task(5)), 3);
		expect(layout.map((t) => t.id)).toEqual([1, 3, 4, 5]);
	});

	it("never drops unfinished tasks no matter how many", () => {
		const tasks: Task[] = [];
		for (let i = 1; i <= 4; i++) tasks.push(done(i, i));
		for (let i = 5; i <= 12; i++) tasks.push(task(i, i % 2 === 0 ? "pending" : "in_progress"));
		const layout = selectOverlayTasks(stateWith(...tasks), 3);
		expect(layout).toHaveLength(11); // 3 completed kept + 8 unfinished
		expect(layout.filter((t) => t.status !== "completed")).toHaveLength(8);
	});

	it("ranks unstamped (pre-feature) completions oldest and tie-breaks by id", () => {
		// 2 stamped + 3 unstamped, K=3 → keep the 2 stamped + newest unstamped id.
		const layout = selectOverlayTasks(stateWith(done(1), done(2), done(3), done(4, 10), done(5, 11)), 3);
		expect(layout.map((t) => t.id)).toEqual([3, 4, 5]);
	});

	it("keeps all completed visible when every completed is unstamped and count <= K", () => {
		const layout = selectOverlayTasks(stateWith(done(1), done(2), task(3)), 3);
		expect(layout.map((t) => t.id)).toEqual([1, 2, 3]);
	});

	it("drops the oldest unstamped by id when unstamped count exceeds K", () => {
		const layout = selectOverlayTasks(stateWith(done(1), done(2), done(3), done(4), task(5)), 3);
		expect(layout.map((t) => t.id)).toEqual([2, 3, 4, 5]);
	});

	it("always drops deleted tombstones regardless of stamps", () => {
		const layout = selectOverlayTasks(stateWith(done(1, 9), task(2, "deleted"), done(3, 10), task(4)), 3);
		expect(layout.map((t) => t.id)).toEqual([1, 3, 4]);
	});
});
