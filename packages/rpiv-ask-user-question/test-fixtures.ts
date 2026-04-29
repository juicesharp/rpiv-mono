import { vi } from "vitest";
import type { QuestionnaireState } from "./state/state.js";
import type { ApplyContext } from "./state/state-reducer.js";
import type { QuestionData } from "./tool/types.js";
import type { MultiSelectViewProps } from "./view/components/multi-select-view.js";
import type { SubmitPickerProps } from "./view/components/submit-picker.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";
import type { StatefulView } from "./view/stateful-view.js";
import type { TabComponents } from "./view/tab-components.js";

export const itemsRegular: ReadonlyArray<WrappingSelectItem> = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
];

export const itemsWithOther: ReadonlyArray<WrappingSelectItem> = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
	{ kind: "other", label: "Type something." },
];

export function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
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

export function makeQuestionnaireState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: over.currentTab ?? 0,
		optionIndex: over.optionIndex ?? 0,
		inputMode: over.inputMode ?? false,
		notesVisible: over.notesVisible ?? false,
		chatFocused: over.chatFocused ?? false,
		answers: over.answers ?? new Map(),
		multiSelectChecked: over.multiSelectChecked ?? new Set(),
		notesByTab: over.notesByTab ?? new Map(),
		focusedOptionHasPreview: over.focusedOptionHasPreview ?? false,
		submitChoiceIndex: over.submitChoiceIndex ?? 0,
	};
}

export function makeApplyContext(over: Partial<ApplyContext> = {}): ApplyContext {
	const questions = over.questions ?? [makeQuestion()];
	return {
		questions,
		itemsByTab: over.itemsByTab ?? questions.map(() => itemsRegular),
		pendingNotesValue: over.pendingNotesValue ?? "",
	};
}

export function makeStatefulView<P>(): StatefulView<P> {
	return {
		setProps: vi.fn(),
		render: () => [],
		invalidate: () => {},
		handleInput: () => {},
	};
}

export function makeTabComponents(over: Partial<TabComponents> = {}): TabComponents {
	return {
		optionList: over.optionList ?? makeStatefulView(),
		preview: over.preview ?? makeStatefulView(),
		multiSelect: over.multiSelect,
		bodyHeights: over.bodyHeights ?? (() => ({ current: 0, max: 0 })),
	};
}

export interface MultiSelectPropsOverrides {
	optionIndex?: number;
	checkedIndices?: ReadonlySet<number>;
	focused?: boolean;
	nextLabel?: string;
}

export function makeMultiSelectViewProps(
	question: QuestionData,
	over: MultiSelectPropsOverrides = {},
): MultiSelectViewProps {
	const optionIndex = over.optionIndex ?? 0;
	const checkedIndices = over.checkedIndices ?? new Set<number>();
	const focused = over.focused ?? true;
	const rows = question.options.map((_, i) => ({
		checked: checkedIndices.has(i),
		active: focused && i === optionIndex,
	}));
	const nextActive = focused && optionIndex === question.options.length;
	const nextLabel = over.nextLabel ?? "Next";
	return { rows, nextActive, nextLabel };
}

export function makeMultiSelectPropsFromState(
	question: QuestionData,
	state: QuestionnaireState,
	focused = true,
): MultiSelectViewProps {
	const rows = question.options.map((_, i) => ({
		checked: state.multiSelectChecked.has(i),
		active: focused && i === state.optionIndex,
	}));
	const nextActive = focused && state.optionIndex === question.options.length;
	return { rows, nextActive, nextLabel: "Next" };
}

export function makeSubmitPickerPropsFromState(state: QuestionnaireState, focused = true): SubmitPickerProps {
	return {
		rows: [
			{ active: focused && state.submitChoiceIndex === 0 },
			{ active: focused && state.submitChoiceIndex === 1 },
		],
	};
}
