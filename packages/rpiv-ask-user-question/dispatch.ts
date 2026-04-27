import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { QuestionAnswer, QuestionData } from "./types.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

const NOTES_ACTIVATE_KEY = "n";
const SPACE_KEY = " ";

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
	| { kind: "toggle"; index: number }
	| { kind: "multi_confirm"; selected: string[]; autoAdvanceTab?: number }
	| { kind: "cancel" }
	| { kind: "notes_enter" }
	| { kind: "notes_exit" }
	| { kind: "submit" }
	| { kind: "focus_chat" }
	| { kind: "focus_options" }
	| { kind: "ignore" };

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

export interface QuestionnaireDispatchState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesMode: boolean;
	chatFocused: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectIndices: ReadonlySet<number>;
	questions: readonly QuestionData[];
	isMulti: boolean;
	keybindings: QuestionnaireKeybindings;
	currentItem: WrappingSelectItem | undefined;
	inputBuffer: string;
	items: readonly WrappingSelectItem[];
	/**
	 * True iff the currently-focused option carries a non-empty `preview` string.
	 * Set by `ask-user-question.ts:dispatchSnapshot()` via `computeFocusedOptionHasPreview()`.
	 * Gates the `notes_enter` action — notes are scoped to preview-bearing options
	 * (Decision 8 + reference image showing affordance only on preview-bearing rows).
	 */
	focusedOptionHasPreview: boolean;
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(state: QuestionnaireDispatchState): boolean {
	if (state.questions.length === 0) return false;
	for (let i = 0; i < state.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(state: QuestionnaireDispatchState): number {
	return state.isMulti ? state.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(state: QuestionnaireDispatchState): number | undefined {
	if (!state.isMulti) return undefined;
	if (state.currentTab < state.questions.length - 1) return state.currentTab + 1;
	return state.questions.length;
}

function buildSingleSelectAnswer(state: QuestionnaireDispatchState): QuestionAnswer | null {
	const q = state.questions[state.currentTab];
	if (!q) return null;

	// Chat sentinel takes priority over inputMode: when chatFocused=true, the host overrides
	// currentItem() to return the chat sentinel even if inputMode is still true (e.g. user
	// navigated from "Type something." and DOWN focused the chat row).
	const item = state.currentItem;
	if (item?.isChat) {
		return {
			questionIndex: state.currentTab,
			question: q.question,
			answer: item.label,
			wasChat: true,
		};
	}

	if (state.inputMode) {
		const label = state.inputBuffer;
		return {
			questionIndex: state.currentTab,
			question: q.question,
			answer: label.length > 0 ? label : null,
			wasCustom: true,
		};
	}
	if (!item) return null;
	if (item.isOther) {
		return null;
	}
	return {
		questionIndex: state.currentTab,
		question: q.question,
		answer: item.label,
		wasCustom: false,
	};
}

function buildMultiSelected(state: QuestionnaireDispatchState): string[] {
	const q = state.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectIndices.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function tabSwitchAction(data: string, state: QuestionnaireDispatchState): QuestionnaireAction | null {
	if (!state.isMulti) return null;
	const total = totalTabs(state);
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
	}
	return null;
}

// DOWN navigation helper shared by inputMode and normal nav branches.
// Emits focus_chat at the boundary (last item) so the host can transfer focus to the chat row
// without mutating optionIndex — UP-from-chat then restores prior selection.
function nextNavOnDown(state: QuestionnaireDispatchState): QuestionnaireAction {
	if (state.items.length > 0 && state.optionIndex === state.items.length - 1) {
		return { kind: "focus_chat" };
	}
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, state.items.length)) };
}

export function handleQuestionnaireInput(data: string, state: QuestionnaireDispatchState): QuestionnaireAction {
	const kb = state.keybindings;

	if (state.notesMode) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "notes_exit" };
		if (kb.matches(data, KEYBIND_CONFIRM)) return { kind: "notes_exit" };
		return { kind: "ignore" };
	}

	if (state.chatFocused) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			const answer = buildSingleSelectAnswer(state);
			if (!answer) return { kind: "ignore" };
			return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state) };
		}
		if (kb.matches(data, KEYBIND_UP)) return { kind: "focus_options" };
		// DOWN from the chat row returns focus to the options column. Without this, the chat
		// row becomes a one-way trap on DOWN, which made it feel unselectable in some flows.
		if (kb.matches(data, KEYBIND_DOWN)) return { kind: "focus_options" };
		const tab = tabSwitchAction(data, state);
		if (tab) return tab;
		return { kind: "ignore" };
	}

	if (state.inputMode) {
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			const answer = buildSingleSelectAnswer(state);
			if (!answer) return { kind: "ignore" };
			return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state) };
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		if (kb.matches(data, KEYBIND_UP)) {
			return { kind: "nav", nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, state.items.length)) };
		}
		if (kb.matches(data, KEYBIND_DOWN)) {
			return nextNavOnDown(state);
		}
		return { kind: "ignore" };
	}

	if (state.isMulti && state.currentTab === state.questions.length) {
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			return allAnswered(state) ? { kind: "submit" } : { kind: "ignore" };
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		const tab = tabSwitchAction(data, state);
		if (tab) return tab;
		return { kind: "ignore" };
	}

	const tab = tabSwitchAction(data, state);
	if (tab) return tab;

	const q = state.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	if (data === NOTES_ACTIVATE_KEY && !q.multiSelect && state.focusedOptionHasPreview) {
		return { kind: "notes_enter" };
	}

	if (kb.matches(data, KEYBIND_UP)) {
		return { kind: "nav", nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, state.items.length)) };
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state);
	}

	if (q.multiSelect) {
		if (data === SPACE_KEY) return { kind: "toggle", index: state.optionIndex };
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// Mirror single-select `confirm`: carry autoAdvanceTab so the host can advance to the
			// next tab in multi-question mode, OR submit the dialog in single-question mode
			// (autoAdvanceTab === undefined when !isMulti). Without this, Enter on a single
			// multi-select question saved the answer but never submitted — the user got stuck.
			return {
				kind: "multi_confirm",
				selected: buildMultiSelected(state),
				autoAdvanceTab: computeAutoAdvanceTab(state),
			};
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	if (kb.matches(data, KEYBIND_CONFIRM)) {
		const answer = buildSingleSelectAnswer(state);
		if (!answer) return { kind: "ignore" };
		return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state) };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	return { kind: "ignore" };
}
