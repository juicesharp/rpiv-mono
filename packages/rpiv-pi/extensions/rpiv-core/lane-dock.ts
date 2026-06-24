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
import { shortFailureReason } from "./lane-failure.js";
import { type RenderSource, renderBranch, type ToolDefArg, type ViewerEntry } from "./lane-transcript.js";
import { type DiskBranch, loadBranchFromDisk } from "./lane-transcript-disk.js";
import {
	getDockState,
	type LaneEntry,
	type LaneProgress,
	type LaneSession,
	type LaneStatus,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	setDockActive,
} from "./run-lane-registry.js";

const WIDGET_KEY = "rpiv-lanes";
/** Content-row budget (heading + lane rows). The footer + trailing spacer render below it. */
const MAX_WIDGET_LINES = 12;
/** Ambient discoverability footer — surfaces how to step in with the two self-explanatory
 *  gestures only: ↓ from an empty prompt, or the always-available /lanes command. The `^Q`
 *  hotkey still steps in (lane-switcher) but is intentionally NOT advertised here — its glyph
 *  is the least legible of the three and Ctrl+Q reads as "quit" elsewhere, so the footer keeps
 *  to the two hints that explain themselves. */
const DEFAULT_FOOTER_TEXT = "↓ step in · /lanes";
/** Footer shown while the dock is active (the user has stepped in). ⏎ and → are
 *  DEDICATED keys (answer / transcript) that never swap meaning; the footer only hides
 *  the ⏎ hint on a lane with nothing to answer, where ⏎ is inert. Back wording is
 *  unified with the viewer: ←/esc back. */
const ACTIVE_FOOTER_NEEDS_INPUT = "⏎ answer · → transcript · ↑/↓ navigate · x stop · ←/esc back";
const ACTIVE_FOOTER_DEFAULT = "→ transcript · ↑/↓ navigate · x stop · ←/esc back";
/** Active-only preview height cap — the dock shows at most this many lines of the
 *  selected lane's transcript tail. Self-bounded: MAX_WIDGET_LINES governs only the lane
 *  rows, not the preview, so the preview must cap its own footprint. */
const PREVIEW_LINES = 6;
/** Selection-gutter cells reserved on every row (so a row never shifts when stepping in):
 *  the `❯` cursor (matching pi's selectors) on the active selection, two spaces otherwise. */
const CURSOR_SELECTED = "❯ ";
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
/** Minimum leftover display columns to bother showing a failure-reason chip (Problem 1).
 *  Below this the chip would be all separator + ellipsis, so it is dropped entirely. */
const MIN_REASON_WIDTH = 6;
/**
 * Lap marker (`↻7`) for the path ordinal. `stageNumber` counts every activation
 * incl. loop-backs, so it can exceed the distinct-stage fraction; shown ONLY when
 * the walk has actually re-entered a stage (`stageNumber > visited`) so an acyclic
 * run stays a clean `3/4` with no marker. Distinct from `RETRY_GLYPH` (same stage,
 * retried) — this is the loop/re-entry counter.
 */
const LAP_MARK = "↻";
/** Retry glyph (onStageRetry); running uses the spinner, error the failed glyph. */
const RETRY_GLYPH = "⟲";

// ---------------------------------------------------------------------------
// Fixed-width columns (FR7 — column stability). Each leading field is truncated
// or right-padded to a constant DISPLAY width so the bar / status region starts
// at the same column on every row, regardless of workflow name or descriptor.
// ---------------------------------------------------------------------------
/** Display width of the workflow-tag column (the dim `ship:` prefix). Workflow names
 *  are short slugs; longer names truncate with … so the tag never exceeds this width
 *  and the descriptor column always starts at the same offset. */
const TAG_COL = 12;
/** Cap on the descriptor-label width. The label = --name alias OR truncated user prompt.
 *  Its ACTUAL width is content-aware (the max descriptor among the visible lanes), so the
 *  progress region stays column-aligned AND a no-descriptor lane keeps the old narrow
 *  prefix (no dead label column squeezing the failure-reason chip under width pressure). */
const MAX_LABEL_WIDTH = 40;
/** Leading fixed cells before the label cell: head (gutter 2 + glyph 1 + space 1) + tag
 *  (TAG_COL) + 2 separators. Used to bound the label width by available row width. */
