/**
 * lane-dock — the always-mounted lane dock rendered BELOW the editor (FR4/FR7).
 *
 * Lifecycle controller for Pi's setWidget contract (placement: "belowEditor"),
 * mirroring TodoOverlay: register-once factory, requestRender() refresh,
 * height-stable single-line rows with a fixed budget + "+N more" collapse,
 * auto-hide when no runs are in-flight. Reads live state from the run-lane
 * registry at render time (never a stale snapshot).
 *
 * The dock has TWO states, both rendered from registry dock-state (getDockState):
 *   - ambient (inactive): a read-only run list — the discoverability footer
 *     advertises how to step in.
 *   - active (focused): the same list with a `▸` selection cursor on the selected
 *     row and a navigation footer. The dock is not itself focusable (widgets never
 *     receive input); LaneDockEditor proxies arrow/enter/tab keys from the editor
 *     into the registry's dock selection, and this widget renders the result.
 */

import type { ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	getDockState,
	type LaneEntry,
	type LaneProgress,
	type LaneStatus,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	setDockActive,
	shortRunId,
} from "./run-lane-registry.js";

const WIDGET_KEY = "rpiv-lanes";
/** Content-row budget (heading + lane rows). The footer + trailing spacer render below it. */
const MAX_WIDGET_LINES = 12;
/** Default discoverability footer — surfaces how to switch in. The switcher overrides
 *  it via setFooterText with the ACTUAL resolved hotkey glyph (Phase E); this fallback
 *  (no hotkey prefix) is used in tests / before the switcher wires the binding. */
const DEFAULT_FOOTER_TEXT = "/lanes — step into runs";
/** Footer shown while the dock is active (the user has stepped in) — the navigation
 *  contract: arrows move, ⏎ opens the selected run, esc/↑-at-top return to the input. */
const ACTIVE_FOOTER_TEXT = "↑/↓ move · ⏎ open · x stop · esc input";
/** Selection-gutter cells prepended to every row while the dock is active (so all rows
 *  shift equally — column stability holds within the active state). */
const CURSOR_SELECTED = "▸ ";
const CURSOR_UNSELECTED = "  ";
/** Heartbeat cadence (Phase C) — refresh the aging "needs input · 4m" heading even when
 *  no lane is streaming (the spinner timer is then idle). Minute-granularity needs only
 *  a slow tick; `.unref()` so it never keeps the process alive. */
const NEEDS_INPUT_TICK_MS = 10_000;

/** Compact relative age (Phase C): "30s" · "4m" · "2h". */
function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** Mini stage-progress bar (Phase 8): filled/empty cells, capped + scaled for big workflows. */
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_MAX_CELLS = 7;
/** Retry glyph (onStageRetry); running uses the spinner, error the failed glyph. */
const RETRY_GLYPH = "⟲";

// ---------------------------------------------------------------------------
// Fixed-width columns (FR7 — column stability). Each leading field is truncated
// or right-padded to a constant DISPLAY width so the bar / status region starts
// at the same column on every row, regardless of name or short-id length.
// ---------------------------------------------------------------------------
/** Display width of the lane-name column (longer names truncate with …). */
const NAME_COL = 12;
/** Display width of the short-run-id column (the distinguishing hex tail). */
const ID_COL = 6;
/** Display width of the `N/total` stage-counter column (fits up to "99/99"). */
const NUM_COL = 5;

/**
 * Truncate `text` to `width` display columns (… on overflow) then right-pad with
 * plain spaces to EXACTLY `width`, returning the content colored + the pad bare.
 * Operates on raw (uncolored) text so visibleWidth is exact; the trailing pad is
 * uncolored (invisible) so columns align across rows without per-cell theming.
 */
function padCol(theme: Theme, color: ThemeColor, text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	const gap = Math.max(0, width - visibleWidth(truncated));
	return theme.fg(color, truncated) + " ".repeat(gap);
}

