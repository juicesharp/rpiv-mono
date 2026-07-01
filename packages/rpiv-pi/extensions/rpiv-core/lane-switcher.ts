/**
 * lane-switcher — composition for the parallel-run lane switcher.
 *
 * The launcher (root) owns this: it mounts the always-on lane DOCK below the editor
 * on the captured launcher UI, subscribes it to the run-lane registry so it
 * re-renders as runs start / finish / need input, and installs the LaneDockEditor —
 * the input editor that proxies arrow/enter/tab/x keys into the dock's navigation
 * (widgets can't take focus; the editor is the only component reliably reached at
 * the idle prompt). `/lanes` and the `^Q` hotkey simply step INTO the dock. When the
 * user opens a run (→ or ⏎), switchIntoLane opens the UNIFIED console on the real UI —
 * the lane's transcript read-only, with any queued question mounted inline; the console
 * itself commits/advances the unit's question queue.
 */

import type { ExtensionAPI, ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { showLaneConsole } from "./lane-console.js";
import { LaneDock } from "./lane-dock.js";
import { LaneDockEditor } from "./lane-dock-editor.js";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	getFocusedRun,
	laneCount,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	setDockActive,
	setDockSelection,
	setFocusedRun,
	subscribeLanes,
} from "./run-lane-registry.js";

/**
 * Root hotkey that opens the lane switcher, registered via Pi's `registerShortcut`
 * (a raw `onTerminalInput` tap does NOT reliably fire at the idle editor prompt).
 *
 * Default is `ctrl+q` — historically "the one free control key" (Pi's core + editor
 * keymaps claim ctrl+a..z except h/i/j/m/q; h/i/j/m alias Backspace/Tab/LF/Enter).
 * BUT ctrl+q is terminal XOFF flow-control on many setups and can freeze output below
 * Pi's keymap. So the binding is OVERRIDABLE: set `RPIV_LANES_HOTKEY` to a
 * different KeyId to rebind, or to `off`/`none`/empty to disable the hotkey entirely
 * and rely on the always-safe `/lanes` command. `/lanes` is always available.
 */
const DEFAULT_HOTKEY = "ctrl+q";

/** Resolve the switcher hotkey from the environment; undefined = no hotkey. */
function resolveHotkey(): string | undefined {
	const raw = process.env.RPIV_LANES_HOTKEY;
	if (raw === undefined) return DEFAULT_HOTKEY; // back-compat default
	const v = raw.trim();
	if (v === "" || /^(off|none|false|disabled?)$/i.test(v)) return undefined;
	return v;
}

let overlay: LaneDock | undefined;
let unsubscribe: (() => void) | undefined;
/** The launcher UI that owns the dock editor — kept so __resetLaneSwitcher can
 *  restore Pi's default editor. Set once per ctx identity at session_start. */
let editorCtx: ExtensionUIContext | undefined;
/** Guard so a second ⏎ never stacks a second console (re-entrancy belt-and-braces;
 *  while a console is open the editor isn't focused, so this rarely trips). */
let switchingLane = false;

/** Step INTO the dock at the top row — the shared body of `/lanes` and the hotkey. */
function enterDock(): void {
	if (laneCount() === 0) return;
	setDockActive(true);
	setDockSelection(0);
}

/**
 * Re-park dock focus after leaving a lane — the tail of switchIntoLane's "back" path.
 * Reads ONLY registry state, so it is throw-safe inside a finally. The
 * tri-state (the focus-after-verb fix from 8c4a2f4):
 *  - no lanes left → drop to the ambient root prompt;
 *  - some lane still needs input → park row 0 so a run of ⏎ presses walks the queue
 *    (needs-input lanes bucket-sort to the top, run-lane-registry.ts:422-433);
 *  - otherwise → return to the EXACT display row the user opened (the unit sub-row for a
 *    fan-out unit, else the lane row), so focus returns to it.
 */
function reparkAfterLane(runId: string, unitIndex: number): void {
	if (laneCount() === 0) {
		setDockActive(false); // nothing left to step onto — back to the ambient prompt
	} else if (listLanes().some((l) => laneNeedsInput(l.runId))) {
		setDockActive(true); // another lane awaits — park at the top so the next ⏎ walks to it
		setDockSelection(0);
	} else {
		// No lane needs input: stay stepped in on the originating row, so focus returns
		// to it rather than the primary session input. ↑/esc steps back out.
		setDockActive(true);
		const idx = listLanesForDisplay().findIndex((r) =>
			unitIndex >= 0
				? r.kind === "unit" && r.lane.runId === runId && r.unit.index === unitIndex
				: r.kind === "lane" && r.lane.runId === runId,
		);
		setDockSelection(idx >= 0 ? idx : 0);
	}
}