const LABEL_LEADING = 4 + TAG_COL + 2;
/** Minimum progress footprint (N/total + 1 + a short stage name) reserved so a long
 *  descriptor never eats the entire row — the descriptor is the signal, but stage
 *  progress must survive. */
const PROGRESS_MIN_WIDTH = 12;
/** Display width of the `N/total` stage-counter column (fits up to "99/99"). */
const NUM_COL = 5;

/**
 * Truncate `text` to `width` display columns (… on overflow) then right-pad with
 * plain spaces to EXACTLY `width`, returning the content colored + the pad bare.
 * Operates on raw (uncolored) text so visibleWidth is exact; the trailing pad is
 * uncolored (invisible) so columns align across rows without per-cell theming.
 * `bold` applies emphasis to the content (not the pad) — used for the selected row's
 * name, mirroring ask_user_question's accent+bold `selectedText`.
 */
function padCol(theme: Theme, color: ThemeColor, text: string, width: number, bold = false): string {
	const truncated = truncateToWidth(text, width, "…");
	const gap = Math.max(0, width - visibleWidth(truncated));
	const content = bold ? theme.bold(truncated) : truncated;
	return theme.fg(color, content) + " ".repeat(gap);
}

/**
 * The dock descriptor for a lane — the run's `--name` alias (when it differs from the
 * workflow), else the user prompt (whitespace-collapsed so a multi-line input never
 * breaks the single-line row), else undefined (a bare-workflow row). Shared by
 * `renderWidget` (the content-aware label-width computation) AND `renderRow` (the
 * render) so the two never drift. A `--name` that happens to equal the workflow name
 * degrades gracefully — no alias, so the label falls through to the prompt (or bare tag).
 */
