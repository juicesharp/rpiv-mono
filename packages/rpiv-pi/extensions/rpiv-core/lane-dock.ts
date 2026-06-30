/**
 * lane-dock — the always-mounted lane dock rendered BELOW the editor.
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
import {
	type RenderSource,
	renderBranch,
	renderStreamingMessage,
	type StreamingHandle,
	type ToolDefArg,
	type ViewerEntry,
	type ViewerMessage,
} from "./lane-transcript.js";
import { type DiskBranch, loadBranchFromDisk } from "./lane-transcript-disk.js";
import { formatTokens, type LaneUsage } from "./lane-usage.js";
import {
	type DisplayRow,
	getDockState,
	getUnit,
	type LaneEntry,
	type LaneProgress,
	type LaneSession,
	type LaneStatus,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	SINGLE_UNIT_KEY,
	setDockActive,
	type UnitLane,
	unitNeedsInput,
	unitUsage,
} from "./run-lane-registry.js";

const WIDGET_KEY = "rpiv-lanes";
/** Per-row CAP on the lane region (the scroll-follow window + its +N above/below summaries).
 *  computeLayout bounds laneCap at MAX_WIDGET_LINES - 1, so a tall terminal grows the
 *  live-output region rather than an unbounded lane list. (Was the fixed content budget.) */
const MAX_WIDGET_LINES = 12;
/** Compact CAP on the dock's TOTAL height — top framing + lane region + live-output region +
 *  bottom framing. computeLayout clamps totalRows to min(MAX_DOCK_ROWS, terminal.rows): a tiny
 *  terminal shrinks the dock, a tall one stays compact (NOT floor(rows * 0.9)). Tunable (~18–22). */
const MAX_DOCK_ROWS = 20;
/** Lines reserved for the live-output region BEFORE lanes claim the content body — guarantees
 *  the preview/placeholder survives even when lanes fill the cap. Tunable (1–2). */
const MIN_PREVIEW_ROWS = 2;
/** terminal.rows fallback when the TUI hasn't reported a size (pre-mount / headless host).
 *  Mirrors lane-viewer.ts' `?? 24`. */
const FALLBACK_ROWS = 24;
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
/** Centered live-output placeholder — fills the region when no line is selected (ambient, or
 *  active with no resolved unit) so the region's height is constant in every dock state. */
const NO_SELECTION_PLACEHOLDER = "↑/↓ select a line for live output";
/** CAP on the live-output region's CONTENT (the transcript tail). The region itself is
 *  `previewBudget` lines (the content-body remainder); no more than min(previewBudget,
 *  PREVIEW_LINES) of it is ever transcript, and the rest pads blank so the region height is
 *  constant as the body grows (the ghost-block fix). Self-bounds the content slice. */
const PREVIEW_LINES = 6;
/** Selection-gutter cells reserved on every row (so a row never shifts when stepping in):
 *  the `❯` cursor (matching pi's selectors) on the active selection, two spaces otherwise. */
const CURSOR_SELECTED = "❯ ";
const CURSOR_UNSELECTED = "  ";
/** Heartbeat cadence — refresh the aging "needs input · 4m" heading even when
 *  no lane is streaming (the spinner timer is then idle). Minute-granularity needs only
 *  a slow tick; `.unref()` so it never keeps the process alive. */
const NEEDS_INPUT_TICK_MS = 10_000;

