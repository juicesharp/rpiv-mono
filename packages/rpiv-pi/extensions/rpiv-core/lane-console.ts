/**
 * lane-console — the unified, always-on lane console: ONE focused overlay that is the
 * SOLE transcript surface for a switched-into lane unit. It renders the lane's live
 * transcript read-only (full-height band) and, the instant a question is queued for its
 * unit (`peekInput` non-empty), mounts the parked ask_user_question INLINE beneath the
 * transcript — no overlay swap. Answering commits that child and advances to the next
 * queued question in place; `esc`/`←` back out (leaving any still-queued question
 * deferred). This replaces the old read-only transcript viewer + per-question drain loop.
 *
 * The deferred question is a captured `{factory, options, resolve}` (run-lane-registry
 * PendingInput). We instantiate `head.factory` against a `cappedTui` whose `terminal.rows`
 * reports the question's ALLOCATED band, so the questionnaire self-windows via its own
 * 3-region scroller (build-questionnaire.ts:105 reads getTerminalRows) with NO change to
 * the ask-user-question package. The console is therefore generic over ANY deferred
 * overlay factory.
 *
 * Both modes render exactly `maxRows` lines so the surface never changes shape when a
 * question mounts/unmounts (ghost-block safety, the chain 56af2f9/cdcf3ee/c0797b6); a
 * full repaint is forced on every mount / commit / back-out. Input: esc always backs out
 * (queued question stays deferred); `←` backs out only in read-only mode; PageUp/PageDown
 * scroll the transcript; in read-only mode `↑/↓` scroll and `t` toggles tool expansion;
 * in question mode everything else → the embedded questionnaire (arrows/space/tab/enter/
 * text/Ctrl+]).
 */

import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { LaneTranscriptView } from "./lane-transcript-view.js";
import { formatTokens, type LaneUsage } from "./lane-usage.js";
import {
	dequeueInput,
	getLane,
	getUnit,
	type LaneStatus,
	type PendingInput,
	peekInput,
	subscribeLanes,
	unitUsage,
} from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;
/** Guaranteed transcript rows in question mode — the question never fully squeezes the
 *  context out; also the PageUp/PageDown page size. */
const TRANSCRIPT_MIN = 4;

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
 * Full token-detail suffix for the console header — the footer.js omit-when-zero segment
 * set `↑in ↓out R W CH% $cost`, formatted via formatTokens. Console-local (not exported):
 * the lane DOCK renders a different, compact tally, so a shared full-detail formatter would
 * be console-only and is not factored into lane-usage.ts.
 *
 *   • "" when usage is undefined (running unit / parent row / not yet captured)
 *   • each of ↑in ↓out R W pushed only when nonzero (footer.js omit-when-zero)
 *   • CH% : `CH${percent.toFixed(1)}%` for a numeric percent; omitted for null/undefined
 *   • $cost: `$${cost.toFixed(3)}` when nonzero; omitted otherwise
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

/**
 * A TUI proxy that reports a capped `terminal.rows` (the embedded questionnaire's
 * allocated band) while forwarding everything else — requestRender, columns, cursor.
 * DialogView reads getTerminalRows() → tui.terminal.rows at render time, so this makes
 * the questionnaire self-window to its band with no ask-user-question change.
 */
export function cappedTui(real: TUI, rows: () => number): TUI {
	const terminal = new Proxy(real.terminal as object, {
		get(t, p) {
			if (p === "rows") return Math.max(1, rows());
			const v = Reflect.get(t, p, t);
			return typeof v === "function" ? v.bind(t) : v;
		},
	}) as TUI["terminal"];
	return new Proxy(real, {
		get(t, p) {
			if (p === "terminal") return terminal;
			const v = Reflect.get(t, p, t);
			return typeof v === "function" ? v.bind(t) : v;
		},
	});
}

export class LaneConsole implements Component {
	private scrollOffset = 0;
	/** `t` toggles tool/summary expansion in read-only mode (viewer parity). */
	private toolsExpanded = false;
	private readonly transcript: LaneTranscriptView;
	private readonly registryUnsub: () => void;
	/** Question-band budget; read by cappedTui BEFORE inner.render each frame. */
	private readonly budgetRef = { rows: 1 };
	/** The mounted questionnaire (question mode) or undefined (read-only). */
	private inner: Component | undefined;
	/** The queue head `inner` was built from — the identity guard so we never remount the
	 *  same question or forward keystrokes to a torn-down child. */
	private mountedFor: PendingInput | undefined;
	private resolved = false; // esc/back resolves the overlay once

