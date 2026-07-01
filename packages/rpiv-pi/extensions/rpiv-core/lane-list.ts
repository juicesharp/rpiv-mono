/**
 * lane-list — the shared, rich lane-list renderer used by BOTH surfaces so a lane row is
 * byte-for-byte identical whether it appears in the ambient dock (lane-dock) or in the
 * stepped-in browser's bottom-pinned lane block (lane-console). Keeping ONE renderer is
 * what makes the lane view provably static across the ambient↔selected transition: the only
 * per-surface differences are the `❯` selection cursor (already reserved in the gutter) and
 * the footer, which each surface owns.
 *
 * Everything here is a pure function of `(theme, width, registry snapshot)` plus an injected
 * spinner `frame` (each surface drives its own repaint timer). The registry is read live at
 * render time — never a stale snapshot.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { shortFailureReason } from "./lane-failure.js";
import { formatTokens, type LaneUsage } from "./lane-usage.js";
import {
	type DisplayRow,
	type LaneEntry,
	type LaneProgress,
	type LaneStatus,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	type UnitLane,
	unitNeedsInput,
	unitUsage,
} from "./run-lane-registry.js";

/** Per-row CAP on the lane region (the scroll-follow window + its +N above/below summaries).
 *  computeLaneLayout bounds laneCap at MAX_WIDGET_LINES - 1, so the list never grows unbounded. */
export const MAX_WIDGET_LINES = 12;
/** Compact CEILING on the dock's TOTAL height — clamps totalRows to min(MAX_DOCK_ROWS,
 *  terminal.rows). With the lane region capped at MAX_WIDGET_LINES the list is content-sized. */
export const MAX_DOCK_ROWS = 40;
/** terminal.rows fallback when the TUI hasn't reported a size (pre-mount / headless host). */
export const FALLBACK_ROWS = 24;
/** Heartbeat cadence — refresh the aging "needs input · 4m" heading even when no lane is
 *  streaming (the spinner timer is then idle). Minute-granularity needs only a slow tick. */
export const NEEDS_INPUT_TICK_MS = 10_000;
/** Spinner frames for running lanes — rpiv-warp's ambient-activity indicator: a 4-frame
 *  braille rotation, deliberately slower than a typical CLI spinner so it reads as calm
 *  background activity. Colored "accent". */
export const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const;
/** Spinner repaint cadence while ≥1 lane is running (matches rpiv-warp's 160ms). */
export const SPIN_INTERVAL_MS = 160;

/** Selection-gutter cells reserved on every row (so a row never shifts when stepping in):
 *  the `❯` cursor (matching pi's selectors) on the active selection, two spaces otherwise. */
const CURSOR_SELECTED = "❯ ";
const CURSOR_UNSELECTED = "  ";

/** Mini stage-progress bar: filled/empty cells, capped + scaled for big workflows. */
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_MAX_CELLS = 7;
/** Minimum leftover display columns to bother showing a failure-reason chip. */
const MIN_REASON_WIDTH = 6;
/** Lap marker (`↻7`) for the path ordinal — shown ONLY once the walk has re-entered a stage
 *  (`stageNumber > visited`) so an acyclic run stays a clean `3/4` with no marker. */
const LAP_MARK = "↻";
/** Retry glyph (onStageRetry); running uses the spinner, error the failed glyph. */
const RETRY_GLYPH = "⟲";

// Fixed-width columns (column stability): each leading field is truncated or right-padded to a
// constant DISPLAY width so the bar / status region starts at the same column on every row.
const TAG_COL = 12;
const MAX_LABEL_WIDTH = 40;
const LABEL_LEADING = 4 + TAG_COL + 2;
const PROGRESS_MIN_WIDTH = 12;
const NUM_COL = 5;

/** Per-status glyph; needs-input overrides it (see renderLaneRow). */
const STATUS_GLYPH: Record<LaneStatus, string> = {
	running: "▶",
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};
const NEEDS_INPUT_GLYPH = "⚑";
/** Glyph for a fan-out unit seeded PENDING before its onUnitStart fires. */
const PENDING_UNIT_GLYPH = "○";

/** Compact relative age: "30s" · "4m" · "2h". */
function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/**
 * Truncate `text` to `width` display columns (… on overflow) then right-pad with plain spaces
 * to EXACTLY `width`, returning the content colored + the pad bare. `bold` emphasises the
 * content (not the pad) — the selected row's name, mirroring ask_user_question's selectedText.
 */
function padCol(theme: Theme, color: ThemeColor, text: string, width: number, bold = false): string {
	const truncated = truncateToWidth(text, width, "…");
	const gap = Math.max(0, width - visibleWidth(truncated));
	const content = bold ? theme.bold(truncated) : truncated;
	return theme.fg(color, content) + " ".repeat(gap);
}

