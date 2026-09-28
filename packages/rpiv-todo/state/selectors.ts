import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * How many completed rows the overlay keeps on screen. Product rule: a
 * finished task earns its row only until K newer completions displace it —
 * "show what just finished, hide what finished a while ago". Deliberately a
 * constant, not a config knob: the overlay is a summary surface and the
 * number is a UX decision, not a user preference.
 */
export const KEEP_RECENT_COMPLETED = 3;

/**
 * Overlay-eligible tasks: everything non-deleted, minus completed tasks that
 * have been displaced by at least `keepRecentCompleted` newer completions.
 * Recency ranks by `completedSeq` (monotonic completion order assigned by the
 * reducer); tasks missing the stamp — completed before the feature existed —
 * rank oldest and tie-break by id. Unfinished tasks are never dropped, so a
 * scattered mix of pending/in_progress rows always survives to the layout
 * step. This replaces the old turn-boundary hiding machinery: fading is
 * immediate and deterministic, not deferred to `agent_start`.
 *
 * Returns a mutable `Task[]` so callers can feed the result into
 * `TaskState`-shaped selectors (`selectOverlayLayout`, `selectTodoCounts`)
 * without a defensive copy — `filter` already allocates a fresh array.
 */
export function selectOverlayTasks(state: TaskState, keepRecentCompleted: number): Task[] {
	const completed = state.tasks.filter((t) => t.status === "completed");
	if (completed.length <= keepRecentCompleted) {
		return state.tasks.filter((t) => t.status !== "deleted");
	}
	// Rank newest-first: stamped completions by seq desc; unstamped ones
	// (pre-feature snapshots) are older than any stamp and order among
	// themselves by id desc (higher id = created later = least stale).
	const ranked = [...completed].sort((a, b) => (b.completedSeq ?? -1) - (a.completedSeq ?? -1) || b.id - a.id);
	const keep = new Set<Task>(ranked.slice(0, Math.max(0, keepRecentCompleted)));
	return state.tasks.filter((t) => t.status !== "deleted" && (t.status !== "completed" || keep.has(t)));
}

/**
 * Partition overlay-eligible tasks into the active strip (`in_progress`) and
 * the remainder, each preserving id order. Runs AFTER `selectOverlayTasks`
 * (the completed-recency filter) so its input is already fade-aware — active
 * tasks are never faded anyway, so `active` is stable regardless of filter.
 * The overlay renders `active` first (all visible in-progress work stays on
 * screen even when the focus window below would have hidden it) and passes
 * `rest` to `selectOverlayLayout`.
 */
export interface ActivePartition {
	active: Task[];
	rest: Task[];
}
export function selectActivePartition(tasks: readonly Task[]): ActivePartition {
	return {
		active: tasks.filter((t) => t.status === "in_progress"),
		rest: tasks.filter((t) => t.status !== "in_progress"),
	};
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