/** Per-status glyph; needs-input overrides it (see renderRow). */
const STATUS_GLYPH: Record<LaneStatus, string> = {
	running: "▶",
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};
const NEEDS_INPUT_GLYPH = "⚑";

/** Spinner frames for running lanes — rpiv-warp's ambient-activity indicator
 *  (title-spinner.ts SPINNER_FRAMES): a 4-frame braille rotation, deliberately
 *  slower than a typical CLI spinner so it reads as calm background activity, which
 *  suits an ambient lane overlay. Colored "accent". */
const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const;
/** Spinner repaint cadence while ≥1 lane is running (matches rpiv-warp's 160ms). */
const SPIN_INTERVAL_MS = 160;

export class LaneDock {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	/** Animation frame, advanced by the spin timer; read at render time. */
	private frame = 0;
	/** Repaint timer — alive ONLY while a lane is running (see syncSpinner). */
	private spinTimer: ReturnType<typeof setInterval> | undefined;
	/** Heartbeat timer (Phase C) — alive ONLY while a lane needs input, to age the heading. */
	private needsInputTimer: ReturnType<typeof setInterval> | undefined;
	/** Footer hint text — set by the switcher with the resolved hotkey glyph (Phase E). */
	private footerText = DEFAULT_FOOTER_TEXT;

	/** Set the discoverability footer (Phase E) — the switcher passes the resolved
	 *  hotkey hint so the overlay never advertises a key that isn't bound. */
	setFooterText(text: string): void {
		this.footerText = text;
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
		const lanes = listLanes();
		this.syncSpinner(lanes); // start/stop the repaint timer with running-lane presence
		this.syncHeartbeat(lanes); // start/stop the aging heartbeat with needs-input presence
		if (lanes.length === 0) {
			// No lanes → the dock hides; there is nothing to navigate, so drop any
			// stale navigation focus too (e.g. the last lane was evicted while the
			// user was stepped in). setDockActive(false) is a no-op when already
			// inactive, so this never recurses past one shallow notify.
			setDockActive(false);
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
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	/** Drive a repaint timer ONLY while ≥1 lane is running — a finished/idle set
	 *  spins no dead timer. `.unref()` so the spinner never keeps the process alive. */
	private syncSpinner(lanes: LaneEntry[]): void {
		const anyRunning = lanes.some((l) => l.status === "running");
		if (anyRunning && !this.spinTimer) {
			this.spinTimer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.tui?.requestRender();
			}, SPIN_INTERVAL_MS);
			this.spinTimer.unref?.();
		} else if (!anyRunning && this.spinTimer) {
			clearInterval(this.spinTimer);
			this.spinTimer = undefined;
		}
	}

	/** Drive a slow repaint heartbeat (Phase C) ONLY while ≥1 lane needs input — so a
	 *  stalled run's "needs input · Nm" heading ages visibly even when nothing streams.
	 *  Independent of the spinner timer (which stops when no lane is running). */
	private syncHeartbeat(lanes: LaneEntry[]): void {
		const anyNeedsInput = lanes.some((l) => l.pendingInput.length > 0);
		if (anyNeedsInput && !this.needsInputTimer) {
			this.needsInputTimer = setInterval(() => this.tui?.requestRender(), NEEDS_INPUT_TICK_MS);
			this.needsInputTimer.unref?.();
		} else if (!anyNeedsInput && this.needsInputTimer) {
			clearInterval(this.needsInputTimer);
			this.needsInputTimer = undefined;
		}
	}

