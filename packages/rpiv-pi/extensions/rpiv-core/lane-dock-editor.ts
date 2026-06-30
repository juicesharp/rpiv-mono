/**
 * lane-dock-editor — the input-editor adapter that proxies navigation into the
 * lane dock (the "step into the dock with the keyboard" mechanism).
 *
 * Widgets (the belowEditor lane dock) never receive keyboard input, and a raw
 * onTerminalInput tap does NOT reliably fire at the idle prompt — so the ONLY
 * component that reliably sees every keystroke at the prompt is the editor itself.
 * This CustomEditor subclass therefore owns the dock's navigation: it intercepts
 * arrow/enter/tab/esc when the dock is (or should become) active, mutates the
 * registry's dock selection, and otherwise delegates to super.handleInput so all
 * built-in editing + app keybindings keep working untouched.
 *
 * The decision is a PURE function (decideDockAction) so the whole state machine is
 * unit-testable without constructing a real editor; this class is a thin adapter
 * that reads live registry/editor state, asks the function, and executes the verb.
 *
 * Entry gesture: DOWN on an EMPTY prompt (no autocomplete open) with ≥1 lane —
 * restricting entry to an empty editor sidesteps the cursor/history/autocomplete
 * overload of the arrow keys entirely (there is no text to navigate). Exit: ↑ at
 * the top row, esc, or simply typing (the keystroke is forwarded so editing
 * resumes seamlessly). ⏎ opens the selected run.
 *
 * The editor stays FOCUSED while stepped in (it has to, to keep proxying keys), so
 * its render() is overridden to BLANK the input box (border + blinking cursor) for
 * the duration — otherwise an empty prompt with a live cursor would sit above the
 * dock you're navigating. It keeps the box's full HEIGHT (blanked, not collapsed) so
 * the dock stays anchored in the footer and never shifts as you step in and out. It
 * reappears the instant focus returns to the prompt (dock deactivated).
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	type DisplayRow,
	evictRun,
	getDockState,
	type LaneEntry,
	listLanesForDisplay,
	moveDockSelection,
	retireRun,
	SINGLE_UNIT_KEY,
	setDockActive,
	setDockSelection,
	unitNeedsInput,
} from "./run-lane-registry.js";

/** The navigation keys the dock cares about; everything else is "other".
 *  "stop" is the `x` key (abort a running lane / dismiss a finished one).
 *  "right" (→) always opens the selected lane's transcript viewer. */
export type DockKey = "up" | "down" | "enter" | "right" | "left" | "escape" | "tab" | "stop" | "other";

/** Live inputs the decision depends on — snapshotted from the editor + registry. */
export interface DockDecisionContext {
	/** Is the dock currently holding navigation focus? */
	readonly dockActive: boolean;
	/** Is the editor's autocomplete dropdown open? (It owns ↑/↓/⏎/tab when so.) */
	readonly autocompleteOpen: boolean;
	/** Is the prompt empty? (DOWN-entry is gated on this to avoid arrow overload.) */
	readonly editorEmpty: boolean;
	/** Number of flattened DISPLAY ROWS (lane rows + unit sub-rows) — the dock's
	 *  auto-show gate AND the tab-wrap modulus (tab now cycles unit sub-rows too). */
	readonly rowCount: number;
	/** Current dock selection (index into listLanesForDisplay()). */
	readonly selection: number;
}

/** A verb for the adapter to execute. Pure data — no side effects here. */
export type DockAction =
	| { kind: "activate" } // step into the dock at the top
	| { kind: "move"; delta: number } // shift selection (registry clamps)
	| { kind: "select"; index: number } // jump selection to an absolute row (tab wrap)
	| { kind: "open" } // view the selected run's transcript (viewer; drains on esc)
	| { kind: "answer" } // drain the selected run's queued question directly (no viewer)
	| { kind: "stop" } // abort (running) / dismiss (finished) the selected lane
	| { kind: "deactivate" } // step back to the input, swallow the key
	| { kind: "exit-passthrough" } // step back AND forward the key (resume typing)
	| { kind: "passthrough" }; // not ours — hand to the editor

/**
 * The dock navigation state machine — pure. See the module header for the gesture
 * contract; every branch is covered by lane-dock-editor.test.ts.
 */
export function decideDockAction(key: DockKey, ctx: DockDecisionContext): DockAction {
	if (!ctx.dockActive) {
		// Entry: DOWN from an empty prompt, no autocomplete open, with lanes present.
		if (key === "down" && ctx.editorEmpty && !ctx.autocompleteOpen && ctx.rowCount > 0) {
			return { kind: "activate" };
		}
		return { kind: "passthrough" };
	}
	// Active. Defensive: never steal keys from an open autocomplete (shouldn't
	// co-occur with an active dock, but if it does the dropdown wins).
	if (ctx.autocompleteOpen) return { kind: "passthrough" };
	switch (key) {
		case "up":
			// ↑ at the top row returns focus to the input; otherwise move up.
			return ctx.selection <= 0 ? { kind: "deactivate" } : { kind: "move", delta: -1 };
		case "down":
			return { kind: "move", delta: 1 };
		case "tab":
			// Tab cycles with wraparound (last → first).
			return { kind: "select", index: ctx.rowCount > 0 ? (ctx.selection + 1) % ctx.rowCount : 0 };
		case "enter":
			// ⏎ is the dedicated ANSWER key — it drains the selected lane's queued
			// question (the adapter makes it a no-op when nothing is queued). Right is the
			// dedicated TRANSCRIPT key (below); the two never swap meaning.
			return { kind: "answer" };
		case "right":
			return { kind: "open" }; // always view the transcript, even on a needs-input lane
		case "stop":
			return { kind: "stop" };
		case "left":
			// ← backs out of the dock (mirror of → stepping in / opening the viewer). deactivate
			// SWALLOWS the key (unlike exit-passthrough), so ← never also moves the editor cursor.
			return { kind: "deactivate" };
		case "escape":
			return { kind: "deactivate" };
		default:
			// Any other key (typing) exits the dock and resumes editing with that key.
			return { kind: "exit-passthrough" };
	}
}

