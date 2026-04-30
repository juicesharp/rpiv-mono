import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

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
 * Overlay layout decision. Encapsulates the "drop completed first, then
 * truncate non-completed tail" rule pre-refactor lived in
 * `todo-overlay.ts:144-188`. `budget` is the body-slot count (caller passes
 * `MAX_WIDGET_LINES - 1` to reserve the heading row); on overflow the
 * selector reserves one more slot internally for the summary row. Returns
 * the visible task slice plus the overflow summary parts.
 */
export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}
	const innerBudget = budget - 1;
	const nonCompleted = all.filter((t) => t.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;
	if (nonCompleted.length <= innerBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const t of all) {
			if (kept.size >= innerBudget) break;
			if (t.status === "completed") kept.add(t);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
	}
	const visible = nonCompleted.slice(0, innerBudget);
	const truncatedTail = nonCompleted.length - innerBudget;
	return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}

/**
 * Helper: whether any visible task is `pending` or `in_progress`. The overlay
 * uses this to pick the heading icon (`accent`+`●` vs `dim`+`○`).
 */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
