import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../tool/types.js";
import { selectActivePartition, selectOverlayLayout, selectOverlayTasks } from "./selectors.js";
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

describe("selectActivePartition — active strip partition", () => {
	it("splits in_progress into active, everything else into rest, preserving id order", () => {
		const tasks = [task(1), task(2, "in_progress"), task(3, "completed"), task(4, "in_progress"), task(5)];
		const { active, rest } = selectActivePartition(tasks);
		expect(active.map((t) => t.id)).toEqual([2, 4]);
		expect(rest.map((t) => t.id)).toEqual([1, 3, 5]);
	});

	it("returns empty active and full rest when nothing is in_progress", () => {
		const { active, rest } = selectActivePartition([task(1), task(2, "completed")]);
		expect(active).toEqual([]);
		expect(rest.map((t) => t.id)).toEqual([1, 2]);
	});

	it("does not mutate its input and returns fresh arrays", () => {
		const tasks = [task(1, "in_progress"), task(2)];
		const { active } = selectActivePartition(tasks);
		active.pop();
		expect(selectActivePartition(tasks).active).toHaveLength(1);
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

describe("active strip + focus window budget math", () => {
	const done = (id: number, seq?: number): Task => ({ id, subject: `c${id}`, status: "completed", completedSeq: seq });

	// Mirror of the renderer's arithmetic so budget boundaries are pinned as a
	// pure function: strip takes `active.length` rows, the rest gets
	// `bodyBudget - active.length`; when the strip exceeds `bodyBudget - 2` it
	// is capped and the rest gets nothing.
	const stripPlan = (state: TaskState, bodyBudget: number) => {
		const overlayTasks = selectOverlayTasks(state, 3);
		const { active, rest } = selectActivePartition(overlayTasks);
		if (bodyBudget <= 2) {
			return {
				mode: "no-hoist" as const,
				layout: selectOverlayLayout({ tasks: overlayTasks, nextId: state.nextId }, bodyBudget),
			};
		}
		if (active.length > bodyBudget - 2) {
			return {
				mode: "active-overflow" as const,
				shownActive: bodyBudget - 2,
				hiddenActive: active.length - (bodyBudget - 2),
			};
		}
		return {
			mode: "strip" as const,
			layout: selectOverlayLayout({ tasks: rest, nextId: state.nextId }, bodyBudget - active.length),
			activeIds: active.map((t) => t.id),
		};
	};

	it("active fits: strip renders and the rest window keeps the remaining budget", () => {
		// 2 active + 10 pending = 12 overlay tasks, B=11 → strip 2, rest budget 9.
		const tasks = [task(1, "in_progress"), task(5, "in_progress")];
		for (let i = 2; i <= 12; i++) if (i !== 5) tasks.push(task(i));
		tasks.sort((a, b) => a.id - b.id);
		const plan = stripPlan(stateWith(...tasks), 11);
		expect(plan.mode).toBe("strip");
		if (plan.mode === "strip") {
			expect(plan.activeIds).toEqual([1, 5]);
			expect(visibleIds(plan.layout)).toHaveLength(8);
			expect(plan.layout.hiddenAfter).toBe(2);
		}
	});

	it("active exactly at cap: B-2 actives show and the rest window is empty", () => {
		// 4 active + 4 pending = 8, B=6 → cap B-2=4 → strip consumes cap exactly,
		// rest budget 2 → all rest rows fold behind the summary marker.
		const tasks = [task(1, "in_progress"), task(2, "in_progress"), task(3, "in_progress"), task(4, "in_progress")];
		for (let i = 5; i <= 8; i++) tasks.push(task(i));
		const plan = stripPlan(stateWith(...tasks), 6);
		expect(plan.mode).toBe("strip");
		if (plan.mode === "strip") {
			expect(plan.activeIds).toEqual([1, 2, 3, 4]);
			expect(visibleIds(plan.layout)).toEqual([5]);
			expect(plan.layout.hiddenBefore).toBe(0);
			expect(plan.layout.hiddenAfter).toBe(3);
		}
	});

	it("active over cap: first B-2 actives show, remainder count feeds the marker", () => {
		// 9 active + 2 pending, B=10 → cap B-2=8, 1 hidden active.
		const tasks: Task[] = [];
		for (let i = 1; i <= 9; i++) tasks.push(task(i, "in_progress"));
		tasks.push(task(10), task(11));
		const plan = stripPlan(stateWith(...tasks), 10);
		expect(plan.mode).toBe("active-overflow");
		if (plan.mode === "active-overflow") {
			expect(plan.shownActive).toBe(8);
			expect(plan.hiddenActive).toBe(1);
		}
	});

	it("rest window shrinks by the strip height, not by the raw list size", () => {
		// 3 active + 9 pending, B=11 → rest budget 8 → window 7 + 1 marker row.
		const tasks = [task(1, "in_progress"), task(6, "in_progress"), task(9, "in_progress")];
		for (let i = 2; i <= 12; i++) if (i !== 6 && i !== 9) tasks.push(task(i));
		tasks.sort((a, b) => a.id - b.id);
		const plan = stripPlan(stateWith(...tasks), 11);
		if (plan.mode === "strip") {
			expect(plan.layout.hiddenAfter).toBe(2);
			expect(visibleIds(plan.layout)).toHaveLength(7);
		}
	});

	it("B=2 degenerate budget: no hoist, window runs over the filtered list", () => {
		const tasks = [task(1, "in_progress"), task(2), task(3), task(4), task(5)];
		const plan = stripPlan(stateWith(...tasks), 2);
		expect(plan.mode).toBe("no-hoist");
		if (plan.mode === "no-hoist") {
			expect(visibleIds(plan.layout)).toEqual([1]);
			expect(plan.layout.hiddenAfter).toBe(4);
		}
	});

	it("recency filter runs before the partition: faded completions never reach rest", () => {
		// 5 completed (only 3 kept) + 2 active + 4 pending; faded c1/c2 must not
		// appear in the rest window or count toward its hidden markers.
		const tasks = [done(1, 1), done(2, 2), done(3, 3), done(4, 4), done(5, 5), task(6, "in_progress"), task(7)];
		for (let i = 8; i <= 10; i++) tasks.push(task(i));
		tasks.push(task(11, "in_progress"));
		const plan = stripPlan(stateWith(...tasks), 8);
		expect(plan.mode).toBe("strip");
		if (plan.mode === "strip") {
			expect(plan.activeIds).toEqual([6, 11]);
			// rest = c3,c4,c5,t7,t8,t9,t10 → 7 tasks in budget 6 → the anchor
			// backfills so only an earlier marker is needed, eating 1 row.
			expect(visibleIds(plan.layout)).toEqual([5, 7, 8, 9, 10]);
			expect(plan.layout.hiddenBefore).toBe(2);
			expect(plan.layout.hiddenAfter).toBe(0);
			expect(visibleIds(plan.layout)).not.toContain(1);
			expect(visibleIds(plan.layout)).not.toContain(2);
		}
	});
});
