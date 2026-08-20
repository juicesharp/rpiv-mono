import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Editor, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	makeQuestionnaireState,
	makeSubmitPickerPropsFromState as submitPickerPropsFromState,
} from "../test-fixtures.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import { SUBMIT_LABEL, SubmitPicker } from "./components/submit-picker.js";
import type { TabBar } from "./components/tab-bar.js";
import {
	type DialogConfig,
	type DialogProps,
	type DialogState,
	DialogView,
	HINT_MULTI,
	HINT_PART_CANCEL,
	HINT_PART_ENTER,
	HINT_PART_NEW_LINE,
	HINT_PART_NOTES,
	HINT_SINGLE,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.js";
import type { TabComponents } from "./tab-components.js";

const theme = makeTheme() as unknown as Theme;

const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trim();

function stubComponent(lines: string[]): Component {
	return { render: () => lines, handleInput() {}, invalidate() {} };
}

function stubPreviewPane(lines: string[], rowRange?: (w: number) => [number, number]): PreviewPane {
	return {
		...stubComponent(lines),
		focusedItemRowRange: rowRange ?? ((_w: number) => [0, 1] as [number, number]),
	} as unknown as PreviewPane;
}

function stubMultiSelect(lines: string[], rowRange?: (w: number) => [number, number]): MultiSelectView {
	return {
		...stubComponent(lines),
		focusedItemRowRange: rowRange ?? ((_w: number) => [0, 0] as [number, number]),
		naturalHeight: (_w: number) => lines.length,
	} as unknown as MultiSelectView;
}

function stubOptionList(): OptionListView {
	return stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView;
}

interface DialogParts {
	config: DialogConfig;
	initialProps: DialogProps;
}

type MakeConfigOverrides = Partial<Omit<DialogConfig, "tabsByIndex">> & {
	state?: DialogState;
	previewPane?: PreviewPane;
	initialProps?: DialogProps;
	tabsByIndex?: ReadonlyArray<TabComponents>;
	multiSelectByTab?: ReadonlyArray<MultiSelectView | undefined>;
};

function makeConfig(over: MakeConfigOverrides = {}): DialogParts {
	const questions: QuestionData[] = over.questions
		? [...over.questions]
		: [
				{
					question: "Q1?",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			];
	const state: DialogState = over.state ?? {
		currentTab: 0,
		optionIndex: 0,
		notesVisible: false,
		inputMode: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
	const previewPane = over.previewPane ?? stubPreviewPane(["<PREVIEW>"]);
	const tabsByIndex: ReadonlyArray<TabComponents> =
		over.tabsByIndex ??
		questions.map((_, i) => ({
			optionList: stubOptionList(),
			preview: previewPane,
			multiSelect: over.multiSelectByTab?.[i],
			bodyHeights: () => ({ current: 0, max: 0 }),
		}));
	const config: DialogConfig = {
		theme: over.theme ?? theme,
		questions,
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Editor),
		isMulti: over.isMulti ?? questions.length > 1,
		tabsByIndex,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight: over.getCurrentBodyHeight ?? (() => 1),
		getTerminalRows: over.getTerminalRows ?? (() => 24),
		collapseKey: over.collapseKey ?? "ctrl+]",
	};
	const initialProps: DialogProps = over.initialProps ?? { state, activePreviewPane: previewPane };
	return { config, initialProps };
}

function makeDialog(parts: DialogParts): DialogView {
	return new DialogView(parts.config, parts.initialProps);
}

describe("Dialog overflow — no clipping when terminal is tall enough", () => {
	it("returns full output including residual spacer when terminal is very tall", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 50, getBodyHeight: () => 6, getCurrentBodyHeight: () => 1 }),
		);
		const lines = dlg.render(80);
		// With termRows=50, dialog fits easily. Residual spacer rows should be present.
		const hintIdx = lines.findIndex((l) => l.includes(HINT_PART_ENTER));
		expect(hintIdx).toBeGreaterThan(0);
		const tail = lines.slice(hintIdx + 1);
		// Residual spacer = (6 + 5) - (1 + 2) = 8 rows  (footerRowCount dropped 4→2)
		expect(tail.length).toBe(8);
		expect(tail.every((l) => l.trim() === "")).toBe(true);
	});

	it("preserves exact same output as current code when no overflow", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 100, getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 }),
		);
		const lines = dlg.render(80);
		// Residual spacer = (5 + 5) - (1 + 2) = 7 rows of trailing blanks  (footerRowCount 4→2)
		const emptyTail = lines.filter((l) => l.trim() === "").length;
		expect(emptyTail).toBeGreaterThanOrEqual(7);
	});
});

