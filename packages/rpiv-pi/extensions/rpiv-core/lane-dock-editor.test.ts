import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DockDecisionContext, type DockKey, decideDockAction, LaneDockEditor } from "./lane-dock-editor.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getDockState,
	recordRun,
	SINGLE_UNIT_KEY,
	setDockActive,
	setDockSelection,
} from "./run-lane-registry.js";

/** Base context: dock inactive, prompt empty, no autocomplete, two rows, top selected. */
function ctx(overrides: Partial<DockDecisionContext> = {}): DockDecisionContext {
	return {
		dockActive: false,
		autocompleteOpen: false,
		editorEmpty: true,
		rowCount: 2,
		selection: 0,
		...overrides,
	};
}

describe("decideDockAction — inactive (entry gesture)", () => {
	it("DOWN on an empty prompt with lanes and no autocomplete → activate", () => {
		expect(decideDockAction("down", ctx())).toEqual({ kind: "activate" });
	});

	it("DOWN is NOT hijacked when the editor has text (cursor movement wins)", () => {
		expect(decideDockAction("down", ctx({ editorEmpty: false }))).toEqual({ kind: "passthrough" });
	});

	it("DOWN is NOT hijacked while autocomplete is open", () => {
		expect(decideDockAction("down", ctx({ autocompleteOpen: true }))).toEqual({ kind: "passthrough" });
	});

	it("DOWN does nothing special when there are no rows", () => {
		expect(decideDockAction("down", ctx({ rowCount: 0 }))).toEqual({ kind: "passthrough" });
	});

	it.each<DockKey>([
		"up",
		"enter",
		"right",
		"left",
		"tab",
		"escape",
		"stop",
		"other",
	])("%s passes through while inactive", (key) => {
		expect(decideDockAction(key, ctx())).toEqual({ kind: "passthrough" });
	});
});

describe("decideDockAction — active (navigation)", () => {
	const active = (o: Partial<DockDecisionContext> = {}) => ctx({ dockActive: true, ...o });

	it("UP at the top row returns focus to the input (deactivate)", () => {
		expect(decideDockAction("up", active({ selection: 0 }))).toEqual({ kind: "deactivate" });
	});

	it("UP below the top moves the selection up", () => {
		expect(decideDockAction("up", active({ selection: 1 }))).toEqual({ kind: "move", delta: -1 });
	});

	it("DOWN moves the selection down (registry clamps at the end)", () => {
		expect(decideDockAction("down", active({ selection: 0 }))).toEqual({ kind: "move", delta: 1 });
	});

	it("TAB cycles to the next row", () => {
		expect(decideDockAction("tab", active({ selection: 0, rowCount: 3 }))).toEqual({ kind: "select", index: 1 });
	});

	it("TAB wraps from the last row back to the top", () => {
		expect(decideDockAction("tab", active({ selection: 2, rowCount: 3 }))).toEqual({ kind: "select", index: 0 });
	});

	it("ENTER is the dedicated answer key (the adapter no-ops it when nothing is queued)", () => {
		expect(decideDockAction("enter", active({ selection: 1 }))).toEqual({ kind: "answer" });
	});

	it("RIGHT is the dedicated transcript key — always opens the viewer", () => {
		expect(decideDockAction("right", active({ selection: 1 }))).toEqual({ kind: "open" });
	});

	it("STOP (x) acts on the selected lane (abort/remove resolved by the adapter)", () => {
		expect(decideDockAction("stop", active({ selection: 1 }))).toEqual({ kind: "stop" });
	});

	it("ESC steps back to the input", () => {
		expect(decideDockAction("escape", active())).toEqual({ kind: "deactivate" });
	});

	it("LEFT backs out of the dock (deactivate), mirroring → stepping in", () => {
		expect(decideDockAction("left", active({ selection: 1 }))).toEqual({ kind: "deactivate" });
	});

	it("any other key exits the dock AND forwards the keystroke (resume typing)", () => {
		expect(decideDockAction("other", active())).toEqual({ kind: "exit-passthrough" });
	});

	it("an open autocomplete defensively keeps all keys (never steals from the dropdown)", () => {
		expect(decideDockAction("up", active({ autocompleteOpen: true }))).toEqual({ kind: "passthrough" });
		expect(decideDockAction("down", active({ autocompleteOpen: true }))).toEqual({ kind: "passthrough" });
	});
});