	private renderWidget(theme: Theme, width: number): string[] {
		// Phase B — display order is a stable priority sort (needs-input → running →
		// terminal), so the lane that needs the user never hides below the `+N more` fold.
		const lanes = listLanesForDisplay();
		if (lanes.length === 0) return [];
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		// Dock navigation state — drives the `▸` selection cursor and the footer hint.
		// Selection indexes this same listLanesForDisplay() order (clamped on read).
		const { active, selection } = getDockState();

		const needsInputLanes = lanes.filter((l) => laneNeedsInput(l.runId));
		const anyNeedsInput = needsInputLanes.length > 0;
		const activeCount = lanes.filter((l) => l.status === "running").length;
		// needs-input is the loudest state (warning); running is accent; an all-terminal
		// retained set is dim. Mirrors TodoOverlay's active/idle root convention.
		const headColor = anyNeedsInput ? "warning" : activeCount > 0 ? "accent" : "dim";
		// ● needs-input · spinner while running · ○ when only terminal lanes remain.
		const headIcon = anyNeedsInput ? "●" : activeCount > 0 ? SPINNER_FRAMES[this.frame] : "○";
		// Phase C — when a run is blocked on input, the heading SHOUTS it and ages: the
		// oldest pending question drives "N run(s) need input · 4m". Otherwise show the
		// active count (terminal lanes are retained — Phase A — so total ≠ active).
		let headText: string;
		if (anyNeedsInput) {
			const now = Date.now();
			const oldest = needsInputLanes.reduce((min, l) => Math.min(min, l.needsInputSince ?? now), now);
			const verb = needsInputLanes.length === 1 ? "run needs" : "runs need";
			headText = `${needsInputLanes.length} ${verb} input · ${formatAge(now - oldest)}`;
		} else {
			headText = activeCount > 0 ? `Runs (${activeCount} active)` : `Runs (${lanes.length})`;
		}
		const heading = truncate(`${theme.fg(headColor, headIcon)} ${theme.fg(headColor, headText)}`);

		const lines: string[] = [heading];
		const budget = MAX_WIDGET_LINES - 1; // rows available after the heading

		// While active, a leading selection gutter is prepended to every row — pass the
		// per-row selected flag down so the cursor lands on the dock's selected index.
		const sel = (i: number): boolean => active && i === selection;
		if (lanes.length <= budget) {
			lanes.forEach((lane, i) => {
				lines.push(truncate(this.renderRow(theme, lane, i === lanes.length - 1, width, active, sel(i))));
			});
		} else {
			// Reserve the last row for the "+N more" summary.
			const shown = lanes.slice(0, budget - 1);
			shown.forEach((lane, i) => {
				lines.push(truncate(this.renderRow(theme, lane, false, width, active, sel(i))));
			});
			const moreCount = lanes.length - shown.length;
			const gutter = active ? CURSOR_UNSELECTED : "";
			lines.push(truncate(`${gutter}${theme.fg("dim", "└─")} ${theme.fg("dim", `+${moreCount} more`)}`));
		}
		// Footer — mirrors the ask_user_question footer layout (tab-content-strategy.ts:
		// 139-144): a blank separator line, then the dim hint indented one space. Active
		// shows the navigation contract; ambient shows the discoverability hint.
		lines.push("");
		lines.push(truncate(` ${theme.fg("dim", active ? ACTIVE_FOOTER_TEXT : this.footerText)}`));
		return lines;
	}