/** Compact relative age: "30s" · "4m" · "2h". */
function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** Active-preview "live output" banner: a dim, full-width rule carrying a leading label so the
 *  preview separator is distinguishable by CONTENT from the bare top/bottom framing rules.
 *  Fail-soft (matches renderPreview's invariant): degrades to a truncated label — never throws —
 *  when `width` is narrower than the label itself. */
function renderPreviewBanner(theme: Theme, width: number): string {
	const label = "── live output ";
	const remaining = width - visibleWidth(label);
	if (remaining >= 0) return theme.fg("dim", label + "─".repeat(remaining));
	return theme.fg("dim", truncateToWidth(label, Math.max(0, width)));
}

/** Mini stage-progress bar: filled/empty cells, capped + scaled for big workflows. */
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const BAR_MAX_CELLS = 7;
/** Minimum leftover display columns to bother showing a failure-reason chip.
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
// Fixed-width columns (column stability). Each leading field is truncated
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
 * The dock descriptor for a lane — the run's resume handle (its `runId`), surfaced so the
 * user can act on the lane via `@<runId>`. The run's `--name` alias still wins when it
 * differs from the workflow (both `@<alias>` and `@<runId>` are valid resume tokens);
 * otherwise the `runId` is the descriptor. The descriptor is ALWAYS defined — there is no
 * bare-tag fallback — so every lane row carries the `workflow:` colon tag + the descriptor
 * cell. Shared by `renderWidget` (the content-aware label-width computation) AND `renderRow`
 * (the render) so the two never drift. A `--name` that happens to equal the workflow name
 * degrades gracefully — no alias, so the descriptor falls through to the runId.
 */
function laneDescriptor(lane: LaneEntry): string {
	const workflow = lane.workflow ?? lane.name;
	const alias = lane.name !== workflow ? lane.name : undefined;
	return alias ?? lane.runId;
}

/**
 * Compact dock token tally — `↑{in} ↓{out} R{cacheRead}` via formatTokens,
 * each segment omitted when its value is 0 and the WHOLE tally omitted (→ "") when usage
 * is undefined OR all three are zero. footer.js:108-127 omit-when-zero idiom. Deliberately
 * the 3-segment subset — W (cacheWrite) / CH% (context fill) / $cost are the
 * lane-viewer header's segments, NOT this ambient dock surface.
 */
function formatUsageTally(usage: LaneUsage | undefined): string {
	if (!usage) return "";
	const segments: string[] = [];
	if (usage.input > 0) segments.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) segments.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) segments.push(`R${formatTokens(usage.cacheRead)}`);
	return segments.join(" ");
}

/**
 * Run-level token aggregate over a lane's units — sums input/output/cacheRead/cacheWrite
 * across every unit's EFFECTIVE usage (the teardown snapshot `finalUsage` when present,
 * else the live child's `getUsage()` via `unitUsage` — so a RUNNING lane with attached
 * live sessions tallies in real time, not frozen at zero until teardown); RECOMPUTES total
 * = sum of the four (does NOT trust each child's stored total, which may have been computed
 * under a different window); accumulates scalar cost (only when at least one contributing
 * unit carries one); OMITS percent (a context-window fill has no meaningful value summed
 * across siblings with independent windows). Returns undefined when NO unit carries usage
 * (no snapshot AND no live session). A pure synchronous read over the registry, safe under
 * JS run-to-completion.
 */
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
	const result: LaneUsage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
	if (hasCost) result.cost = cost;
	return result;
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
/** Glyph for a fan-out unit seeded PENDING before its onUnitStart fires (a hollow
 *  circle reads "queued, not yet running" alongside ✓/✗/⚑/▶). */
