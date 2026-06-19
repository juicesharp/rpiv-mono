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
 * ToolExecutionComponent is
 * too heavy to reconstruct from a branch (needs ToolDefinition/ui/cwd + staged
 * call/result), so tool results + non-message entries collapse to one dim line.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionUIContext,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { getLane, type LaneSession, type LaneStatus, laneNeedsInput, subscribeLanes } from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;

/** Header glyph for a retained terminal lane (Phase A) — mirrors the overlay's STATUS_GLYPH. */
const TERMINAL_GLYPH: Partial<Record<LaneStatus, string>> = {
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
	cancelled: "⊘",
};

/** Local narrowing of getBranch()'s entry shape (mirrors rpiv-workflow transcript.ts:BranchEntry). */
interface ViewerEntry {
	type: string;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string; name?: string }>;
		stopReason?: string;
	};
}

export class LaneViewer implements Component {
	private scrollOffset = 0;
	private currentSession: LaneSession | undefined;
	private sessionUnsub: (() => void) | undefined;
	private readonly registryUnsub: () => void;

	constructor(
		private readonly runId: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
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

	render(width: number): string[] {
		const lane = getLane(this.runId);
		if (!lane) return this.frame([this.theme.fg("dim", "(run dismissed — esc to return)")], width);
		const session = this.currentSession;
		let entries: ViewerEntry[];
		try {
			if (session) {
				entries = (session.sessionManager.getBranch() as ViewerEntry[] | undefined) ?? [];
			} else if (lane.finalBranch !== undefined) {
				// Phase A — terminated run: the live session is gone, render the snapshot.
				entries = (lane.finalBranch as ViewerEntry[]) ?? [];
			} else if (lane.status === "running") {
				return this.frame([this.theme.fg("dim", "(stage starting…)")], width); // between stages
			} else {
				return this.frame([this.theme.fg("dim", "(no transcript — esc to return)")], width);
			}
		} catch {
			// disposed mid-render / unexpected shape — fail soft (never throw inside the overlay)
			return this.frame([this.theme.fg("dim", "(transcript unavailable)")], width);
		}
		const body: string[] = [];
		for (const e of entries) body.push(...this.renderEntry(e, width));
		return this.frame(body, width);
	}

	private renderEntry(e: ViewerEntry, width: number): string[] {
		if (e.type !== "message" || !e.message) return [];
		const { role, content } = e.message;
		try {
			if (role === "assistant") {
				return new AssistantMessageComponent(e.message as unknown as AssistantMessage).render(width);
			}
			if (role === "user") {
				const text = (content ?? [])
					.filter((p) => p.type === "text" && typeof p.text === "string")
					.map((p) => p.text)
					.join("\n")
					.trim();
				if (text) return new UserMessageComponent(text).render(width);
				return [truncateToWidth(this.theme.fg("dim", "└ tool result"), width, "…")]; // tool_result / non-text
			}
		} catch {
			// component construction/render hiccup on an unexpected message shape — compact fallback
		}
		return [truncateToWidth(this.theme.fg("dim", `· ${role ?? e.type}`), width, "…")];
	}

	/** Header + bottom-anchored windowed body + footer. scrollOffset 0 = newest (tail). */
	private frame(body: string[], width: number): string[] {
		const lane = getLane(this.runId);
		const name = lane?.name ?? this.runId;
		// Live runs read "▶ name — live"; a retained terminal run reflects its outcome.
		const headText =
			!lane || lane.status === "running"
				? `▶ ${name} — live`
				: `${TERMINAL_GLYPH[lane.status] ?? "•"} ${name} — ${lane.status}`;
		const header = truncateToWidth(this.theme.fg("accent", headText), width, "…");
		// When the lane has a queued question, esc closes the viewer AND surfaces it
		// (switchIntoLane drains after the viewer resolves) — so advertise "esc to answer".
		const needs = laneNeedsInput(this.runId);
		const footer = truncateToWidth(
			this.theme.fg(needs ? "warning" : "dim", needs ? "↑/↓ scroll · esc to answer" : "↑/↓ scroll · esc back"),
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
		if (matchesKey(data, Key.escape)) {
			this.done();
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
 * Open the viewer as a focused overlay (mirror showBtwOverlay). The focused lane
 * manager (Phase 5) calls this on ⏎; resolves when the user presses esc.
 */
export function showLaneViewer(ui: ExtensionUIContext, runId: string): Promise<void> {
	return ui.custom<void>((tui, theme, _kb, done) => new LaneViewer(runId, tui, theme, done), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "90%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
