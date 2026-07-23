import { vi } from "vitest";
import type { QuestionnaireState } from "./state/state.js";
import type { ApplyContext } from "./state/state-reducer.js";
import type { QuestionData } from "./tool/types.js";
import type { MultiSelectView, MultiSelectViewProps } from "./view/components/multi-select-view.js";
import type { PreviewPane, PreviewPaneProps } from "./view/components/preview/preview-pane.js";
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
		answers: over.answers ?? new Map(),
		multiSelectChecked: over.multiSelectChecked ?? new Set(),
		notesByTab: over.notesByTab ?? new Map(),
		submitChoiceIndex: over.submitChoiceIndex ?? 0,
		notesDraft: over.notesDraft ?? "",
		collapsed: over.collapsed ?? false,
	};
}

export function makeApplyContext(over: Partial<ApplyContext> = {}): ApplyContext {
	const questions = over.questions ?? [makeQuestion()];
	return {
		questions,
		itemsByTab: over.itemsByTab ?? questions.map(() => itemsRegular),
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

/**
 * Mock PreviewPane for test fixtures. `TabComponents.preview` is statically typed
 * `PreviewPane`, but tests bypass `buildQuestionnaire` and only need a `StatefulView`
 * shape — this cast preserves that ergonomics without forcing tests to construct
 * a real PreviewPane (which would require a real OptionListView + PreviewBlockRenderer).
 */
export function makeFakePreviewPane(): PreviewPane {
	return {
		...makeStatefulView<PreviewPaneProps>(),
		setGlobalLeftWidth: vi.fn(),
	} as unknown as PreviewPane;
}

/**
 * Mock MultiSelectView for test fixtures. Mirrors makeFakePreviewPane — provides
 * the concrete methods (focusedItemRowRange, naturalHeight) that TabComponents.multiSelect
 * requires now that it's typed as MultiSelectView instead of StatefulView<MultiSelectViewProps>.
 */
export function makeFakeMultiSelectView(): MultiSelectView {
	return {
		...makeStatefulView<MultiSelectViewProps>(),
		focusedItemRowRange: (_w: number) => [0, 0] as [number, number],
		naturalHeight: (_w: number) => 0,
	} as unknown as MultiSelectView;
}

export function makeTabComponents(over: Partial<TabComponents> = {}): TabComponents {
	return {
		optionList: over.optionList ?? makeStatefulView(),
		preview: over.preview ?? makeFakePreviewPane(),
		multiSelect: over.multiSelect,
		bodyHeights: over.bodyHeights ?? (() => ({ current: 0, max: 0 })),
	};
}

export interface MultiSelectPropsOverrides {
	optionIndex?: number;
	checkedIndices?: ReadonlySet<number>;
	focused?: boolean;
	nextLabel?: string;
	inputBuffer?: string;
	inputCursorOffset?: number | undefined;
	inputMode?: boolean;
}

export function makeMultiSelectViewProps(
	question: QuestionData,
	over: MultiSelectPropsOverrides = {},
): MultiSelectViewProps {
	const optionIndex = over.optionIndex ?? 0;
	const checkedIndices = over.checkedIndices ?? new Set<number>();
	const focused = over.focused ?? true;
	const inputBuffer = over.inputBuffer ?? "";
	const rows = question.options.map((_, i) => ({
		checked: checkedIndices.has(i),
		active: focused && i === optionIndex,
	}));
	const otherActive = focused && optionIndex === question.options.length;
	const nextActive = focused && optionIndex === question.options.length + 1;
	const nextLabel = over.nextLabel ?? "Next";
	return {
		rows,
		other: {
			active: otherActive,
			inputMode: (over.inputMode ?? false) && otherActive,
			inputBuffer,
			inputCursorOffset: over.inputCursorOffset,
		},
		nextActive,
		nextLabel,
	};
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
	return {
		rows,
		other: {
			active: focused && state.optionIndex === question.options.length,
			inputMode: state.inputMode,
			inputBuffer: "",
			inputCursorOffset: undefined,
		},
		nextActive: focused && state.optionIndex === question.options.length + 1,
		nextLabel: "Next",
	};
}

export function makeSubmitPickerPropsFromState(state: QuestionnaireState, focused = true): SubmitPickerProps {
	return {
		rows: [
			{ active: focused && state.submitChoiceIndex === 0 },
			{ active: focused && state.submitChoiceIndex === 1 },
		],
	};
}
