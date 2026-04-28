import type { QuestionnaireAction } from "./dispatch.js";
import { computeFocusedOptionHasPreview, type QuestionnaireState } from "./questionnaire-state.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "./types.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

/**
 * Per-dispatch context that doesn't live on canonical state. Captured by the runtime each
 * tick (`pendingNotesValue` is `notesInput.getValue().trim()`; `itemsByTab` is constant for
 * the session lifetime). The reducer never touches a live component — every IO call is
 * emitted as an `Effect` in the result.
 */
export interface ApplyContext {
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	/** Trimmed notes input value at dispatch time. The reducer uses this for `notes_exit`
	 * to decide whether to merge notes into the current answer or delete pending notes. */
	pendingNotesValue: string;
}

/**
 * Declarative side-effects emitted by `applyAction`. The runtime executes them after
 * committing the new state, then asks the view-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
	| { kind: "set_input_buffer"; value: string }
	| { kind: "clear_input_buffer" }
	| { kind: "set_notes_value"; value: string }
	| { kind: "set_notes_focused"; focused: boolean }
	| { kind: "set_active_preview_pane"; paneIndex: number }
	| { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
	state: QuestionnaireState;
	effects: readonly Effect[];
}

const EMPTY_NOTES: ReadonlyMap<number, string> = new Map();

function notesOf(state: QuestionnaireState): ReadonlyMap<number, string> {
	return state.notesByTab ?? EMPTY_NOTES;
}

function orderedAnswers(state: QuestionnaireState, questions: readonly QuestionData[]): QuestionAnswer[] {
	const out: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const a = state.answers.get(i);
		if (a) out.push(a);
	}
	return out;
}

function withFocusedOptionHasPreview(
	state: QuestionnaireState,
	questions: readonly QuestionData[],
): QuestionnaireState {
	const focusedOptionHasPreview = computeFocusedOptionHasPreview(questions, state.currentTab, state.optionIndex);
	if (state.focusedOptionHasPreview === focusedOptionHasPreview) return state;
	return { ...state, focusedOptionHasPreview };
}

function syncMultiSelectFromAnswers(
	answers: ReadonlyMap<number, QuestionAnswer>,
	questions: readonly QuestionData[],
	tab: number,
): ReadonlySet<number> {
	const q = questions[tab];
	if (!q?.multiSelect) return new Set();
	const saved = answers.get(tab);
	const labels = saved?.selected ?? [];
	const indices = new Set<number>();
	for (let i = 0; i < q.options.length; i++) {
		if (labels.includes(q.options[i]!.label)) indices.add(i);
	}
	return indices;
}

function persistMultiSelectAnswer(state: QuestionnaireState, ctx: ApplyContext): ReadonlyMap<number, QuestionAnswer> {
	const q = ctx.questions[state.currentTab];
	if (!q?.multiSelect) return state.answers;
	const selected: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) selected.push(q.options[i]!.label);
	}
	const out = new Map(state.answers);
	if (selected.length === 0) {
		out.delete(state.currentTab);
		return out;
	}
	const pendingNotes = notesOf(state).get(state.currentTab);
	out.set(state.currentTab, {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "multi",
		answer: null,
		selected,
		...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
	});
	return out;
}

function switchTabResult(state: QuestionnaireState, nextTab: number, ctx: ApplyContext): ApplyResult {
	const transitioned: QuestionnaireState = {
		...state,
		currentTab: nextTab,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		chatFocused: false,
		submitChoiceIndex: 0,
		multiSelectChecked: syncMultiSelectFromAnswers(state.answers, ctx.questions, nextTab),
	};
	const finalState = withFocusedOptionHasPreview(transitioned, ctx.questions);
	const paneIndex = Math.min(nextTab, Math.max(0, ctx.questions.length - 1));
	const notesValue = notesOf(state).get(nextTab) ?? state.answers.get(nextTab)?.notes ?? "";
	return {
		state: finalState,
		effects: [
			{ kind: "set_active_preview_pane", paneIndex },
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: notesValue },
		],
	};
}

function doneFor(state: QuestionnaireState, ctx: ApplyContext, cancelled: boolean): ApplyResult {
	const result: QuestionnaireResult = { answers: orderedAnswers(state, ctx.questions), cancelled };
	return { state, effects: [{ kind: "done", result }] };
}

/**
 * Pure reducer: given (state, action, ctx) returns new state + a list of declarative IO
 * effects. Mirrors `rpiv-todo`'s `applyTaskMutation`.
 *
 * Actions NOT routed through this reducer (handled by the runtime directly):
 * - `ignore` — per-keystroke input-buffer mutation; no canonical-state change. The runtime
 *   calls `pane.appendInput` / `pane.backspaceInput` directly via `handleIgnoreInline`.
 * - `notes_visible` two-pass forward — the runtime probes the dispatcher for `notes_exit`;
 *   every other key forwards to the pi-tui `Input` without reducer involvement.
 */