/**
 * Switch into a run's UNIT — ALWAYS the UNIFIED console, whether or not a question is
 * queued. The console renders the lane's transcript read-only and mounts any queued
 * question inline (and mounts one that ARRIVES mid-browse, no overlay swap), committing
 * and advancing the unit's question queue itself. Marks the lane focused for the whole
 * switched-in session so THIS run's abort tap (and only it) interprets Ctrl-C; cleared in
 * finally so a console throw can't strand focus (which would leave Ctrl-C hijacked at
 * root). Called by the dock editor's `onOpen` on → / ⏎.
 */
export async function switchIntoLane(ui: ExtensionUIContext, runId: string, unitIndex: number): Promise<void> {
	if (switchingLane) return; // never stack two overlays
	switchingLane = true;
	setFocusedRun(runId);
	try {
		await showLaneConsole(ui, runId, unitIndex); // transcript + (any queued) question in ONE overlay
	} finally {
		setFocusedRun(undefined);
		switchingLane = false;
		reparkAfterLane(runId, unitIndex); // → and ⏎ converge: land back on the originating row, not at root
	}
}

export function registerLaneSwitcher(pi: ExtensionAPI): void {
	const hotkey = resolveHotkey();

	pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext }) => {
		// A detached child re-loads rpiv-core and re-fires this hook with its
		// bound relay ui. Skip it — only the ROOT launcher owns the ambient overlay +
		// registry subscription. A child mounting its own overlay would re-point the
		// shared singleton at its relay and clobber the launcher's `rpiv-lanes` widget.
		if (!ctx.hasUI || !ctx.ui || isLaneRelayUiContext(ctx.ui)) return;
		const ui = ctx.ui;
		overlay ??= new LaneDock();
		overlay.setUICtx(ui);
		overlay.update();
		// Subscribe once: re-render the dock on any registry change (run recorded/
		// evicted, status, current session, needs-input, dock selection).
		unsubscribe ??= subscribeLanes(() => overlay?.update());
		// Install the dock editor once per ctx identity (re-install on /reload). It
		// proxies dock navigation; ⏎ on a selected lane switches into it. The host
		// preserves editor text + app keybindings across the swap.
		if (ui !== editorCtx) {
			editorCtx = ui;
			ui.setEditorComponent(
				(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
					new LaneDockEditor(
						tui,
						theme,
						keybindings,
						(runId, unitIndex) => void switchIntoLane(ui, runId, unitIndex),
					),
			);
		}
	});

	pi.registerCommand("lanes", {
		description: "Step into the workflow run lane dock",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (laneCount() === 0) {
				ctx.ui.notify("No in-flight runs.", "info");
				return;
			}
			enterDock();
		},
	});

	// Root hotkey — the keybinding-API equivalent of /lanes. Fires at the editor prompt
	// via Pi's shortcut dispatch (NOT a raw onTerminalInput tap, which doesn't reliably
	// reach the idle editor). Gated like /lanes: only with a UI, only at root (not
	// switched into a lane — the console owns input there), only when a lane is in-flight.
	// Skipped entirely when the binding is disabled (RPIV_LANES_HOTKEY=off) — /lanes
	// still works. The DOWN-from-empty-prompt gesture (LaneDockEditor) is a
	// third, always-available way in.
	if (hotkey) {
		// Cast: an env-provided KeyId is validated by Pi at registration; an unknown id
		// simply never fires (the user still has /lanes).
		pi.registerShortcut(hotkey as KeyId, {
			description: "Step into the workflow run lane dock",
			handler: (ctx) => {
				if (!ctx.hasUI || getFocusedRun() !== undefined || laneCount() === 0) return;
				enterDock();
			},
		});
	}
}

/** Test reset — wired into test/setup.ts beforeEach (module owns singleton state). */
export function __resetLaneSwitcher(): void {
	unsubscribe?.();
	unsubscribe = undefined;
	switchingLane = false;
	editorCtx?.setEditorComponent(undefined); // restore Pi's default editor
	editorCtx = undefined;
	overlay?.dispose();
	overlay = undefined;
}