/** The dock descriptor for a lane — the run's `--name` alias when it differs from the workflow,
 *  else the `runId` (always defined, so every row carries the `workflow:` tag + a descriptor). */
function laneDescriptor(lane: LaneEntry): string {
	const workflow = lane.workflow ?? lane.name;
	const alias = lane.name !== workflow ? lane.name : undefined;
	return alias ?? lane.runId;
}

/** Compact token tally `↑{in} ↓{out} R{cacheRead}`, each segment omitted when 0 and the whole
 *  tally omitted (→ "") when usage is undefined or all three are zero. */
function formatUsageTally(usage: LaneUsage | undefined): string {
	if (!usage) return "";
	const segments: string[] = [];
	if (usage.input > 0) segments.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) segments.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) segments.push(`R${formatTokens(usage.cacheRead)}`);
	return segments.join(" ");
}

/** Run-level token aggregate over a lane's units — sums the four token dimensions across every
 *  unit's EFFECTIVE usage (teardown snapshot else live child), recomputes total, accumulates
 *  scalar cost, omits percent. Returns undefined when NO unit carries usage. */
function sumLaneUsage(units: Iterable<UnitLane>): LaneUsage | undefined {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let hasCost = false;
	let any = false;
	for (const unit of units) {
		const u = unitUsage(unit);
		if (!u) continue;
		any = true;
		input += u.input;
		output += u.output;
		cacheRead += u.cacheRead;
		cacheWrite += u.cacheWrite;
		if (u.cost !== undefined) {
			cost += u.cost;
			hasCost = true;
		}
	}
	if (!any) return undefined;
	const result: LaneUsage = { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
	if (hasCost) result.cost = cost;
	return result;
}

/** The compact CAP + lane-region budget, computed from the terminal size. `totalRows` is
 *  min(MAX_DOCK_ROWS, terminal.rows); `laneCap` is the lane region, bounded by MAX_WIDGET_LINES
 *  - 1 so the list never grows unbounded. Both surfaces size the lane block with the SAME
 *  laneCap so the rows are identical (the console spends its extra height on live output, not
 *  on a taller lane list). */
export function computeLaneLayout(termRows: number): { totalRows: number; laneCap: number } {
	const overhead = 3 /*top: blank + heading + blank*/ + 3 /*bottom: blank + footer + rule*/;
	const totalRows = Math.min(MAX_DOCK_ROWS, termRows);
	const contentBody = Math.max(0, totalRows - overhead);
	const laneCap = Math.min(MAX_WIDGET_LINES - 1, Math.max(1, contentBody));
	return { totalRows, laneCap };
}

/** Group-aware scroll-follow viewport over the flattened display rows. Returns the visible
 *  slice [start, start+window) plus whether rows fold behind a `+N above` / `+N below` summary
 *  (both live INSIDE laneCap, so the region height is constant whether or not scrolled). The
 *  selection is always inside the window; it opens at a lane boundary and folds whole lane+unit
 *  groups atomically. */
export function computeViewport(
	rows: DisplayRow[],
	selection: number,
	laneCap: number,
): { start: number; window: number; above: number; below: number } {
	const n = rows.length;
	if (n <= laneCap) return { start: 0, window: n, above: 0, below: 0 };
	const reserve = Math.min(2, laneCap - 1);
	const window = Math.max(1, laneCap - reserve);
	let start = selection - Math.floor(window / 2);
	if (start < 0) start = 0;
	const maxStart = n - window;
	if (start > maxStart) start = maxStart;
	const floor = Math.max(0, selection - window + 1);
	while (start > floor && rows[start].kind === "unit") start--;
	let end = start + window;
	if (end < n && rows[end].kind === "unit") {
		let lane = end;
		while (lane > start && rows[lane].kind === "unit") lane--;
		if (lane > start && lane > selection) end = lane;
	}
	return { start, window: end - start, above: start > 0 ? 1 : 0, below: end < n ? 1 : 0 };
}

/**
 * Render an indented unit SUB-ROW (a fan-out unit). Mirrors renderLaneRow's gutter + glyph
 * priority (needs-input → running spinner → terminal glyph) keyed on the UNIT's own state, and
 * shows its label + a compact status word — no stage bar (that belongs to the parent lane row).
 */
function renderUnitRow(
	theme: Theme,
	lane: LaneEntry,
	unit: UnitLane,
	labelWidth: number,
	selected: boolean,
	frame: number,
): string {
	const gutter = selected ? theme.fg("accent", theme.bold(CURSOR_SELECTED)) : CURSOR_UNSELECTED;
	const needs = unitNeedsInput(lane.runId, unit.index);
	let glyph: string;
	let glyphColor: ThemeColor;
	if (needs) {
		glyph = NEEDS_INPUT_GLYPH;
		glyphColor = "warning";
	} else if (unit.status === "running") {
		glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		glyphColor = "accent";
	} else if (unit.status === "pending") {
		glyph = PENDING_UNIT_GLYPH;
		glyphColor = "dim";
	} else if (unit.status === "failed") {
		glyph = STATUS_GLYPH.failed;
		glyphColor = "warning";
	} else {
		glyph = STATUS_GLYPH.completed; // "done" → ✓
		glyphColor = "dim";
	}
	const indent = "  ";
	const label = unit.label ?? `unit ${unit.index}`;
	const labelCell = labelWidth > 0 ? padCol(theme, selected ? "accent" : "text", label, labelWidth, selected) : label;
	const usageTally = formatUsageTally(unitUsage(unit));
	const tail = needs
		? theme.fg("warning", "needs input")
		: theme.fg("muted", unit.status === "running" ? "live" : unit.status) +
			(usageTally ? theme.fg("muted", ` · ${usageTally}`) : "");
	return `${gutter}${indent}${theme.fg(glyphColor, glyph)} ${labelCell} ${tail}`;
}

/**
 * Render a lane row carrying live stage progress. Width priority under pressure: the
 * `N/total stageName` label is always kept; the failure `reason` chip is kept next; the
 * mini-bar (decoration) is dropped FIRST — so a failed row shows its cause before its bar.
 */
function renderProgressRow(
	theme: Theme,
	prefix: string,
	progress: LaneProgress,
	width: number,
	reason?: string,
	usage?: LaneUsage,
): string {
	const cells = BAR_MAX_CELLS;
	const visited = progress.visited ?? Math.min(progress.stageNumber, progress.totalStages);
	const ratio = progress.totalStages > 0 ? visited / progress.totalStages : 0;
	const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
	const filledStr = BAR_FILLED.repeat(filled);
	const emptyStr = BAR_EMPTY.repeat(cells - filled);

	const numRaw = `${visited}/${progress.totalStages}`;
	let nameRaw = progress.stageName;
	if (progress.phase === "retry" && progress.attempt !== undefined) nameRaw += ` · retry ${progress.attempt}`;
	if (progress.stageNumber > visited) nameRaw += ` · ${LAP_MARK}${progress.stageNumber}`;
	if (progress.units) nameRaw += ` · units ${progress.units.done}/${progress.units.total}`;
	const usageTally = formatUsageTally(usage);
	if (usageTally) nameRaw += ` · ${usageTally}`;

	const numCol = padCol(theme, "muted", numRaw, NUM_COL);
	const coloredName = theme.fg("muted", nameRaw);
	const coreW = visibleWidth(prefix) + Math.max(NUM_COL, visibleWidth(numRaw)) + 1 + visibleWidth(nameRaw);

	let reasonStr = "";
	if (reason) {
		const leftover = width - coreW;
		if (leftover >= MIN_REASON_WIDTH) reasonStr = theme.fg("warning", truncateToWidth(` — ${reason}`, leftover, "…"));
	}
	const reasonW = visibleWidth(reasonStr);

	const includeBar = cells > 0 && coreW + reasonW + cells + 2 <= width;
	if (!includeBar) return `${prefix}${numCol} ${coloredName}${reasonStr}`;
	const coloredBar = `${theme.fg("accent", filledStr)}${theme.fg("dim", emptyStr)}`;
	return `${prefix}${coloredBar}  ${numCol} ${coloredName}${reasonStr}`;
}

/** Render a lane (parent) row: cursor-gutter · status-glyph · workflow-tag · descriptor ·
 *  [progress bar / status word]. needs-input wins the glyph + trailing label. */
function renderLaneRow(
	theme: Theme,
	lane: LaneEntry,
	width: number,
	labelWidth: number,
	selected: boolean,
	frame: number,
): string {
	const gutter = selected ? theme.fg("accent", theme.bold(CURSOR_SELECTED)) : CURSOR_UNSELECTED;
	const needs = laneNeedsInput(lane.runId);
	const progress = lane.progress;
	const running = lane.status === "running";

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
		glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		glyphColor = "accent";
	} else {
		glyph = STATUS_GLYPH[lane.status];
		glyphColor = "dim";
	}

	const head = `${gutter}${theme.fg(glyphColor, glyph)} `;
	const workflow = lane.workflow ?? lane.name;
	const descriptor = laneDescriptor(lane);
	const tagRaw = descriptor ? `${workflow}:` : workflow;
	const prefix =
		`${head}${padCol(theme, "muted", tagRaw, TAG_COL)} ` +
		(labelWidth > 0 ? `${padCol(theme, selected ? "accent" : "text", descriptor ?? "", labelWidth, selected)} ` : "");

	if (needs) return `${prefix}${theme.fg("warning", "needs input")}`;
	const reason = shortFailureReason(lane.error ?? (progress?.phase === "error" ? progress.reason : undefined));
	if (progress) return renderProgressRow(theme, prefix, progress, width, reason, sumLaneUsage(lane.units.values()));
	const label = running ? "streaming…" : lane.status;
	const tail = reason ? `${theme.fg("muted", label)}${theme.fg("warning", ` — ${reason}`)}` : theme.fg("muted", label);
	return `${prefix}${tail}`;
}

