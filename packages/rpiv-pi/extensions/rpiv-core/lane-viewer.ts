/**
 * lane-viewer — read-only LIVE transcript viewer for a switched-into run.
 *
 * The no-upstream-SDK substitute for native reattach: a focused ctx.ui.custom
 * overlay that RENDERS the lane's currently-live child session's getBranch()
 * (in-memory, always current — never the lagging .jsonl) via the SDK's own
 * exported message components, re-rendered on every streaming tick. Strictly
 * read-only: it never swaps, disposes, or writes any session.
 *
 * It FOLLOWS the lane: as stages advance the registry's currentSession changes,
 * so the viewer re-subscribes to the new child; when the run is evicted it
 * shows a terminal "finished" frame and waits for esc.
 *
 * Input split while this viewer is open (the lane is focused): esc/↑/↓ are
 * the viewer's own (esc → back to root, ↑/↓ → scroll); Ctrl-C is consumed by the
 * focus-gated abort tap (which fires ahead of this component) and aborts the run on
 * screen. The viewer therefore deliberately does NOT handle Ctrl-C itself.
 *
 * Tool calls + results are reconstructed via the SDK's own ToolExecutionComponent,
 * mirroring interactive-mode's renderSessionContext two-pass replay: each assistant
 * `toolCall` block spawns a component, and the later `toolResult` entry (matched by
 * toolCallId) is folded into it via updateResult before render. ToolDefinition/cwd
 * come from the live session (getToolDefinition/getCwd), or — once a run retires — from
 * the snapshot retireRun captured before dropping the session; a tool with no captured
 * def degrades to the component's built-in fallback renderer. Bash runs,
 * custom messages, skill invocations, and compaction/branch summaries each render via
 * their own SDK component; only genuinely unknown-role entries collapse to one dim line.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
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
	getLane,
	getUnit,
	type LaneSession,
	type LaneStatus,
	subscribeLanes,
	type UnitLane,
	unitNeedsInput,
	unitUsage,
} from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;

/** Header glyph for a retained terminal lane — mirrors the overlay's STATUS_GLYPH. */
const TERMINAL_GLYPH: Partial<Record<LaneStatus, string>> = {
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};

/** Header glyph for a unit sub-row (mirrors TERMINAL_GLYPH + the dock's PENDING_UNIT_GLYPH). */
const UNIT_GLYPH: Record<"done" | "failed" | "pending", string> = { done: "✓", failed: "✗", pending: "○" };

/**
 * Full token-detail suffix for the lane-viewer header — the footer.js
 * omit-when-zero segment set `↑in ↓out R W CH% $cost`, formatted via
 * formatTokens. Viewer-local (not exported): the lane DOCK renders a different,
 * compact tally, so a shared full-detail formatter would be viewer-only
 * and is not factored into lane-usage.ts.
 *
 *   • "" when usage is undefined (running unit / parent row / not yet captured)
 *   • each of ↑in ↓out R W pushed only when nonzero (footer.js omit-when-zero)
 *   • CH% : `CH${percent.toFixed(1)}%` for a numeric percent; omitted for null/undefined
 *   • $cost: `$${cost.toFixed(3)}` when nonzero; omitted otherwise
 *   • segment order: ↑in ↓out R W CH% $cost (the slice title's stated order, NOT
 *     footer.js's line order — there the bare `%` is an always-present dedicated
 *     line pinned last; here every segment is omit-when-zero with no such anchor)
 *   • segments joined by a single space (footer.js idiom)
 */
function formatUsageDetail(usage: LaneUsage | undefined): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.percent != null) parts.push(`CH${usage.percent.toFixed(1)}%`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	return parts.join(" ");
}

export class LaneViewer implements Component {
	private scrollOffset = 0;
	/** Collapsed by default (keeps the overlay short); `t` toggles every tool/summary
	 *  component's expanded state, mirroring interactive-mode's tool-output toggle. */
	private toolsExpanded = false;
	private currentSession: LaneSession | undefined;
	private sessionUnsub: (() => void) | undefined;
	/** The live child's in-flight partial, rendered as its own persistent component appended
	 *  after the committed body. Reset on syncSession identity change (so a stage swap never
	 *  shows the prior child's partial); cleared automatically the tick getStreamingMessage()
	 *  returns undefined (turn committed). */
	private streamingComponent: StreamingHandle | undefined;
	private readonly registryUnsub: () => void;
	/** Disk-jsonl fallback parsed ONCE and cached by file key — render runs
	 *  synchronously every streaming tick, so the disk read must not repeat per frame. */
	private diskCache: { key: string; value: DiskBranch | undefined } | undefined;

