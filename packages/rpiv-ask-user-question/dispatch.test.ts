import { describe, expect, it } from "vitest";
import { allAnswered, handleQuestionnaireInput, wrapTab } from "./dispatch.js";
import type { QuestionnaireDispatchSnapshot } from "./questionnaire-state.js";
import type { QuestionAnswer, QuestionData } from "./types.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

const KEY = {
	UP: "tui.select.up",
	DOWN: "tui.select.down",
	CONFIRM: "tui.select.confirm",
	CANCEL: "tui.select.cancel",
};
const sentinel = (name: string) => `<KEY:${name}>`;
const keybindings = { matches: (data: string, name: string) => data === sentinel(name) };

const BYTE_TAB = "\t";
const BYTE_SHIFT_TAB = "\x1b[Z";
const BYTE_RIGHT = "\x1b[C";
const BYTE_LEFT = "\x1b[D";
const BYTE_SPACE = " ";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
			{ label: "C", description: "c" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeAnswer(over: Partial<QuestionAnswer> = {}): QuestionAnswer {
	return {
		questionIndex: over.questionIndex ?? 0,
		question: over.question ?? "q",
		answer: over.answer ?? "A",
		wasCustom: over.wasCustom ?? false,
	};
}

function baseState(over: Partial<QuestionnaireDispatchSnapshot> = {}): QuestionnaireDispatchSnapshot {
	const questions = over.questions ?? [makeQuestion(), makeQuestion()];
	const items: WrappingSelectItem[] = questions[0]!.options.map((o) => ({ label: o.label }));
	return {
		currentTab: over.currentTab ?? 0,
		optionIndex: over.optionIndex ?? 0,
		inputMode: over.inputMode ?? false,
		notesVisible: over.notesVisible ?? false,
		chatFocused: over.chatFocused ?? false,
		answers: over.answers ?? new Map<number, QuestionAnswer>(),
		multiSelectChecked: over.multiSelectChecked ?? new Set<number>(),
		questions,
		isMulti: over.isMulti ?? questions.length > 1,
		keybindings: over.keybindings ?? keybindings,
		currentItem: over.currentItem ?? items[0],
		inputBuffer: over.inputBuffer ?? "",
		items: over.items ?? items,
		focusedOptionHasPreview: over.focusedOptionHasPreview ?? false,
		submitChoiceIndex: over.submitChoiceIndex ?? 0,
	};
}

describe("wrapTab + allAnswered", () => {
	it("wraps negative + over-max into [0, total)", () => {
		expect(wrapTab(-1, 3)).toBe(2);
		expect(wrapTab(3, 3)).toBe(0);
		expect(wrapTab(0, 0)).toBe(0);
	});

	it("allAnswered is false when any question lacks an answer", () => {
		const s = baseState({ answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]) });
		expect(allAnswered(s)).toBe(false);
	});

	it("allAnswered is true when every question has an answer", () => {
		const s = baseState({
			answers: new Map([
				[0, makeAnswer({ questionIndex: 0 })],
				[1, makeAnswer({ questionIndex: 1 })],
			]),
		});
		expect(allAnswered(s)).toBe(true);
	});
});

describe("handleQuestionnaireInput — nav", () => {
	// Boundary case (UP at optionIndex 0 → focus_chat) is exercised by the chat-inclusive
	// cycle suite below. Above the top boundary, UP simply decrements.
	it("UP from a non-zero index decrements by 1", () => {
		const s = baseState({ optionIndex: 2 });
		expect(handleQuestionnaireInput(sentinel(KEY.UP), s)).toEqual({ kind: "nav", nextIndex: 1 });
	});
	it("DOWN advances by 1", () => {
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), baseState())).toEqual({ kind: "nav", nextIndex: 1 });
	});
});

