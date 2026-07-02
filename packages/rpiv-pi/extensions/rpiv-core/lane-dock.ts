/**
 * lane-dock — the always-mounted ambient lane dock rendered BELOW the editor.
 *
 * Lifecycle controller for Pi's setWidget contract (placement: "belowEditor"),
 * mirroring TodoOverlay: register-once factory, requestRender() refresh, height-stable
 * single-line rows with a fixed budget + "+N below" collapse, auto-hide when no runs are
 * in-flight. Reads live state from the run-lane registry at render time (never a stale
 * snapshot). The dock is a pure read-only lane GLANCE — live output lives in the stepped-in
 * lane browser (lane-console), not here.
 *
 * The lane rows themselves are rendered by the SHARED renderer (lane-list.ts) so a row is
 * byte-for-byte identical to the browser's bottom-pinned lane block — that shared renderer is
 * what keeps the lane view static across the ambient↔stepped-in transition. The dock owns only
 * the widget lifecycle (registration, spinner/heartbeat timers, forced-redraw gating) and its
 * own ambient discoverability footer (`↓ step in · /lanes`); it is always ambient
 * (`active:false`), so the `❯` selection cursor is never drawn here.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	computeLaneLayout,
	FALLBACK_ROWS,
	NEEDS_INPUT_TICK_MS,
	renderLaneList,
	SPIN_INTERVAL_MS,
	SPINNER_FRAMES,
} from "./lane-list.js";
import { type LaneEntry, laneNeedsInput, listLanes, listLanesForDisplay } from "./run-lane-registry.js";

const WIDGET_KEY = "rpiv-lanes";
/** Ambient discoverability footer — surfaces how to step in with the two self-explanatory
 *  gestures only: ↓ from an empty prompt, or the always-available /lanes command. The `^Q`
 *  hotkey still steps in (lane-switcher) but is intentionally NOT advertised here. */
const DEFAULT_FOOTER_TEXT = "↓ step in · /lanes";

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
	/** Last height-shape signature (see shapeSignature) — drives the forced-redraw decision in
	 *  update(). undefined until the widget mounts (re-seeded on (re)registration). */
	private lastShapeSig: string | undefined;
	/** While true the dock unregisters its widget regardless of lane presence — set around the
	 *  in-flow lane browser (lane-console), which renders the same lane block itself in the
	 *  editor slot; an ambient dock below it would be a duplicate. */
	private suppressed = false;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/** Hide/show the dock around an in-flow lane browser (see `suppressed`). Idempotent. */
	setSuppressed(suppressed: boolean): void {
		if (suppressed === this.suppressed) return;
		this.suppressed = suppressed;
		this.update();
	}

	update(): void {
		if (!this.uiCtx) return;
		const lanes = listLanes();
		this.syncSpinner(lanes); // start/stop the repaint timer with running-lane presence
		this.syncHeartbeat(lanes); // start/stop the aging heartbeat with needs-input presence
		if (lanes.length === 0 || this.suppressed) {
			// No lanes (nothing to glance at) or an in-flow browser owns the lane block → hide.
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
					// Re-seed the shape baseline now that the TUI (and its terminal size) is known, so
					// the first post-mount update() doesn't see a FALLBACK → real termRows change and
					// force a spurious full redraw.
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
			this.lastShapeSig = this.shapeSignature();
		} else {
			// pi-tui's differential renderer mis-paints when this belowEditor widget changes HEIGHT
			// between frames (a fan-out stage transition swaps unit sub-rows), painting the taller
			// frame BELOW the shorter one and leaving a stale duplicate block. Forcing a full redraw
			// whenever the row shape changes resets previousLines so the grown frame paints clean.
			// Gated on the shape signature so spinner ticks and stable-shape progress notifies stay
			// cheap differential renders — only a structural height step pays for a clear.
			const sig = this.shapeSignature();
			const shapeChanged = sig !== this.lastShapeSig;
			this.lastShapeSig = sig;
			this.tui?.requestRender(shapeChanged);
		}
	}

	/** Lazy terminal-row read — `this.tui` is assigned by the widget factory before render;
	 *  FALLBACK_ROWS covers pre-mount / headless. */
	private getTerminalRows(): number {
		return (this.tui?.terminal as { rows?: number } | undefined)?.rows ?? FALLBACK_ROWS;
	}

	/**
	 * Cheap height-shape signature: termRows (a resize is a height step) plus the flattened
	 * display-row count. A change in either is a structural height step; the spinner frame is
	 * deliberately EXCLUDED (it changes every tick but the differential path absorbs it without
	 * artifacts). The dock is always ambient, so there is no selection dimension.
	 */
	private shapeSignature(): string {
		return `${this.getTerminalRows()}:${listLanesForDisplay().length}`;
	}

	/** Drive a repaint timer ONLY while ≥1 lane is running. `.unref()` so it never keeps the
	 *  process alive. */
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

	/** Drive a slow repaint heartbeat ONLY while ≥1 lane needs input — so a stalled run's
	 *  "needs input · Nm" heading ages visibly even when nothing streams. */
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

	private renderWidget(theme: Theme, width: number): string[] {
		const rows = listLanesForDisplay();
		if (rows.length === 0) return [];
		const { laneCap } = computeLaneLayout(this.getTerminalRows());
		// The lane block itself comes from the SHARED renderer — byte-for-byte the browser's rows.
		// The dock is a read-only ambient glance: never active, no selection cursor (active:false).
		const list = renderLaneList(theme, width, { active: false, selection: 0, frame: this.frame, laneCap });
		// Ambient discoverability footer (dim), indented one space — preceded by a blank (rhythm) and
		// followed by the bottom rule. Both always dim: no active-state accent term survives.
		const footer = truncateToWidth(` ${theme.fg("dim", DEFAULT_FOOTER_TEXT)}`, width, "…");
		const rule = theme.fg("dim", "─".repeat(Math.max(0, width)));
		return [...list, "", footer, rule];
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
		this.lastShapeSig = undefined;
	}
}
