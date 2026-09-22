/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, compact/focused/minimized display modes, Pi tool-output expansion
 * awareness, and auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import type { Task } from "./tool/types.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";
const FOCUSED_HEIGHT_RATIO = 0.3;
const MIN_FOCUSED_WIDGET_ROWS = 5;

type OverlayMode = "compact" | "focused" | "minimized";

type WidgetMouseEvent = {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
	wheelDelta?: number;
};

type WidgetMouseResult = {
	handled?: boolean;
	render?: boolean;
};

interface TodoWidgetComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: WidgetMouseEvent): WidgetMouseResult | undefined;
	invalidate(): void;
	dispose(): void;
}

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private widgetComponent: TodoWidgetComponent | undefined;
	private removeInputListener: (() => void) | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private mode: OverlayMode = "compact";
	private scrollOffset = 0;
	private lastFocusedViewportRows = 1;
	private lastFocusedTaskCount = 0;
	private scrollAnchorTaskId: number | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.detachWidgetRuntime();
			this.uiCtx = ctx;
			this.widgetRegistered = false;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const allTasks = this.selectAllTasks(snapshot);

		if (allTasks.length === 0) {
			if (this.widgetRegistered) {
				this.detachWidgetRuntime();
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.detachWidgetRuntime();
					this.tui = tui;
					const component: TodoWidgetComponent = {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						handleInput: (data: string) => {
							this.handleFocusedInput(data);
						},
						handleMouse: (event: WidgetMouseEvent) => this.handleMouse(event),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
						dispose: () => {
							if (this.widgetComponent === component) this.detachWidgetRuntime();
						},
					};
					this.widgetComponent = component;
					this.removeInputListener = tui.addInputListener?.((data) =>
						this.handleFocusedInput(data) ? { consume: true } : undefined,
					);
					return component;
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
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	cycleMode(): void {
		if (this.mode === "compact") {
			this.mode = "focused";
			this.scrollOffset = 0;
			this.scrollAnchorTaskId = this.selectAllTasks(this.getSnapshot()).find(
				(task) => task.status === "in_progress",
			)?.id;
		} else if (this.mode === "focused") {
			this.mode = "minimized";
			this.scrollAnchorTaskId = undefined;
		} else {
			this.mode = "compact";
		}
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private detachWidgetRuntime(): void {
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		this.widgetComponent = undefined;
		this.tui = undefined;
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
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

	private selectAllTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>): Task[] {
		return snapshot.tasks.filter((task) => task.status !== "deleted");
	}

	private selectCompactTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>): Task[] {
		return this.selectAllTasks(snapshot).filter((task) => !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: Task): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const allTasks = this.selectAllTasks(snapshot);
		if (allTasks.length === 0) return [];

		if (this.mode === "focused") return this.renderFocused(theme, width, allTasks, snapshot.nextId);

		const overlayTasks = this.selectCompactTasks(snapshot);
		if (overlayTasks.length === 0) return [];
		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const heading = this.renderHeading(theme, truncate, overlayState);

		if (this.mode === "minimized") {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode remains available in compact mode.
		const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		const showIds = selectShowTaskIds(overlayState);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}
		// Preserve the existing turn-boundary behavior: completed tasks count as
		// displayed even when compact overflow drops their rows.
		this.trackDisplayedCompleted(overlayTasks);

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

	private renderFocused(theme: Theme, width: number, tasks: Task[], nextId: number): string[] {
		const state = { tasks, nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const terminalRows = this.tui?.terminal?.rows ?? Math.ceil(MIN_FOCUSED_WIDGET_ROWS / FOCUSED_HEIGHT_RATIO);
		const widgetRows = Math.max(MIN_FOCUSED_WIDGET_ROWS, Math.floor(terminalRows * FOCUSED_HEIGHT_RATIO));
		const viewportRows = Math.max(1, widgetRows - 3); // heading + range/help + trailing spacer
		const maxOffset = Math.max(0, tasks.length - viewportRows);

		if (this.scrollAnchorTaskId !== undefined) {
			const anchorIndex = tasks.findIndex((task) => task.id === this.scrollAnchorTaskId);
			if (anchorIndex >= 0) this.scrollOffset = anchorIndex - Math.floor(viewportRows / 2);
			this.scrollAnchorTaskId = undefined;
		}
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
		this.lastFocusedViewportRows = viewportRows;
		this.lastFocusedTaskCount = tasks.length;

		const visible = tasks.slice(this.scrollOffset, this.scrollOffset + viewportRows);
		const lines = [this.renderHeading(theme, truncate, state)];
		const showIds = selectShowTaskIds(state);
		for (const task of visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}
		this.trackDisplayedCompleted(visible);

		const start = tasks.length === 0 ? 0 : this.scrollOffset + 1;
		const end = Math.min(tasks.length, this.scrollOffset + visible.length);
		const range = `${start}–${end}/${tasks.length}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `${range} · ↑↓/PgUp/PgDn · Esc`)}`));
		return this.withTrailingSpacer(lines);
	}

	private renderHeading(
		theme: Theme,
		truncate: (line: string) => string,
		state: { tasks: Task[]; nextId: number },
	): string {
		const counts = selectTodoCounts(state);
		const hasActive = selectHasActive(state);
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const focusMarker = this.mode === "focused" ? " ↕" : "";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})${focusMarker}`;
		return truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);
	}

	private trackDisplayedCompleted(tasks: readonly Task[]): void {
		for (const task of tasks) {
			if (
				task.status === "completed" &&
				!this.completedTaskIdsPendingHide.has(task.id) &&
				!this.hiddenCompletedTaskIds.has(task.id)
			) {
				this.completedTaskIdsPendingHide.add(task.id);
			}
		}
	}

	private handleFocusedInput(data: string): boolean {
		if (this.mode !== "focused") return false;
		const cycleKey = resolveCollapseKey();
		if (cycleKey !== COLLAPSE_KEY_OFF && matchesKey(data, cycleKey as KeyId)) {
			this.cycleMode();
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this.mode = "compact";
			this.scrollAnchorTaskId = undefined;
			this.tui?.requestRender(true);
			return true;
		}
		if (matchesKey(data, Key.up)) return this.scrollBy(-1);
		if (matchesKey(data, Key.down)) return this.scrollBy(1);
		if (matchesKey(data, Key.pageUp)) return this.scrollBy(-Math.max(1, this.lastFocusedViewportRows - 1));
		if (matchesKey(data, Key.pageDown)) return this.scrollBy(Math.max(1, this.lastFocusedViewportRows - 1));
		if (matchesKey(data, Key.home)) return this.scrollTo(0);
		if (matchesKey(data, Key.end)) return this.scrollTo(this.maxScrollOffset());
		return false;
	}

	private handleMouse(event: WidgetMouseEvent): WidgetMouseResult | undefined {
		if (event.type === "click" && event.button === "left") {
			if (this.mode !== "focused") this.cycleMode();
			return { handled: true, render: true };
		}
		if (event.type === "wheel" && this.mode === "focused" && event.wheelDelta) {
			this.scrollBy(event.wheelDelta);
			return { handled: true, render: true };
		}
		return undefined;
	}

	private scrollBy(lines: number): boolean {
		return this.scrollTo(this.scrollOffset + lines);
	}

	private scrollTo(offset: number): boolean {
		const next = Math.max(0, Math.min(this.maxScrollOffset(), offset));
		if (next !== this.scrollOffset) {
			this.scrollOffset = next;
			this.tui?.requestRender();
		}
		return true;
	}

	private maxScrollOffset(): number {
		return Math.max(0, this.lastFocusedTaskCount - this.lastFocusedViewportRows);
	}

	/** Append a trailing blank line so the overlay isn't flush against the editor box. */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.detachWidgetRuntime();
		this.widgetRegistered = false;
		this.uiCtx = undefined;
		this.mode = "compact";
		this.scrollOffset = 0;
		this.scrollAnchorTaskId = undefined;
		this.resetCompletedDisplayState();
	}
}
