/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { t } from "./state/i18n-bridge.js";
import {
	KEEP_RECENT_COMPLETED,
	selectActivePartition,
	selectHasActive,
	selectOverlayLayout,
	selectOverlayTasks,
	selectShowTaskIds,
	selectTodoCounts,
} from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EARLIER = "… {count} earlier";
const OVERLAY_LATER = "… {count} later";
const OVERLAY_MORE_ACTIVE = "… {count} more active";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

/** Localized overflow marker with the {count} placeholder spliced (same pattern as overlay.expandHint's {key}). */
function formatOverflowMarker(
	key: "overlay.earlier" | "overlay.later" | "overlay.moreActive",
	fallback: string,
	count: number,
): string {
	return t(key, fallback).replace("{count}", String(count));
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private collapsed = false;

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
		const snapshot = getRenderState();
		const visible = selectOverlayTasks(snapshot, KEEP_RECENT_COMPLETED);

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

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh path in update().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = getRenderState();
		const overlayTasks = selectOverlayTasks(snapshot, KEEP_RECENT_COMPLETED);
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
		// trailing spacer. Short-circuit before the budget math. The hint splices
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
		// Budget for content rows (heading + tasks/markers). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const expanded = this.uiCtx?.getToolsExpanded?.() === true;
		const bodyBudget = expanded ? overlayTasks.length : getMaxWidgetLines() - 1;

		// Active strip: all in_progress rows render first so parallel work stays
		// visible instead of hiding behind the focus window's `… N later` marker.
		// A degenerate two-row body budget (maxWidgetLines=3) fits only one marker
		// row and cannot express the active strip PLUS the folded `+N more`
		// summary, so the strip is skipped there and the window runs over the whole
		// filtered list exactly like before. Expansion mode shows everything, so
		// the same strip renders naturally with room for all rows.
		const { active, rest } =
			expanded || bodyBudget <= 2 ? { active: [], rest: overlayTasks } : selectActivePartition(overlayTasks);

		// Active overflow: when the strip itself exceeds the budget, cap it at
		// B-2 rows and spend the last row on a `… N more active` marker — parallel
		// work still gets priority over the rest of the list, but never breaks
		// maxWidgetLines. No rest rows render in this mode.
		if (active.length > bodyBudget - 2) {
			for (const task of active.slice(0, bodyBudget - 2)) {
				lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
			}
			const hiddenActive = active.length - (bodyBudget - 2);
			const marker = formatOverflowMarker("overlay.moreActive", OVERLAY_MORE_ACTIVE, hiddenActive);
			lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", marker)}`));
			return this.withTrailingSpacer(lines);
		}

		for (const task of active) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		const restState = { tasks: rest, nextId: snapshot.nextId };
		const restBudget = expanded ? rest.length : bodyBudget - active.length;
		const layout = selectOverlayLayout(restState, restBudget);

		// Focus-window overflow: one marker row per hidden side. A degenerate
		// two-row REST budget fits only one marker row, so both hidden sides fold
		// into a single legacy `+N more` bottom summary instead of breaking the
		// row cap.
		const combinedOnly = layout.hiddenBefore > 0 && layout.hiddenAfter > 0 && restBudget < 3;
		const hiddenBefore = combinedOnly ? 0 : layout.hiddenBefore;
		const hiddenAfter = combinedOnly ? layout.hiddenBefore + layout.hiddenAfter : layout.hiddenAfter;

		if (hiddenBefore > 0) {
			const marker = formatOverflowMarker("overlay.earlier", OVERLAY_EARLIER, hiddenBefore);
			lines.push(truncate(`${theme.fg("dim", "├─")} ${theme.fg("dim", marker)}`));
		}
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		if (hiddenAfter === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const summary = combinedOnly
			? `+${hiddenAfter} ${t("overlay.more", OVERLAY_MORE)}`
			: formatOverflowMarker("overlay.later", OVERLAY_LATER, hiddenAfter);
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
	}
}
