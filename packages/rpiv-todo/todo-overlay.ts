/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Renders a persistent widget via Pi core's `ExtensionUIContext.setWidget`
 * contract (`@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1288-1317`):
 * factory-form registration in widgetContainerAbove, register-once +
 * requestRender() refresh, 12-line collapse-not-scroll, auto-hide when empty.
 * No timer (todos have no animation), no status bar, no aging map.
 *
 * Data source is module-level getTodos() read at render time — NEVER
 * reconstructTodoState from a tool_execution_end handler, since the persisted
 * branch is stale at that point (message_end runs after the extension event).
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import { getTodos, type Task, type TaskStatus } from "./todo.js";

// ---- Constants ----

const WIDGET_KEY = "rpiv-todos";
/** Maximum rendered lines before overflow-collapse kicks in. */
const MAX_WIDGET_LINES = 12;

// ---- Helpers ----

function statusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

// ---- Controller ----

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;

	/**
	 * Bind or rebind the UI context. Identity-compares the incoming ctx so
	 * subsequent session_start handlers are idempotent; on identity change
	 * (e.g. /reload) cached widgetRegistered/tui are invalidated so the next
	 * update() re-registers under the fresh context.
	 */
	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/**
	 * Idempotent refresh. Safe to call from session_start, session_compact,
	 * session_tree, and tool_execution_end. Reads live state via getTodos() —
	 * NEVER calls reconstructTodoState (branch is stale during tool events).
	 */
	update(): void {
		if (!this.uiCtx) return;

		const visible = getTodos().filter((t) => t.status !== "deleted");

		// Empty → unregister and clear cached refs.
		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		// Non-empty → register once, then requestRender on subsequent updates.
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							// Theme changed — force factory re-invocation to capture fresh theme.
							this.widgetRegistered = false;
							this.tui = undefined;
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

	/**
	 * Build rendered rows. Called from the registered widget's render() closure,
	 * so it reads live state each time via getTodos() rather than capturing it.
	 * Preserves natural (insertion) order. On overflow, drops completed tasks
	 * first (in-place — remaining items stay in natural order), then truncates
	 * the non-completed tail if still overflowing.
	 */
	private renderWidget(theme: Theme, width: number): string[] {
		const all = getTodos().filter((t) => t.status !== "deleted");
		if (all.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");

		const completedCount = all.filter((t) => t.status === "completed").length;
		const totalVisible = all.length;
		const hasActive = all.some((t) => t.status === "in_progress" || t.status === "pending");
		// Show per-row ids only when at least one task has a blockedBy
		// reference — otherwise the `⛓ #N` suffix on a dep row couldn't be
		// resolved against any visible task.
		const showIds = all.some((t) => t.blockedBy && t.blockedBy.length > 0);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `Todos (${completedCount}/${totalVisible})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		const lines: string[] = [heading];
		const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 row

		// Happy path: everything fits in natural order.
		if (all.length <= maxBody) {
			for (const t of all) {
				lines.push(truncate(`${theme.fg("dim", "├─")} ${this.formatTaskLine(t, theme, showIds)}`));
			}
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		// Overflow path: reserve 1 line for the summary, drop completed first
		// (in natural order), then truncate the non-completed tail if needed.
		const budget = maxBody - 1;
		const nonCompleted = all.filter((t) => t.status !== "completed");

		let visible: Task[];
		let truncatedTailCount = 0;
		if (nonCompleted.length <= budget) {
			// Dropping completed alone was enough. Fill remaining slots with
			// completed tasks from `all` until the budget is hit, then re-sort
			// into natural order.
			const kept = new Set<Task>(nonCompleted);
			for (const t of all) {
				if (kept.size >= budget) break;
				if (t.status === "completed") kept.add(t);
			}
			visible = all.filter((t) => kept.has(t));
		} else {
			// Even dropping all completed isn't enough — truncate the
			// non-completed tail.
			visible = nonCompleted.slice(0, budget);
			truncatedTailCount = nonCompleted.length - budget;
		}

		for (const t of visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${this.formatTaskLine(t, theme, showIds)}`));
		}

		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		const hiddenCompleted = completedCount - shownCompleted;
		const totalHidden = hiddenCompleted + truncatedTailCount;
		const overflowParts: string[] = [];
		if (hiddenCompleted > 0) overflowParts.push(`${hiddenCompleted} completed`);
		if (truncatedTailCount > 0) overflowParts.push(`${truncatedTailCount} pending`);
		lines.push(
			truncate(
				theme.fg("dim", "└─") +
					" " +
					theme.fg(
						"dim",
						overflowParts.length > 0
							? `+${totalHidden} more (${overflowParts.join(", ")})`
							: `+${totalHidden} more`,
					),
			),
		);
		return lines;
	}

	private formatTaskLine(t: Task, theme: Theme, showId: boolean): string {
		const glyph = statusGlyph(t.status, theme);
		const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
		let subject = theme.fg(subjectColor, t.subject);
		if (t.status === "completed" || t.status === "deleted") {
			subject = theme.strikethrough(subject);
		}
		let line = `${glyph}`;
		if (showId) {
			line += ` ${theme.fg("accent", `#${t.id}`)}`;
		}
		line += ` ${subject}`;
		if (t.status === "in_progress" && t.activeForm) {
			line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
		}
		if (t.blockedBy && t.blockedBy.length > 0) {
			line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
		}
		return line;
	}

	dispose(): void {
		if (this.uiCtx) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