describe("handleQuestionnaireInput — tab_switch", () => {
	it("Tab cycles forward through total tabs (questions + Submit)", () => {
		const s = baseState();
		expect(handleQuestionnaireInput(BYTE_TAB, s)).toEqual({ kind: "tab_switch", nextTab: 1 });
	});

	it("Right is an alias for Tab", () => {
		expect(handleQuestionnaireInput(BYTE_RIGHT, baseState())).toEqual({ kind: "tab_switch", nextTab: 1 });
	});

	it("Shift+Tab wraps backward from tab 0 to the Submit tab", () => {
		const s = baseState({ currentTab: 0 });
		expect(handleQuestionnaireInput(BYTE_SHIFT_TAB, s)).toEqual({ kind: "tab_switch", nextTab: 2 });
	});

	it("Left is an alias for Shift+Tab", () => {
		expect(handleQuestionnaireInput(BYTE_LEFT, baseState({ currentTab: 1 }))).toEqual({
			kind: "tab_switch",
			nextTab: 0,
		});
	});

	it("Tab is a no-op (returns ignore) in single-question mode", () => {
		const s = baseState({ isMulti: false, questions: [makeQuestion()] });
		expect(handleQuestionnaireInput(BYTE_TAB, s)).toEqual({ kind: "ignore" });
	});
});

describe("handleQuestionnaireInput — confirm (single-select)", () => {
	it("emits confirm with autoAdvanceTab pointing to the next tab", () => {
		const s = baseState({ currentTab: 0 });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action).toMatchObject({
			kind: "confirm",
			answer: { questionIndex: 0, answer: "A", wasCustom: false },
			autoAdvanceTab: 1,
		});
	});

	it("last question -> autoAdvanceTab points at the Submit tab (questions.length)", () => {
		const s = baseState({ currentTab: 1 });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action).toMatchObject({ kind: "confirm", autoAdvanceTab: 2 });
	});

	it("single-question (!isMulti) -> autoAdvanceTab is undefined (dialog submits)", () => {
		const questions = [makeQuestion()];
		const s = baseState({ isMulti: false, questions, items: [{ label: "A" }, { label: "B" }, { label: "C" }] });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action).toMatchObject({ kind: "confirm" });
		if (action.kind === "confirm") {
			expect(action.autoAdvanceTab).toBeUndefined();
		}
	});

	it("chat sentinel item -> answer.wasChat === true", () => {
		const chat: WrappingSelectItem = { label: "Chat about this", isChat: true };
		const s = baseState({ currentItem: chat });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") expect(action.answer.wasChat).toBe(true);
	});

	it("inline-input mode: Enter confirms with the buffered text + wasCustom", () => {
		const other: WrappingSelectItem = { label: "Type something.", isOther: true };
		const s = baseState({ inputMode: true, currentItem: other, inputBuffer: "my custom answer" });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.answer).toBe("my custom answer");
			expect(action.answer.wasCustom).toBe(true);
		}
	});
});

describe("handleQuestionnaireInput — multiSelect", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});

	it("Space emits toggle for the current optionIndex", () => {
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 1,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }],
			currentItem: { label: "BE" },
		});
		expect(handleQuestionnaireInput(BYTE_SPACE, s)).toEqual({ kind: "toggle", index: 1 });
	});

	// Spec: Enter on a REGULAR option row toggles that row's checkbox (matches Space). Committing
	// + advancing requires explicit focus on the Next sentinel — see the multi_confirm tests below.
	it("Enter on a regular row emits toggle for the current optionIndex", () => {
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 1,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "BE" },
		});
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({ kind: "toggle", index: 1 });
	});

	// Spec: Space on the Next sentinel is ignored — Next is not a real option.
	it("Space on Next sentinel is ignored", () => {
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 3,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "Next", isNext: true },
		});
		expect(handleQuestionnaireInput(BYTE_SPACE, s)).toEqual({ kind: "ignore" });
	});

	it("Enter on Next emits multi_confirm with selected labels in option order", () => {
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 3,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "Next", isNext: true },
			multiSelectChecked: new Set([2, 0]),
		});
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({
			kind: "multi_confirm",
			selected: ["FE", "Tests"],
			autoAdvanceTab: undefined,
		});
	});

	// Spec: Enter on Next for a SINGLE multi-select question submits the dialog.
	it("single-question multi-select: Enter on Next carries autoAdvanceTab=undefined (host → submit)", () => {
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 3,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "Next", isNext: true },
			multiSelectChecked: new Set([0]),
		});
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBeUndefined();
	});

	// Spec: Enter on Next for a multi-question dialog advances to the next tab.
	it("multi-question multi-select on tab 0: Enter on Next carries autoAdvanceTab=1", () => {
		const s = baseState({
			questions: [multiQ, makeQuestion()],
			isMulti: true,
			currentTab: 0,
			optionIndex: 3,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "Next", isNext: true },
			multiSelectChecked: new Set([0]),
		});
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(1);
	});

	// Spec: Enter on Next from the LAST multi-select question advances to the Submit tab.
	it("multi-question multi-select on last tab: Enter on Next carries autoAdvanceTab=questions.length (Submit)", () => {
		const s = baseState({
			questions: [makeQuestion(), multiQ],
			isMulti: true,
			currentTab: 1,
			optionIndex: 3,
			items: [{ label: "FE" }, { label: "BE" }, { label: "Tests" }, { label: "Next", isNext: true }],
			currentItem: { label: "Next", isNext: true },
			multiSelectChecked: new Set([0]),
		});
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(2);
	});

	it("Space does NOT emit toggle on a single-select question", () => {
		const s = baseState();
		expect(handleQuestionnaireInput(BYTE_SPACE, s)).toEqual({ kind: "ignore" });
	});
});

