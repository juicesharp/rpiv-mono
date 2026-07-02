/**
 * lane-console — the unified, focused lane BROWSER: ONE overlay that is the SOLE
 * stepped-in surface for every lane. Stepping in (↓ from an empty prompt, `^Q`, or
 * `/lanes`) opens it; it is not the belowEditor dock's active mode (the dock stays a
 * read-only ambient glance).
 *
 * Layout is the ambient dock's lane list, UNCHANGED, plus a live-output region on top —
 * so the lane view is static across the step-in. The bottom-pinned LANE BLOCK is rendered
 * by the SHARED renderer (lane-list.ts) with the SAME compact `laneCap` the dock uses, so a
 * row is byte-for-byte identical to the ambient one (the only delta is the `❯` cursor). The
 * browser spends its extra height (90% of the terminal) on the LIVE-OUTPUT region above the
 * lanes: a `── live output ──` labelled border, then the selected unit's transcript
 * unfurling upward, then any inline question. Arrows move the selection and the transcript
 * re-targets in place, so you see a lane's context the instant you land on it.
 *
 * When the selected unit has a queued `ask_user_question` (`peekInput` non-empty), the
 * questionnaire is mounted INLINE in the live-output region EAGERLY (so `this.inner` is built
 * and arming is instant — no async settle on the reveal) but NOT PAINTED until armed: the
 * render gate holds the band off in lane focus, so the surface is height-identical to
 * read-only and only the `⚑` needs-input badge + the `⏎ answer` footer cue that the selected
 * unit is answerable. Arming (`⏎`/`→`) flips to question focus — the band paints and the
 * questionnaire owns arrows/space/tab/text; `esc` hands keys back to the lanes and RE-HIDES
 * the band (the question stays deferred, not cancelled). Answering commits the child and
 * advances the unit's FIFO in place; a same-unit follow-up stays armed, but a genuine drain
 * or cross-lane re-sort returns to lane focus with the band hidden (the browser stays open —
 * you are never stranded, the lanes + transcript are still there).
 *
 * The deferred question is a captured `{factory, options, resolve}` (run-lane-registry
 * PendingInput). We instantiate `head.factory` against a `cappedTui` whose `terminal.rows`
 * reports the question's ALLOCATED band, so the questionnaire self-windows via its own
 * 3-region scroller (build-questionnaire.ts:105 reads getTerminalRows) with NO change to
 * the ask-user-question package. The console is therefore generic over ANY deferred
 * overlay factory.
 *
 * Height is CONSTANT: every frame totals exactly `maxRows` (90% of the terminal) — the
 * transcript is the ONLY variable-height band (it absorbs the question mount/unmount and the
 * lane-count changes), so the lane block never moves (the static-lanes + ghost-block
 * invariant, the chain 56af2f9/cdcf3ee/c0797b6); a full repaint is forced on every mount /
 * commit / re-target / focus flip.
 */

import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	computeLaneLayout,
	renderLaneList,
	renderLiveOutputBorder,
	SPIN_INTERVAL_MS,
	SPINNER_FRAMES,
} from "./lane-list.js";
import { LaneTranscriptView } from "./lane-transcript-view.js";
import {
	type DisplayRow,
	dequeueInput,
	evictRun,
	listLanes,
	listLanesForDisplay,
	type PendingInput,
	peekInput,
	retireRun,
	SINGLE_UNIT_KEY,
	subscribeLanes,
	unitNeedsInput,
} from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.9;
/** Guaranteed transcript rows — the question band never fully squeezes the context out; also
 *  the PageUp/PageDown page size. */
const TRANSCRIPT_MIN = 4;

/** The (runId, unitIndex) a display row addresses — a lane (parent) row resolves the
 *  reserved single-unit key; a unit sub-row resolves its own index. Mirrors the dock
 *  editor's resolveRow so the selection and its actions can't drift. */
interface Target {
	readonly runId: string;
	readonly unitIndex: number;
}

function resolveRow(row: DisplayRow | undefined): Target | undefined {
	if (!row) return undefined;
	if (row.kind === "unit") return { runId: row.lane.runId, unitIndex: row.unit.index };
	return { runId: row.lane.runId, unitIndex: SINGLE_UNIT_KEY };
}