const PENDING_UNIT_GLYPH = "○";

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
	/** Heartbeat timer — alive ONLY while a lane needs input, to age the heading. */
	private needsInputTimer: ReturnType<typeof setInterval> | undefined;
	/** The selected lane's live child session the preview follows. Identity-
	 *  guarded so an unrelated registry notify never stacks a second subscription (a leak). */
	private previewSession: LaneSession | undefined;
	private previewUnsub: (() => void) | undefined;
	/** The selected lane's in-flight partial, rendered as its own persistent component appended
	 *  before the PREVIEW_LINES tail-slice. Reset on preview-session identity change
	 *  (syncPreviewSubscription) so a switched-away lane's partial never lingers; nulled on dispose;
	 *  cleared automatically the tick getStreamingMessage() returns undefined (turn committed). */
	private streamingComponent: StreamingHandle | undefined;
	/** Disk-jsonl preview fallback parsed ONCE and cached by file key — the
	 *  preview re-renders on every spinner tick, so the disk read must not repeat per frame. */
	private previewDiskCache: { key: string; value: DiskBranch | undefined } | undefined;
	/** Last height-shape signature (see shapeSignature) — drives the forced-redraw decision in
	 *  update(). undefined until the widget mounts (re-seeded on (re)registration). */
	private lastShapeSig: string | undefined;

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
		const prevPreviewSession = this.previewSession; // pre-sync, for the force-clear gate below
		this.syncPreviewSubscription(); // follow the SELECTED lane's live session
		const previewTargetChanged = this.previewSession !== prevPreviewSession; // re-target, not a shape step
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
				this.lastShapeSig = undefined; // re-seed on the next (re)registration
			}
			return;
		}
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					// Re-seed the shape baseline now that the TUI (and its terminal size) is known.
					// update() seeds earlier against the FALLBACK_ROWS baseline (this.tui is unset
					// until the factory runs); without this re-seed the first post-mount update()
					// would see a termRows change (FALLBACK → real) and force a spurious full redraw.
					this.lastShapeSig = this.shapeSignature();
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
							this.lastShapeSig = undefined; // re-seed on the next (re)registration
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
			// Seed the shape baseline so the first post-mount update() doesn't force a spurious
			// full redraw (mount already paints clean from an empty previousLines).
			this.lastShapeSig = this.shapeSignature();
		} else {
			// pi-tui's differential renderer mis-paints when this belowEditor widget changes
			// HEIGHT between frames: a fan-out stage transition swaps the prior stage's unit
			// sub-rows for the next stage's (and the lane row advances a stage), growing the dock
			// mid-frame. The line-diff then paints the taller frame BELOW the shorter previous one
			// instead of over it, leaving a stale duplicate block (two `❯` rows with DIFFERENT
			// spinner frames — proof of two surviving render passes) until a wider repaint
			// overwrites it. Forcing a full redraw whenever our row shape changes resets
			// previousLines so the grown frame paints clean. Gated on the shape signature so
			// spinner ticks (which bypass update() entirely) and stable-shape progress notifies
			// stay cheap differential renders — only a structural height step pays for a clear.
			// A SECOND trigger is the active-preview RE-TARGET, which is a SEPARATE signal from
			// shapeSignature() (it deliberately excludes the preview footprint — see that method's
			// docstring): a non-fan-out single-unit stage advance keeps the row count at 1 and the
			// selection at 0 (signature `1:0 → 1:0`, unchanged), yet the selected unit's transcript
			// swaps session S1 → S2 and the new shorter frame is painted over the taller old one —
			// the same ghost-block artifact with a STABLE signature. shapeSignature() can't see it,
			// so update() tracks it separately via the previewSession identity check
			// (previewTargetChanged); both signals OR into the single force gate here.
			const sig = this.shapeSignature();
			const shapeChanged = sig !== this.lastShapeSig;
			this.lastShapeSig = sig;
			this.tui?.requestRender(shapeChanged || previewTargetChanged);
		}
	}

	/**
	 * Cheap height-shape signature: the flattened display-row count plus the active selection
	 * index (active-only — ambient has no `❯` cursor and no preview, so selection can't move the
	 * height there). A change in either is a structural height step — rows added/removed (the
	 * fan-out unit churn that triggers the duplicate-block artifact), stepping in/out (the
	 * preview region + top rule appear/disappear), or moving the selection (the active preview
	 * re-targets a different lane's transcript tail). Deliberately EXCLUDES the spinner frame and
	 * the streaming-preview tail length: those change every tick but are absorbed by the
	 * differential path without artifacts, and forcing a screen-clear on each would flicker.
	 * NOTE: this does NOT cover an active-preview RE-TARGET that keeps the row count and the
	 * selection index fixed (a single-unit stage advance: signature `1:0 → 1:0` unchanged while
	 * the selected unit's currentSession swaps S1 → S2) — that footprint change is tracked
	 * separately in update() via the previewSession identity check, so the signature stays cheap.
	 */
	/** Lazy terminal-row read — `this.tui` is assigned by the widget factory before render, so
	 *  `terminal.rows` is available; FALLBACK_ROWS covers pre-mount / headless. The erased
	 *  `terminal` shape is narrowed to `{ rows?: number }` (mirrors lane-viewer.ts). */
	private getTerminalRows(): number {
		return (this.tui?.terminal as { rows?: number } | undefined)?.rows ?? FALLBACK_ROWS;
	}

	/** The top-down frame budget, computed once per render from the terminal size + dock state.
	 *  `totalRows` is the compact CAP (min(MAX_DOCK_ROWS, terminal.rows)); `overhead` is the
	 *  constant framing (top block + bottom block + the live-output banner); the content body
	 *  splits into `laneCap` (lanes take priority, bounded by MAX_WIDGET_LINES - 1, reserving
	 *  MIN_PREVIEW_ROWS) and `previewBudget` (the REMAINDER). totalRows = overhead + contentBody
	 *  is invariant for a given state + terminal regardless of the lane count N. */
	private computeLayout(active: boolean): { totalRows: number; laneCap: number; previewBudget: number } {
		const termRows = this.getTerminalRows();
		const overhead = (active ? 5 : 3) + 3 /*bottom: blank + footer + rule*/ + 1 /*live-output banner*/;
		const totalRows = Math.min(MAX_DOCK_ROWS, termRows);
		const contentBody = Math.max(0, totalRows - overhead);
		const laneCap = Math.min(MAX_WIDGET_LINES - 1, Math.max(1, contentBody - MIN_PREVIEW_ROWS));
		const previewBudget = Math.max(0, contentBody - laneCap);
		return { totalRows, laneCap, previewBudget };
	}

	/** Group-aware scroll-follow viewport over the flattened display rows. Returns the visible
	 *  slice [start, start+window) plus whether rows fold behind a `+N above` / `+N below` summary
	 *  (both summaries live INSIDE laneCap, so the lane region's height is constant whether or not
	 *  it is scrolled). The selection (the ❯ cursor) is always inside the window; the window opens
	 *  at a lane boundary and folds whole lane+unit groups (running AND pending) atomically. */
	private computeViewport(
		rows: DisplayRow[],
		selection: number,
		laneCap: number,
	): { start: number; window: number; above: number; below: number } {
		const n = rows.length;
		// Everything fits — show it all, no summaries, no scrolling.
		if (n <= laneCap) return { start: 0, window: n, above: 0, below: 0 };

		// Reserve up to two summary rows inside laneCap; the content window is what remains.
		const reserve = Math.min(2, laneCap - 1);
		const window = Math.max(1, laneCap - reserve);

		// Center the content window on the selection, clamped to the scrollable range.
		let start = selection - Math.floor(window / 2);
		if (start < 0) start = 0;
		const maxStart = n - window;
		if (start > maxStart) start = maxStart;

		// Group-aware START: snap start DOWN to a lane boundary so the window never opens
		// mid-group — but never below the cursor-visibility floor (the cursor stays visible).
		const floor = Math.max(0, selection - window + 1);
		while (start > floor && rows[start].kind === "unit") start--;

		// Group-aware END: if a trailing group is cut at `end`, fold it atomically behind `+N
		// below` (pull end back to the group's lane boundary) — unless that would hide the cursor
		// (the cut group contains the selection) or empty the window (a group larger than it).
		let end = start + window;
		if (end < n && rows[end].kind === "unit") {
			let lane = end;
			while (lane > start && rows[lane].kind === "unit") lane--;
			if (lane > start && lane > selection) end = lane;
		}

		return {
			start,
			window: end - start,
			above: start > 0 ? 1 : 0,
			below: end < n ? 1 : 0,
		};
	}

	private shapeSignature(): string {
		const { active, selection } = getDockState();
		// termRows is a HEIGHT dimension (a row resize is a potential height step even when the
		// lane set is unchanged), prepended so any resize forces a full redraw. Raw termRows (a
		// superset of the clamped total) — the clamp is render-time only.
		const termRows = this.getTerminalRows();
		return `${termRows}:${listLanesForDisplay().length}:${active ? selection : -1}`;
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

	/** Drive a slow repaint heartbeat ONLY while ≥1 lane needs input — so a
	 *  stalled run's "needs input · Nm" heading ages visibly even when nothing streams.
	 *  Independent of the spinner timer (which stops when no lane is running). */
	private syncHeartbeat(lanes: LaneEntry[]): void {
		const anyNeedsInput = lanes.some((l) => laneNeedsInput(l.runId));
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
		const sel = this.selectedUnit();
		const next = sel?.unit?.currentSession;
		if (next === this.previewSession) return;
		this.previewUnsub?.();
		this.previewSession = next;
		this.streamingComponent = undefined; // drop any in-flight partial from the previously-followed child
		// `this.tui?` is read LAZILY at fire time, not captured: update() (and thus this
		// subscribe) can run before the widget factory assigns this.tui (e.g. the first
		// update() during mount, ahead of the factory). The optional-chain no-ops until the
		// widget mounts, then repaints normally — so DON'T hoist this.tui into a local here.
		this.previewUnsub = next?.subscribe(() => this.tui?.requestRender());
	}

	/** Resolve the selected display row to a unit address — the SINGLE seam both the
	 *  preview subscription and the preview render go through (so they can't drift). A
	 *  lane (parent) row resolves the sentinel unit; a unit sub-row resolves itself.
	 *  No-op while ambient (no selection) — the preview is active-only. */
	private selectedUnit(): { runId: string; unitIndex: number; unit: UnitLane | undefined } | undefined {
		const { active, selection } = getDockState();
		if (!active) return undefined;
		const row = listLanesForDisplay()[selection];
		if (!row) return undefined;
		if (row.kind === "unit") return { runId: row.lane.runId, unitIndex: row.unit.index, unit: row.unit };
		return { runId: row.lane.runId, unitIndex: SINGLE_UNIT_KEY, unit: getUnit(row.lane.runId, SINGLE_UNIT_KEY) };
	}

	private renderWidget(theme: Theme, width: number): string[] {
		// Flattened display rows (lane rows + indented unit sub-rows); selection indexes
		// THIS list. Display order is a stable priority sort (needs-input →
		// running → terminal), so the lane that needs the user never hides below the fold.
		const rows = listLanesForDisplay();
		if (rows.length === 0) return [];
		// Lane-level heading counts come from the lane set, not the (larger) row count.
		const allLanes = listLanes();
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		// Dock navigation state — drives the `❯` selection cursor and the footer hint.
		// Selection indexes this same listLanesForDisplay() order (clamped on read).
		const { active, selection } = getDockState();

		const needsInputLanes = allLanes.filter((l) => laneNeedsInput(l.runId));
		const anyNeedsInput = needsInputLanes.length > 0;
		const activeCount = allLanes.filter((l) => l.status === "running").length;
		// When a run is blocked on input, the title SHOUTS it and ages: the
		// oldest pending question drives "N run(s) need input · 4m". Otherwise show the
		// active count (terminal lanes are retained, so total ≠ active).
		let headText: string;
		if (anyNeedsInput) {
			const now = Date.now();
			const oldest = needsInputLanes.reduce((min, l) => Math.min(min, l.needsInputSince ?? now), now);
			const verb = needsInputLanes.length === 1 ? "run needs" : "runs need";
			headText = `${needsInputLanes.length} ${verb} input · ${formatAge(now - oldest)}`;
		} else {
			headText = activeCount > 0 ? `Runs (${activeCount} active)` : `Runs (${allLanes.length})`;
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
		// Top-down frame budget from the terminal size + dock state (computed once per render,
		// never re-derived from a derived value). laneCap bounds the lane region (the scroll-follow
		// window + its +N above/below summaries); previewBudget is the live-output REMAINDER.
		// totalRows (inside computeLayout) is the compact CAP — min(MAX_DOCK_ROWS, terminal.rows).
		const { laneCap, previewBudget } = this.computeLayout(active);

		// The 2-col selection gutter is ALWAYS reserved (see renderRow) so stepping in
		// only swaps spaces for the `❯` cursor — no row ever shifts. sel(i) marks the
		// active selection (only true while active).
		const sel = (i: number): boolean => active && i === selection;
		// Content-aware label-column width — the MAX width among BOTH the lane descriptors
		// (the run's resume handle / --name alias) AND the unit sub-row labels, clamped to
		// MAX_LABEL_WIDTH and the available row width, so the progress region stays
		// column-aligned AND a unit label never truncates to the (short) runId descriptor.
		// Unit sub-rows render under it with their own indent. Constant across rows.
		const labelWidth = Math.min(
			MAX_LABEL_WIDTH,
			allLanes.reduce((m, l) => {
				let w = Math.max(m, visibleWidth(laneDescriptor(l)));
				for (const u of l.units.values()) w = Math.max(w, visibleWidth(u.label ?? `unit ${u.index}`));
				return w;
			}, 0),
			Math.max(0, width - LABEL_LEADING - PROGRESS_MIN_WIDTH),
		);
		const renderAt = (row: DisplayRow, i: number): string =>
			truncate(
				row.kind === "lane"
					? this.renderRow(theme, row.lane, width, labelWidth, sel(i))
					: this.renderUnitRow(theme, row.lane, row.unit, width, labelWidth, sel(i)),
			);
		// Group-aware scroll-follow viewport: when rows exceed laneCap the window centers on
		// the selection (the ❯ cursor never vanishes into overflow), opens at a lane boundary,
		// and folds whole lane+unit groups behind +N above / +N below summaries that live
		// INSIDE laneCap — so the lane region's height is constant whether or not scrolled.
		const vp = this.computeViewport(rows, selection, laneCap);
		if (vp.above) {
			lines.push(truncate(`${CURSOR_UNSELECTED}${theme.fg("dim", `+${vp.start} above`)}`));
		}
		for (let i = vp.start; i < vp.start + vp.window; i++) {
			lines.push(renderAt(rows[i], i));
		}
		if (vp.below) {
			const hidden = rows.length - (vp.start + vp.window);
			lines.push(truncate(`${CURSOR_UNSELECTED}${theme.fg("dim", `+${hidden} below`)}`));
		}
		// The live-output region is ALWAYS present and exactly 1 + previewBudget lines: a dim
		// "live output" banner then either the selected lane's transcript tail (active + unit)
		// or a centered placeholder — both padded so a streaming body changing every tick does
		// NOT change the dock height (the ghost-block regression). Content is active-gated; the
		// region itself renders in every state so the total height is stable.
		const selUnit = this.selectedUnit();
		const region: string[] =
			active && selUnit
				? this.renderPreview(theme, selUnit.runId, selUnit.unitIndex, selUnit.unit, width, previewBudget)
				: [
						renderPreviewBanner(theme, width),
						...Array.from({ length: previewBudget }, () =>
							this.centerLine(theme, NO_SELECTION_PLACEHOLDER, width),
						),
					];
		for (const line of region) lines.push(truncate(line));
		// Footer hint (dim), indented one space — active shows the navigation contract,
		// ambient the discoverability hint. Preceded by a blank line (rhythm) and followed
		// by the bottom rule (the separator from Pi's status chrome below).
		lines.push("");
		const activeFooter =
			selUnit && unitNeedsInput(selUnit.runId, selUnit.unitIndex)
				? ACTIVE_FOOTER_NEEDS_INPUT
				: ACTIVE_FOOTER_DEFAULT;
		lines.push(truncate(` ${theme.fg("dim", active ? activeFooter : DEFAULT_FOOTER_TEXT)}`));
		lines.push(rule);
		return lines;
	}

	/**
	 * Render an indented unit SUB-ROW (a fan-out unit). Mirrors `renderRow`'s gutter +
	 * glyph priority (needs-input → running spinner → terminal glyph) but is keyed on the
	 * UNIT's own `pendingInput`/`status` and shows its label + a compact status word — the
	 * unit carries no stage-progress bar (that belongs to the parent lane row).
	 */
	private renderUnitRow(
		theme: Theme,
		lane: LaneEntry,
		unit: UnitLane,
		_width: number,
		labelWidth: number,
		selected: boolean,
	): string {
		const gutter = selected ? theme.fg("accent", theme.bold(CURSOR_SELECTED)) : CURSOR_UNSELECTED;
		const needs = unitNeedsInput(lane.runId, unit.index);
		let glyph: string;
		let glyphColor: ThemeColor;
		if (needs) {
			glyph = NEEDS_INPUT_GLYPH;
			glyphColor = "warning";
		} else if (unit.status === "running") {
			glyph = SPINNER_FRAMES[this.frame];
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
		// Indent one level (a 2-col child indent) past the gutter so sub-rows read as
		// children of the lane row above; align the label to the lane descriptor column.
		const indent = "  ";
		const label = unit.label ?? `unit ${unit.index}`;
		const labelCell =
			labelWidth > 0 ? padCol(theme, selected ? "accent" : "text", label, labelWidth, selected) : label;
		const usageTally = formatUsageTally(unitUsage(unit));
		const tail = needs
			? theme.fg("warning", "needs input")
			: theme.fg("muted", unit.status === "running" ? "live" : unit.status) +
				(usageTally ? theme.fg("muted", ` · ${usageTally}`) : "");
		return `${gutter}${indent}${theme.fg(glyphColor, glyph)} ${labelCell} ${tail}`;
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

		// needs-input ALWAYS wins the trailing label (overrides live progress).
		if (needs) return `${prefix}${theme.fg("warning", "needs input")}`;
		// Failure cause — the trimmed headline of either the terminal
		// `lane.error` (post-retirement) or the live `error`-phase reason (pre-retirement).
		const reason = shortFailureReason(lane.error ?? (progress?.phase === "error" ? progress.reason : undefined));
		// Live stage progress: [bar] N/total stageName [· reason] [· units x/y] [· ↑in ↓out R].
		if (progress)
			return this.renderProgressRow(theme, prefix, progress, width, reason, sumLaneUsage(lane.units.values()));
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
		usage?: LaneUsage,
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
		// Aggregate token tally as the trailing nameRaw segment, appended WHILE
		// nameRaw is assembled and BEFORE coreW so the existing reason-chip / includeBar
		// budget math accounts for the true full name width (no special tally logic); the
		// row's outer truncate(line, width, "…") remains the final overflow safety net.
		const usageTally = formatUsageTally(usage);
		if (usageTally) nameRaw += ` · ${usageTally}`;

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

	/** Pad a preview body to `budget` blank lines so the live-output region's height is constant
	 *  on every render path (the ghost-block fix: a body growing every streaming tick must not
	 *  change the dock height). The banner is always the first element. */
	private padPreview(rule: string, body: string[], budget: number): string[] {
		const padded = body.slice();
		while (padded.length < budget) padded.push("");
		return [rule, ...padded];
	}

	/** Center `text` in a full-width line via symmetric spacing (left = floor(gap/2)), fail-soft
	 *  to a truncate when `width` is narrower than the copy. No centering helper exists today
	 *  (`padCol` only right-pads). Operates on raw text (visibleWidth is exact); dims the result. */
	private centerLine(theme: Theme, text: string, width: number): string {
		const visible = visibleWidth(text);
		if (visible >= width) return theme.fg("dim", truncateToWidth(text, Math.max(0, width), "…"));
		const gap = width - visible;
		const left = Math.floor(gap / 2);
		return theme.fg("dim", `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`);
	}

	/**
	 * Active-only transcript-tail preview of the selected lane. A dim separator rule
	 * then the last min(previewBudget, PREVIEW_LINES) of the lane's rendered transcript,
	 * padded to `previewBudget` so the live-output region's height never changes as the body
	 * grows (ghost-block fix). Sourced from the live child session, else the retirement
	 * snapshot, exactly like the viewer (lane-viewer.ts). Reuses the shared renderBranch;
	 * toolsExpanded is always false so the preview stays compact. Fail-soft: a disposed/odd
	 * session degrades to a dim placeholder, never throws into the widget. scrollOffset is
	 * deliberately absent — scrolling stays in the focused viewer; this is a fixed tail.
	 */
	private renderPreview(
		theme: Theme,
		runId: string,
		unitIndex: number,
		unit: UnitLane | undefined,
		width: number,
		previewBudget: number,
	): string[] {
		const rule = renderPreviewBanner(theme, width);
		let entries: ViewerEntry[];
		let source: RenderSource;
		try {
			const session = unit?.currentSession;
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
				source = {
					cwd: session.sessionManager.getCwd(),
					toolDef: (name) => session.getToolDefinition(name) as ToolDefArg,
				};
			} else if (unit?.finalBranch !== undefined) {
				entries = (unit.finalBranch as ViewerEntry[]) ?? [];
				const defs = unit.finalToolDefs;
				source = { cwd: unit.finalCwd ?? "", toolDef: (name) => defs?.get(name) as ToolDefArg };
			} else {
				// No live child + no snapshot — fall through to the on-disk jsonl
				// exactly like the viewer: live → finalBranch → disk → placeholder.
				const disk = this.loadPreviewDiskBranch(runId, unitIndex, unit);
				if (disk) {
					entries = disk.entries;
					source = disk.source;
				} else {
					return this.padPreview(rule, [theme.fg("dim", "  (stage starting…)")], previewBudget);
				}
			}
		} catch {
			return this.padPreview(rule, [theme.fg("dim", "  (transcript unavailable)")], previewBudget);
		}
		if (!this.tui) return this.padPreview(rule, [], previewBudget); // pre-mount guard (tui is set by the widget factory before render)
		const body = renderBranch(entries, width, source, this.tui, theme, false);
		const live = unit?.currentSession;
		if (live) {
			// Live source only (terminal lanes carry no partial): append the in-flight partial's thinking
			// before the tail-slice so the dock preview's content window shows it. Cleared the
			// instant the turn commits (getStreamingMessage → undefined) — no double-render.
			const { component, lines } = renderStreamingMessage(
				this.streamingComponent,
				this.readPreviewStreaming(live),
				width,
			);
			this.streamingComponent = component;
			body.push(...lines);
		}
		const cap = Math.min(previewBudget, PREVIEW_LINES);
		return this.padPreview(rule, body.slice(Math.max(0, body.length - cap)), previewBudget);
	}

	/** Read the selected lane's live in-flight partial, narrowed to ViewerMessage at the call
	 *  site. Fail-soft: a throwing accessor yields undefined. */
	private readPreviewStreaming(session: LaneSession): ViewerMessage | undefined {
		try {
			return session.getStreamingMessage() as ViewerMessage | undefined;
		} catch {
			return undefined;
		}
	}

	/** Disk-jsonl preview fallback, memoized by the PER-UNIT key
	 *  `runId::unitIndex::file` so two units' caches never collide and the per-tick
	 *  preview render re-reads disk at most once per source. */
	private loadPreviewDiskBranch(runId: string, unitIndex: number, unit: UnitLane | undefined): DiskBranch | undefined {
		const key = `${runId}::${unitIndex}::${unit?.lastSessionFile ?? ""}`;
		if (this.previewDiskCache?.key !== key) {
			this.previewDiskCache = { key, value: loadBranchFromDisk(runId, unit?.lastSessionFile) };
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
		this.streamingComponent = undefined;
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.lastShapeSig = undefined;
	}
}