/** The title chip (`  ● [ N runs need input · 4m ]` / `  [ Runs (2 active) ]`) — identical on
 *  both surfaces. A STATIC ● (warning) flags needs-input urgency outside the selectedBg chip. */
function renderHeading(theme: Theme, width: number): string {
	const allLanes = listLanes();
	const needsInputLanes = allLanes.filter((l) => laneNeedsInput(l.runId));
	const anyNeedsInput = needsInputLanes.length > 0;
	const activeCount = allLanes.filter((l) => l.status === "running").length;
	let headText: string;
	if (anyNeedsInput) {
		const now = Date.now();
		const oldest = needsInputLanes.reduce((min, l) => Math.min(min, l.needsInputSince ?? now), now);
		const verb = needsInputLanes.length === 1 ? "run needs" : "runs need";
		headText = `${needsInputLanes.length} ${verb} input · ${formatAge(now - oldest)}`;
	} else {
		headText = activeCount > 0 ? `Runs (${activeCount} active)` : `Runs (${allLanes.length})`;
	}
	const titleIcon = anyNeedsInput ? `${theme.fg("warning", "●")} ` : "";
	return truncateToWidth(`  ${titleIcon}${theme.bg("selectedBg", ` ${headText} `)}`, width, "…");
}

/**
 * Render the shared lane block — `["", heading, "", ...viewport rows]` (NO footer / rule; each
 * surface frames those itself). The `❯` cursor is drawn only on `active && i === selection`, so
 * an ambient render (active=false) and a stepped-in render (active=true) produce IDENTICAL rows
 * apart from the gutter glyph — the invariant that keeps the lane view static across step-in.
 * `frame` is the caller's spinner tick; `laneCap` comes from computeLaneLayout.
 */