describe("Dialog overflow — output never exceeds terminal.rows", () => {
	it.each([10, 15, 20, 24])("terminal height %d: output <= terminal rows", (termRows) => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => termRows, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(termRows);
	});

	it("width safety: every line <= width across heights and widths", () => {
		for (const termRows of [10, 15, 24]) {
			for (const w of [60, 80, 120]) {
				const dlg = makeDialog(
					makeConfig({ getTerminalRows: () => termRows, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
				);
				for (const line of dlg.render(w)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(w);
				}
			}
		}
	});
});

describe("Dialog overflow — 3-region partition", () => {
	it("sticky top preserved: first row is border", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 14, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		// First row should be a horizontal border (─────)
		expect(lines[0]).toMatch(/─/);
	});

	it("sticky bottom preserved: footer hint at end", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 14, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain(HINT_PART_NOTES);
	});

	it("single-question mode: no tab bar in output", () => {
		const dlg = makeDialog(
			makeConfig({
				questions: [{ question: "only?", header: "Only", options: [{ label: "yes", description: "" }] }],
				isMulti: false,
				getTerminalRows: () => 10,
				getBodyHeight: () => 10,
				getCurrentBodyHeight: () => 5,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("<TABBAR>");
		expect(joined).toContain(HINT_SINGLE);
	});
});

describe("Dialog overflow — overflow indicators", () => {
	it("no indicators when content fits", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 50, getBodyHeight: () => 1, getCurrentBodyHeight: () => 1 }),
		);
		const lines = dlg.render(80);
		// Overflow indicators are emitted as a row whose entire visible content is just "↑" or "↓"
		// (theme.fg("dim", …)). The HINT line legitimately contains "↑/↓ to navigate", so this
		// scans for indicator-only rows rather than any occurrence.
		expect(lines.some((l) => stripAnsi(l) === "↑")).toBe(false);
		expect(lines.some((l) => stripAnsi(l) === "↓")).toBe(false);
	});

	it("renders within terminal bounds under heavy overflow with focus at index 0", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 14, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
	});
});

describe("Dialog overflow — minimum terminal", () => {
	it("shows chrome only at topFixed + bottomFixed height", () => {
		// Multi-question: topFixed = 1 + 2 + 1 = 4, bottomFixed = 1 + 2 = 3, total chrome = 7
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 7, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBe(7);
		expect(lines[0]).toMatch(/─/);
		expect(lines.join("\n")).toContain(HINT_PART_NOTES);
	});

	it("clips chrome when terminal smaller than topFixed + bottomFixed", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 5, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		// availableMiddle = max(0, 5 - 4 - 3) = 0 → just chrome, then clipped to termRows
		// (bottomFixed dropped 5→3; still <0 clamp at termRows=5)
		expect(lines.length).toBeLessThanOrEqual(5);
	});
});

describe("Dialog overflow — submit tab", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", kind: "option", answer: "X" }],
	]);

	function submitState(over: Partial<DialogState> = {}): DialogState {
		return {
			currentTab: 2,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers,
			multiSelectChecked: new Set(),
			customDraftsByTab: new Map(),
			notesByTab: new Map(),
			submitChoiceIndex: 0,
			notesDraft: "",
			collapsed: false,
			...over,
		};
	}

	it("output fits terminal on submit tab", () => {
		const state = submitState();
		const picker = new SubmitPicker(theme);
		picker.setProps(submitPickerPropsFromState(state, true));
		const dlg = makeDialog(
			makeConfig({ state, submitPicker: picker, getTerminalRows: () => 12, getBodyHeight: () => 6 }),
		);
		expect(dlg.render(80).length).toBeLessThanOrEqual(12);
	});

	it("top-anchors middle section (no scroll-to-focus)", () => {
		const state = submitState();
		const picker = new SubmitPicker(theme);
		picker.setProps(submitPickerPropsFromState(state, true));
		// topFixed=4, bottomFixed=1+5=6, termRows=14 → availableMiddle=4 (includes REVIEW heading rows)
		const dlg = makeDialog(
			makeConfig({ state, submitPicker: picker, getTerminalRows: () => 14, getBodyHeight: () => 6 }),
		);
		const lines = dlg.render(80);
		const joined = lines.join("\n");
		// With top-anchored scroll on submit, the REVIEW heading should be visible.
		expect(joined).toContain(REVIEW_HEADING);
	});
});

