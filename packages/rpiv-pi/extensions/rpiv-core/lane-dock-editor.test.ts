import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DockDecisionContext, type DockKey, decideDockAction, LaneDockEditor } from "./lane-dock-editor.js";
import { __resetRunLaneRegistry } from "./run-lane-registry.js";

/** Base context: prompt empty, no autocomplete, two rows. */
function ctx(overrides: Partial<DockDecisionContext> = {}): DockDecisionContext {
	return {
		autocompleteOpen: false,
		editorEmpty: true,
		rowCount: 2,
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

describe("LaneDockEditor — force-clear on genuine submit", () => {
	const ENTER = "\r"; // Key.enter codepoint 13
	const TYPE_A = "a"; // an ordinary (non-Enter) keystroke

	/** A render-spy harness: captures requestRender calls (including the `force` arg). */
	function makeRenderSpyEditor(): {
		editor: LaneDockEditor;
		calls: Array<{ runId: string; unitIndex: number }>;
		renders: Array<{ force: boolean | undefined }>;
	} {
		const renders: Array<{ force: boolean | undefined }> = [];
		const tui = {
			terminal: { rows: 40 },
			requestRender: (force?: boolean) => renders.push({ force }),
		} as unknown as TUI;
		const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as EditorTheme;
		const keybindings = { matches: () => false } as unknown as KeybindingsManager;
		const calls: Array<{ runId: string; unitIndex: number }> = [];
		const editor = new LaneDockEditor(tui, theme, keybindings, (runId, unitIndex) =>
			calls.push({ runId, unitIndex }),
		);
		return { editor, calls, renders };
	}

	beforeEach(() => __resetRunLaneRegistry());
	afterEach(() => __resetRunLaneRegistry());

	it("a genuine non-empty Enter (dock inactive) forces a full repaint exactly once (c1)", () => {
		// No lanes recorded → the dock is inactive and stays inactive; the editor's own
		// submit path runs via super.handleInput. Seed genuine submit text BEFORE handleInput
		// so the pre-submit editorEmpty snapshot reflects it (not the cleared post-state).
		const { editor, calls, renders } = makeRenderSpyEditor();
		editor.setText("ship it");
		editor.handleInput(ENTER);

		// The editor's submitValue runs through super.handleInput — the dock adapter
		// forwards nothing (no lanes → nothing to open).
		expect(calls).toEqual([]);
		// Exactly one forced full repaint, fired AFTER super.handleInput.
		expect(renders).toEqual([{ force: true }]);
	});

	it("a no-op Enter on an EMPTY editor does NOT force-render (c2)", () => {
		// editorEmpty short-circuits the guard, so the empty-prompt Enter (a no-op submit)
		// never triggers the full-screen-clear flicker.
		const { editor, renders } = makeRenderSpyEditor();
		editor.handleInput(ENTER);

		expect(renders.filter((r) => r.force === true)).toEqual([]);
	});

	it("a NON-Enter key on a non-empty editor does NOT force-render (key guard)", () => {
		// Locks the `key === "enter"` guard so ordinary typing never flickers.
		const { editor, renders } = makeRenderSpyEditor();
		editor.setText("ship it");
		editor.handleInput(TYPE_A);

		expect(renders.filter((r) => r.force === true)).toEqual([]);
	});
});
