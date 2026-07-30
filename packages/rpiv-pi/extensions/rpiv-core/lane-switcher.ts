/**
 * lane-switcher — composition for the parallel-run lane switcher.
 *
 * The launcher (root) owns this: it mounts the always-on ambient lane DOCK below the
 * editor on the captured launcher UI (a read-only glance of in-flight runs), subscribes
 * it to the run-lane registry so it re-renders as runs start / finish / need input, and
 * installs the LaneDockEditor — the input editor that owns the DOWN-from-empty-prompt
 * step-in gesture (widgets can't take focus; the editor is the only component reliably
 * reached at the idle prompt). `/lanes`, the `^Q` hotkey, and that DOWN gesture all call
 * `stepIn`, which opens the focused lane BROWSER (lane-console) on the top display row.
 * The browser owns all navigation from there — spine selection, the transcript swap, and
 * inline question answering — so the belowEditor dock is never itself "activated".
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
import type { WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { showLaneConsole } from "./lane-console.js";
import { LaneDock } from "./lane-dock.js";
import { LaneDockEditor } from "./lane-dock-editor.js";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	getFocusedRun,
	laneCount,
	listLanesForDisplay,
	SINGLE_UNIT_KEY,
	setFocusedRun,
	subscribeLanes,
} from "./run-lane-registry.js";
import { isModuleNotFound } from "./utils.js";

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

let dock: LaneDock | undefined;
let unsubscribe: (() => void) | undefined;
/** The launcher UI that owns the dock editor — kept so __resetLaneSwitcher can
 *  restore Pi's default editor. Set once per ctx identity at session_start. */
let editorCtx: ExtensionUIContext | undefined;
/** The rerun callback the lane console calls on `r` — built in session_start (where pi/ui
 *  are in scope) from the captured launcher cwd + sessionManager. Undefined before the first
 *  root session_start (the console passes a no-op then). */
let rerunCallback: ((runId: string) => void) | undefined;
/** Launcher cwd captured at session_start — the WorkflowHostContext.cwd the rerun's
 *  resumeWorkflowByRunId resolves the run-id against (resolveRun/loadWorkflows read it). */
let launcherCwd: string | undefined;
/** Launcher sessionManager captured at session_start — the WorkflowHostContext.sessionManager
 *  the detached executor host borrows as its live observer. */
let launcherSessionManager: ExtensionContext["sessionManager"] | undefined;
/** Guard so a second ⏎ never stacks a second console (re-entrancy belt-and-braces;
 *  while a console is open the editor isn't focused, so this rarely trips). */
let switchingLane = false;

/**
 * Step INTO the lane browser at the top display row — the shared body of `/lanes`, the
 * `^Q` hotkey, and the DOWN-from-empty-prompt gesture (LaneDockEditor). Opens the focused
 * console, which owns lane navigation, the transcript swap, and question answering — NOT
 * the old in-editor dock-active nav. The top row is the needs-input/running/terminal-sorted
 * first row, so a step-in lands on the lane most likely to want the user. No-op with no
 * lanes (the caller has already gated on laneCount for its own messaging).
 */
function stepIn(ui: ExtensionUIContext): void {
	const top = listLanesForDisplay()[0];
	if (!top) return;
	const unitIndex = top.kind === "unit" ? top.unit.index : SINGLE_UNIT_KEY;
	void switchIntoLane(ui, top.lane.runId, unitIndex, rerunCallback ?? (() => {}));
}

/**
 * Switch into a run's UNIT — opens the UNIFIED lane browser starting on `(runId, unitIndex)`.
 * The console renders that unit's transcript, lets the user navigate the spine to any sibling
 * lane (re-targeting the transcript in place), and mounts/commits/advances each unit's queued
 * question inline — the browser stays open across answers (you are never stranded), so there
 * is no per-answer re-park: backing out (esc/←) returns straight to the prompt. Marks the run
 * focused so THIS run's abort tap interprets Ctrl-C; cleared in finally so a console throw
 * can't strand focus (which would leave Ctrl-C hijacked at root). Called by the dock editor's
 * `onOpen` and by `stepIn`.
 */
export async function switchIntoLane(
	ui: ExtensionUIContext,
	runId: string,
	unitIndex: number,
	onRerun: (runId: string) => void = () => {},
): Promise<void> {
	if (switchingLane) return; // never stack two consoles
	switchingLane = true;
	setFocusedRun(runId);
	// The in-flow browser renders the lane block itself in the editor slot, so the ambient
	// dock below would duplicate it — hide it for the duration.
	dock?.setSuppressed(true);
	try {
		await showLaneConsole(ui, runId, unitIndex, onRerun); // the lane browser: spine + transcript + inline question
	} finally {
		dock?.setSuppressed(false);
		setFocusedRun(undefined);
		switchingLane = false;
	}
}