describe("Dialog overflow — indicator content", () => {
	it("shows combined ↕ when availableMiddle === 1 with both overflow directions", () => {
		// topFixed=4, bottomFixed=3 (footerRowCount 4→2), termRows=8 → availableMiddle=1.
		// Body=20 rows, focus at [0,1] → focusedRowInMiddle=2, idealStart=2, scrollStart=2.
		// hasUp=true, hasDown=true, availableMiddle===1 → combined ↕.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 8,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 10,
				previewPane: stubPreviewPane(Array(20).fill("<LINE>")),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(8);
		// Middle row at index topFixed=4 carries the combined glyph.
		expect(stripAnsi(lines[4])).toBe("↕");
		// And no separate ↑/↓ leak through.
		expect(lines.some((l) => stripAnsi(l) === "↑")).toBe(false);
		expect(lines.some((l) => stripAnsi(l) === "↓")).toBe(false);
	});

	it("shows individual ↑ and ↓ when availableMiddle > 1 with centering", () => {
		// termRows=14, availableMiddle=5. focusedItemRowRange=[5,8] → focusedRowInMiddle=7,
		// focusedHeight=3, idealStart=6 → both up and down overflow at scrollStart=6.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 14,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 10,
				previewPane: stubPreviewPane(Array(20).fill("<LINE>"), (_w: number) => [5, 8] as [number, number]),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
		// Top of middle region (index 4) is ↑, bottom (index 10 = 4+7-1) is ↓. At termRows=14
		// with bottomFixed=3 (footerRowCount 4→2), availableMiddle = 14 - 4 - 3 = 7.
		expect(stripAnsi(lines[4])).toBe("↑");
		expect(stripAnsi(lines[10])).toBe("↓");
		// No combined glyph when there's room for two separate indicators.
		expect(lines.some((l) => stripAnsi(l) === "↕")).toBe(false);
	});

	it("shows only ↓ when focused item is at top (scrollStart=0)", () => {
		// Default [0,1] range → focusedRowInMiddle=2, idealStart=0 → scrollStart=0 → only ↓.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 14,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 10,
				previewPane: stubPreviewPane(Array(20).fill("<LINE>")),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
		expect(lines.some((l) => stripAnsi(l) === "↑")).toBe(false);
		expect(lines.some((l) => stripAnsi(l) === "↓")).toBe(true);
		expect(lines.some((l) => stripAnsi(l) === "↕")).toBe(false);
	});

	it("shows only ↑ when focused item is at bottom (scrollStart pinned to max)", () => {
		// Body=30 rows, focus at last row [29,30]. focusedRowInMiddle=31, idealStart=29,
		// scrollStart pinned to middleRows-availableMiddle = 28. hasUp=true, hasDown=false.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 14,
				getBodyHeight: () => 30,
				getCurrentBodyHeight: () => 30,
				previewPane: stubPreviewPane(Array(30).fill("<LINE>"), (_w: number) => [29, 30] as [number, number]),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
		expect(lines.some((l) => stripAnsi(l) === "↑")).toBe(true);
		expect(lines.some((l) => stripAnsi(l) === "↓")).toBe(false);
		expect(lines.some((l) => stripAnsi(l) === "↕")).toBe(false);
	});
});