function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.runId === b.runId && a.unitIndex === b.unitIndex;
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
	/** Index into listLanesForDisplay() — the ❯-marked spine row (clamped on every read). */
	private selection = 0;
	/** Two-level focus: "lanes" (arrows navigate the spine, the question is HIDDEN + inert —
	 *  the render gate holds the band off; ⏎/→ arms it) or "question" (the band paints and
	 *  arrows/text drive the mounted questionnaire; esc re-hides it and hands back). */
	private focus: "lanes" | "question" = "lanes";
	private scrollOffset = 0;
	/** `t` toggles tool/summary expansion in the transcript. */
	private toolsExpanded = false;
	/** The transcript view for the currently-selected unit; swapped on re-target. */
	private transcript: LaneTranscriptView | undefined;
	private transcriptTarget: Target | undefined;
	private readonly registryUnsub: () => void;
	/** Question-band budget; read by cappedTui BEFORE inner.render each frame. */
	private readonly budgetRef = { rows: 1 };
	/** The mounted questionnaire (selected unit has a queued question) or undefined. */
	private inner: Component | undefined;
	/** The queue head `inner` was built from — the identity guard so we never remount the
	 *  same question or forward keystrokes to a torn-down child. */
	private mountedFor: PendingInput | undefined;
	/** The unit `inner` was mounted for — captured so commit dequeues the RIGHT queue even
	 *  when the dequeue notify re-sorts the display rows out from under the selection. */
	private questionTarget: Target | undefined;
	private resolved = false; // esc/back resolves the overlay once
	/** Spinner animation frame for the shared lane rows; advanced by spinTimer while ≥1 lane runs. */
	private frame = 0;
	private readonly spinTimer: ReturnType<typeof setInterval>;

	constructor(
		runId: string,
		unitIndex: number,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly kb: KeybindingsManager,
		private readonly done: () => void,
	) {
		// Land on the row the user stepped in from (the dock's top / needs-input row), else 0.
		const rows = listLanesForDisplay();
		const idx = rows.findIndex((r) => sameTarget(resolveRow(r), { runId, unitIndex }));
		this.selection = idx >= 0 ? idx : 0;
		// Re-render on any registry change AND reconcile the selection / transcript target /
		// mounted question with the live display (a follow-up arrives, a lane retires or is
		// evicted, needs-input re-sorts the rows).
		this.registryUnsub = subscribeLanes(() => this.sync());
		this.sync(); // point the transcript + mount any already-queued question now
		// Animate the shared lane rows' running spinner (the transcript view repaints for the
		// SELECTED unit's stream, but sibling running lanes need this tick). Only repaints while a
		// lane is running; `.unref()` so it never keeps the process alive.
		this.spinTimer = setInterval(() => {
			if (listLanes().some((l) => l.status === "running")) {
				this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
				this.tui.requestRender();
			}
		}, SPIN_INTERVAL_MS);
		this.spinTimer.unref?.();
	}

	// ---------------------------------------------------------------------------
	// Reconciliation
	// ---------------------------------------------------------------------------

	/** Reconcile selection, transcript target, and the mounted questionnaire with the live
	 *  display rows. Called on construction and on every registry notify. */
	private sync(): void {
		const rows = listLanesForDisplay();
		if (rows.length === 0) {
			this.finish(); // last lane evicted/dismissed — nothing left to browse
			return;
		}
		if (this.selection > rows.length - 1) this.selection = rows.length - 1;
		const target = resolveRow(rows[this.selection]);
		this.retarget(target);
		// Mount / advance / drop the inline question against the SELECTED unit's queue head.
		const head = target ? peekInput(target.runId, target.unitIndex) : undefined;
		if (head !== this.mountedFor) {
			this.unmountInner(); // dispose the previous unit's question before (re)mounting
			if (head && target) this.mountInner(head, target); // queue drained → transcript only
		}
		this.tui.requestRender();
	}

	/** Point the transcript view at `target`, disposing the previous unit's view. No-op when
	 *  the target is unchanged (the common streaming-tick case); a real swap forces a full
	 *  repaint because the whole transcript band reflows (the dock's preview-re-target fix). */
	private retarget(target: Target | undefined): void {
		if (sameTarget(this.transcriptTarget, target)) return;
		this.transcript?.dispose();
		this.transcript = target
			? new LaneTranscriptView(target.runId, target.unitIndex, this.tui, this.theme)
			: undefined;
		this.transcriptTarget = target;
		this.scrollOffset = 0; // land on the newest tail of the newly-selected unit
		this.tui.requestRender(true);
	}

	/** Build the questionnaire against a capped tui; guard against a stale async result. */
	private mountInner(head: PendingInput, target: Target): void {
		this.mountedFor = head;
		this.questionTarget = target;
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
		this.questionTarget = undefined;
		if (this.focus === "question") this.focus = "lanes"; // the armed question vanished — return keys to the spine
	}

	/** Answer committed: dequeue + resolve THIS child exactly once (only the console
	 *  dequeues), then advance to the next queued question or back to lane focus.
	 *  Order matters: `dequeueInput` notifies SYNCHRONOUSLY (run-lane-registry notify() fires
	 *  listeners inline), so our own subscribeLanes→sync() re-enters mid-commit. Unmount FIRST
	 *  (mountedFor=undefined) so the re-entrant sync() mounts the next head exactly once; the
	 *  trailing sync() is then a no-op (head === mountedFor). If we dequeued before unmounting,
	 *  sync() would fire once here AND again below → the next question's factory builds twice.
	 *
	 *  The dequeue targets the CAPTURED questionTarget, not the live selection: the notify may
	 *  re-sort the display rows (the answered lane drops out of the needs-input bucket) between
	 *  unmount and dequeue, so `rows[selection]` is no longer the unit we answered. On a genuine
	 *  drain the browser STAYS OPEN in lane focus — you're never stranded, the spine + transcript
	 *  are still the surface (unlike the old single-unit console, which backed out to the dock). */
	private commit(result: unknown): void {
		const target = this.questionTarget;
		const stayArmed = this.focus === "question";
		this.unmountInner(); // mountedFor=undefined BEFORE the dequeue notify re-enters sync()
		if (target) dequeueInput(target.runId, target.unitIndex)?.resolve(result);
		// Same-unit follow-up (rare — ask_user_question is blocking): keep the question armed so a
		// queued run of answers walks without re-pressing ⏎. A drain, or a cross-lane re-sort that
		// moves the selection to a different unit, leaves focus on the spine (a fresh lane needs a
		// fresh arm — the arm-then-fire safety). Set AFTER the dequeue notify's re-entrant sync()
		// has already mounted the follow-up (unmountInner there reset focus to "lanes").
		if (stayArmed && target && peekInput(target.runId, target.unitIndex)) this.focus = "question";
		this.tui.requestRender(true);
		this.sync(); // peek the next question for the selected unit (or drop the band) — idempotent
	}

	/** Resolve the overlay once; force a full repaint because the surface collapses (cdcf3ee). */
	private finish(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.tui.requestRender(true);
		this.done();
	}

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------

	render(width: number): string[] {
		const realRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(8, Math.floor(realRows * MAX_HEIGHT_RATIO));
		const rows = listLanesForDisplay();
		// Defensive clamp — the row set can shrink between a sync() and this render().
		const selection = rows.length > 0 ? Math.min(this.selection, rows.length - 1) : 0;
		const target = resolveRow(rows[selection]);

		// Bottom-pinned LANE BLOCK — the SHARED renderer (lane-list), byte-for-byte the ambient
		// dock's rows plus the `❯` cursor. laneCap is the SAME compact budget the dock uses, so the
		// block is identical (the browser spends its extra height on live output, not a taller list)
		// — this is what keeps the lane view static across the step-in.
		const { laneCap } = computeLaneLayout(realRows);
		const laneList = renderLaneList(this.theme, width, { active: true, selection, frame: this.frame, laneCap });
		const rule = this.theme.fg("accent", "─".repeat(Math.max(0, width)));
		const laneBlock = [...laneList, "", this.footer(width, target), rule];

		// LIVE OUTPUT region on top: a `── live output ──` labelled border, then the transcript
		// (the padded flex band that unfurls upward), then the inline question when the selected
		// unit has one. The transcript is the only variable-height band, so the total stays exactly
		// maxRows and the lane block never moves (the static-lanes + ghost-block invariant).
		const border = renderLiveOutputBorder(this.theme, width);
		let qLines: string[] = [];
		let q = 0;
		// The arm-gate: paint the question band ONLY in question focus. In lane focus the
		// questionnaire is mounted (ready to arm) but held off, so the surface is height-
		// identical to read-only — the `⚑` badge + `⏎ answer` footer are the only cue.
		if (this.inner && target && unitNeedsInput(target.runId, target.unitIndex) && this.focus === "question") {
			this.budgetRef.rows = Math.max(
				0,
				maxRows - laneBlock.length - 1 /*border*/ - 1 /*q divider*/ - TRANSCRIPT_MIN,
			);
			qLines = this.inner.render(width);
			q = Math.min(qLines.length, this.budgetRef.rows);
		}
		const hasQuestion = q > 0;
		const transcriptRows = Math.max(0, maxRows - laneBlock.length - 1 - (hasQuestion ? q + 1 : 0));

		const body = this.transcript?.renderBody(width, this.toolsExpanded) ?? [];
		const out: string[] = [border, ...this.windowTranscript(body, transcriptRows)];
		if (hasQuestion) {
			out.push(this.divider(width));
			out.push(...qLines.slice(0, q));
		}
		out.push(...laneBlock);
		return out;
	}

	/** Bottom-anchored, padded-to-`rows` transcript window. scrollOffset 0 = newest tail;
	 *  padding keeps total height constant so the surface never changes shape while
	 *  scrolling or re-targeting (ghost-block avoidance). */
	private windowTranscript(body: string[], rows: number): string[] {
		if (rows <= 0) return [];
		const excess = Math.max(0, body.length - rows);
		if (this.scrollOffset > excess) this.scrollOffset = excess;
		const start = excess - this.scrollOffset;
		const window = body.slice(start, start + rows);
		while (window.length < rows) window.push(""); // pad — constant height
		return window;
	}

	/** Footer hint — the navigation contract, gated on focus and the selected unit's state.
	 *  This is the browser's own footer (its actions differ from the ambient dock's); the lane
	 *  rows above it are the shared, static renderer. */
	private footer(width: number, target: Target | undefined): string {
		if (this.focus === "question") {
			return truncateToWidth(this.theme.fg("dim", "esc → lanes · answer in the question above"), width, "…");
		}
		const canAnswer = target && unitNeedsInput(target.runId, target.unitIndex);
		const scrolled = this.scrollOffset > 0 ? "PgDn newest · " : "";
		const toggle = this.toolsExpanded ? "t collapse" : "t expand";
		const answer = canAnswer ? "⏎ answer · " : "";
		return truncateToWidth(
			this.theme.fg("dim", `↑/↓ lanes · ${answer}${scrolled}PgUp/PgDn scroll · ${toggle} · x stop · ↑/←/esc back`),
			width,
			"…",
		);
	}

	private divider(width: number): string {
		return this.theme.fg("dim", "─".repeat(Math.max(0, width)));
	}

	// ---------------------------------------------------------------------------
	// Input
	// ---------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.focus === "question") {
			// esc hands keys back to the spine (the question stays deferred). PageUp/PageDown
			// scroll the transcript (reserved). Everything else → the mounted questionnaire.
			if (matchesKey(data, Key.escape)) {
				this.focus = "lanes";
				this.tui.requestRender(true);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.scroll(TRANSCRIPT_MIN);
			} else if (matchesKey(data, Key.pageDown)) {
				this.scroll(-TRANSCRIPT_MIN);
			} else {
				this.inner?.handleInput?.(data); // everything else → the mounted questionnaire
			}
			return;
		}
		// Lane focus: arrows navigate the spine; esc/← back out of the browser.
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			this.finish();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selection === 0)
				this.finish(); // top row → back out (restored gesture)
			else this.move(-1); // mid-spine → navigate up, unchanged
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll(TRANSCRIPT_MIN);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll(-TRANSCRIPT_MIN);
			return;
		}
		// ⏎/→ arm the selected unit's queued question (inert → hot). Inert when nothing is
		// queued — the transcript is already shown, so there is no separate "open" verb.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.inner) {
				this.focus = "question";
				this.tui.requestRender(true);
			}
			return;
		}
		if (data === "x") {
			this.stopSelected();
			return;
		}
		if (data === "t") {
			this.toolsExpanded = !this.toolsExpanded;
			this.tui.requestRender();
		}
	}

	/** Move the spine selection (clamped) and reconcile via sync() — the single seam that
	 *  re-targets the transcript and mounts the newly-selected unit's question. */
	private move(delta: number): void {
		const rows = listLanesForDisplay();
		if (rows.length === 0) return;
		const next = Math.max(0, Math.min(rows.length - 1, this.selection + delta));
		if (next === this.selection) return;
		this.selection = next;
		this.sync(); // retarget + question-reconcile; retarget forces the reflow repaint
	}

	private scroll(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.tui.requestRender();
	}

	/** `x` targets the selected row's PARENT run (no per-unit abort), mirroring the dock: abort
	 *  a running run then optimistically retire it, or evict a finished/retained one. sync()
	 *  re-clamps the selection (and finishes if that was the last lane). */
	private stopSelected(): void {
		const rows = listLanesForDisplay();
		const row = rows[this.selection];
		if (!row) return;
		const lane = row.lane;
		if (lane.status === "running") {
			lane.abort?.();
			retireRun(lane.runId, "aborted");
		} else {
			evictRun(lane.runId);
		}
		// retire/evict notify()s → sync() runs; force a repaint for the structural change.
		this.tui.requestRender(true);
	}

	invalidate(): void {
		this.inner?.invalidate?.();
	}

	dispose(): void {
		clearInterval(this.spinTimer);
		this.registryUnsub();
		this.transcript?.dispose();
		this.unmountInner();
	}
}

/**
 * Open the unified lane browser starting on `(runId, unitIndex)` (the row the user stepped
 * in from). Resolves when the user backs out (esc/←) or the last lane is dismissed. The
 * browser navigates lanes, re-targets the transcript, and mounts/commits/advances each
 * unit's question FIFO itself.
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