describe("LaneDockEditor — input visibility while stepped in", () => {
	// A minimal harness: the base Editor.render only touches tui.terminal.rows +
	// theme.borderColor (the editor box is just horizontal rules around the text),
	// and CustomEditor merely stores keybindings — so these stubs suffice.
	function makeEditor(): LaneDockEditor {
		const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
		const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as EditorTheme;
		const keybindings = { matches: () => false } as unknown as KeybindingsManager;
		return new LaneDockEditor(tui, theme, keybindings, () => {});
	}

	beforeEach(() => __resetRunLaneRegistry());
	afterEach(() => __resetRunLaneRegistry());

	it("renders the normal input box while the dock is inactive", () => {
		expect(makeEditor().render(80).length).toBeGreaterThan(0);
	});

	it("hides the input box while the dock holds navigation focus, keeping one blank line", () => {
		const editor = makeEditor();
		setDockActive(true);
		// A single blank line: no border, no cursor — but the editor keeps its height so
		// the dock below doesn't jump up against Pi's chrome.
		expect(editor.render(80)).toEqual([""]);
	});

	it("restores the input box when focus returns to the prompt (dock deactivated)", () => {
		const editor = makeEditor();
		setDockActive(true);
		expect(editor.render(80)).toEqual([""]);
		setDockActive(false);
		expect(editor.render(80).length).toBeGreaterThan(1);
	});
});

describe("LaneDockEditor — dedicated answer/transcript dispatch", () => {
	const ENTER = "\r"; // Key.enter codepoint 13
	const RIGHT = "\x1b[C"; // legacy right-arrow sequence

	function makeSpyEditor(): {
		editor: LaneDockEditor;
		calls: Array<{ runId: string; unitIndex: number; mode: string }>;
	} {
		const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
		const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as EditorTheme;
		const keybindings = { matches: () => false } as unknown as KeybindingsManager;
		const calls: Array<{ runId: string; unitIndex: number; mode: string }> = [];
		const editor = new LaneDockEditor(tui, theme, keybindings, (runId, unitIndex, mode) =>
			calls.push({ runId, unitIndex, mode }),
		);
		return { editor, calls };
	}

	function enqueue(runId: string): void {
		enqueueInput(runId, SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
	}

	beforeEach(() => __resetRunLaneRegistry());
	afterEach(() => __resetRunLaneRegistry());

	it("ENTER answers a flagged lane (drains its queued question)", () => {
		recordRun("run-1", "ship");
		enqueue("run-1");
		setDockActive(true);
		setDockSelection(0);
		const { editor, calls } = makeSpyEditor();
		editor.handleInput(ENTER);
		expect(calls).toEqual([{ runId: "run-1", unitIndex: SINGLE_UNIT_KEY, mode: "answer" }]);
	});

	it("ENTER is inert on a lane with nothing queued — stays stepped in, opens nothing", () => {
		recordRun("run-1", "ship");
		setDockActive(true);
		setDockSelection(0);
		const { editor, calls } = makeSpyEditor();
		editor.handleInput(ENTER);
		expect(calls).toEqual([]);
		expect(getDockState().active).toBe(true);
	});

	it("RIGHT (→) opens the transcript for any lane (view mode), flagged or not", () => {
		recordRun("run-1", "ship");
		setDockActive(true);
		setDockSelection(0);
		const { editor, calls } = makeSpyEditor();
		editor.handleInput(RIGHT);
		expect(calls).toEqual([{ runId: "run-1", unitIndex: SINGLE_UNIT_KEY, mode: "view" }]);
	});
});
