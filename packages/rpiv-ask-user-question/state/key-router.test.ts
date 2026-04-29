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
		chatFocused: false,
		answers: new Map<number, QuestionAnswer>(),
		multiSelectChecked: new Set<number>(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
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
	// Boundary case (UP at optionIndex 0 → focus_chat) is exercised by the chat-inclusive
	// cycle suite below. Above the top boundary, UP simply decrements.
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

	it("chat sentinel item -> answer.kind === 'chat'", () => {
		const chat: WrappingSelectItem = { kind: "chat", label: "Chat about this" };
		const action = routeKey(sentinel(KEY.CONFIRM), makeState(), makeRuntime({ currentItem: chat }));
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") expect(action.answer.kind).toBe("chat");
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

	it("notesMode: Tab byte is ignored (input-guard suppresses tab nav)", () => {
		expect(routeKey(BYTE_TAB, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
	});

	it("notesMode: arbitrary printable byte is ignored (forwarded to Input by dialog)", () => {
		expect(routeKey("a", makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "ignore",
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

	it("printable bytes return ignore (dialog forwards to WrappingSelect.appendInput)", () => {
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

describe("routeKey — chat focus", () => {
	const chatItem: WrappingSelectItem = { kind: "chat", label: "Chat about this" };

	it("DOWN-on-last single-select → focus_chat (no optionIndex mutation)", () => {
		// items.length === 3
		expect(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "focus_chat",
		});
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
		const items: WrappingSelectItem[] = multiQ.options.map((o) => ({ kind: "option" as const, label: o.label }));
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 2 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items,
					currentItem: items[2],
				}),
			),
		).toEqual({ kind: "focus_chat" });
	});

	it("DOWN-on-last + inputMode (last item is kind:'other') → focus_chat", () => {
		const other: WrappingSelectItem = { kind: "other", label: "Type something." };
		const items: WrappingSelectItem[] = [{ kind: "option", label: "A" }, { kind: "option", label: "B" }, other];
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ inputMode: true, optionIndex: 2 }),
				makeRuntime({ items, currentItem: other }),
			),
		).toEqual({ kind: "focus_chat" });
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
		expect(routeKey(byte, makeState({ chatFocused: true }), makeRuntime({ currentItem: chatItem }))).toEqual({
			kind: "tab_switch",
			nextTab: expected,
		});
	});

	it("Enter while chatFocused single-select → confirm kind:'chat'", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ chatFocused: true }),
			makeRuntime({ currentItem: chatItem }),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.kind).toBe("chat");
			expect(action.answer.answer).toBe("Chat about this");
		}
	});

	it("Enter while chatFocused multi-select → confirm kind:'chat' (overrides multi_confirm)", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ currentTab: 0, chatFocused: true, multiSelectChecked: new Set([0, 1]) }),
			makeRuntime({ questions: [multiQ, makeQuestion()], currentItem: chatItem }),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.kind).toBe("chat");
		}
	});

	it("Esc while chatFocused → cancel", () => {
		expect(
			routeKey(sentinel(KEY.CANCEL), makeState({ chatFocused: true }), makeRuntime({ currentItem: chatItem })),
		).toEqual({ kind: "cancel" });
	});

	it("Space while chatFocused (multi) → ignore", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ chatFocused: true }),
				makeRuntime({ questions: [multiQ, makeQuestion()], currentItem: chatItem }),
			),
		).toEqual({ kind: "ignore" });
	});

	it("'n' while chatFocused → ignore", () => {
		expect(
			routeKey(
				"n",
				makeState({ chatFocused: true, focusedOptionHasPreview: true }),
				makeRuntime({ currentItem: chatItem }),
			),
		).toEqual({ kind: "ignore" });
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
describe("routeKey — chat-inclusive cycle (Defect 2)", () => {
	const chatItem: WrappingSelectItem = { kind: "chat", label: "Chat about this" };

	it("UP at optionIndex 0 (single-select) emits focus_chat — wraps UP into the chat row", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 0 }), makeRuntime())).toEqual({
			kind: "focus_chat",
		});
	});

	it("UP at optionIndex 0 (multi-select with Next sentinel) emits focus_chat", () => {
		const multiQ = makeQuestion({
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
			],
		});
		const items: WrappingSelectItem[] = [
			{ kind: "option", label: "FE" },
			{ kind: "option", label: "BE" },
			{ kind: "next", label: "Next" },
		];
		expect(
			routeKey(
				sentinel(KEY.UP),
				makeState({ optionIndex: 0 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items,
					currentItem: items[0],
				}),
			),
		).toEqual({ kind: "focus_chat" });
	});

	it("DOWN while chatFocused returns to options at index 0 (continuous cycle, not a no-op)", () => {
		// Carries the target index so the host can land on option 0 (top of the cycle)
		// rather than restoring whatever optionIndex the user left chat from.
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ chatFocused: true, optionIndex: 2 }),
				makeRuntime({ currentItem: chatItem }),
			),
		).toEqual({
			kind: "focus_options",
			optionIndex: 0,
		});
	});

	it("UP while chatFocused returns to options at the LAST item (continuous cycle)", () => {
		// items.length - 1 is the last navigable row (Type-something on single-select,
		// Next sentinel on multi-select). Symmetric with DOWN-from-last → focus_chat.
		const runtime = makeRuntime({ currentItem: chatItem });
		expect(routeKey(sentinel(KEY.UP), makeState({ chatFocused: true, optionIndex: 0 }), runtime)).toEqual({
			kind: "focus_options",
			optionIndex: runtime.items.length - 1,
		});
	});
});