describe("Dialog overflow — centering with non-trivial focusedItemRowRange", () => {
	it("centers 3-row focused item in scroll window", () => {
		// focusedItemRowRange=[5,8] → 3-row item, should be centered.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 14,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 10,
				previewPane: stubPreviewPane(Array(20).fill("<LINE>"), (_w: number) => [5, 8] as [number, number]),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
		// Focused item content should be visible in the middle region (between indicators).
		expect(lines.slice(4, 9).some((l) => l.includes("<LINE>"))).toBe(true);
	});

	it("handles focusedHeight > availableMiddle (top-anchored fallback)", () => {
		// focusedItemRowRange=[2,8] → focusedHeight=6 > availableMiddle=5. idealStart=4 → top-anchored.
		const dlg = makeDialog(
			makeConfig({
				getTerminalRows: () => 14,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 10,
				previewPane: stubPreviewPane(Array(20).fill("<LINE>"), (_w: number) => [2, 8] as [number, number]),
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(14);
	});
});

describe("Dialog overflow — notes open on a multi-select tab (NFR-2)", () => {
	const multiQ: QuestionData = {
		question: "Areas",
		header: "Areas",
		multiSelect: true,
		options: [
			{ label: "FE", description: "f" },
			{ label: "BE", description: "b" },
		],
	};

	it("flipping notesVisible false→true grows render length by exactly 3; trailing residual-spacer tail unchanged", () => {
		const ms = stubMultiSelect(["<MULTI>"]);
		const common = {
			questions: [multiQ],
			isMulti: false,
			multiSelectByTab: [ms],
			getTerminalRows: () => 50,
			getBodyHeight: () => 8,
			getCurrentBodyHeight: () => 4,
		};
		const closed = makeDialog(makeConfig({ ...common, state: makeQuestionnaireState({ notesVisible: false }) }));
		const open = makeDialog(makeConfig({ ...common, state: makeQuestionnaireState({ notesVisible: true }) }));
		const closedLines = closed.render(80);
		const openLines = open.render(80);
		expect(closedLines.length).toBeLessThanOrEqual(50);
		expect(openLines.length).toBeLessThanOrEqual(50);
		// midRows = Notes header + notesInput + Spacer = 3 rows; everything else is invariant.
		expect(openLines.length - closedLines.length).toBe(3);
		// NFR-2: growing midRows never desyncs the spacerRows residual math — the trailing
		// residual-spacer tail is identical with notes closed vs open.
		const trailingBlanks = (lines: string[]) => {
			let n = 0;
			for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) n++;
			return n;
		};
		expect(trailingBlanks(openLines)).toBe(trailingBlanks(closedLines));
	});

	it("overflow with notes open: output ≤ termRows, top border sticky, HINT_PART_CANCEL sticky (NOT HINT_MULTI)", () => {
		// On a multi-select tab `buildHintText` interleaves HINT_PART_TOGGLE between NAV and
		// (post-Phase-1) NOTES, and NOTES drops when notesVisible, so HINT_MULTI
		// (ENTER·NAV·NOTES·TAB·CANCEL) is never a contiguous substring of this render.
		// HINT_PART_CANCEL (always the last core part) is the correct sticky-chrome assertion.
		const ms = stubMultiSelect(Array(10).fill("<MULTI>"));
		const dlg = makeDialog(
			makeConfig({
				questions: [multiQ],
				isMulti: false,
				state: makeQuestionnaireState({ notesVisible: true }),
				multiSelectByTab: [ms],
				getTerminalRows: () => 10,
				getBodyHeight: () => 20,
				getCurrentBodyHeight: () => 20,
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines[0]).toMatch(/─/);
		expect(lines.join("\n")).toContain(HINT_PART_CANCEL);
		expect(lines.join("\n")).not.toContain(HINT_MULTI);
	});
});

describe("Dialog overflow — notes open on the Submit tab (NFR-2)", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", kind: "option", answer: "X" }],
	]);

	function submitState(over: Partial<DialogState> = {}): DialogState {
		return {
			currentTab: 2,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers,
			multiSelectChecked: new Set(),
			customDraftsByTab: new Map(),
			notesByTab: new Map(),
			submitChoiceIndex: 0,
			notesDraft: "",
			collapsed: false,
			...over,
		};
	}

	function makeSubmitDialog(state: DialogState, over: MakeConfigOverrides = {}): DialogView {
		const picker = new SubmitPicker(theme);
		picker.setProps(submitPickerPropsFromState(state, true));
		return makeDialog(
			makeConfig({
				state,
				submitPicker: picker,
				getTerminalRows: () => 50,
				getBodyHeight: () => 8,
				...over,
			}),
		);
	}

	it("flipping notesVisible false→true grows the render by exactly 3; tail identical; hint blanks while open", () => {
		const closedLines = makeSubmitDialog(submitState()).render(80);
		const openLines = makeSubmitDialog(submitState({ notesVisible: true })).render(80);
		// midRows = Global-note header + notesInput (stubbed to 1 row) + Spacer = 3 rows.
		expect(openLines.length - closedLines.length).toBe(3);
		expect(openLines.join("\n")).toContain("Global note:");
		expect(openLines.join("\n")).toContain("<NOTES_INPUT>");
		expect(closedLines.join("\n")).not.toContain("<NOTES_INPUT>");
		// The bottom hint row is always present: the note part shows while closed and
		// gives way to the Shift+Enter newline hint while the editor is open.
		expect(closedLines.join("\n")).toContain("n to add a note");
		expect(openLines.join("\n")).not.toContain("n to add a note");
		expect(openLines.join("\n")).toContain(HINT_PART_NEW_LINE);
		// NFR-2: growing midRows never desyncs the residual-spacer math — the trailing
		// blank tail is identical with the editor closed vs open (footer stays 5 rows).
		const trailingBlanks = (lines: string[]) => {
			let n = 0;
			for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) n++;
			return n;
		};
		expect(trailingBlanks(openLines)).toBe(trailingBlanks(closedLines));
	});

	it("overflow while open: output ≤ termRows, sticky top border, sticky footer (picker visible)", () => {
		const dlg = makeSubmitDialog(submitState({ notesVisible: true }), {
			getTerminalRows: () => 12,
			getBodyHeight: () => 20,
		});
		const lines = dlg.render(80);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines[0]).toMatch(/─/);
		expect(lines.join("\n")).toContain(SUBMIT_LABEL);
	});

	it("width-clip: render length is width-invariant in the one-line regime; hint clips to one row, never wraps", () => {
		// READY_PROMPT (30 visible cols) is the widest footer string, so the length sweep
		// starts where every footer row is single-line. A wrapping hint would inflate the
		// submit footer past footerRowCount=5 and desync the cross-tab height equalizer.
		const widths = [40, 60, 80, 120];
		const lengths = new Set(widths.map((w) => makeSubmitDialog(submitState()).render(w).length));
		expect(lengths.size).toBe(1);
		// Ultra-narrow: exactly one hint row survives, clipped (never wrapped to two).
		// The bottom hint opens with HINT_PART_ENTER, so its prefix is the row's signature.
		const narrow = makeSubmitDialog(submitState()).render(10);
		const hintRows = narrow.filter((l) => stripAnsi(l).startsWith("Enter to"));
		expect(hintRows.length).toBe(1);
		expect(visibleWidth(hintRows[0]!)).toBeLessThanOrEqual(10);
	});

	it("hint sits BELOW the picker; the prompt reads straight into its options", () => {
		// The #182 review moved the note affordance out of the prompt→picker gap: the
		// footer order is prompt, picker rows, then the bottom key-hint row (the same
		// bottom-row idiom as question tabs).
		const lines = makeSubmitDialog(submitState()).render(80).map(stripAnsi);
		const promptRow = lines.findIndex((l) => l.includes(READY_PROMPT));
		const submitRow = lines.findIndex((l) => l.includes(SUBMIT_LABEL));
		const hintRow = lines.findIndex((l) => l.includes("n to add a note"));
		expect(promptRow).toBeGreaterThanOrEqual(0);
		expect(submitRow).toBe(promptRow + 1);
		expect(hintRow).toBeGreaterThan(submitRow);
	});

	it("a committed global note renders as a review entry while closed and hides while the editor is open", () => {
		// The committed note lives at the questions.length pseudo-index (2 questions here).
		const noted = () => new Map([[2, "Ship behind a feature flag"]]);
		const closed = makeSubmitDialog(submitState({ notesByTab: noted() }))
			.render(80)
			.join("\n");
		expect(closed).toContain("● Note");
		expect(closed).toContain("Ship behind a feature flag");
		// While the editor is open it is the live surface (seeded with this text) — the
		// review entry hides so the note never appears twice.
		const open = makeSubmitDialog(submitState({ notesByTab: noted(), notesVisible: true }))
			.render(80)
			.join("\n");
		expect(open).not.toContain("● Note");
	});
});
