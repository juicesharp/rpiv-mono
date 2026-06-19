/**
 * lane-switcher — composition for the parallel-run lane switcher (FR3/FR4/FR5).
 *
 * The launcher (root) owns this: it mounts the ambient lane overlay on the
 * captured launcher UI, subscribes it to the run-lane registry so it re-renders
 * as runs start / finish / need input, and registers the /lanes command that
 * opens the focused lane manager. The manager resolves with a selection; the
 * switcher then opens the read-only viewer AFTER the manager closes (LIFO-safe —
 * never two stacked overlays), and after the viewer closes drains any queued
 * foreground-stage questions onto the real UI (FR5: context first, then answer).
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { showLaneManager } from "./lane-manager.js";
import { LaneOverlay } from "./lane-overlay.js";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import { showLaneViewer } from "./lane-viewer.js";
import {
	dequeueInput,
	evictRun,
	getFocusedRun,
	getLane,
	listLanes,
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

/** Render a KeyId as a compact footer glyph: "ctrl+q" → "^Q", else the raw id. */
function hotkeyGlyph(key: string): string {
	const m = /^ctrl\+([a-z])$/i.exec(key);
	return m ? `^${m[1].toUpperCase()}` : key;
}

/** Build the overlay footer hint reflecting the ACTUAL binding (Phase E). */
function footerText(hotkey: string | undefined): string {
	return hotkey ? `${hotkeyGlyph(hotkey)} · /lanes — open run manager` : "/lanes — open run manager";
}

let overlay: LaneOverlay | undefined;
let unsubscribe: (() => void) | undefined;
/** Guard so a second hotkey/`/lanes` press never stacks a second switcher overlay. */
let switcherOpen = false;

/**
 * Open the focused manager, then (on a switch selection) open the read-only
 * viewer, then drain the lane's queued questions — sequentially, so overlays
 * never stack. `dismiss`/`ambient` fall back to the root (the ambient overlay
 * stays mounted underneath).
 */
async function openLaneSwitcher(ui: ExtensionUIContext): Promise<void> {
	if (switcherOpen) return; // already open (hotkey + /lanes both route here) — never stack
	switcherOpen = true;
	try {
		const result = await showLaneManager(ui);
		if (result.kind === "switch") {
			// Mark this lane focused for the whole switched-in session: while it's set,
			// THIS run's abort tap (and only it) interprets Ctrl-C, so esc-to-return in
			// the viewer and Ctrl-C-to-abort target the run on screen — never a sibling
			// or the editor. Cleared in finally so a viewer/drain throw can't strand
			// focus (which would leave Ctrl-C hijacked at root).
			setFocusedRun(result.runId);
			try {
				await showLaneViewer(ui, result.runId); // 1) see live context (esc → back)
				await drainPendingInput(ui, result.runId); // 2) then answer any queued questions (FR5)
			} finally {
				setFocusedRun(undefined);
			}
		} else if (result.kind === "cancel") {
			// Phase D — abort a running lane without switching in (the abort tap is
			// focus-gated; this calls the run's own AbortController directly). The lane
			// then retires to "aborted" and stays visible until dismissed.
			getLane(result.runId)?.abort?.();
		} else if (result.kind === "remove") {
			// Phase D — dismiss a finished (retained) lane from the overlay.
			evictRun(result.runId);
		}
	} finally {
		switcherOpen = false;
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
		overlay ??= new LaneOverlay();
		overlay.setFooterText(footerText(hotkey)); // Phase E — advertise the actual binding
		overlay.setUICtx(ctx.ui);
		overlay.update();
		// Subscribe once: re-render the ambient overlay on any registry change
		// (run recorded/evicted, status, current session, needs-input).
		unsubscribe ??= subscribeLanes(() => overlay?.update());
	});

	pi.registerCommand("lanes", {
		description: "Open the workflow run lane switcher",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (listLanes().length === 0) {
				ctx.ui.notify("No in-flight runs.", "info");
				return;
			}
			await openLaneSwitcher(ctx.ui);
		},
	});

	// Root hotkey — the keybinding-API equivalent of /lanes. Fires at the editor prompt
	// via Pi's shortcut dispatch (NOT a raw onTerminalInput tap, which doesn't reliably
	// reach the idle editor). Gated like /lanes: only with a UI, only at root (not
	// switched into a lane — the viewer owns input there), only when a lane is in-flight.
	// The switcherOpen guard inside openLaneSwitcher prevents stacking. Skipped entirely
	// when the binding is disabled (RPIV_LANES_HOTKEY=off) — /lanes still works (Phase E).
	if (hotkey) {
		// Cast: an env-provided KeyId is validated by Pi at registration; an unknown id
		// simply never fires (the user still has /lanes).
		pi.registerShortcut(hotkey as KeyId, {
			description: "Open the workflow run lane switcher",
			handler: (ctx) => {
				if (!ctx.hasUI || getFocusedRun() !== undefined || listLanes().length === 0) return;
				void openLaneSwitcher(ctx.ui);
			},
		});
	}
}

/** Test reset — wired into test/setup.ts beforeEach (module owns singleton state). */
export function __resetLaneSwitcher(): void {
	unsubscribe?.();
	unsubscribe = undefined;
	switcherOpen = false;
	overlay?.dispose();
	overlay = undefined;
}
