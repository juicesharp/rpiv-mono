/**
 * lane-viewer — read-only LIVE transcript viewer for a switched-into run (FR2).
 *
 * The no-upstream-SDK substitute for native reattach: a focused ctx.ui.custom
 * overlay that RENDERS the lane's currently-live child session's getBranch()
 * (in-memory, always current — never the lagging .jsonl) via the SDK's own
 * exported message components, re-rendered on every streaming tick. Strictly
 * read-only: it never swaps, disposes, or writes any session.
 *
 * It FOLLOWS the lane: as stages advance the registry's currentSession changes,
 * so the viewer re-subscribes to the new child; when the run is evicted (FR6) it
 * shows a terminal "finished" frame and waits for esc.
 *
 * Input split while this viewer is open (the lane is focused, Slice 6): esc/↑/↓ are
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
import { type RenderSource, renderBranch, type ToolDefArg, type ViewerEntry } from "./lane-transcript.js";
import { type DiskBranch, loadBranchFromDisk } from "./lane-transcript-disk.js";
import {
	getLane,
	type LaneEntry,
	type LaneSession,
	type LaneStatus,
	laneNeedsInput,
	subscribeLanes,
} from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;

/** Header glyph for a retained terminal lane (Phase A) — mirrors the overlay's STATUS_GLYPH. */
const TERMINAL_GLYPH: Partial<Record<LaneStatus, string>> = {
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};

export class LaneViewer implements Component {
	private scrollOffset = 0;
	/** Collapsed by default (keeps the overlay short); `t` toggles every tool/summary
	 *  component's expanded state, mirroring interactive-mode's tool-output toggle. */
	private toolsExpanded = false;
	private currentSession: LaneSession | undefined;
	private sessionUnsub: (() => void) | undefined;
	private readonly registryUnsub: () => void;
	/** Disk-jsonl fallback (Problem 2) parsed ONCE and cached by file key — render runs
	 *  synchronously every streaming tick, so the disk read must not repeat per frame. */
	private diskCache: { key: string; value: DiskBranch | undefined } | undefined;

	constructor(
		private readonly runId: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (intent: "answer" | "back") => void,
	) {
		this.currentSession = getLane(runId)?.currentSession;
		this.sessionUnsub = this.currentSession?.subscribe(() => this.tui.requestRender());
		// Follow the lane across stage transitions + detect eviction.
		this.registryUnsub = subscribeLanes(() => this.syncSession());
	}

	/** Re-point to the lane's current child if it changed; always re-render. */
	private syncSession(): void {
		const next = getLane(this.runId)?.currentSession;
		if (next !== this.currentSession) {
			this.sessionUnsub?.();
			this.currentSession = next;
			this.sessionUnsub = next?.subscribe(() => this.tui.requestRender());
		}
		this.tui.requestRender();
	}

	/** Disk-jsonl transcript fallback (Problem 2), memoized by `runId::lastSessionFile`
	 *  so the synchronous per-tick render re-reads disk at most once per source. */
	private loadDiskBranch(lane: LaneEntry): DiskBranch | undefined {
		const key = `${this.runId}::${lane.lastSessionFile ?? ""}`;
		if (this.diskCache?.key !== key) {
			this.diskCache = { key, value: loadBranchFromDisk(this.runId, lane.lastSessionFile) };
		}
		return this.diskCache.value;
	}

	render(width: number): string[] {
		const lane = getLane(this.runId);
		if (!lane) return this.frame([this.theme.fg("dim", "(run dismissed — esc to return)")], width);
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
			} else if (lane.finalBranch !== undefined) {
				// Phase A — terminated run: the live session is gone, render the snapshot,
				// and resolve cwd + tool defs from what retireRun captured (Phase 4).
				entries = (lane.finalBranch as ViewerEntry[]) ?? [];
				const defs = lane.finalToolDefs;
				source = {
					cwd: lane.finalCwd ?? "",
					toolDef: (name) => defs?.get(name) as ToolDefArg,
				};
			} else {
				// No live session + no in-memory snapshot — fall through to the on-disk jsonl
				// (Problem 2 durable path) before giving up: live → finalBranch → disk → none.
				const disk = this.loadDiskBranch(lane);
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
		return this.frame(renderBranch(entries, width, source, this.tui, this.theme, this.toolsExpanded), width);
	}

	/** Header + bottom-anchored windowed body + footer. scrollOffset 0 = newest (tail). */
	private frame(body: string[], width: number): string[] {
		const lane = getLane(this.runId);
		const name = lane?.name ?? this.runId;
		// Live runs read "▶ name — live"; a retained terminal run reflects its outcome,
		// and a failed/aborted run appends its full cause (Problem 1) — "✗ ship — failed:
		// <reason>" — truncated to width by the header truncate below.
		const glyph = lane ? (TERMINAL_GLYPH[lane.status] ?? "•") : "•";
		const headText =
			!lane || lane.status === "running"
				? `▶ ${name} — live`
				: lane.error
					? `${glyph} ${name} — ${lane.status}: ${lane.error}`
					: `${glyph} ${name} — ${lane.status}`;
		const header = truncateToWidth(this.theme.fg("accent", headText), width, "…");
		// A queued question is answered IN PLACE with ⏎ (switchIntoLane drains only on the
		// "answer" intent); esc/← back out without draining, so the view verb and the answer
		// verb never share a key. Advertise both on a needs-input lane.
		const needs = laneNeedsInput(this.runId);
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
		if (matchesKey(data, Key.enter) && laneNeedsInput(this.runId)) {
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
export function showLaneViewer(ui: ExtensionUIContext, runId: string): Promise<"answer" | "back"> {
	return ui.custom<"answer" | "back">((tui, theme, _kb, done) => new LaneViewer(runId, tui, theme, done), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "90%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