describe("handleQuestionnaireInput — cancel + submit", () => {
	it("Esc cancels the entire questionnaire from any tab", () => {
		expect(handleQuestionnaireInput(sentinel(KEY.CANCEL), baseState())).toEqual({ kind: "cancel" });
		expect(handleQuestionnaireInput(sentinel(KEY.CANCEL), baseState({ currentTab: 2 }))).toEqual({
			kind: "cancel",
		});
	});

	it("Submit tab + Enter on Submit row + allAnswered -> submit", () => {
		const s = baseState({
			currentTab: 2,
			submitChoiceIndex: 0,
			answers: new Map([
				[0, makeAnswer({ questionIndex: 0 })],
				[1, makeAnswer({ questionIndex: 1 })],
			]),
		});
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({ kind: "submit" });
	});

	// D1 revised: partial submission allowed. Enter on Submit row always submits.
	it("Submit tab + Enter on Submit row when not allAnswered -> submit (partial)", () => {
		const s = baseState({
			currentTab: 2,
			submitChoiceIndex: 0,
			answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]),
		});
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({ kind: "submit" });
	});

	it("Submit tab + DOWN -> submit_nav nextIndex=1", () => {
		const s = baseState({ currentTab: 2, submitChoiceIndex: 0 });
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({ kind: "submit_nav", nextIndex: 1 });
	});

	it("Submit tab + UP wraps from 0 to 1", () => {
		const s = baseState({ currentTab: 2, submitChoiceIndex: 0 });
		expect(handleQuestionnaireInput(sentinel(KEY.UP), s)).toEqual({ kind: "submit_nav", nextIndex: 1 });
	});

	it("Submit tab + DOWN from index 1 wraps to 0", () => {
		const s = baseState({ currentTab: 2, submitChoiceIndex: 1 });
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({ kind: "submit_nav", nextIndex: 0 });
	});

	it("Submit tab + Enter on Cancel row (index 1) when complete -> cancel", () => {
		const s = baseState({
			currentTab: 2,
			submitChoiceIndex: 1,
			answers: new Map([
				[0, makeAnswer({ questionIndex: 0 })],
				[1, makeAnswer({ questionIndex: 1 })],
			]),
		});
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({ kind: "cancel" });
	});

	it("Submit tab + Enter on Cancel row (index 1) when incomplete -> cancel", () => {
		const s = baseState({ currentTab: 2, submitChoiceIndex: 1 });
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), s)).toEqual({ kind: "cancel" });
	});
});

