import { describe, expect, it, vi } from "vitest";
import type { DialogComponent } from "./dialog-builder.js";
import type { MultiSelectOptions } from "./multi-select-options.js";
import type { OptionListView } from "./option-list-view.js";
import type { PreviewPane } from "./preview-pane.js";
import type { QuestionnaireState } from "./questionnaire-state.js";
import type { SubmitPicker } from "./submit-picker.js";
import type { TabBar } from "./tab-bar.js";
import type { QuestionAnswer, QuestionData } from "./types.js";
import { QuestionnaireViewAdapter } from "./view-adapter.js";
import type { WrappingSelect, WrappingSelectItem } from "./wrapping-select.js";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: over.currentTab ?? 0,
		optionIndex: over.optionIndex ?? 0,
		inputMode: over.inputMode ?? false,
		notesVisible: over.notesVisible ?? false,
		chatFocused: over.chatFocused ?? false,
		answers: over.answers ?? new Map(),
		multiSelectChecked: over.multiSelectChecked ?? new Set(),
		notesByTab: over.notesByTab,
		focusedOptionHasPreview: over.focusedOptionHasPreview ?? false,
		submitChoiceIndex: over.submitChoiceIndex ?? 0,
	};
}

function makeFixture(overQuestions?: QuestionData[]) {
	const questions = overQuestions ?? [makeQuestion(), makeQuestion()];
	const itemsByTab: WrappingSelectItem[][] = questions.map(() => [
		{ kind: "option", label: "A" },
		{ kind: "option", label: "B" },
	]);
	const optionListViewsByTab = questions.map(() => ({
		setSelectedIndex: vi.fn(),
		setFocused: vi.fn(),
		setConfirmedIndex: vi.fn(),
	})) as unknown as OptionListView[];
	const previewPanes = questions.map(() => ({
		setNotesVisible: vi.fn(),
	})) as unknown as PreviewPane[];
	const chatList = {
		setFocused: vi.fn(),
		setNumbering: vi.fn(),
	} as unknown as WrappingSelect;
	const multiSelectOptionsByTab: Array<MultiSelectOptions | undefined> = questions.map((q) =>
		q.multiSelect
			? ({
					setState: vi.fn(),
					setFocused: vi.fn(),
				} as unknown as MultiSelectOptions)
			: undefined,
	);
	const submitPicker = {
		setState: vi.fn(),
		setFocused: vi.fn(),
	} as unknown as SubmitPicker;
	const tabBar = { setConfig: vi.fn() } as unknown as TabBar;
	const dialog = {
		setState: vi.fn(),
		setPreviewPane: vi.fn(),
	} as unknown as DialogComponent;
	const tui = { requestRender: vi.fn() };
	const adapter = new QuestionnaireViewAdapter({
		tui,
		questions,
		itemsByTab,
		optionListViewsByTab,
		previewPanes,
		chatList,
		multiSelectOptionsByTab,
		submitPicker,
		tabBar,
		dialog,
	});
	return {
		adapter,
		tui,
		dialog,
		optionListViewsByTab,
		previewPanes,
		chatList,
		multiSelectOptionsByTab,
		submitPicker,
		tabBar,
		questions,
	};
}

describe("QuestionnaireViewAdapter.apply", () => {
	it("calls dialog.setState exactly once with the state argument", () => {
		const { adapter, dialog } = makeFixture();
		const state = makeState();
		adapter.apply(state);
		expect((dialog.setState as ReturnType<typeof vi.fn>).mock.calls).toEqual([[state]]);
	});

	it("drives the active OptionListView with selectedIndex / focused / confirmedIndex and the active PreviewPane with notesVisible", () => {
		const { adapter, optionListViewsByTab, previewPanes } = makeFixture();
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "Pick one", kind: "option", answer: "B" }],
		]);
		adapter.apply(makeState({ optionIndex: 1, answers }));
		expect(optionListViewsByTab[0]!.setSelectedIndex).toHaveBeenCalledWith(1);
		expect(optionListViewsByTab[0]!.setFocused).toHaveBeenCalledWith(true);
		expect(optionListViewsByTab[0]!.setConfirmedIndex).toHaveBeenCalledWith(1, undefined);
		expect(previewPanes[0]!.setNotesVisible).toHaveBeenCalledWith(false);
	});

	it("suppresses option focus when notes is visible or chat is focused", () => {
		const { adapter, optionListViewsByTab } = makeFixture();
		adapter.apply(makeState({ notesVisible: true }));
		expect(optionListViewsByTab[0]!.setFocused).toHaveBeenLastCalledWith(false);
		adapter.apply(makeState({ chatFocused: true }));
		expect(optionListViewsByTab[0]!.setFocused).toHaveBeenLastCalledWith(false);
	});

	it("focuses the submitPicker only when on the Submit tab", () => {
		const { adapter, submitPicker, questions } = makeFixture();
		adapter.apply(makeState({ currentTab: 0 }));
		expect(submitPicker.setFocused).toHaveBeenLastCalledWith(false);
		adapter.apply(makeState({ currentTab: questions.length }));
		expect(submitPicker.setFocused).toHaveBeenLastCalledWith(true);
	});

	it("passes a NEW Map to tabBar.setConfig (defensive copy)", () => {
		const { adapter, tabBar } = makeFixture();
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
		]);
		adapter.apply(makeState({ answers }));
		const arg = (tabBar.setConfig as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(arg.answers).not.toBe(answers);
		expect(arg.answers.get(0)?.answer).toBe("A");
	});

	it("calls tui.requestRender exactly once", () => {
		const { adapter, tui } = makeFixture();
		adapter.apply(makeState());
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("multi-select panes get setState + setFocused on every apply", () => {
		const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
		const { adapter, multiSelectOptionsByTab } = makeFixture(questions);
		const state = makeState();
		adapter.apply(state);
		const mso = multiSelectOptionsByTab[0]!;
		expect(mso.setState).toHaveBeenCalledWith(state);
		expect(mso.setFocused).toHaveBeenCalledWith(true);
	});
});

describe("QuestionnaireViewAdapter.setActivePreviewPane", () => {
	it("forwards the resolved pane to dialog.setPreviewPane", () => {
		const { adapter, dialog, previewPanes } = makeFixture();
		adapter.setActivePreviewPane(1);
		expect(dialog.setPreviewPane).toHaveBeenCalledWith(previewPanes[1]);
	});
	it("falls back to the first pane on invalid index (defensive)", () => {
		const { adapter, dialog, previewPanes } = makeFixture();
		adapter.setActivePreviewPane(99);
		expect(dialog.setPreviewPane).toHaveBeenCalledWith(previewPanes[0]);
	});
});