export function renderLaneList(
	theme: Theme,
	width: number,
	opts: { active: boolean; selection: number; frame: number; laneCap: number },
): string[] {
	const rows = listLanesForDisplay();
	if (rows.length === 0) return [];
	const { active, selection, frame, laneCap } = opts;
	const allLanes = listLanes();
	const truncate = (line: string): string => truncateToWidth(line, width, "…");
	const lines: string[] = ["", renderHeading(theme, width), ""];

	// Content-aware label-column width — the MAX descriptor / unit-label width among the visible
	// lanes, clamped to MAX_LABEL_WIDTH and the available row width, so the progress region stays
	// column-aligned and a unit label never truncates to the (short) runId descriptor.
	const labelWidth = Math.min(
		MAX_LABEL_WIDTH,
		allLanes.reduce((m, l) => {
			let w = Math.max(m, visibleWidth(laneDescriptor(l)));
			for (const u of l.units.values()) w = Math.max(w, visibleWidth(u.label ?? `unit ${u.index}`));
			return w;
		}, 0),
		Math.max(0, width - LABEL_LEADING - PROGRESS_MIN_WIDTH),
	);
	const sel = (i: number): boolean => active && i === selection;
	const renderAt = (row: DisplayRow, i: number): string =>
		truncate(
			row.kind === "lane"
				? renderLaneRow(theme, row.lane, width, labelWidth, sel(i), frame)
				: renderUnitRow(theme, row.lane, row.unit, labelWidth, sel(i), frame),
		);

	const vp = computeViewport(rows, selection, laneCap);
	if (vp.above) lines.push(truncate(`${CURSOR_UNSELECTED}${theme.fg("dim", `+${vp.start} above`)}`));
	for (let i = vp.start; i < vp.start + vp.window; i++) lines.push(renderAt(rows[i], i));
	if (vp.below) {
		const hidden = rows.length - (vp.start + vp.window);
		lines.push(truncate(`${CURSOR_UNSELECTED}${theme.fg("dim", `+${hidden} below`)}`));
	}
	return lines;
}

/** The `── live output ` labelled top border of the console's live-output region — the leading
 *  label distinguishes it by CONTENT from the lane block's bottom rule. Fail-soft: degrades to a
 *  truncated label when `width` is narrower than the label itself. */
export function renderLiveOutputBorder(theme: Theme, width: number): string {
	const label = "── live output ";
	const remaining = width - visibleWidth(label);
	if (remaining >= 0) return theme.fg("dim", label + "─".repeat(remaining));
	return theme.fg("dim", truncateToWidth(label, Math.max(0, width)));
}