	private renderRow(
		theme: Theme,
		lane: LaneEntry,
		isLast: boolean,
		width: number,
		active: boolean,
		selected: boolean,
	): string {
		// Active-state selection gutter: `▸ ` (accent) on the selected row, two spaces
		// otherwise. Prepended before the tree branch so every active row shifts equally.
		const gutter = active ? (selected ? theme.fg("accent", CURSOR_SELECTED) : CURSOR_UNSELECTED) : "";
		const branch = isLast ? "└─" : "├─";
		const needs = laneNeedsInput(lane.runId);
		const progress = lane.progress;
		const running = lane.status === "running";

		// Glyph + color: needs-input wins, then retry (⟲) / error (✗) phases, then the
		// running spinner, then the static terminal glyph.
		let glyph: string;
		let glyphColor: ThemeColor;
		if (needs) {
			glyph = NEEDS_INPUT_GLYPH;
			glyphColor = "warning";
		} else if (progress?.phase === "retry") {
			glyph = RETRY_GLYPH;
			glyphColor = "warning";
		} else if (progress?.phase === "error") {
			glyph = STATUS_GLYPH.failed;
			glyphColor = "warning";
		} else if (running) {
			glyph = SPINNER_FRAMES[this.frame];
			glyphColor = "accent";
		} else {
			glyph = STATUS_GLYPH[lane.status];
			glyphColor = "dim";
		}

		// Fixed-width leading columns: glyph · name · short-id. These align on every
		// row so the status region (bar / label) always starts at the same column.
		// The preset name renders in the normal "text" color; the short-id is dim
		// metadata — mirrors TodoOverlay (subject "text", metadata "dim", format.ts).
		const head = `${gutter}${theme.fg("dim", branch)} ${theme.fg(glyphColor, glyph)} `;
		const prefix =
			`${head}${padCol(theme, "text", lane.name, NAME_COL)} ` +
			`${padCol(theme, "dim", shortRunId(lane.runId), ID_COL)} `;

		// needs-input ALWAYS wins the trailing label (overrides live progress, FR7).
		if (needs) return `${prefix}${theme.fg("warning", "needs input")}`;
		// Live stage progress (Phase 8): [bar] N/total stageName [· units x/y].
		if (progress) return this.renderProgressRow(theme, prefix, progress, width);
		// No progress yet: running animates "streaming…"; terminal shows its raw status.
		const label = running ? "streaming…" : lane.status;
		return `${prefix}${theme.fg("muted", label)}`;
	}

	/**
	 * Render a lane row carrying live stage progress. The mini-bar is dropped FIRST
	 * under width pressure (the `N/total stageName` label is the signal; the bar is
	 * decoration), measured pre-color via visibleWidth so the decision is ANSI-safe.
	 */
	private renderProgressRow(theme: Theme, prefix: string, progress: LaneProgress, width: number): string {
		// Mini-bar: ALWAYS BAR_MAX_CELLS cells wide (the filled portion is scaled to
		// progress) so the bar — and every column after it — aligns across rows
		// regardless of each workflow's stage count (a 5-stage and a 6-stage run must
		// not shift the N/total column by a cell).
		const cells = BAR_MAX_CELLS;
		const ratio = progress.totalStages > 0 ? progress.stageNumber / progress.totalStages : 0;
		const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
		const filledStr = BAR_FILLED.repeat(filled);
		const emptyStr = BAR_EMPTY.repeat(cells - filled);

		// N/total is its OWN fixed-width column so stage names align across rows.
		const numRaw = `${progress.stageNumber}/${progress.totalStages}`;
		let nameRaw = progress.stageName;
		if (progress.phase === "retry" && progress.attempt !== undefined) nameRaw += ` · retry ${progress.attempt}`;
		if (progress.units) nameRaw += ` · units ${progress.units.done}/${progress.units.total}`;

		const barRaw = filledStr + emptyStr;
		// Drop the bar first if the row (prefix + bar + num + name) would overflow.
		const includeBar = visibleWidth(prefix) + visibleWidth(`${barRaw}  ${numRaw}  ${nameRaw}`) <= width && cells > 0;

		const numCol = padCol(theme, "muted", numRaw, NUM_COL);
		const coloredName = theme.fg("muted", nameRaw);
		if (!includeBar) return `${prefix}${numCol} ${coloredName}`;
		const coloredBar = `${theme.fg("accent", filledStr)}${theme.fg("dim", emptyStr)}`;
		return `${prefix}${coloredBar}  ${numCol} ${coloredName}`;
	}

	dispose(): void {
		if (this.spinTimer) {
			clearInterval(this.spinTimer);
			this.spinTimer = undefined;
		}
		if (this.needsInputTimer) {
			clearInterval(this.needsInputTimer);
			this.needsInputTimer = undefined;
		}
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
