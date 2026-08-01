/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	getCompletedTaskPresentation,
	getCompletedTaskVisibility,
	getMaxVisibleCompleted,
	getMaxWidgetLines,
	resolveCollapseKey,
	resolveCompletedCollapseKey,
} from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import {
	selectHasActive,
	selectOverlayLayout,
	selectPriorityOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
} from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";
const RECENT_COMPLETION_WINDOW_MS = 5_000;

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private completedRowsExpanded = false;
	// Standalone overlay tests do not exercise extension shortcut registration; the
	// extension explicitly disables this when session folding is not bound.
	private completedRowsShortcutEnabled = true;
	private completedSessionWasActive = false;
	private observedTaskStatuses = new Map<number, string>();
	private recentCompletedAt = new Map<number, number>();
	private recentCompletionTimer: ReturnType<typeof setTimeout> | undefined;
	private lastNextId: number | undefined;
	private collapsed = false;

	setCompletedRowsShortcutEnabled(enabled: boolean): void {
		this.completedRowsShortcutEnabled = enabled;
		if (!enabled) this.completedRowsExpanded = false;
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.completedRowsExpanded = false;
		this.completedSessionWasActive = false;
		this.observedTaskStatuses.clear();
		this.recentCompletedAt.clear();
		if (this.recentCompletionTimer) clearTimeout(this.recentCompletionTimer);
		this.recentCompletionTimer = undefined;
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (getCompletedTaskVisibility() === "session") {
			// Session mode keeps completed rows available. Clear only stale state from a
			// preceding turn-mode render without collapsing a user-expanded fold.
			this.completedTaskIdsPendingHide.clear();
			this.hiddenCompletedTaskIds.clear();
			this.completedSessionWasActive = true;
			this.tui?.requestRender();
			return;
		}
		if (this.completedSessionWasActive) {
			// A policy change is applied on this turn boundary: rows retained under
			// session mode now become subject to the compact turn-mode behavior.
			for (const task of this.getSnapshot().tasks) {
				if (task.status === "completed") this.hiddenCompletedTaskIds.add(task.id);
			}
			this.completedRowsExpanded = false;
			this.completedSessionWasActive = false;
			this.tui?.requestRender();
			return;
		}
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}
	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	toggleCompletedRows(): void {
		const snapshot = this.getSnapshot();
		if (this.getFoldedCompletedPrefixCount(this.selectOverlayTasks(snapshot)) === 0) return;
		this.completedRowsExpanded = !this.completedRowsExpanded;
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		this.observeTaskStatusTransitions(state.tasks);
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private observeTaskStatusTransitions(
		tasks: readonly ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number][],
	): void {
		const now = Date.now();
		const currentStatuses = new Map<number, string>();
		for (const task of tasks) {
			currentStatuses.set(task.id, task.status);
			const previousStatus = this.observedTaskStatuses.get(task.id);
			if (previousStatus !== undefined && previousStatus !== "completed" && task.status === "completed") {
				this.recentCompletedAt.set(task.id, now);
			} else if (task.status !== "completed") {
				this.recentCompletedAt.delete(task.id);
			}
		}
		for (const taskId of this.recentCompletedAt.keys()) {
			if (!currentStatuses.has(taskId)) this.recentCompletedAt.delete(taskId);
		}
		this.observedTaskStatuses = currentStatuses;
		for (const [taskId, completedAt] of this.recentCompletedAt) {
			if (now - completedAt >= RECENT_COMPLETION_WINDOW_MS) this.recentCompletedAt.delete(taskId);
		}
		this.scheduleRecentCompletionRender();
	}

	private scheduleRecentCompletionRender(): void {
		if (this.recentCompletionTimer) clearTimeout(this.recentCompletionTimer);
		this.recentCompletionTimer = undefined;
		if (getCompletedTaskVisibility() !== "session" || getCompletedTaskPresentation() !== "priority") return;
		const now = Date.now();
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const completedAt of this.recentCompletedAt.values()) {
			nextExpiry = Math.min(nextExpiry, completedAt + RECENT_COMPLETION_WINDOW_MS);
		}
		if (!Number.isFinite(nextExpiry)) return;
		const timer = setTimeout(() => this.tui?.requestRender(true), Math.max(1, nextExpiry - now));
		timer.unref?.();
		this.recentCompletionTimer = timer;
	}

	private getRecentCompletedTaskIds(): ReadonlySet<number> {
		return new Set(this.recentCompletedAt.keys());
	}

	private getPriorityTaskBudget(): number {
		const terminalRows = this.tui?.terminal?.rows;
		if (typeof terminalRows === "number") {
			return terminalRows <= 10 ? 0 : Math.min(5, Math.max(3, terminalRows - 14));
		}
		return Math.min(5, Math.max(3, getMaxWidgetLines() - 1));
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		const visibility = getCompletedTaskVisibility();
		return snapshot.tasks.filter(
			(task) => task.status !== "deleted" && (visibility === "session" || !this.shouldHideCompletedTask(task)),
		);
	}

	private getFoldedCompletedPrefixCount(
		tasks: readonly ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number][],
	): number {
		if (getCompletedTaskVisibility() !== "session") return 0;
		if (getCompletedTaskPresentation() !== "chronological" || !this.completedRowsShortcutEnabled) return 0;
		const completedKey = resolveCompletedCollapseKey();
		if (completedKey === COLLAPSE_KEY_OFF || completedKey === resolveCollapseKey()) return 0;
		let completedPrefixCount = 0;
		for (const task of tasks) {
			if (task.status !== "completed") break;
			completedPrefixCount++;
		}
		return Math.max(0, completedPrefixCount - getMaxVisibleCompleted());
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}
	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track, and skipping the tracking
		// when nothing is rendered is correctness, not optimization. The hint splices
		// the resolved key into the {key} placeholder (per-render, like the row
		// budget); a config edit needs /reload to re-bind the actual shortcut. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of splicing the sentinel into the placeholder.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		const lines: string[] = [heading];
		const completedVisibility = getCompletedTaskVisibility();
		if (completedVisibility === "session") this.completedSessionWasActive = true;
		if (completedVisibility === "session") {
			if (getCompletedTaskPresentation() === "chronological") {
				// Preserve chronological order and fold only an old completed prefix.
				const foldedCompletedCount = this.getFoldedCompletedPrefixCount(overlayTasks);
				const visibleTasks = this.completedRowsExpanded ? overlayTasks : overlayTasks.slice(foldedCompletedCount);
				if (foldedCompletedCount > 0) {
					const icon = this.completedRowsExpanded ? "▼" : "▶";
					const label = `${foldedCompletedCount} ${formatStatusLabel("completed")}`;
					const key = resolveCompletedCollapseKey();
					const detail = this.completedRowsExpanded
						? label
						: `${label} · ${t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key)}`;
					lines.push(truncate(`${theme.fg("dim", "├─")} ${theme.fg("dim", `${icon} ${detail}`)}`));
				}
				for (const task of visibleTasks) {
					lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
				}
				const last = lines.length - 1;
				lines[last] = lines[last].replace("├─", "└─");
				return this.withTrailingSpacer(lines);
			}

			// Claude-like projection keeps the session state intact while fitting current
			// work into the terminal: recent completion, in-progress, ready pending,
			// blocked pending, then older completion.
			const priorityLayout = selectPriorityOverlayLayout(
				overlayState,
				this.getPriorityTaskBudget(),
				this.getRecentCompletedTaskIds(),
			);
			for (const task of priorityLayout.visible) {
				lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
			}
			if (priorityLayout.hiddenTotal > 0) {
				const hiddenParts: string[] = [];
				if (priorityLayout.hiddenInProgress > 0) {
					hiddenParts.push(`${priorityLayout.hiddenInProgress} ${formatStatusLabel("in_progress")}`);
				}
				if (priorityLayout.hiddenPending > 0) {
					hiddenParts.push(`${priorityLayout.hiddenPending} ${formatStatusLabel("pending")}`);
				}
				if (priorityLayout.hiddenCompleted > 0) {
					hiddenParts.push(`${priorityLayout.hiddenCompleted} ${formatStatusLabel("completed")}`);
				}
				lines.push(truncate(`${theme.fg("dim", "├─")} ${theme.fg("dim", `… +${hiddenParts.join(", ")}`)}`));
			}
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		// Turn mode retains the upstream compact-overlay behavior, including the
		// terminal-height budget and next-agent-turn removal of completed rows.
		const layout = selectOverlayLayout(overlayState, getMaxWidgetLines() - 1);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}