function laneDescriptor(lane: LaneEntry): string | undefined {
	const workflow = lane.workflow ?? lane.name;
	const alias = lane.name !== workflow ? lane.name : undefined;
	const prompt = lane.input ? lane.input.replace(/\s+/g, " ").trim() : undefined;
	return alias ?? (prompt || undefined);
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
	/** The selected lane's live child session the preview follows. Identity-
	 *  guarded so an unrelated registry notify never stacks a second subscription (a leak). */
	private previewSession: LaneSession | undefined;
	private previewUnsub: (() => void) | undefined;
	/** Disk-jsonl preview fallback (Problem 2) parsed ONCE and cached by file key — the
	 *  preview re-renders on every spinner tick, so the disk read must not repeat per frame. */
	private previewDiskCache: { key: string; value: DiskBranch | undefined } | undefined;

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
		this.syncPreviewSubscription(); // follow the SELECTED lane's live session
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

	/**
	 * Follow the SELECTED lane's live child session while the dock is active so the preview
	 * repaints on every streaming tick — mirrors the viewer's identity-guarded
	 * subscription (lane-viewer.ts). The guard is essential: without it every unrelated
	 * registry notify (setLaneProgress/setLaneStatus) would stack a NEW
	 * currentSession.subscribe and leak listeners. One guard covers all transitions: arrow
	 * to another lane, the selected lane advances a stage (currentSession swaps), or it
	 * retires (→ undefined, the preview falls back to finalBranch). No-op while ambient
	 * (no selection) — the preview is active-only.
	 */
	private syncPreviewSubscription(): void {
		const { active, selection } = getDockState();
		const selLane = active ? listLanesForDisplay()[selection] : undefined;
		const next = selLane?.currentSession;
		if (next === this.previewSession) return;
		this.previewUnsub?.();
		this.previewSession = next;
		// `this.tui?` is read LAZILY at fire time, not captured: update() (and thus this
		// subscribe) can run before the widget factory assigns this.tui (e.g. the first
		// update() during mount, ahead of the factory). The optional-chain no-ops until the
		// widget mounts, then repaints normally — so DON'T hoist this.tui into a local here.
		this.previewUnsub = next?.subscribe(() => this.tui?.requestRender());
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
		// Phase C — when a run is blocked on input, the title SHOUTS it and ages: the
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
		// Title is rendered as a CHIP, exactly like ask_user_question's question HEADER
		// badge (tab-content-strategy.ts): a selectedBg block with one space of padding on
		// each side — no spinner/progress (that lives on the rows). A STATIC ● (warning)
		// flags needs-input urgency outside the chip. The chip is NOT truncated to a tight
		// character budget: the whole dock width is available before it clips.
		const titleIcon = anyNeedsInput ? `${theme.fg("warning", "●")} ` : "";
		const heading = truncate(`  ${titleIcon}${theme.bg("selectedBg", ` ${headText} `)}`);

		// A bottom rule separates the dock from Pi's status chrome below. Accent while
		// focused, dim otherwise. The TOP boundary depends on focus: ambient leaves a
		// blank because the editor's own border above is the boundary; ACTIVE hides that
		// editor (LaneDockEditor suppresses its render while stepped in), so the dock
		// draws its own top rule to stay framed as a panel.
		const rule = theme.fg(active ? "accent" : "dim", "─".repeat(Math.max(0, width)));
		// ask_user_question vertical rhythm. Ambient: a breathing-room blank (the editor
		// border above is the boundary), the title, a blank, then the rows. ACTIVE: the
		// editor is hidden, so lead with a blank, the top rule, a blank, THEN the title —
		// (blank · HR · blank · title) keeps the rule off the chrome above and gives the
		// title room to breathe under the rule.
		const lines: string[] = active ? ["", rule, "", heading, ""] : ["", heading, ""];
		const budget = MAX_WIDGET_LINES - 1; // rows available after the heading

		// The 2-col selection gutter is ALWAYS reserved (see renderRow) so stepping in
		// only swaps spaces for the `❯` cursor — no row ever shifts. sel(i) marks the
		// active selection (only true while active).
		const sel = (i: number): boolean => active && i === selection;
		// Content-aware descriptor-label width — the MAX descriptor width among the visible
		// lanes (clamped to MAX_LABEL_WIDTH and the available row width), so the progress
		// region (bar / N-total) stays column-aligned (FR7) AND a render with no descriptors
		// keeps the old narrow prefix (labelWidth 0 → no label cell). Constant across rows.
		const labelWidth = Math.min(
			MAX_LABEL_WIDTH,
			lanes.reduce((m, l) => Math.max(m, visibleWidth(laneDescriptor(l) ?? "")), 0),
			Math.max(0, width - LABEL_LEADING - PROGRESS_MIN_WIDTH),
		);
		const row = (lane: LaneEntry, i: number): string =>
			truncate(this.renderRow(theme, lane, width, labelWidth, sel(i)));
		if (lanes.length <= budget) {
			lanes.forEach((lane, i) => {
				lines.push(row(lane, i));
			});
		} else {
			// Reserve the last row for the "+N more" summary.
			const shown = lanes.slice(0, budget - 1);
			shown.forEach((lane, i) => {
				lines.push(row(lane, i));
			});
			const moreCount = lanes.length - shown.length;
			// Same reserved gutter so the summary aligns with the lane rows above.
			lines.push(truncate(`${CURSOR_UNSELECTED}${theme.fg("dim", `+${moreCount} more`)}`));
		}
		// Active-only transcript-tail preview of the SELECTED lane: a dim separator
		// rule then the last PREVIEW_LINES of its transcript, between the rows / "+N more" fold
		// and the footer. Active-gated so ambient stays byte-for-byte stable.
		// NB: this is the SAME `selLane` the footer below reads — declared once here, replacing
		// the old standalone footer-block declaration. Do not re-declare it.
		const selLane = active ? lanes[selection] : undefined;
		if (active && selLane) {
			for (const line of this.renderPreview(theme, selLane, width)) lines.push(truncate(line));
		}
		// Footer hint (dim), indented one space — active shows the navigation contract,
		// ambient the discoverability hint. Preceded by a blank line (rhythm) and followed
		// by the bottom rule (the separator from Pi's status chrome below).
		lines.push("");
		const activeFooter = selLane && laneNeedsInput(selLane.runId) ? ACTIVE_FOOTER_NEEDS_INPUT : ACTIVE_FOOTER_DEFAULT;
		lines.push(truncate(` ${theme.fg("dim", active ? activeFooter : DEFAULT_FOOTER_TEXT)}`));
		lines.push(rule);
		return lines;
	}

	private renderRow(theme: Theme, lane: LaneEntry, width: number, labelWidth: number, selected: boolean): string {
		// Selection styling mirrors ask_user_question (WrappingSelect): the selected row
		// is marked by the `❯ ` pointer plus an accent+bold LABEL — NOT a full-width
		// background block. Secondary metadata (id, status/progress) keeps its own color,
		// exactly as ask_user_question leaves the description dim on the active row.
		//
		// Selection gutter, ALWAYS 2 cols so it's reserved in every state: `❯ ` (accent+
		// bold) on the active selection, two blank spaces otherwise (ambient or unselected).
		// Reserving it in the ambient state is what prevents a layout shift when the user
		// steps in — the row content never moves, only the gutter glyph swaps.
		const gutter = selected ? theme.fg("accent", theme.bold(CURSOR_SELECTED)) : CURSOR_UNSELECTED;
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

		// Fixed-width leading columns: cursor-gutter · status-glyph · workflow-tag · descriptor.
		// The workflow name is a dim tag (always present, so the workflow never disappears);
		// the descriptor is the run's --name alias OR the truncated user prompt, accent+bold
		// when selected. Tag + descriptor are fixed-width (per render) so the status region
		// (bar / label) always starts at the same column. Mirrors ask_user_question's
		// accent+bold `selectedText` + always-dim description split.
		const head = `${gutter}${theme.fg(glyphColor, glyph)} `;
		const workflow = lane.workflow ?? lane.name;
		const descriptor = laneDescriptor(lane);
		const tagRaw = descriptor ? `${workflow}:` : workflow;
		// The label cell is emitted ONLY when this render reserved label width (≥1 descriptor
		// somewhere). A no-descriptor render has labelWidth 0 → bare tag prefix (old shape),
		// so a no-descriptor lane never pays dead label space that would squeeze the reason chip.
		const prefix =
			`${head}${padCol(theme, "dim", tagRaw, TAG_COL)} ` +
			(labelWidth > 0
				? `${padCol(theme, selected ? "accent" : "text", descriptor ?? "", labelWidth, selected)} `
				: "");

		// needs-input ALWAYS wins the trailing label (overrides live progress, FR7).
		if (needs) return `${prefix}${theme.fg("warning", "needs input")}`;
		// Failure cause (Problem 1) — the trimmed headline of either the terminal
		// `lane.error` (post-retirement) or the live `error`-phase reason (pre-retirement).
		const reason = shortFailureReason(lane.error ?? (progress?.phase === "error" ? progress.reason : undefined));
		// Live stage progress (Phase 8): [bar] N/total stageName [· reason] [· units x/y].
		if (progress) return this.renderProgressRow(theme, prefix, progress, width, reason);
		// No progress yet: running animates "streaming…"; terminal shows its raw status,
		// with the failure reason appended (clipped by the row's width truncate).
		const label = running ? "streaming…" : lane.status;
		const tail = reason
			? `${theme.fg("muted", label)}${theme.fg("warning", ` — ${reason}`)}`
			: theme.fg("muted", label);
		return `${prefix}${tail}`;
	}

	/**
	 * Render a lane row carrying live stage progress. Width priority under pressure:
	 * the `N/total stageName` label (the signal) is always kept; the failure `reason`
	 * chip is kept next (truncated to the leftover); the mini-bar (decoration) is
	 * dropped FIRST — so a failed row shows its cause before its bar. All widths are
	 * measured pre-color via visibleWidth so the decision is ANSI-safe.
	 */
	private renderProgressRow(
		theme: Theme,
		prefix: string,
		progress: LaneProgress,
		width: number,
		reason?: string,
	): string {
		// Mini-bar: ALWAYS BAR_MAX_CELLS cells wide (the filled portion is scaled to
		// progress) so the bar — and every column after it — aligns across rows
		// regardless of each workflow's stage count (a 5-stage and a 6-stage run must
		// not shift the N/total column by a cell).
		const cells = BAR_MAX_CELLS;
		// Fraction is DISTINCT-STAGES-VISITED / graph size — the only pair where the
		// numerator can't exceed the denominator. `stageNumber` (the path ordinal) is
		// NOT used here: dividing it by graph size produced the misleading "7/4".
		const visited = progress.visited ?? Math.min(progress.stageNumber, progress.totalStages);
		const ratio = progress.totalStages > 0 ? visited / progress.totalStages : 0;
		const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
		const filledStr = BAR_FILLED.repeat(filled);
		const emptyStr = BAR_EMPTY.repeat(cells - filled);

		// N/total is its OWN fixed-width column so stage names align across rows.
		const numRaw = `${visited}/${progress.totalStages}`;
		let nameRaw = progress.stageName;
		if (progress.phase === "retry" && progress.attempt !== undefined) nameRaw += ` · retry ${progress.attempt}`;
		// Lap marker: surface the path ordinal only once the walk has re-entered a
		// stage, so it reads as "on lap 7 of this 4-stage flow", never as "7 of 4".
		if (progress.stageNumber > visited) nameRaw += ` · ${LAP_MARK}${progress.stageNumber}`;
		if (progress.units) nameRaw += ` · units ${progress.units.done}/${progress.units.total}`;

		const numCol = padCol(theme, "muted", numRaw, NUM_COL);
		const coloredName = theme.fg("muted", nameRaw);

		// Core (always rendered): prefix + numCol + " " + name. numCol pads to NUM_COL.
		const coreW = visibleWidth(prefix) + Math.max(NUM_COL, visibleWidth(numRaw)) + 1 + visibleWidth(nameRaw);

		// Failure-reason chip (priority OVER the bar): a warning ` — <reason>` truncated to
		// the leftover after the core; dropped when the leftover can't hold a fragment.
		let reasonStr = "";
		if (reason) {
			const leftover = width - coreW;
			if (leftover >= MIN_REASON_WIDTH)
				reasonStr = theme.fg("warning", truncateToWidth(` — ${reason}`, leftover, "…"));
		}
		const reasonW = visibleWidth(reasonStr);

		// The mini-bar is the LOWEST priority: include it only if the core + reason + bar all
		// fit, so a failed row never sacrifices its cause for decoration. cells + 2 = bar + gap.
		const includeBar = cells > 0 && coreW + reasonW + cells + 2 <= width;
		if (!includeBar) return `${prefix}${numCol} ${coloredName}${reasonStr}`;
		const coloredBar = `${theme.fg("accent", filledStr)}${theme.fg("dim", emptyStr)}`;
		return `${prefix}${coloredBar}  ${numCol} ${coloredName}${reasonStr}`;
	}

	/**
	 * Active-only transcript-tail preview of the selected lane. A dim separator rule
	 * then the last PREVIEW_LINES of the lane's rendered transcript — sourced from the live
	 * child session, else the retirement snapshot, exactly like the viewer (lane-viewer.ts).
	 * Reuses the shared renderBranch; toolsExpanded is always false so the preview stays compact.
	 * Fail-soft: a disposed/odd session degrades to a dim placeholder, never throws into the widget.
	 * scrollOffset is deliberately absent — scrolling stays in the focused viewer; this is a fixed tail.
	 */
	private renderPreview(theme: Theme, lane: LaneEntry, width: number): string[] {
		const rule = theme.fg("dim", "─".repeat(Math.max(0, width)));
		let entries: ViewerEntry[];
		let source: RenderSource;
		try {
			const session = lane.currentSession;
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
				source = {
					cwd: session.sessionManager.getCwd(),
					toolDef: (name) => session.getToolDefinition(name) as ToolDefArg,
				};
			} else if (lane.finalBranch !== undefined) {
				entries = (lane.finalBranch as ViewerEntry[]) ?? [];
				const defs = lane.finalToolDefs;
				source = { cwd: lane.finalCwd ?? "", toolDef: (name) => defs?.get(name) as ToolDefArg };
			} else {
				// No live child + no snapshot — fall through to the on-disk jsonl (Problem 2)
				// exactly like the viewer: live → finalBranch → disk → placeholder.
				const disk = this.loadPreviewDiskBranch(lane);
				if (disk) {
					entries = disk.entries;
					source = disk.source;
				} else {
					return [rule, theme.fg("dim", "  (stage starting…)")];
				}
			}
		} catch {
			return [rule, theme.fg("dim", "  (transcript unavailable)")];
		}
		if (!this.tui) return [rule]; // pre-mount guard (tui is set by the widget factory before render)
		const body = renderBranch(entries, width, source, this.tui, theme, false);
		return [rule, ...body.slice(Math.max(0, body.length - PREVIEW_LINES))];
	}

	/** Disk-jsonl preview fallback (Problem 2), memoized by `runId::lastSessionFile` so the
	 *  per-tick preview render re-reads disk at most once per source. */
	private loadPreviewDiskBranch(lane: LaneEntry): DiskBranch | undefined {
		const key = `${lane.runId}::${lane.lastSessionFile ?? ""}`;
		if (this.previewDiskCache?.key !== key) {
			this.previewDiskCache = { key, value: loadBranchFromDisk(lane.runId, lane.lastSessionFile) };
		}
		return this.previewDiskCache.value;
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
		this.previewUnsub?.();
		this.previewUnsub = undefined;
		this.previewSession = undefined;
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