	constructor(
		private readonly runId: string,
		/** The unit this viewer follows — a fan-out index, or SINGLE_UNIT_KEY for the
		 *  lane (parent) row / single-stage run. */
		private readonly unitIndex: number,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (intent: "answer" | "back") => void,
	) {
		this.currentSession = getUnit(runId, unitIndex)?.currentSession;
		this.sessionUnsub = this.currentSession?.subscribe(() => this.tui.requestRender());
		// Follow the unit across stage transitions + detect eviction.
		this.registryUnsub = subscribeLanes(() => this.syncSession());
	}

	/** Re-point to THIS unit's current child if it changed; always re-render. The
	 *  identity-guard logic is unchanged and now a sibling spawn never drags the view
	 *  away (each unit owns its own slot). */
	private syncSession(): void {
		const next = getUnit(this.runId, this.unitIndex)?.currentSession;
		if (next !== this.currentSession) {
			this.sessionUnsub?.();
			this.currentSession = next;
			this.streamingComponent = undefined; // drop any in-flight partial from the old child
			this.sessionUnsub = next?.subscribe(() => this.tui.requestRender());
		}
		this.tui.requestRender();
	}

	/** Disk-jsonl fallback memoized by `runId::unitIndex::lastSessionFile` — the per-unit
	 *  key so two units' caches never collide. */
	private loadDiskBranch(unit: UnitLane | undefined): DiskBranch | undefined {
		const key = `${this.runId}::${this.unitIndex}::${unit?.lastSessionFile ?? ""}`;
		if (this.diskCache?.key !== key) {
			this.diskCache = { key, value: loadBranchFromDisk(this.runId, unit?.lastSessionFile) };
		}
		return this.diskCache.value;
	}

