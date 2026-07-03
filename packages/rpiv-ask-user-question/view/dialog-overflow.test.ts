import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Input, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { makeSubmitPickerPropsFromState as submitPickerPropsFromState } from "../test-fixtures.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import { SubmitPicker } from "./components/submit-picker.js";
import type { TabBar } from "./components/tab-bar.js";
import {
	type DialogConfig,
	type DialogProps,
	type DialogState,
	DialogView,
	HINT_MULTI,
	HINT_SINGLE,
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
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
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
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Input),
		isMulti: over.isMulti ?? questions.length > 1,
		tabsByIndex,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight: over.getCurrentBodyHeight ?? (() => 1),
		getTerminalRows: over.getTerminalRows ?? (() => 24),
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
		const hintIdx = lines.findIndex((l) => l.includes(HINT_MULTI));
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
		expect(joined).toContain(HINT_MULTI);
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
		expect(lines.join("\n")).toContain(HINT_MULTI);
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
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
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
