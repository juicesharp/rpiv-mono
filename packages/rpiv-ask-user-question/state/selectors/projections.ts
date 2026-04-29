import type { QuestionData } from "../../tool/types.js";
import type { ChatRowViewProps } from "../../view/components/chat-row-view.js";
import type { MultiSelectViewProps } from "../../view/components/multi-select-view.js";
import type { OptionListViewProps } from "../../view/components/option-list-view.js";
import type { PreviewPaneProps } from "../../view/components/preview/preview-pane.js";
import type { SubmitPickerProps } from "../../view/components/submit-picker.js";
import type { TabBarProps } from "../../view/components/tab-bar.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";
import type { ActiveView } from "../../view/stateful-view.js";
import type { QuestionnaireState } from "../state.js";
import { chatNumberingFor, selectActiveTabItems, selectConfirmedIndicator } from "./derivations.js";

/**
 * Per-tick projection for a `MultiSelectView` instance. Pre-computes
 * `checked` and `active` per row + the `nextActive` flag so the component's
 * render body is pure styling.
 *
 * Broadcast-safe: every multi-select tab's MSO receives a projection per
 * tick, but only the active tab actually renders its body via
 * `QuestionTabStrategy.bodyComponent`. Non-active MSO instances see
 * `focused === false` because activeView is gated on `state.notesVisible` /
 * `state.chatFocused` / Submit-tab — none of which are true while in options
 * mode on the active tab.
 */
export function selectMultiSelectProps(
	state: QuestionnaireState,
	question: QuestionData,
	activeView: ActiveView,
): MultiSelectViewProps {
	const focused = activeView === "options";
	const rows: { checked: boolean; active: boolean }[] = [];
	for (let i = 0; i < question.options.length; i++) {
		rows.push({
			checked: state.multiSelectChecked.has(i),
			active: focused && i === state.optionIndex,
		});
	}
	const nextActive = focused && state.optionIndex === question.options.length;
	return { rows, nextActive };
}

/**
 * Per-tick projection for the active tab's `OptionListView`. Threads the
 * runtime-owned `inputBuffer` through to the view so the rendering primitive
 * (`WrappingSelect`) sees the value without per-keystroke reducer involvement.
 */
export function selectOptionListProps(
	state: QuestionnaireState,
	items: readonly WrappingSelectItem[],
	questions: readonly QuestionData[],
	activeView: ActiveView,
	inputBuffer: string,
): OptionListViewProps {
	const focused = activeView === "options";
	const confirmed = selectConfirmedIndicator(questions, state.currentTab, state.answers, items);
	return {
		selectedIndex: state.optionIndex,
		focused,
		inputBuffer,
		...(confirmed ? { confirmed } : {}),
	};
}

/**
 * Per-tick projection for the SubmitPicker. Two rows fixed (Submit /
 * Cancel); only `active` per row varies. Focus derives from the
 * `activeView === "submit"` discriminant.
 */
export function selectSubmitPickerProps(
	state: QuestionnaireState,
	totalQuestions: number,
	activeView: ActiveView,
): SubmitPickerProps {
	const focused = activeView === "submit";
	void totalQuestions;
	return {
		rows: [
			{ active: focused && state.submitChoiceIndex === 0 },
			{ active: focused && state.submitChoiceIndex === 1 },
		],
	};
}

/**
 * Per-tick projection for `PreviewPane`. Eliminates the sibling-coupling
 * where `PreviewPane` formerly read `optionListView.getSelectedIndex()` /
 * `isFocused()` live during render. Both `OptionListView` and
 * `PreviewPane.setProps` derive `selectedIndex` and `focused` from the same
 * canonical state per tick.
 */
export function selectPreviewPaneProps(state: QuestionnaireState, activeView: ActiveView): PreviewPaneProps {
	return {
		notesVisible: state.notesVisible,
		selectedIndex: state.optionIndex,
		focused: activeView === "options",
	};
}

/**
 * Per-tick projection for the TabBar. Hoists all per-render derivations
 * (`allAnswered`, `answered`, `isActive`, `submitActive`) out of `tab-bar.ts`
 * into the selector. The Submit slot is an explicit `submit` field, not a
 * hidden `totalTabs` index. `Q{n}` fallback label is computed here once per
 * tab; `header` reads directly from question data.
 */
export function selectTabBarProps(
	state: QuestionnaireState,
	questions: ReadonlyArray<{ header?: string; question: string }>,
): TabBarProps {
	const tabs = questions.map((q, i) => ({
		label: q.header && q.header.length > 0 ? q.header : `Q${i + 1}`,
		answered: state.answers.has(i),
		active: i === state.currentTab,
	}));
	return {
		tabs,
		submit: {
			active: state.currentTab === questions.length,
			allAnswered: state.answers.size === questions.length && questions.length > 0,
		},
	};
}

/**
 * Per-tick projection for `ChatRowView`. Combines focus discriminant with
 * the numbering derivation (`chatNumberingFor` over the active tab's
 * items). `activeView === "chat"` is observably equivalent to
 * `state.chatFocused` because the dispatcher cascade and reducer's defensive
 * clears ensure `chatFocused` and `notesVisible`/Submit-tab cannot be true
 * simultaneously.
 */
export function selectChatRowProps(
	state: QuestionnaireState,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	totalQuestions: number,
	activeView: ActiveView,
): ChatRowViewProps {
	const activeItems = selectActiveTabItems(itemsByTab, state.currentTab, totalQuestions);
	return {
		focused: activeView === "chat",
		numbering: chatNumberingFor(activeItems),
	};
}
