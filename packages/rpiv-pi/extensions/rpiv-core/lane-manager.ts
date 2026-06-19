/**
 * lane-manager — focused ctx.ui.custom lane picker (FR4).
 *
 * Lists the root (launcher) lane + each in-flight run lane with live status, and
 * resolves with the user's selection. Strict-LIFO-safe: it RESOLVES on ⏎ (it does
 * NOT open the viewer itself) — the switcher opens the viewer AFTER the manager
 * overlay has closed, so two overlays never stack (sidesteps showExtensionCustom's
 * topmost-pop hideOverlay). The per-run abort tap is focus-gated (run-lane-registry
 * getFocusedRun): while the manager is open NO run is focused yet, so the tap is
 * dormant and esc here dismisses the manager normally — Ctrl-C only starts aborting
 * a run once the user has switched into a lane (the switcher sets focus around the viewer).
 */

import type { ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type LaneEntry,
	laneNeedsInput,
	listLanesForDisplay,
	shortRunId,
	subscribeLanes,
} from "./run-lane-registry.js";

const MAX_HEIGHT_RATIO = 0.85;

/** What the manager resolves with: switch into a run (⏎), cancel a running lane or
 *  remove a finished one (x, Phase D), dismiss to root (esc), or fall back to the
 *  always-mounted ambient overlay (tab). */
export type ManagerResult =
	| { kind: "switch"; runId: string }
	| { kind: "cancel"; runId: string }
	| { kind: "remove"; runId: string }
	| { kind: "dismiss" }
	| { kind: "ambient" };

export class LaneManager implements Component {
	private selectedIndex = 0; // 0 = root lane; 1.. = listLanes()[index-1]
	private lanes: LaneEntry[];
	private readonly registryUnsub: () => void;

	constructor(
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (result: ManagerResult) => void,
	) {
		this.lanes = listLanesForDisplay();
		this.registryUnsub = subscribeLanes(() => {
			this.lanes = listLanesForDisplay();
			if (this.selectedIndex > this.lanes.length) this.selectedIndex = this.lanes.length;
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const truncate = (l: string): string => truncateToWidth(l, width, "…");
		const lines: string[] = [truncate(this.theme.fg("accent", "Lanes"))];
		lines.push(truncate(this.row(0, "◆ root (launcher)", "dim")));
		this.lanes.forEach((lane, i) => {
			const needs = laneNeedsInput(lane.runId);
			const glyph = needs ? "⚑" : lane.status === "running" ? "▶" : "•";
			const label = `${glyph} ${lane.name}  ${shortRunId(lane.runId)}  ${needs ? "needs input" : lane.status}`;
			lines.push(truncate(this.row(i + 1, label, needs ? "warning" : "muted")));
		});
		lines.push(truncate(this.theme.fg("dim", "↑/↓ move · ⏎ switch · x stop · esc root · tab ambient")));
		return this.clip(lines);
	}

	private row(index: number, text: string, color: ThemeColor): string {
		const selected = index === this.selectedIndex;
		const body = `${selected ? "› " : "  "}${text}`;
		return selected ? this.theme.fg("accent", body) : this.theme.fg(color, body);
	}

	private clip(lines: string[]): string[] {
		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(4, Math.floor(termRows * MAX_HEIGHT_RATIO));
		return lines.length <= maxRows ? lines : lines.slice(0, maxRows);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done({ kind: "dismiss" });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.done({ kind: "ambient" });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.lanes.length, this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedIndex === 0) {
				this.done({ kind: "dismiss" }); // root — already home
				return;
			}
			const lane = this.lanes[this.selectedIndex - 1];
			this.done(lane ? { kind: "switch", runId: lane.runId } : { kind: "dismiss" });
			return;
		}
		// Phase D — `x` on a selected lane: cancel a running run (abort without switching
		// in) or remove a finished one (dismiss the retained lane). No-op on the root row.
		if (data === "x" && this.selectedIndex > 0) {
			const lane = this.lanes[this.selectedIndex - 1];
			if (lane)
				this.done(
					lane.status === "running"
						? { kind: "cancel", runId: lane.runId }
						: { kind: "remove", runId: lane.runId },
				);
		}
	}

	invalidate(): void {
		// render recomputes from live registry state each cycle
	}

	dispose(): void {
		this.registryUnsub();
	}
}

/** Open the focused lane manager; resolves with the user's selection. */
export function showLaneManager(ui: ExtensionUIContext): Promise<ManagerResult> {
	return ui.custom<ManagerResult>((tui, theme, _kb, done) => new LaneManager(theme, tui, done), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "85%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	});
}
