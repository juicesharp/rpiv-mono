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
 * its render() is overridden to HIDE the input box (border + blinking cursor) for
 * the duration — otherwise an empty prompt with a live cursor would sit above the
 * dock you're navigating. It reappears the instant focus returns to the prompt
 * (dock deactivated). The dock draws its own top rule in that state to stay framed.
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	evictRun,
	getDockState,
	laneCount,
	listLanesForDisplay,
	moveDockSelection,
	setDockActive,
	setDockSelection,
} from "./run-lane-registry.js";

/** The navigation keys the dock cares about; everything else is "other".
 *  "stop" is the `x` key (abort a running lane / dismiss a finished one). */
export type DockKey = "up" | "down" | "enter" | "escape" | "tab" | "stop" | "other";

/** Live inputs the decision depends on — snapshotted from the editor + registry. */
export interface DockDecisionContext {
	/** Is the dock currently holding navigation focus? */
	readonly dockActive: boolean;
	/** Is the editor's autocomplete dropdown open? (It owns ↑/↓/⏎/tab when so.) */
	readonly autocompleteOpen: boolean;
	/** Is the prompt empty? (DOWN-entry is gated on this to avoid arrow overload.) */
	readonly editorEmpty: boolean;
	/** Number of lanes (the dock's auto-show gate + tab-wrap modulus). */
	readonly laneCount: number;
	/** Current dock selection (index into listLanesForDisplay()). */
	readonly selection: number;
}

/** A verb for the adapter to execute. Pure data — no side effects here. */
export type DockAction =
	| { kind: "activate" } // step into the dock at the top
	| { kind: "move"; delta: number } // shift selection (registry clamps)
	| { kind: "select"; index: number } // jump selection to an absolute row (tab wrap)
	| { kind: "open" } // switch into the selected run
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
		if (key === "down" && ctx.editorEmpty && !ctx.autocompleteOpen && ctx.laneCount > 0) {
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
			return { kind: "select", index: ctx.laneCount > 0 ? (ctx.selection + 1) % ctx.laneCount : 0 };
		case "enter":
			return { kind: "open" };
		case "stop":
			return { kind: "stop" };
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
	if (matchesKey(data, Key.escape)) return "escape";
	if (matchesKey(data, Key.tab)) return "tab";
	if (data === "x") return "stop"; // mirrors the retired manager's `x` binding
	return "other";
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
		private readonly onOpen: (runId: string) => void,
	) {
		super(tui, theme, keybindings);
	}

	/**
	 * Hide the input box while the dock holds navigation focus. The editor remains
	 * focused (so handleInput keeps receiving keystrokes), but rendering a single blank
	 * line suppresses the empty prompt + reversed-video cursor that would otherwise
	 * float above the dock — WITHOUT collapsing the editor to zero height (which would
	 * yank the dock up against Pi's chrome). Falls straight back to the normal editor
	 * render the moment the dock is deactivated, so the prompt returns when focus comes
	 * back to the input.
	 */
	render(width: number): string[] {
		if (getDockState().active) return [""];
		return super.render(width);
	}

	handleInput(data: string): void {
		const dock = getDockState();
		const action = decideDockAction(classifyKey(data), {
			dockActive: dock.active,
			autocompleteOpen: this.isShowingAutocomplete(),
			editorEmpty: this.getText().trim().length === 0,
			laneCount: laneCount(),
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
				const lane = listLanesForDisplay()[getDockState().selection];
				setDockActive(false);
				if (lane) this.onOpen(lane.runId);
				return;
			}
			case "stop": {
				// `x` on the selected lane: abort a running run (it retires to "aborted"),
				// or dismiss a finished/retained one. The dock stays active so the user can
				// keep acting on the list; selection re-clamps as lanes drop.
				const lane = listLanesForDisplay()[getDockState().selection];
				if (lane) {
					if (lane.status === "running") lane.abort?.();
					else evictRun(lane.runId);
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
			default:
				super.handleInput(data);
		}
	}
}
