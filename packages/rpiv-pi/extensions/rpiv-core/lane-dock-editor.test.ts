import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DockDecisionContext, type DockKey, decideDockAction, LaneDockEditor } from "./lane-dock-editor.js";
import { __resetRunLaneRegistry, listLanes, recordRun, retireRun } from "./run-lane-registry.js";

/** Base context: prompt empty, no autocomplete, two rows. */
function ctx(overrides: Partial<DockDecisionContext> = {}): DockDecisionContext {
	return {
		autocompleteOpen: false,
		editorEmpty: true,
		rowCount: 2,
		allTerminal: false,
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

	it.each<DockKey>(["up", "enter", "right", "left", "tab", "escape", "stop", "other"])(
		"%s passes through while inactive",
		(key) => {
			expect(decideDockAction(key, ctx())).toEqual({ kind: "passthrough" });
		},
	);
});

describe("decideDockAction — clear-completed (ESC at empty root prompt)", () => {
	it("ESC on an empty prompt with all-terminal lanes, no autocomplete → clear-completed", () => {
		expect(
			decideDockAction(
				"escape",
				ctx({ editorEmpty: true, autocompleteOpen: false, rowCount: 2, allTerminal: true }),
			),
		).toEqual({ kind: "clear-completed" });
	});

	it("ESC is NOT hijacked when the editor has text (typing role preserved)", () => {
		expect(decideDockAction("escape", ctx({ editorEmpty: false, allTerminal: true }))).toEqual({
			kind: "passthrough",
		});
	});

	it("ESC is NOT hijacked while autocomplete is open (dropdown closes, not clear)", () => {
		expect(decideDockAction("escape", ctx({ autocompleteOpen: true, allTerminal: true }))).toEqual({
			kind: "passthrough",
		});
	});

	it("ESC does NOT clear when there are no rows (defeats every() vacuous truth)", () => {
		expect(decideDockAction("escape", ctx({ rowCount: 0, allTerminal: true }))).toEqual({ kind: "passthrough" });
	});

	it("ESC does NOT clear while a lane is still running (allTerminal false)", () => {
		expect(decideDockAction("escape", ctx({ rowCount: 1, allTerminal: false }))).toEqual({ kind: "passthrough" });
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

describe("LaneDockEditor — ESC clears finished lanes at an empty root prompt", () => {
	const ESC = "\x1b"; // Key.escape codepoint 27 (matches matchesKey(data, Key.escape))
	const TYPE_A = "a"; // an ordinary keystroke (non-empty prompt)

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

	it("ESC at an empty prompt with all lanes terminal → batch-evicts every lane (dock collapses)", () => {
		recordRun("run-1", "ship");
		retireRun("run-1", "completed");
		recordRun("run-2", "build");
		retireRun("run-2", "failed", "boom");
		expect(listLanes().length).toBe(2); // two terminal lanes seeded

		const { editor, calls } = makeRenderSpyEditor();
		editor.handleInput(ESC); // empty prompt (default), autocomplete closed (default)

		// Every terminal lane evicted from the live registry (evictRun per terminal lane) →
		// the registry is empty, so LaneDock.update() will unregister the widget (collapse).
		expect(listLanes()).toEqual([]);
		// ESC is consumed — no browser step-in (onOpen never called).
		expect(calls).toEqual([]);
	});

	it("a single terminal lane is also evicted (N=1 case)", () => {
		recordRun("run-1", "ship");
		retireRun("run-1", "completed");

		const { editor } = makeRenderSpyEditor();
		editor.handleInput(ESC);

		expect(listLanes()).toEqual([]);
	});

	it("ESC with a running lane present → NOT evicted; the lane survives (passes through)", () => {
		recordRun("run-1", "ship"); // status: running (no retireRun)

		const { editor } = makeRenderSpyEditor();
		editor.handleInput(ESC);

		// allTerminal is false → clear-completed gate fails → passthrough. The running lane
		// is preserved (NOT evicted) and ESC delegates to super.handleInput.
		expect(listLanes().map((l) => l.runId)).toEqual(["run-1"]);
		expect(listLanes()[0].status).toBe("running");
	});

	it("ESC with zero lanes → passes through (not consumed for nothing)", () => {
		// No lanes recorded → rowCount 0 (defeats every() vacuous truth). ESC must not be
		// hijacked into a no-op clear; it delegates to the editor.
		const { editor } = makeRenderSpyEditor();
		editor.handleInput(ESC);

		expect(listLanes()).toEqual([]);
	});

	it("ESC while typing (non-empty prompt) → passes through (typing role preserved)", () => {
		recordRun("run-1", "ship");
		retireRun("run-1", "completed"); // allTerminal true, but prompt is non-empty

		const { editor } = makeRenderSpyEditor();
		editor.setText(TYPE_A); // non-empty prompt
		editor.handleInput(ESC);

		// editorEmpty is false → clear-completed gate fails → passthrough. The terminal lane
		// is preserved; ESC keeps its editor role.
		expect(listLanes().map((l) => l.runId)).toEqual(["run-1"]);
	});
});