/** Classify a raw terminal data string into a DockKey. */
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
 * run-level `x` action (`x` targets the PARENT run, never a single unit).
 */
function resolveRow(row: DisplayRow | undefined): { runId: string; unitIndex: number; lane: LaneEntry } | undefined {
	if (!row) return undefined;
	if (row.kind === "unit") return { runId: row.lane.runId, unitIndex: row.unit.index, lane: row.lane };
	return { runId: row.lane.runId, unitIndex: SINGLE_UNIT_KEY, lane: row.lane };
}

/**
 * Editor that proxies dock navigation. Constructed by the factory passed to
 * ctx.ui.setEditorComponent (lane-switcher wires `onOpen` to switchIntoLane). The
 * host copies app keybindings, onEscape/onCtrlD/onExtensionShortcut, autocomplete
 * provider, and wires onSubmit/onChange after construction — so subclassing and
 * overriding only handleInput preserves all built-in editor behavior.
 */
export class LaneDockEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly onOpen: (runId: string, unitIndex: number, mode: "view" | "answer") => void,
	) {
		super(tui, theme, keybindings);
	}

	/**
	 * Hide the input box while the dock holds navigation focus, but keep its FULL height.
	 * The editor stays focused (so handleInput keeps receiving keystrokes); we render the
	 * normal box and blank every line, suppressing the empty prompt + reversed-video cursor
	 * WITHOUT changing the line count. Preserving the height is what keeps the dock below
	 * anchored in the footer — collapsing to a single line (the old behavior) pulled the dock
	 * up by several rows every time the user stepped in, and back down on the way out. Falls
	 * straight back to the normal render the moment the dock is deactivated.
	 */
	render(width: number): string[] {
		if (getDockState().active) return super.render(width).map(() => "");
		return super.render(width);
	}

	handleInput(data: string): void {
		const dock = getDockState();
		const key = classifyKey(data);
		const editorEmpty = this.getText().trim().length === 0;
		const action = decideDockAction(key, {
			dockActive: dock.active,
			autocompleteOpen: this.isShowingAutocomplete(),
			editorEmpty,
			rowCount: listLanesForDisplay().length,
			selection: dock.selection,
		});
		switch (action.kind) {
			case "activate":
				setDockActive(true);
				setDockSelection(0);
				return;
			case "move":
				moveDockSelection(action.delta);
				return;
			case "select":
				setDockSelection(action.index);
				return;
			case "open": {
				// Resolve the selection against the SAME order the dock renders, then
				// step out before opening so the dock isn't "active" behind the viewer.
				// A unit sub-row opens THAT unit's transcript; a lane row opens the sentinel.
				const t = resolveRow(listLanesForDisplay()[getDockState().selection]);
				setDockActive(false);
				if (t) this.onOpen(t.runId, t.unitIndex, "view");
				return;
			}
			case "answer": {
				// ⏎ drains THIS row's unit queue (lane row → sentinel queue; unit row → its
				// own). Inert when that unit has nothing queued — stay in the dock rather than
				// stepping out, so the key never does something surprising on a non-flagged row.
				const t = resolveRow(listLanesForDisplay()[getDockState().selection]);
				if (t && unitNeedsInput(t.runId, t.unitIndex)) {
					setDockActive(false);
					this.onOpen(t.runId, t.unitIndex, "answer");
				}
				return;
			}
			case "stop": {
				// `x` targets the row's PARENT run (no per-unit abort): abort a running
				// run, or dismiss a finished/retained one. The dock stays active so the user
				// can keep acting on the list; selection re-clamps as lanes drop.
				const t = resolveRow(listLanesForDisplay()[getDockState().selection]);
				if (t) {
					if (t.lane.status === "running") {
						// Fire the cooperative abort to actually halt the run, THEN
						// optimistically retire the lane so the overlay clears on the
						// keystroke. The runner's terminal `onWorkflowEnd` is the canonical
						// writer, but on an abort the dispatched session can be torn down
						// before the chain reaches a terminal write — `onWorkflowEnd` then
						// never fires and the lane would be stranded "running" (overlay keeps
						// showing it in progress). Retiring here makes the UI authoritative
						// for the user's own cancel; `retireRun` is idempotent, so a later
						// `onWorkflowEnd` for the same run is a no-op.
						t.lane.abort?.();
						retireRun(t.lane.runId, "aborted");
					} else evictRun(t.lane.runId);
				}
				return;
			}
			case "deactivate":
				setDockActive(false);
				return;
			case "exit-passthrough":
				setDockActive(false);
				super.handleInput(data);
				return;
			default: {
				// Genuine submit = a non-empty Enter that the inactive dock is letting
				// through to the editor. Snapshot it BEFORE super.handleInput (which runs
				// submitValue() and clears this.state), so the snapshot reflects the
				// pre-submit text rather than the cleared post-submit state. dock.active is
				// already false here (this is the inactive passthrough branch), but stating
				// it makes the guard self-documenting and pins it independent of the switch.
				const wasSubmit = !editorEmpty && !dock.active && key === "enter";
				super.handleInput(data);
				// A forced full repaint (force=true) wipes previousLines/width/height and
				// erases the stale-frame ghost left behind at a genuine submit boundary.
				// Confined to genuine submits by the three-way guard, so no-op Enters and
				// ordinary keystrokes never trigger the full-screen-clear flicker.
				if (wasSubmit) this.tui.requestRender(true);
			}
		}
	}
}
