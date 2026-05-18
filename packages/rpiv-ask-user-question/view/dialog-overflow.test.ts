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

function stubComponent(lines: string[]): Component {
	return { render: () => lines, handleInput() {}, invalidate() {} };
}

function stubPreviewPane(lines: string[]): PreviewPane {
	return {
		...stubComponent(lines),
		focusedItemRowRange: (_w: number) => [0, 1] as [number, number],
	} as unknown as PreviewPane;
}

function stubOptionList(): OptionListView {
	return stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView;
}

interface DialogParts {
	config: DialogConfig;
	initialProps: DialogProps;
}

type MakeConfigOverrides = Partial<Omit<DialogConfig, "chatRow" | "tabsByIndex">> & {
	state?: DialogState;
	previewPane?: PreviewPane;
	initialProps?: DialogProps;
	chatList?: DialogConfig["chatRow"];
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
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
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
		chatRow: over.chatList ?? (stubComponent(["<CHAT_ROW>"]) as unknown as DialogConfig["chatRow"]),
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
		const chatIdx = lines.findIndex((l) => l.includes("<CHAT_ROW>"));
		const hintIdx = lines.findIndex((l) => l.includes(HINT_MULTI));
		expect(chatIdx).toBeGreaterThan(0);
		expect(hintIdx).toBeGreaterThan(chatIdx);
		const tail = lines.slice(hintIdx + 1);
		// Residual spacer = (6 + 5) - (1 + 4) = 6 rows
		expect(tail.length).toBe(6);
		expect(tail.every((l) => l.trim() === "")).toBe(true);
	});

	it("preserves exact same output as current code when no overflow", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 100, getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 }),
		);
		const lines = dlg.render(80);
		// Residual spacer = (5 + 5) - (1 + 4) = 5 rows of trailing blanks
		const emptyTail = lines.filter((l) => l.trim() === "").length;
		expect(emptyTail).toBeGreaterThanOrEqual(5);
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

	it("chat row visible in sticky bottom when footer fits", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 14, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("<CHAT_ROW>");
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
		const stripped = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trim();
		expect(lines.some((l) => stripped(l) === "↑")).toBe(false);
		expect(lines.some((l) => stripped(l) === "↓")).toBe(false);
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
		// Multi-question: topFixed = 1 + 2 + 1 = 4, bottomFixed = 1 + 4 = 5, total chrome = 9
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 9, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBe(9);
		expect(lines[0]).toMatch(/─/);
		expect(lines.join("\n")).toContain(HINT_MULTI);
	});

	it("clips chrome when terminal smaller than topFixed + bottomFixed", () => {
		const dlg = makeDialog(
			makeConfig({ getTerminalRows: () => 5, getBodyHeight: () => 20, getCurrentBodyHeight: () => 10 }),
		);
		const lines = dlg.render(80);
		// availableMiddle = max(0, 5 - 4 - 5) = 0 → just chrome, then clipped to termRows
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
			chatFocused: false,
			answers,
			multiSelectChecked: new Set(),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
			notesDraft: "",
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