describe("handleQuestionnaireInput — notes", () => {
	it("'n' when focused option has preview emits notes_enter", () => {
		const s = baseState({ focusedOptionHasPreview: true });
		expect(handleQuestionnaireInput("n", s)).toEqual({ kind: "notes_enter" });
	});

	it("'n' when focused option has no preview is ignored", () => {
		expect(handleQuestionnaireInput("n", baseState({ focusedOptionHasPreview: false }))).toEqual({ kind: "ignore" });
	});

	it("'n' is ignored on multiSelect questions even with preview", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		const s = baseState({
			questions: [multiQ, makeQuestion()],
			focusedOptionHasPreview: true,
		});
		expect(handleQuestionnaireInput("n", s)).toEqual({ kind: "ignore" });
	});

	it("notesMode: Esc -> notes_exit", () => {
		expect(handleQuestionnaireInput(sentinel(KEY.CANCEL), baseState({ notesVisible: true }))).toEqual({
			kind: "notes_exit",
		});
	});

	it("notesMode: Enter -> notes_exit (save + return to options)", () => {
		expect(handleQuestionnaireInput(sentinel(KEY.CONFIRM), baseState({ notesVisible: true }))).toEqual({
			kind: "notes_exit",
		});
	});

	it("notesMode: Tab byte is ignored (input-guard suppresses tab nav)", () => {
		expect(handleQuestionnaireInput(BYTE_TAB, baseState({ notesVisible: true }))).toEqual({ kind: "ignore" });
	});

	it("notesMode: arbitrary printable byte is ignored (forwarded to Input by dialog)", () => {
		expect(handleQuestionnaireInput("a", baseState({ notesVisible: true }))).toEqual({ kind: "ignore" });
	});
});