export function applyAction(state: QuestionnaireState, action: QuestionnaireAction, ctx: ApplyContext): ApplyResult {
	switch (action.kind) {
		case "nav": {
			const items = ctx.itemsByTab[state.currentTab] ?? [];
			const item = items[action.nextIndex];
			const inputMode = item ? ROW_INTENT_META[item.kind].activatesInputMode : false;
			const next = withFocusedOptionHasPreview(
				{ ...state, optionIndex: action.nextIndex, inputMode },
				ctx.questions,
			);
			if (!inputMode) {
				return { state: next, effects: [{ kind: "clear_input_buffer" }] };
			}
			const prior = state.answers.get(state.currentTab);
			if (prior?.kind === "custom" && typeof prior.answer === "string") {
				return { state: next, effects: [{ kind: "set_input_buffer", value: prior.answer }] };
			}
			return { state: next, effects: [] };
		}
		case "tab_switch": {
			return switchTabResult(state, action.nextTab, ctx);
		}
		case "confirm": {
			let answer = action.answer;
			if (answer.kind === "option" && answer.answer) {
				const q = ctx.questions[answer.questionIndex];
				const matched = q?.options.find((o) => o.label === answer.answer);
				if (matched?.preview && matched.preview.length > 0) {
					answer = { ...answer, preview: matched.preview };
				}
			}
			const pendingNotes = notesOf(state).get(answer.questionIndex);
			if (pendingNotes && pendingNotes.length > 0) {
				answer = { ...answer, notes: pendingNotes };
			}
			const answers = new Map(state.answers);
			answers.set(answer.questionIndex, answer);
			const next: QuestionnaireState = { ...state, answers };
			if (action.autoAdvanceTab !== undefined) return switchTabResult(next, action.autoAdvanceTab, ctx);
			return doneFor(next, ctx, false);
		}
		case "toggle": {
			const checked = new Set(state.multiSelectChecked);
			if (checked.has(action.index)) checked.delete(action.index);
			else checked.add(action.index);
			const intermediate: QuestionnaireState = { ...state, multiSelectChecked: checked };
			const answers = persistMultiSelectAnswer(intermediate, ctx);
			return { state: { ...intermediate, answers }, effects: [] };
		}
		case "multi_confirm": {
			const q = ctx.questions[state.currentTab];
			if (!q) return { state, effects: [] };
			const pendingNotes = notesOf(state).get(state.currentTab);
			const answers = new Map(state.answers);
			answers.set(state.currentTab, {
				questionIndex: state.currentTab,
				question: q.question,
				kind: "multi",
				answer: null,
				selected: action.selected,
				...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
			});
			const synced: QuestionnaireState = {
				...state,
				answers,
				multiSelectChecked: syncMultiSelectFromAnswers(answers, ctx.questions, state.currentTab),
			};
			if (action.autoAdvanceTab !== undefined) return switchTabResult(synced, action.autoAdvanceTab, ctx);
			return doneFor(synced, ctx, false);
		}
		case "cancel": {
			return doneFor(state, ctx, true);
		}
		case "notes_enter": {
			const value = state.answers.get(state.currentTab)?.notes ?? "";
			return {
				state: { ...state, notesVisible: true },
				effects: [
					{ kind: "set_notes_value", value },
					{ kind: "set_notes_focused", focused: true },
				],
			};
		}
		case "notes_exit": {
			const trimmed = ctx.pendingNotesValue;
			const notes = new Map(notesOf(state));
			const answers = new Map(state.answers);
			if (trimmed.length === 0) {
				notes.delete(state.currentTab);
				const prev = answers.get(state.currentTab);
				if (prev?.notes) {
					const stripped = { ...prev };
					delete (stripped as { notes?: string }).notes;
					answers.set(state.currentTab, stripped);
				}
			} else {
				notes.set(state.currentTab, trimmed);
				const prev = answers.get(state.currentTab);
				if (prev) answers.set(state.currentTab, { ...prev, notes: trimmed });
			}
			return {
				state: { ...state, notesByTab: notes, answers, notesVisible: false },
				effects: [{ kind: "set_notes_focused", focused: false }],
			};
		}
		case "submit": {
			return doneFor(state, ctx, false);
		}
		case "submit_nav": {
			return { state: { ...state, submitChoiceIndex: action.nextIndex }, effects: [] };
		}
		case "focus_chat": {
			return { state: { ...state, chatFocused: true }, effects: [] };
		}
		case "focus_options": {
			let optionIndex = state.optionIndex;
			let inputMode = state.inputMode;
			let effects: readonly Effect[] = [];
			if (action.optionIndex !== undefined) {
				optionIndex = action.optionIndex;
				const items = ctx.itemsByTab[state.currentTab] ?? [];
				const focused = items[optionIndex];
				inputMode = focused ? ROW_INTENT_META[focused.kind].activatesInputMode : false;
				if (!inputMode) effects = [{ kind: "clear_input_buffer" }];
			}
			const next = withFocusedOptionHasPreview(
				{ ...state, chatFocused: false, optionIndex, inputMode },
				ctx.questions,
			);
			return { state: next, effects };
		}
		case "ignore": {
			return { state, effects: [] };
		}
	}
}