	render(width: number): string[] {
		const lane = getLane(this.runId);
		if (!lane) return this.frame([this.theme.fg("dim", "(run dismissed — esc to return)")], width);
		const unit = getUnit(this.runId, this.unitIndex);
		const session = this.currentSession;
		let entries: ViewerEntry[];
		let source: RenderSource;
		try {
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
				// Live source: cwd + per-tool definitions straight from the running child.
				source = {
					cwd: session.sessionManager.getCwd(),
					toolDef: (name) => session.getToolDefinition(name) as ToolDefArg,
				};
			} else if (unit?.finalBranch !== undefined) {
				// Terminated unit: render its snapshot + the cwd/tool-defs captured at teardown.
				entries = (unit.finalBranch as ViewerEntry[]) ?? [];
				const defs = unit.finalToolDefs;
				source = {
					cwd: unit.finalCwd ?? "",
					toolDef: (name) => defs?.get(name) as ToolDefArg,
				};
			} else {
				// No live session + no in-memory snapshot — fall through to this unit's on-disk
				// jsonl (durable path): live → unit.finalBranch → unit disk → none.
				const disk = this.loadDiskBranch(unit);
				if (disk) {
					entries = disk.entries;
					source = disk.source;
				} else if (lane.status === "running") {
					return this.frame([this.theme.fg("dim", "(stage starting…)")], width); // between stages
				} else {
					return this.frame([this.theme.fg("dim", "(no transcript — esc to return)")], width);
				}
			}
		} catch {
			// disposed mid-render / unexpected shape — fail soft (never throw inside the overlay)
			return this.frame([this.theme.fg("dim", "(transcript unavailable)")], width);
		}
		const body = renderBranch(entries, width, source, this.tui, this.theme, this.toolsExpanded);
		if (session) {
			// Live source only: append the in-flight partial after the committed body so it sits at the
			// bottom-anchored tail. getStreamingMessage() → undefined the instant the turn commits, so the
			// component clears and renderBranch shows the committed turn — no double-render.
			const { component, lines } = renderStreamingMessage(
				this.streamingComponent,
				this.readStreaming(session),
				width,
			);
			this.streamingComponent = component;
			body.push(...lines);
		}
		return this.frame(body, width);
	}

	/** Read the live session's in-flight partial, narrowed to ViewerMessage at the call site
	 *  (the boundary decision). Fail-soft: a throwing accessor yields undefined. */
	private readStreaming(session: LaneSession): ViewerMessage | undefined {
		try {
			return session.getStreamingMessage() as ViewerMessage | undefined;
		} catch {
			return undefined;
		}
	}

	/** Header + bottom-anchored windowed body + footer. scrollOffset 0 = newest (tail). */
	private frame(body: string[], width: number): string[] {
		const lane = getLane(this.runId);
		const unit = getUnit(this.runId, this.unitIndex);
		// A real fan-out unit (unitIndex ≥ 0) reflects ITS OWN status + label; the lane
		// row / sentinel keeps the run-driven header (name + run status + cause).
		const isUnit = this.unitIndex >= 0 && unit !== undefined;
		const name = (isUnit ? unit.label : undefined) ?? lane?.name ?? this.runId;
		let headText: string;
		if (isUnit) {
			headText =
				unit.status === "running" ? `▶ ${name} — live` : `${UNIT_GLYPH[unit.status]} ${name} — ${unit.status}`;
		} else {
			// Live runs read "▶ name — live"; a retained terminal run reflects its outcome,
			// and a failed/aborted run appends its full cause — "✗ ship — failed:
			// <reason>" — truncated to width by the header truncate below.
			const glyph = lane ? (TERMINAL_GLYPH[lane.status] ?? "•") : "•";
			headText =
				!lane || lane.status === "running"
					? `▶ ${name} — live`
					: lane.error
						? `${glyph} ${name} — ${lane.status}: ${lane.error}`
						: `${glyph} ${name} — ${lane.status}`;
		}
		// Append the focused unit's full token-detail suffix
		// (↑in ↓out R W CH% $cost) when its captured finalUsage carries one. Two-space
		// break from the name/status/cause; rightmost-clipped by the truncate below so
		// the left-anchored name + status always survive under narrow widths.
		const detail = formatUsageDetail(unitUsage(unit));
		if (detail) headText = `${headText}  ${detail}`;
		const header = truncateToWidth(this.theme.fg("accent", headText), width, "…");
		// A queued question is answered IN PLACE with ⏎ (switchIntoLane drains only on the
		// "answer" intent); esc/← back out without draining, so the view verb and the answer
		// verb never share a key. Needs-input is now PER-UNIT — the ⏎ answer hint + drain
		// target is THIS unit.
		const needs = unitNeedsInput(this.runId, this.unitIndex);
		const toggle = this.toolsExpanded ? "t collapse" : "t expand";
		const footer = truncateToWidth(
			this.theme.fg(
				needs ? "warning" : "dim",
				needs ? `↑/↓ scroll · ${toggle} · ⏎ answer · ←/esc back` : `↑/↓ scroll · ${toggle} · ←/esc back`,
			),
			width,
			"…",
		);
		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(6, Math.floor(termRows * MAX_HEIGHT_RATIO));
		const bodyBudget = Math.max(1, maxRows - 2); // header + footer
		const excess = Math.max(0, body.length - bodyBudget);
		if (this.scrollOffset > excess) this.scrollOffset = excess;
		const start = excess - this.scrollOffset;
		return [header, ...body.slice(start, start + bodyBudget), footer];
	}

	handleInput(data: string): void {
		// esc/← back out WITHOUT answering ("back"); ⏎ answers in place on a needs-input
		// lane ("answer"). switchIntoLane drains only on "answer", so the view verb (→/esc/←)
		// and the answer verb (⏎) are fully decoupled here.
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			this.done("back");
			return;
		}
		if (matchesKey(data, Key.enter) && unitNeedsInput(this.runId, this.unitIndex)) {
			this.done("answer");
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = this.scrollOffset + 1; // reveal older
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "t") {
			// Toggle expanded state for every tool/summary component (rebuilt next render).
			this.toolsExpanded = !this.toolsExpanded;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		// render recomputes from live state each cycle — nothing cached
	}

	dispose(): void {
		this.sessionUnsub?.();
		this.registryUnsub();
	}
}

/**
 * Open the viewer as a focused overlay (mirror showBtwOverlay). The focused lane manager
 * calls this on → / ⏎; resolves with the user's exit INTENT: esc/← → "back" (don't drain),
 * ⏎ on a needs-input lane → "answer" (switchIntoLane then drains the queued question).
 */
export function showLaneViewer(ui: ExtensionUIContext, runId: string, unitIndex: number): Promise<"answer" | "back"> {
	return ui.custom<"answer" | "back">((tui, theme, _kb, done) => new LaneViewer(runId, unitIndex, tui, theme, done), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "90%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
