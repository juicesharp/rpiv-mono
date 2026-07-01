/**
 * lane-dock-editor — the input-editor adapter that owns the DOWN-from-empty-prompt
 * step-in gesture into the lane browser.
 *
 * Widgets (the belowEditor lane dock) never receive keyboard input, and a raw
 * onTerminalInput tap does NOT reliably fire at the idle prompt — so the ONLY
 * component that reliably sees every keystroke at the prompt is the editor itself.
 * This CustomEditor subclass intercepts the single DOWN-from-empty-prompt entry
 * gesture and opens the lane BROWSER (the focused console) on the top display row;
 * every other keystroke is delegated to super.handleInput so all built-in editing +
 * app keybindings keep working untouched.
 *
 * The decision is a PURE function (decideDockAction) so the gesture is
 * unit-testable without constructing a real editor; this class is a thin adapter
 * that reads live editor state, asks the function, and executes the verb.
 *
 * The browser (lane-console) owns all navigation from there — spine selection, the
 * transcript swap, and inline question answering — so the belowEditor dock is never
 * itself "activated" and stays a read-only ambient glance at all times. The editor
 * render() is the base CustomEditor render (no blanking override): the dock never
 * holds navigation focus.
 *
 * One extra responsibility: a genuine non-empty Enter (a real submit the inactive
 * editor lets through to super.handleInput) forces a full repaint (requestRender(true))
 * to wipe the stale-frame ghost left at a submit boundary. Confined to genuine submits
 * by a two-way guard (non-empty AND enter) so no-op Enters and ordinary keystrokes
 * never trigger the full-screen-clear flicker.
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { type DisplayRow, type LaneEntry, listLanesForDisplay, SINGLE_UNIT_KEY } from "./run-lane-registry.js";

/** The navigation keys the dock cares about; everything else is "other".
 *  Only "down" is acted on (the entry gesture); the rest are classified for the
 *  genuine-submit guard (`key === "enter"`). Kept verbatim — classifyKey still maps
 *  the full set even though only "down" now drives a decision. */
export type DockKey = "up" | "down" | "enter" | "right" | "left" | "escape" | "tab" | "stop" | "other";

/** Live inputs the entry-gesture decision depends on — snapshotted from the editor. */
export interface DockDecisionContext {
	/** Is the editor's autocomplete dropdown open? (It owns ↑/↓/⏎/tab when so.) */
	readonly autocompleteOpen: boolean;
	/** Is the prompt empty? (DOWN-entry is gated on this to avoid arrow overload.) */
	readonly editorEmpty: boolean;
	/** Number of flattened DISPLAY ROWS (lane rows + unit sub-rows) — the entry gate
	 *  (no entry when there is nothing to step into). */
	readonly rowCount: number;
}

/** A verb for the adapter to execute. Pure data — no side effects here.
 *  The dock-active navigation verbs (move/select/open/answer/stop/deactivate/exit-passthrough)
 *  are retired: the browser owns all navigation now, so only the entry gesture + the
 *  passthrough (delegate to the editor) remain. */
export type DockAction =
	| { kind: "activate" } // step into the lane browser on the top display row
	| { kind: "passthrough" }; // not ours — hand to the editor

/**
 * The dock entry-gesture decision — pure. See the module header for the gesture
 * contract; the retained branch is covered by lane-dock-editor.test.ts
 * ("decideDockAction — inactive (entry gesture)").
 */
export function decideDockAction(key: DockKey, ctx: DockDecisionContext): DockAction {
	// Entry: DOWN from an empty prompt, no autocomplete open, with lanes present.
	if (key === "down" && ctx.editorEmpty && !ctx.autocompleteOpen && ctx.rowCount > 0) {
		return { kind: "activate" };
	}
	return { kind: "passthrough" };
}

/** Classify a raw terminal data string into a DockKey. (Kept verbatim.) */
function classifyKey(data: string): DockKey {
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.enter)) return "enter";
	if (matchesKey(data, Key.right)) return "right";
	if (matchesKey(data, Key.left)) return "left";
	if (matchesKey(data, Key.escape)) return "escape";
	if (matchesKey(data, Key.tab)) return "tab";
	if (data === "x") return "stop"; // mirrors the retired manager's `x` binding
	return "other";
}

/**
 * Resolve a display row to a unit address. A lane (parent) row → the reserved
 * single-unit key; a unit sub-row → its own index. The lane is carried for the
 * run-level `x` action (`x` targets the PARENT run, never a single unit). (Kept verbatim.)
 */
function resolveRow(row: DisplayRow | undefined): { runId: string; unitIndex: number; lane: LaneEntry } | undefined {
	if (!row) return undefined;
	if (row.kind === "unit") return { runId: row.lane.runId, unitIndex: row.unit.index, lane: row.lane };
	return { runId: row.lane.runId, unitIndex: SINGLE_UNIT_KEY, lane: row.lane };
}

/**
 * Editor that owns the DOWN-from-empty step-in gesture. Constructed by the factory passed to
 * ctx.ui.setEditorComponent (lane-switcher wires `onOpen` to switchIntoLane). The host copies app
 * keybindings, onEscape/onCtrlD/onExtensionShortcut, autocomplete provider, and wires
 * onSubmit/onChange after construction — so subclassing and overriding only handleInput preserves
 * all built-in editor behavior.
 */
export class LaneDockEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly onOpen: (runId: string, unitIndex: number) => void,
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		const key = classifyKey(data);
		const editorEmpty = this.getText().trim().length === 0;
		const action = decideDockAction(key, {
			autocompleteOpen: this.isShowingAutocomplete(),
			editorEmpty,
			rowCount: listLanesForDisplay().length,
		});
		if (action.kind === "activate") {
			// Step in = open the lane BROWSER (the focused console) on the top display row —
			// the needs-input/running/terminal-sorted first row. The console owns lane
			// navigation, the transcript swap, and question answering from there; the
			// belowEditor dock stays a read-only ambient glance and is never itself
			// "activated".
			const top = resolveRow(listLanesForDisplay()[0]);
			if (top) this.onOpen(top.runId, top.unitIndex);
			return;
		}
		// passthrough — delegate to the editor so editing + app keybindings keep working.
		// Snapshot the genuine-submit guard BEFORE super.handleInput (which runs
		// submitValue() and clears this.state), so the snapshot reflects the pre-submit text.
		const wasSubmit = !editorEmpty && key === "enter";
		super.handleInput(data);
		// A forced full repaint (force=true) wipes previousLines/width/height and erases the
		// stale-frame ghost left behind at a genuine submit boundary. Confined to genuine
		// submits by the two-way guard, so no-op Enters and ordinary keystrokes never trigger
		// the full-screen-clear flicker.
		if (wasSubmit) this.tui.requestRender(true);
	}
}