export function registerLaneSwitcher(pi: ExtensionAPI): void {
	const hotkey = resolveHotkey();

	pi.on(
		"session_start",
		async (
			_event: unknown,
			ctx: {
				hasUI?: boolean;
				ui?: ExtensionUIContext;
				cwd?: string;
				sessionManager?: ExtensionContext["sessionManager"];
			},
		) => {
			// A detached child re-loads rpiv-core and re-fires this hook with its
			// bound relay ui. Skip it — only the ROOT launcher owns the ambient dock +
			// registry subscription. A child mounting its own dock would re-point the
			// shared singleton at its relay and clobber the launcher's `rpiv-lanes` widget.
			if (!ctx.hasUI || !ctx.ui || isLaneRelayUiContext(ctx.ui)) return;
			const ui = ctx.ui;
			// Capture the launcher cwd + sessionManager so the `r` rerun callback can build the
			// observer-only WorkflowHostContext resumeWorkflowByRunId needs (resolveRun +
			// loadWorkflows read cwd; the detached executor host borrows sessionManager as its
			// live observer). Re-captured on every root session_start (/reload) like editorCtx.
			launcherCwd = ctx.cwd;
			launcherSessionManager = ctx.sessionManager;
			// Build the rerun callback here (ui in scope): resume a failed/aborted/cancelled run
			// by its run-id via a guarded dynamic import of the workflow runner. Degrades silently
			// when rpiv-workflow is absent (isModuleNotFound) — /rpiv-setup guides the user. The
			// async resume is fire-and-forget; the failed→running lane flip is subscription-driven
			// (recordRun reactivation via the lane lifecycle), so the console does NOT await it.
			rerunCallback = (runId: string): void => {
				void (async () => {
					try {
						// Guarded dynamic import — degrades silently when rpiv-workflow is absent
						// (isModuleNotFound); /rpiv-setup guides the user. The /runner entry keeps the
						// loader/DSL graph off the import (sibling-import-graph permits the dynamic form).
						const runner = await import("@juicesharp/rpiv-workflow/runner");
						// Observer-only ctx: the detached executor provider supplies spawnChild/
						// maxConcurrency (registered on the root session_start by workflow-execution-host).
						// The double cast is required — the object omits spawnChild/maxConcurrency, so a
						// single `as WorkflowHostContext` fails TS2352 (mirrors the as-unknown-as cast in
						// workflow-execution-host.ts). cwd/sessionManager are the real captured launcher values.
						const hostCtx = {
							cwd: launcherCwd,
							hasUI: true,
							ui: { notify: (m: string, l?: "info" | "warning" | "error") => ui.notify(m, l) },
							sessionManager: launcherSessionManager,
							waitForIdle: () => Promise.resolve(),
						} as unknown as WorkflowHostContext;
						void runner
							.resumeWorkflowByRunId(hostCtx, runId)
							.then((r) => {
								// Surface ONLY a pre-run refusal (no JSONL created) — an in-run failure is
								// notified by the stage machinery; a success reactivates the lane reactively.
								// r.runId === undefined distinguishes a refusal (resolveRun/load miss).
								if (!r.success && r.runId === undefined && r.error) ui.notify(r.error, "error");
							})
							.catch((e) => ui.notify(`rpiv: resume failed — ${String(e)}`, "error"));
					} catch (err) {
						if (!isModuleNotFound(err)) console.error("[rpiv-core] failed to load workflow runner:", err);
						return; // sibling absent — /rpiv-setup guides the user
					}
				})();
			};
			dock ??= new LaneDock();
			dock.setUICtx(ui);
			dock.update();
			// Subscribe once: re-render the dock on any registry change (run recorded/
			// evicted, status, current session, needs-input, dock selection).
			unsubscribe ??= subscribeLanes(() => dock?.update());
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
							(runId, unitIndex) => void switchIntoLane(ui, runId, unitIndex, rerunCallback ?? (() => {})),
						),
				);
			}
		},
	);

	pi.registerCommand("lanes", {
		description: "Open the workflow run lane browser",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (laneCount() === 0) {
				ctx.ui.notify("No in-flight runs.", "info");
				return;
			}
			stepIn(ctx.ui);
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
			description: "Open the workflow run lane browser",
			handler: (ctx) => {
				if (!ctx.hasUI || getFocusedRun() !== undefined || laneCount() === 0) return;
				stepIn(ctx.ui);
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
	dock?.dispose();
	dock = undefined;
	rerunCallback = undefined;
	launcherCwd = undefined;
	launcherSessionManager = undefined;
}
