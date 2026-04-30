/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, 12-line collapse-not-scroll, auto-hide when empty.
 *
 * Reads live state via `getTodos()` at render time — NEVER `replayFromBranch`
 * from `tool_execution_end` (branch is stale; `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import {
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
	selectVisibleTasks,
} from "./state/selectors.js";
import { getTodos } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";
const MAX_WIDGET_LINES = 12;

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;

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
		const snapshot = { tasks: [...getTodos()], nextId: 0 };
		const visible = selectVisibleTasks(snapshot);

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
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
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

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = { tasks: [...getTodos()], nextId: 0 };
		const all = selectVisibleTasks(snapshot);
		if (all.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(snapshot);
		const hasActive = selectHasActive(snapshot);
		const showIds = selectShowTaskIds(snapshot);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `Todos (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		const lines: string[] = [heading];
		const layout = selectOverlayLayout(snapshot, MAX_WIDGET_LINES - 1);
		for (const t of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(t, theme, showIds)}`));
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} completed`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} pending`);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} more (${overflowParts.join(", ")})` : `+${totalHidden} more`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
