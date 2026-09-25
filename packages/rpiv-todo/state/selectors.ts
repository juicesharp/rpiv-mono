import type { Task, TaskStatus } from "../tool/types.ts";
import type { TaskState } from "./state.ts";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * Group visible tasks by status. Iteration order at the call site uses
 * (`completed`, `inProgress`, `pending`) to match the `/todos` header part
 * order pinned by `todo.command.test.ts`.
 */
export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

/** Total counts for the overlay heading (`Todos (n/m)`) and `/todos` header. */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/**
 * Whether any visible task carries a `blockedBy` reference. The overlay uses
 * this to gate the `#id` prefix on per-task rows — without at least one
 * `⛓ #N` suffix, the per-row id has no anchor.
 */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/**
 * Resolve a task's subject by id from the live state for renderCall's
 * accent label. `undefined` when the id is unknown — caller falls back to
 * `#id` plain rendering.
 */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

/**
 * Overlay layout decision. Focus-window rule: when the visible list overflows
 * the budget, anchor the window at the first unfinished task in display order
 * and backfill from earlier tasks so the window stays full; when every task is
 * completed, the final window is shown. Each overflow marker row
 * (`… N earlier` / `… N later`) consumes one budget slot. `budget` is the
 * body-slot count (caller passes `getMaxWidgetLines() - 1` to reserve the
 * heading row). Returns the visible slice plus the hidden counts on either
 * side.
 */
export interface OverlayLayout {
	visible: readonly Task[];
	hiddenBefore: number;
	hiddenAfter: number;
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenBefore: 0, hiddenAfter: 0 };
	}
	const focusIndex = all.findIndex((t) => t.status !== "completed");
	const anchor = focusIndex === -1 ? all.length : focusIndex;
	// One marker row reserved up front; a second only when both sides hide
	// tasks and the budget still fits at least one task row (budget >= 3).
	let slots = budget - 1;
	let start = Math.min(anchor, all.length - slots);
	if (start > 0 && start + slots < all.length && budget >= 3) {
		slots = budget - 2;
		start = Math.min(anchor, all.length - slots);
	}
	const visible = all.slice(start, start + slots);
	return { visible, hiddenBefore: start, hiddenAfter: all.length - start - visible.length };
}

/**
 * Helper: whether any visible task is `pending` or `in_progress`. The overlay
 * uses this to pick the heading icon (`accent`+`●` vs `dim`+`○`).
 */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
