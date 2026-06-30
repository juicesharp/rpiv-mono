import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { allAnswered, routeKey, wrapTab } from "./key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";

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
		kind: over.kind ?? "option",
		answer: over.answer ?? "A",
	};
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map<number, QuestionAnswer>(),
		multiSelectChecked: new Set<number>(),
		notesByTab: new Map<number, string>(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...over,
	};
}

function makeRuntime(over: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	const questions = over.questions ?? [makeQuestion(), makeQuestion()];
	const items: WrappingSelectItem[] = over.items
		? [...over.items]
		: questions[0]!.options.map((o) => ({ kind: "option" as const, label: o.label }));
	return {
		keybindings,
		inputBuffer: "",
		questions,
		isMulti: questions.length > 1,
		currentItem: items[0],
		items,
		...over,
	};
}

describe("wrapTab + allAnswered", () => {
	it("wraps negative + over-max into [0, total)", () => {
		expect(wrapTab(-1, 3)).toBe(2);
		expect(wrapTab(3, 3)).toBe(0);
		expect(wrapTab(0, 0)).toBe(0);
	});

	it("allAnswered is false when any question lacks an answer", () => {
		expect(allAnswered(makeState({ answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]) }), makeRuntime())).toBe(
			false,
		);
	});

	it("allAnswered is true when every question has an answer", () => {
		expect(
			allAnswered(
				makeState({
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toBe(true);
	});
});

describe("routeKey — nav", () => {
	it("UP from a non-zero index decrements by 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
		});
	});
	it("DOWN advances by 1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState(), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
		});
	});
	// With the chat row gone, UP/DOWN wrap within [option0 … optionLast] via wrapTab.
	// DOWN at the last item wraps to 0; UP at the first item wraps to the last.
	it("DOWN at the last item wraps to 0 (no chat row, wrapTab clamp)", () => {
		// makeRuntime default items length === 3 (questions[0].options)
		expect(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 0,
		});
	});
	it("UP at the first item wraps to the last (no chat row, wrapTab clamp)", () => {
		const runtime = makeRuntime();
		const last = runtime.items.length - 1;
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 0 }), runtime)).toEqual({
			kind: "nav",
			nextIndex: last,
		});
	});
});

describe("routeKey — tab_switch", () => {
	it("Tab cycles forward through total tabs (questions + Submit)", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	it("Right is an alias for Tab", () => {
		expect(routeKey(BYTE_RIGHT, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	it("Shift+Tab wraps backward from tab 0 to the Submit tab", () => {
		expect(routeKey(BYTE_SHIFT_TAB, makeState({ currentTab: 0 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 2,
		});
	});

	it("Left is an alias for Shift+Tab", () => {
		expect(routeKey(BYTE_LEFT, makeState({ currentTab: 1 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 0,
		});
	});

	it("Tab is a no-op (returns ignore) in single-question mode", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime({ isMulti: false, questions: [makeQuestion()] }))).toEqual({
			kind: "ignore",
		});
	});
});

describe("routeKey — confirm (single-select)", () => {
	it("emits confirm with autoAdvanceTab pointing to the next tab", () => {
		const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 0 }), makeRuntime());
		expect(action).toMatchObject({
			kind: "confirm",
			answer: { questionIndex: 0, answer: "A", kind: "option" },
			autoAdvanceTab: 1,
		});
	});

	it("last question -> autoAdvanceTab points at the Submit tab (questions.length)", () => {
		const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 1 }), makeRuntime());
		expect(action).toMatchObject({ kind: "confirm", autoAdvanceTab: 2 });
	});

	it("single-question (!isMulti) -> autoAdvanceTab is undefined (dialog submits)", () => {
		const questions = [makeQuestion()];
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState(),
			makeRuntime({
				isMulti: false,
				questions,
				items: [
					{ kind: "option", label: "A" },
					{ kind: "option", label: "B" },
					{ kind: "option", label: "C" },
				],
			}),
		);
		expect(action).toMatchObject({ kind: "confirm" });
		if (action.kind === "confirm") {
			expect(action.autoAdvanceTab).toBeUndefined();
		}
	});

	it("inline-input mode: Enter confirms with the buffered text + kind:'custom'", () => {
		const other: WrappingSelectItem = { kind: "other", label: "Type something." };
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ inputMode: true }),
			makeRuntime({ currentItem: other, inputBuffer: "my custom answer" }),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.answer).toBe("my custom answer");
			expect(action.answer.kind).toBe("custom");
		}
	});
});

