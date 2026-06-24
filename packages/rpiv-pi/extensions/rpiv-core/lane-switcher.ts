/**
 * lane-switcher — composition for the parallel-run lane switcher (FR3/FR4/FR5).
 *
 * The launcher (root) owns this: it mounts the always-on lane DOCK below the editor
 * on the captured launcher UI, subscribes it to the run-lane registry so it
 * re-renders as runs start / finish / need input, and installs the LaneDockEditor —
 * the input editor that proxies arrow/enter/tab/x keys into the dock's navigation
 * (widgets can't take focus; the editor is the only component reliably reached at
 * the idle prompt). `/lanes` and the `^Q` hotkey simply step INTO the dock. When the
 * user opens a run (⏎), switchIntoLane opens the read-only viewer, then drains any
 * queued foreground-stage questions onto the real UI (FR5: context first, then answer).
 */

import type { ExtensionAPI, ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import { LaneDock } from "./lane-dock.js";
import { LaneDockEditor } from "./lane-dock-editor.js";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import { showLaneViewer } from "./lane-viewer.js";
import {
	dequeueInput,
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
 * Pi's keymap. So the binding is OVERRIDABLE (Phase E): set `RPIV_LANES_HOTKEY` to a
 * different KeyId to rebind, or to `off`/`none`/empty to disable the hotkey entirely
 * and rely on the always-safe `/lanes` command. `/lanes` is always available.
 */
const DEFAULT_HOTKEY = "ctrl+q";

/** Resolve the switcher hotkey from the environment (Phase E); undefined = no hotkey. */
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
/** Guard so a second ⏎ never stacks a second viewer (re-entrancy belt-and-braces;
 *  while a viewer is open the editor isn't focused, so this rarely trips). */
let switchingLane = false;

/** Step INTO the dock at the top row — the shared body of `/lanes` and the hotkey. */
function enterDock(): void {
	if (laneCount() === 0) return;
	setDockActive(true);
	setDockSelection(0);
}

/**
 * Re-park dock focus after leaving a lane — the shared tail of switchIntoLane's "back"
 * and answerLane. Reads ONLY registry state, so it is throw-safe inside a finally. The
 * tri-state (the focus-after-verb fix from 8c4a2f4):
 *  - no lanes left → drop to the ambient root prompt;
 *  - some lane still needs input → park row 0 so a run of ⏎ presses walks the queue
 *    (needs-input lanes bucket-sort to the top, run-lane-registry.ts:422-433);
 *  - otherwise → keep the cursor on the originating lane, so focus returns to it.
 */
function reparkAfterLane(runId: string): void {
	if (laneCount() === 0) {
		setDockActive(false); // nothing left to step onto — back to the ambient prompt
	} else if (listLanes().some((l) => laneNeedsInput(l.runId))) {
		setDockActive(true); // another lane awaits — park at the top so the next ⏎ walks to it
		setDockSelection(0);
	} else {
		// No lane needs input: stay stepped in on the originating lane, so focus returns
		// to it rather than the primary session input. ↑/esc steps back out.
		setDockActive(true);
		const idx = listLanesForDisplay().findIndex((l) => l.runId === runId);
		setDockSelection(idx >= 0 ? idx : 0);
	}
}

/**
 * Switch into a run: open the read-only viewer, then drain its queued foreground
 * questions — sequentially, so overlays never stack. Marks the lane focused for the
 * whole switched-in session so THIS run's abort tap (and only it) interprets Ctrl-C;
 * cleared in finally so a viewer/drain throw can't strand focus (which would leave
 * Ctrl-C hijacked at root). Called by the dock editor's `onOpen` on ⏎.
 */
export async function switchIntoLane(ui: ExtensionUIContext, runId: string): Promise<void> {
	if (switchingLane) return; // never stack two viewers
	switchingLane = true;
	setFocusedRun(runId);
	try {
		const intent = await showLaneViewer(ui, runId); // 1) see live context; esc/← → "back"
		if (intent === "answer") await drainPendingInput(ui, runId); // 2) ⏎ in the viewer → answer in place (FR5)
	} finally {
		setFocusedRun(undefined);
		switchingLane = false;
		reparkAfterLane(runId); // → and ⏎ converge: land back on the originating lane, not at root
	}
}

/**
 * Answer a needs-input lane WITHOUT opening the transcript viewer (the ⏎ shortcut
 * on a flagged lane): drain its queued foreground questions straight onto the real
 * UI. Shares `switchingLane` so it never stacks with a viewer/another drain. After
 * answering it STAYS stepped into the dock — the user came from the dock and expects
 * to land back on the lane, not the primary prompt. When other lanes still await
 * input they sort to the top, so it parks on row 0 and a run of ⏎ presses walks
 * through them; otherwise it keeps the cursor on the lane just answered. It only
 * drops back to root when no lane remains to step onto.
 */
export async function answerLane(ui: ExtensionUIContext, runId: string): Promise<void> {
	if (switchingLane) return; // never stack onto a viewer/another drain
	switchingLane = true;
	setFocusedRun(runId);
	try {
		await drainPendingInput(ui, runId);
	} finally {
		setFocusedRun(undefined);
		switchingLane = false;
		reparkAfterLane(runId); // same re-park as switchIntoLane's "back" path
	}
}

/**
 * FR5 — replay each queued foreground-stage questionnaire on the launcher's REAL
 * UI and resolve the child's stalled promise. Sequential (block-while-occupied);
 * a dismissed/error questionnaire still settles the child so it never hangs.
 */
async function drainPendingInput(ui: ExtensionUIContext, runId: string): Promise<void> {
	for (let pending = dequeueInput(runId); pending; pending = dequeueInput(runId)) {
		try {
			pending.resolve(await ui.custom(pending.factory, pending.options));
		} catch {
			pending.resolve(undefined);
		}
	}
}

export function registerLaneSwitcher(pi: ExtensionAPI): void {
	const hotkey = resolveHotkey();

	pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext }) => {
		// Phase 7.2: a detached child re-loads rpiv-core and re-fires this hook with its
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
						(runId, mode) => void (mode === "answer" ? answerLane(ui, runId) : switchIntoLane(ui, runId)),
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
	// switched into a lane — the viewer owns input there), only when a lane is in-flight.
	// Skipped entirely when the binding is disabled (RPIV_LANES_HOTKEY=off) — /lanes
	// still works (Phase E). The DOWN-from-empty-prompt gesture (LaneDockEditor) is a
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