describe("handleQuestionnaireInput — inputMode (Type something)", () => {
	const other: WrappingSelectItem = { label: "Type something.", isOther: true };

	it("Tab byte is ignored under inputMode", () => {
		expect(handleQuestionnaireInput(BYTE_TAB, baseState({ inputMode: true, currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	it("printable bytes return ignore (dialog forwards to WrappingSelect.appendInput)", () => {
		expect(handleQuestionnaireInput("x", baseState({ inputMode: true, currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	it("Esc cancels the questionnaire even in inputMode", () => {
		expect(
			handleQuestionnaireInput(sentinel(KEY.CANCEL), baseState({ inputMode: true, currentItem: other })),
		).toEqual({ kind: "cancel" });
	});
});

describe("handleQuestionnaireInput — chat focus", () => {
	const chatItem: WrappingSelectItem = { label: "Chat about this", isChat: true };

	it("DOWN-on-last single-select → focus_chat (no optionIndex mutation)", () => {
		const s = baseState({ optionIndex: 2 }); // items.length === 3
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({ kind: "focus_chat" });
	});

	it("DOWN-on-last multi-select → focus_chat", () => {
		const multiQ = makeQuestion({
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
				{ label: "DB", description: "DB" },
			],
		});
		const items = multiQ.options.map((o) => ({ label: o.label }));
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 2,
			items,
			currentItem: items[2],
		});
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({ kind: "focus_chat" });
	});

	it("DOWN-on-last + inputMode (last item is isOther) → focus_chat", () => {
		const other: WrappingSelectItem = { label: "Type something.", isOther: true };
		const items: WrappingSelectItem[] = [{ label: "A" }, { label: "B" }, other];
		const s = baseState({
			inputMode: true,
			items,
			optionIndex: 2,
			currentItem: other,
		});
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({ kind: "focus_chat" });
	});

	// UP / DOWN from the chat row participate in the continuous cycle covered by the
	// "chat-inclusive cycle (Defect 2)" describe block below — they no longer emit a bare
	// `focus_options` (that would leave optionIndex frozen at the prior position).

	it.each<[string, string, number]>([
		["Tab", BYTE_TAB, 1],
		["Right", BYTE_RIGHT, 1],
		["Shift+Tab", BYTE_SHIFT_TAB, 2],
		["Left", BYTE_LEFT, 2],
	])("%s while chatFocused → tab_switch → tab %i", (_label, byte, expected) => {
		const s = baseState({ chatFocused: true, currentItem: chatItem });
		expect(handleQuestionnaireInput(byte, s)).toEqual({ kind: "tab_switch", nextTab: expected });
	});

	it("Enter while chatFocused single-select → confirm wasChat:true", () => {
		const s = baseState({ chatFocused: true, currentItem: chatItem });
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.wasChat).toBe(true);
			expect(action.answer.answer).toBe("Chat about this");
		}
	});

	it("Enter while chatFocused multi-select → confirm wasChat:true (overrides multi_confirm)", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		const s = baseState({
			questions: [multiQ, makeQuestion()],
			currentTab: 0,
			chatFocused: true,
			currentItem: chatItem,
			multiSelectChecked: new Set([0, 1]),
		});
		const action = handleQuestionnaireInput(sentinel(KEY.CONFIRM), s);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.wasChat).toBe(true);
		}
	});

	it("Esc while chatFocused → cancel", () => {
		const s = baseState({ chatFocused: true, currentItem: chatItem });
		expect(handleQuestionnaireInput(sentinel(KEY.CANCEL), s)).toEqual({ kind: "cancel" });
	});

	it("Space while chatFocused (multi) → ignore", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		const s = baseState({
			questions: [multiQ, makeQuestion()],
			chatFocused: true,
			currentItem: chatItem,
		});
		expect(handleQuestionnaireInput(BYTE_SPACE, s)).toEqual({ kind: "ignore" });
	});

	it("'n' while chatFocused → ignore", () => {
		const s = baseState({
			chatFocused: true,
			currentItem: chatItem,
			focusedOptionHasPreview: true,
		});
		expect(handleQuestionnaireInput("n", s)).toEqual({ kind: "ignore" });
	});
});

// Defect 2 — UP/DOWN must form a single natural cycle that includes the chat row both ways:
//   chat → option0 → option1 → … → optionLast → chat → option0 …  (DOWN)
//   chat ← option0 ← option1 ← … ← optionLast ← chat ← option0 …  (UP)
//
// Currently UP at optionIndex 0 wraps to the last option (skips chat), and DOWN/UP from chat
// emits a bare `focus_options` that leaves optionIndex untouched (so chat → DOWN cycles back
// to the prior position, not to option 0). These tests pin the EXPECTED behavior — they fail
// against the current dispatch and will turn green once the fix lands.
describe("handleQuestionnaireInput — chat-inclusive cycle (Defect 2)", () => {
	const chatItem: WrappingSelectItem = { label: "Chat about this", isChat: true };

	it("UP at optionIndex 0 (single-select) emits focus_chat — wraps UP into the chat row", () => {
		const s = baseState({ optionIndex: 0 });
		expect(handleQuestionnaireInput(sentinel(KEY.UP), s)).toEqual({ kind: "focus_chat" });
	});

	it("UP at optionIndex 0 (multi-select with Next sentinel) emits focus_chat", () => {
		const multiQ = makeQuestion({
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
			],
		});
		const items: WrappingSelectItem[] = [{ label: "FE" }, { label: "BE" }, { label: "Next", isNext: true }];
		const s = baseState({
			questions: [multiQ],
			isMulti: false,
			optionIndex: 0,
			items,
			currentItem: items[0],
		});
		expect(handleQuestionnaireInput(sentinel(KEY.UP), s)).toEqual({ kind: "focus_chat" });
	});

	it("DOWN while chatFocused returns to options at index 0 (continuous cycle, not a no-op)", () => {
		const s = baseState({
			chatFocused: true,
			optionIndex: 2,
			currentItem: chatItem,
		});
		// Carries the target index so the host can land on option 0 (top of the cycle)
		// rather than restoring whatever optionIndex the user left chat from.
		expect(handleQuestionnaireInput(sentinel(KEY.DOWN), s)).toEqual({
			kind: "focus_options",
			optionIndex: 0,
		});
	});

	it("UP while chatFocused returns to options at the LAST item (continuous cycle)", () => {
		const s = baseState({
			chatFocused: true,
			optionIndex: 0,
			currentItem: chatItem,
		});
		// items.length - 1 is the last navigable row (Type-something on single-select,
		// Next sentinel on multi-select). Symmetric with DOWN-from-last → focus_chat.
		expect(handleQuestionnaireInput(sentinel(KEY.UP), s)).toEqual({
			kind: "focus_options",
			optionIndex: s.items.length - 1,
		});
	});
});