	constructor(
		private readonly runId: string,
		private readonly unitIndex: number,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly kb: KeybindingsManager,
		private readonly done: () => void,
	) {
		this.transcript = new LaneTranscriptView(runId, unitIndex, tui, theme);
		// Re-render on any registry change AND reconcile the mounted question with the queue
		// head (a follow-up question arrives, or retire/evict drains it out from under us).
		this.registryUnsub = subscribeLanes(() => this.sync());
		this.sync(); // mount now if a question is already queued (the ⏎/→-on-flagged-lane case)
	}

	/** Reconcile the mounted questionnaire with the head of THIS unit's queue. */
	private sync(): void {
		const head = peekInput(this.runId, this.unitIndex);
		if (head !== this.mountedFor) {
			if (head) this.mountInner(head);
			else this.unmountInner(); // queue drained (answered / retire / evict) → read-only
		}
		this.tui.requestRender();
	}

	/** Build the questionnaire against a capped tui; guard against a stale async result. */
	private mountInner(head: PendingInput): void {
		this.mountedFor = head;
		this.scrollOffset = 0; // land on the newest tail beside the new question
		const onDone = (result: unknown) => this.commit(result);
		Promise.resolve(
			head.factory(
				cappedTui(this.tui, () => this.budgetRef.rows),
				this.theme,
				this.kb,
				onDone,
			),
		).then((c) => {
			if (this.mountedFor === head) {
				this.inner = c as Component;
				this.tui.requestRender(true); // surface gains the question band — full repaint
			}
		});
	}

	private unmountInner(): void {
		(this.inner as { dispose?: () => void } | undefined)?.dispose?.(); // no-op for the questionnaire
		this.inner = undefined;
		this.mountedFor = undefined;
	}

	/** Answer committed: dequeue + resolve THIS child exactly once (head === mountedFor,
	 *  and only the console dequeues), then advance to the next queued question or read-only.
	 *  Order matters: `dequeueInput` notifies SYNCHRONOUSLY (run-lane-registry notify() fires
	 *  listeners inline), so our own subscribeLanes→sync() re-enters mid-commit. Unmount FIRST
	 *  (mountedFor=undefined) so that re-entrant sync() mounts the next head exactly once; the
	 *  trailing sync() is then a no-op (head === mountedFor). If we dequeued before unmounting,
	 *  sync() would fire once here AND again below → the next question's factory builds twice. */
	private commit(result: unknown): void {
		this.unmountInner(); // mountedFor=undefined BEFORE the dequeue notify re-enters sync()
		dequeueInput(this.runId, this.unitIndex)?.resolve(result);
		this.tui.requestRender(true);
		this.sync(); // peek the next question (or read-only) — no-op if the notify already advanced us
	}

	/** Resolve the overlay once; force a full repaint because the surface collapses (cdcf3ee). */
	private finish(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.tui.requestRender(true);
		this.done();
	}

	render(width: number): string[] {
		const realRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(8, Math.floor(realRows * MAX_HEIGHT_RATIO));
		// `available` = rows between the header and the final row. BOTH modes total
		// `available + 2`, so the surface height never changes when a question mounts /
		// unmounts — the constant-height invariant now spans the read-only↔question switch,
		// including tiny terminals where the TRANSCRIPT_MIN+1 floor bites.
		const available = Math.max(TRANSCRIPT_MIN + 1, maxRows - 2);
		const header = this.header(width);
		const body = this.transcript.renderBody(width, this.toolsExpanded);
		if (!this.inner) {
			// Read-only: transcript fills `available` rows; total = header + available + footer.
			return [header, ...this.windowTranscript(body, available, width), this.footer(width)];
		}
		// Question mode: header + transcript band + divider + question; total = available + 2.
		this.budgetRef.rows = available - TRANSCRIPT_MIN; // cappedTui reads this BEFORE inner.render
		const qLines = this.inner.render(width);
		const q = Math.min(qLines.length, available - TRANSCRIPT_MIN);
		return [header, ...this.windowTranscript(body, available - q, width), this.divider(width), ...qLines.slice(0, q)];
	}