describe("routeKey — multiSelect", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});

	it("Space emits toggle for the current optionIndex", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 1 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual({ kind: "toggle", index: 1 });
	});

	// Spec: Enter on a REGULAR option row toggles that row's checkbox (matches Space). Committing
	// + advancing requires explicit focus on the Next sentinel — see the multi_confirm tests below.
	it("Enter on a regular row emits toggle for the current optionIndex", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 1 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual({ kind: "toggle", index: 1 });
	});

	// Spec: Space on the Next sentinel is ignored — Next is not a real option.
	it("Space on Next sentinel is ignored", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({ kind: "ignore" });
	});

	it("Enter on Next emits multi_confirm with selected labels in option order", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3, multiSelectChecked: new Set([2, 0]) }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({
			kind: "multi_confirm",
			selected: ["FE", "Tests"],
			autoAdvanceTab: undefined,
		});
	});

	// Spec: Enter on Next for a SINGLE multi-select question submits the dialog.
	it("single-question multi-select: Enter on Next carries autoAdvanceTab=undefined (host → submit)", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [multiQ],
				isMulti: false,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBeUndefined();
	});

	// Spec: Enter on Next for a multi-question dialog advances to the next tab.
	it("multi-question multi-select on tab 0: Enter on Next carries autoAdvanceTab=1", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ currentTab: 0, optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [multiQ, makeQuestion()],
				isMulti: true,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(1);
	});

	// Spec: Enter on Next from the LAST multi-select question advances to the Submit tab.
	it("multi-question multi-select on last tab: Enter on Next carries autoAdvanceTab=questions.length (Submit)", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ currentTab: 1, optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [makeQuestion(), multiQ],
				isMulti: true,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(2);
	});

	it("Space does NOT emit toggle on a single-select question", () => {
		expect(routeKey(BYTE_SPACE, makeState(), makeRuntime())).toEqual({ kind: "ignore" });
	});
});

describe("routeKey — multiSelect free-text ('Type something.')", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});
	// Post-Phase-2 items: 3 options + other + next.
	const items: WrappingSelectItem[] = [
		{ kind: "option", label: "FE" },
		{ kind: "option", label: "BE" },
		{ kind: "option", label: "Tests" },
		{ kind: "other", label: "Type something." },
		{ kind: "next", label: "Next" },
	];

	it("Enter on the 'Type something.' row (inputMode) → confirm kind:'custom' with the buffer", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ optionIndex: 3, inputMode: true }),
			makeRuntime({
				questions: [multiQ],
				isMulti: false,
				items,
				currentItem: items[3],
				inputBuffer: "typed answer",
			}),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.kind).toBe("custom");
			expect(action.answer.answer).toBe("typed answer");
		}
	});

	it("Space on the 'Type something.' row (defensive, !inputMode) → ignore (no phantom toggle)", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("Enter on the 'Type something.' row (defensive, !inputMode) → ignore (no toggle/multi_confirm)", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("DOWN from last option (index 2) → nav to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 2 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[2] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3 });
	});

	it("DOWN from the other row (index 3) → nav to Next (index 4)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "nav", nextIndex: 4 });
	});

	it("UP from Next (index 4) → nav back to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.UP),
				makeState({ optionIndex: 4 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[4] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3 });
	});
});

describe("routeKey — cancel + submit", () => {
	it("Esc cancels the entire questionnaire from any tab", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState(), makeRuntime())).toEqual({ kind: "cancel" });
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ currentTab: 2 }), makeRuntime())).toEqual({
			kind: "cancel",
		});
	});

	it("Submit tab + Enter on Submit row + allAnswered -> submit", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 0,
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "submit" });
	});

	// D1 revised: partial submission allowed. Enter on Submit row always submits.
	it("Submit tab + Enter on Submit row when not allAnswered -> submit (partial)", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 0,
					answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "submit" });
	});

	it("Submit tab + DOWN -> submit_nav nextIndex=1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	it("Submit tab + UP wraps from 0 to 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	it("Submit tab + DOWN from index 1 wraps to 0", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 0,
		});
	});

	it("Submit tab + Enter on Cancel row (index 1) when complete -> cancel", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 1,
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "cancel" });
	});

	it("Submit tab + Enter on Cancel row (index 1) when incomplete -> cancel", () => {
		expect(
			routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime()),
		).toEqual({ kind: "cancel" });
	});
});

