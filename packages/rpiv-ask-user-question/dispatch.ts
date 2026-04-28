import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { QuestionnaireDispatchSnapshot } from "./questionnaire-state.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionAnswer } from "./types.js";

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
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	| { kind: "focus_chat" }
	/**
	 * Optional `optionIndex` lets the dispatcher tell the host where to land when leaving the
	 * chat row, so UP/DOWN form a continuous cycle through `[chat, option0, …, optionLast]`
	 * (Defect 2). When omitted, the host preserves the existing optionIndex (UP-from-chat
	 * legacy behavior — currently still emitted by some branches and consumers).
	 */
	| { kind: "focus_options"; optionIndex?: number }
	| { kind: "ignore" };

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(state: QuestionnaireDispatchSnapshot): boolean {
	if (state.questions.length === 0) return false;
	for (let i = 0; i < state.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(state: QuestionnaireDispatchSnapshot): number {
	return state.isMulti ? state.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(state: QuestionnaireDispatchSnapshot): number | undefined {
	if (!state.isMulti) return undefined;
	if (state.currentTab < state.questions.length - 1) return state.currentTab + 1;
	return state.questions.length;
}

function buildSingleSelectAnswer(state: QuestionnaireDispatchSnapshot): QuestionAnswer | null {
	const q = state.questions[state.currentTab];
	if (!q) return null;

	// Chat sentinel takes priority over inputMode: when chatFocused=true, the host overrides
	// currentItem() to return the chat sentinel even if inputMode is still true (e.g. user
	// navigated from "Type something." and DOWN focused the chat row).
	const item = state.currentItem;
	if (item?.kind === "chat") {
		return {
			questionIndex: state.currentTab,
			question: q.question,
			kind: "chat",
			answer: item.label,
		};
	}

	if (state.inputMode) {
		const label = state.inputBuffer;
		return {
			questionIndex: state.currentTab,
			question: q.question,
			kind: "custom",
			answer: label.length > 0 ? label : null,
		};
	}
	if (!item) return null;
	if (item.kind === "other") {
		return null;
	}
	if (item.kind === "next") {
		return null;
	}
	return {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: item.label,
	};
}

function buildMultiSelected(state: QuestionnaireDispatchSnapshot): string[] {
	const q = state.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function tabSwitchAction(data: string, state: QuestionnaireDispatchSnapshot): QuestionnaireAction | null {
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
// without mutating optionIndex — UP-from-chat then lands on items.length - 1 (continuous cycle).
function nextNavOnDown(state: QuestionnaireDispatchSnapshot): QuestionnaireAction {
	if (state.items.length > 0 && state.optionIndex === state.items.length - 1) {
		return { kind: "focus_chat" };
	}
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, state.items.length)) };
}

// UP navigation helper, symmetric with nextNavOnDown. At the TOP boundary (optionIndex 0)
// emits focus_chat so the cycle wraps `[chat, option0, …, optionLast]` — without this, UP at
// option 0 would skip the chat row entirely (Defect 2). Above the boundary, decrement.
function prevNavOnUp(state: QuestionnaireDispatchSnapshot): QuestionnaireAction {
	if (state.items.length > 0 && state.optionIndex === 0) {
		return { kind: "focus_chat" };
	}
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, state.items.length)) };
}

export function handleQuestionnaireInput(data: string, state: QuestionnaireDispatchSnapshot): QuestionnaireAction {
	const kb = state.keybindings;

	if (state.notesVisible) {
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
		// Continuous cycle: UP from chat → bottom of options (last navigable row), DOWN from
		// chat → top of options (option 0). Symmetric with UP-at-top → focus_chat and
		// DOWN-at-bottom → focus_chat below; together they form one wrapping cycle through
		// `[chat, option0, …, optionLast]`.
		if (kb.matches(data, KEYBIND_UP)) {
			const last = Math.max(0, state.items.length - 1);
			return { kind: "focus_options", optionIndex: last };
		}
		if (kb.matches(data, KEYBIND_DOWN)) {
			return { kind: "focus_options", optionIndex: 0 };
		}
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
			return prevNavOnUp(state);
		}
		if (kb.matches(data, KEYBIND_DOWN)) {
			return nextNavOnDown(state);
		}
		return { kind: "ignore" };
	}

	if (state.isMulti && state.currentTab === state.questions.length) {
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
		const tab = tabSwitchAction(data, state);
		if (tab) return tab;
		if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
			const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
			const next = wrapTab(state.submitChoiceIndex + delta, 2);
			return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// D1 (revised): Submit always submits; Cancel always cancels. The warning header
			// is informational only — `allAnswered(state)` no longer gates submission. Partial
			// answers flow through `orderedAnswers()` in the host.
			return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
		}
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
		return prevNavOnUp(state);
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state);
	}

	if (q.multiSelect) {
		const focusedKind = state.currentItem?.kind;
		const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
		// Space toggles the focused row's checkbox. Suppressed on rows whose META declares
		// `blocksMultiToggle` (the Next sentinel) — Next is not a real option and has no
		// checked/unchecked state.
		if (data === SPACE_KEY) {
			if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
			return { kind: "toggle", index: state.optionIndex };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			// Enter on a regular row toggles (matching Space) — committing the question is now
			// gated behind explicit focus on a row whose META declares `autoSubmitsInMulti`
			// (the Next sentinel), so Enter on options is a no-cost way to flip checkboxes
			// without leaving the keyboard home row.
			if (!focusedMeta?.autoSubmitsInMulti) return { kind: "toggle", index: state.optionIndex };
			// Enter on Next: carry autoAdvanceTab so the host can advance to the next tab in
			// multi-question mode, OR submit the dialog in single-question mode
			// (autoAdvanceTab === undefined when !isMulti). Without this, a single multi-select
			// question would have no way to commit at all.
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