	/** Bottom-anchored, padded-to-`rows` transcript window. scrollOffset 0 = newest tail;
	 *  padding keeps total height constant so the surface never changes shape while
	 *  scrolling (ghost-block avoidance). */
	private windowTranscript(body: string[], rows: number, _width: number): string[] {
		const excess = Math.max(0, body.length - rows);
		if (this.scrollOffset > excess) this.scrollOffset = excess;
		const start = excess - this.scrollOffset;
		const window = body.slice(start, start + rows);
		while (window.length < rows) window.push(""); // pad — constant height
		return window;
	}

	/** The viewer's status header: "▶ name — live" for a running unit/lane, the terminal
	 *  glyph + status (+ cause) for a retired one, plus the formatUsageDetail suffix and a
	 *  " ↑older" marker when scrolled. In question mode the right side carries the defer
	 *  hint (read-only mode carries its hint in the footer instead). */
	private header(width: number): string {
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
			// and a failed/aborted run appends its full cause, truncated to width below.
			const glyph = lane ? (TERMINAL_GLYPH[lane.status] ?? "•") : "•";
			headText =
				!lane || lane.status === "running"
					? `▶ ${name} — live`
					: lane.error
						? `${glyph} ${name} — ${lane.status}: ${lane.error}`
						: `${glyph} ${name} — ${lane.status}`;
		}
		const detail = formatUsageDetail(unitUsage(unit));
		if (detail) headText = `${headText}  ${detail}`;
		if (this.scrollOffset > 0) headText = `${headText} ↑older`;
		if (this.inner) {
			// Question mode: right-align the defer hint.
			const hint = "PgUp/PgDn scroll · esc defer";
			const left = truncateToWidth(this.theme.fg("accent", headText), Math.max(0, width - hint.length - 1), "…");
			const pad = Math.max(1, width - visibleWidth(left) - hint.length);
			return left + " ".repeat(pad) + this.theme.fg("dim", hint);
		}
		return truncateToWidth(this.theme.fg("accent", headText), width, "…");
	}

	/** Read-only mode footer — the viewer's scroll/expand/back hint. */
	private footer(width: number): string {
		const toggle = this.toolsExpanded ? "t collapse" : "t expand";
		return truncateToWidth(this.theme.fg("dim", `↑/↓ scroll · ${toggle} · esc back`), width, "…");
	}

	private divider(width: number): string {
		return this.theme.fg("dim", "─".repeat(Math.max(0, width)));
	}

	handleInput(data: string): void {
		// esc always backs out (any queued question stays deferred). ← backs out only in
		// read-only mode — in question mode ← is the questionnaire's (option/tab nav).
		// esc is remapped from the questionnaire's own "Esc to cancel" to defer (non-
		// destructive); cancel stays reachable via the submit-tab Cancel choice (or dock-x).
		if (matchesKey(data, Key.escape) || (matchesKey(data, Key.left) && !this.inner)) {
			this.finish();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset += TRANSCRIPT_MIN; // reveal older
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - TRANSCRIPT_MIN);
			this.tui.requestRender();
			return;
		}
		if (this.inner) {
			this.inner.handleInput?.(data); // question mode: everything else → the questionnaire
			return;
		}
		// Read-only mode: viewer-style single-line scroll + tool toggle.
		if (matchesKey(data, Key.up)) {
			this.scrollOffset += 1;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
		} else if (data === "t") {
			this.toolsExpanded = !this.toolsExpanded;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.inner?.invalidate?.();
	}

	dispose(): void {
		this.registryUnsub();
		this.transcript.dispose();
		this.unmountInner();
	}
}

/**
 * Open the unified console for `(runId, unitIndex)`. Resolves when the user backs out
 * (esc/←). The console mounts/commits/advances questions itself off the unit's FIFO —
 * read-only transcript when the queue is empty, question band inline when one is queued.
 */
export function showLaneConsole(ui: ExtensionUIContext, runId: string, unitIndex: number): Promise<void> {
	return ui.custom<void>((tui, theme, kb, done) => new LaneConsole(runId, unitIndex, tui, theme, kb, () => done()), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "90%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