describe("routeKey — notes", () => {
	it("'n' when focused option has preview emits notes_enter", () => {
		expect(routeKey("n", makeState({ focusedOptionHasPreview: true }), makeRuntime())).toEqual({
			kind: "notes_enter",
		});
	});

	it("'n' when focused option has no preview is ignored", () => {
		expect(routeKey("n", makeState({ focusedOptionHasPreview: false }), makeRuntime())).toEqual({
			kind: "ignore",
		});
	});

	it("'n' is ignored on multiSelect questions even with preview", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		expect(
			routeKey(
				"n",
				makeState({ focusedOptionHasPreview: true }),
				makeRuntime({ questions: [multiQ, makeQuestion()] }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("notesMode: Esc -> notes_exit", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_exit",
		});
	});

	it("notesMode: Enter -> notes_exit (save + return to options)", () => {
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_exit",
		});
	});

	it("notesMode: Tab byte emits notes_forward (any non-Esc/Enter key forwards to the Input)", () => {
		expect(routeKey(BYTE_TAB, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: BYTE_TAB,
		});
	});

	it("notesMode: arbitrary printable byte emits notes_forward (single dispatch path)", () => {
		expect(routeKey("a", makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: "a",
		});
	});
});

describe("routeKey — inputMode (Type something)", () => {
	const other: WrappingSelectItem = { kind: "other", label: "Type something." };

	it("Tab byte is ignored under inputMode", () => {
		expect(routeKey(BYTE_TAB, makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	it("printable bytes return ignore (dialog forwards to inlineInput.handleInput)", () => {
		expect(routeKey("x", makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	it("Esc cancels the questionnaire even in inputMode", () => {
		expect(
			routeKey(sentinel(KEY.CANCEL), makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
		).toEqual({ kind: "cancel" });
	});
});

describe("routeKey — collapse/expand (Ctrl+] toggle + collapsed-mode lockout)", () => {
	// Raw control byte for Ctrl+] (GS, 0x1d). matchesKey recognises this directly on
	// every terminal that delivers raw control bytes in TUI mode — macOS Terminal.app,
	// iTerm2, Warp, Ghostty, tmux, zellij. The legacy telnet/ssh escape role does NOT
	// apply because the questionnaire runs in-process.
	const BYTE_CTRL_RBRACKET = "\x1d";

	it("Ctrl+] emits toggle_collapsed from the default question state", () => {
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), makeRuntime())).toEqual({ kind: "toggle_collapsed" });
	});

	it("Ctrl+] emits toggle_collapsed even while notesVisible (the notes branch never sees the key)", () => {
		// Notes mode normally forwards every keystroke to the notes input via `notes_forward`.
		// The collapse intercept sits ABOVE all state branches so the user can shrink the
		// dialog to read the transcript mid-notes-edit without dirtying the draft.
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	it("Ctrl+] emits toggle_collapsed even when already collapsed (expand round-trip)", () => {
		// Symmetric: pressing Ctrl+] a second time returns to the full questionnaire.
		// The reducer flips the boolean; the router stays oblivious to which way we're going.
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	it("while collapsed, Esc maps to cancel (the documented escape hatch in the one-line footer)", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "cancel" });
	});

	it("while collapsed, navigation keys are swallowed as ignore (no state mutation behind the one-line footer)", () => {
		// Arrow keys would otherwise navigate options; collapsed mode is a read-the-
		// transcript pause, so non-cancel keys must not advance any focus.
		expect(routeKey(sentinel(KEY.UP), makeState({ collapsed: true, optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(sentinel(KEY.DOWN), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(BYTE_TAB, makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
	});

	it("while collapsed, the notes-forward and toggle branches are unreachable (lockout precedes them)", () => {
		// Regression guard: without the lockout, a collapsed + notesVisible state would forward
		// keystrokes into the notes input, and a collapsed + multiSelect state would let Space
		// flip checkboxes. Both paths must be dead-ended at the collapsed branch.
		expect(routeKey("x", makeState({ collapsed: true, notesVisible: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ collapsed: true }),
				makeRuntime({ questions: [makeQuestion({ multiSelect: true })] }),
			),
		).toEqual({ kind: "ignore" });
	});
});
