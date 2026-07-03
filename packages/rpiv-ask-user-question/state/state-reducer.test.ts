import { describe, expect, it } from "vitest";
import {
	itemsRegular,
	itemsWithOther,
	makeApplyContext as makeCtx,
	makeQuestion,
	makeQuestionnaireState as makeState,
} from "../test-fixtures.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { QuestionnaireAction } from "./key-router.js";
import { reduce } from "./state-reducer.js";

describe("reduce — nav", () => {
	it("regular nav emits clear_input_buffer", () => {
		const r = reduce(makeState(), { kind: "nav", nextIndex: 1 }, makeCtx());
		expect(r.state.optionIndex).toBe(1);
		expect(r.state.inputMode).toBe(false);
		expect(r.effects).toEqual([{ kind: "clear_input_buffer" }]);
	});

	it("nav onto kind:'other' row with prior kind:'custom' answer restores the buffer", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "Pick one", kind: "custom", answer: "Hello" }],
		]);
		const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
		const r = reduce(makeState({ answers }), { kind: "nav", nextIndex: 2 }, ctx);
		expect(r.state.inputMode).toBe(true);
		expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "Hello" }]);
	});

	it("nav onto kind:'other' row with no prior kind:'custom' emits no input effect", () => {
		const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
		const r = reduce(makeState(), { kind: "nav", nextIndex: 2 }, ctx);
		expect(r.state.inputMode).toBe(true);
		expect(r.effects).toEqual([]);
	});
});

describe("reduce — tab_switch", () => {
	it("emits set_notes_focused(false) + set_notes_value", () => {
		const r = reduce(
			makeState(),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions: [makeQuestion(), makeQuestion()], itemsByTab: [itemsRegular, itemsRegular] }),
		);
		expect(r.state.currentTab).toBe(1);
		expect(r.state.optionIndex).toBe(0);
		expect(r.state.notesVisible).toBe(false);
		expect(r.effects).toEqual([
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: "" },
		]);
	});
});

describe("reduce — confirm", () => {
	it("regular option without preview emits done with the answer", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const r = reduce(makeState(), action, makeCtx());
		expect(r.state.answers.get(0)?.answer).toBe("A");
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [r.state.answers.get(0)!], cancelled: false } }]);
	});

	it("regular option matching a preview-bearing option augments answer.preview", () => {
		const questions = [
			makeQuestion({
				options: [
					{ label: "A", description: "a", preview: "code" },
					{ label: "B", description: "b" },
				],
			}),
		];
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const r = reduce(makeState(), action, makeCtx({ questions }));
		expect(r.state.answers.get(0)?.preview).toBe("code");
	});

	it("merges pendingNotes from notesByTab into the confirmed answer", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const state = makeState({ notesByTab: new Map([[0, "  side note  "]]) });
		const r = reduce(state, action, makeCtx());
		expect(r.state.answers.get(0)?.notes).toBe("  side note  ");
	});

	it("autoAdvanceTab dispatches a tab_switch result instead of done", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
			autoAdvanceTab: 1,
		};
		const ctx = makeCtx({ questions: [makeQuestion(), makeQuestion()], itemsByTab: [itemsRegular, itemsRegular] });
		const r = reduce(makeState(), action, ctx);
		expect(r.state.currentTab).toBe(1);
		expect(r.effects.some((e) => e.kind === "set_notes_focused")).toBe(true);
		expect(r.effects.some((e) => e.kind === "done")).toBe(false);
	});
});

describe("reduce — toggle", () => {
	it("toggles index 0 on then off and persists into answers", () => {
		const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
		const r1 = reduce(makeState(), { kind: "toggle", index: 0 }, ctx);
		expect(r1.state.multiSelectChecked.has(0)).toBe(true);
		expect(r1.state.answers.get(0)?.selected).toEqual(["A"]);
		const r2 = reduce(r1.state, { kind: "toggle", index: 0 }, ctx);
		expect(r2.state.multiSelectChecked.has(0)).toBe(false);
		expect(r2.state.answers.has(0)).toBe(false);
	});
});

describe("reduce — round-trip property [toggle, tab_switch, tab_switch_back] preserves multiSelectChecked (precedent f4fdd25)", () => {
	it("multiSelectChecked is reconstructed from answers on tab-back", () => {
		const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
		const ctx = makeCtx({ questions, itemsByTab: questions.map(() => itemsRegular) });

		let s = makeState();
		s = reduce(s, { kind: "toggle", index: 0 }, ctx).state;
		s = reduce(s, { kind: "toggle", index: 1 }, ctx).state;
		expect([...s.multiSelectChecked].sort()).toEqual([0, 1]);
		expect(s.answers.get(0)?.selected).toEqual(["A", "B"]);

		s = reduce(s, { kind: "tab_switch", nextTab: 1 }, ctx).state;
		expect([...s.multiSelectChecked]).toEqual([]);

		s = reduce(s, { kind: "tab_switch", nextTab: 0 }, ctx).state;
		expect([...s.multiSelectChecked].sort()).toEqual([0, 1]);
	});
});

describe("reduce — multi_confirm", () => {
	it("persists answer + multiSelectChecked from action.selected", () => {
		const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
		const r = reduce(makeState(), { kind: "multi_confirm", selected: ["A", "B"] }, ctx);
		expect(r.state.answers.get(0)?.selected).toEqual(["A", "B"]);
		expect([...r.state.multiSelectChecked].sort()).toEqual([0, 1]);
		expect(r.effects.some((e) => e.kind === "done")).toBe(true);
	});
});

describe("reduce — cancel/submit", () => {
	it("cancel emits done with cancelled: true", () => {
		const r = reduce(makeState(), { kind: "cancel" }, makeCtx());
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: true } }]);
	});
	it("submit emits done with cancelled: false", () => {
		const r = reduce(makeState(), { kind: "submit" }, makeCtx());
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: false } }]);
	});
});

describe("reduce — notes_enter / notes_exit / notes_forward", () => {
	it("notes_enter seeds state.notesDraft from existing answer.notes and emits set_notes_value", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const r = reduce(makeState({ answers }), { kind: "notes_enter" }, makeCtx());
		expect(r.state.notesVisible).toBe(true);
		expect(r.state.notesDraft).toBe("old note");
		expect(r.effects).toEqual([
			{ kind: "set_notes_value", value: "old note" },
			{ kind: "set_notes_focused", focused: true },
		]);
	});

	it("notes_exit with empty notesDraft clears notesByTab + strips answer.notes", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const state = makeState({
			answers,
			notesByTab: new Map([[0, "old note"]]),
			notesVisible: true,
			notesDraft: "",
		});
		const r = reduce(state, { kind: "notes_exit" }, makeCtx());
		expect(r.state.notesVisible).toBe(false);
		expect(r.state.notesByTab.has(0)).toBe(false);
		expect(r.state.answers.get(0)?.notes).toBeUndefined();
	});

	it("notes_exit trims state.notesDraft before persisting", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
		]);
		const r = reduce(
			makeState({ answers, notesVisible: true, notesDraft: "  fresh  " }),
			{ kind: "notes_exit" },
			makeCtx(),
		);
		expect(r.state.notesByTab.get(0)).toBe("fresh");
		expect(r.state.answers.get(0)?.notes).toBe("fresh");
	});

	it("notes_exit with whitespace-only notesDraft clears notesByTab + strips answer.notes", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const r = reduce(
			makeState({
				answers,
				notesByTab: new Map([[0, "old note"]]),
				notesVisible: true,
				notesDraft: "   ",
			}),
			{ kind: "notes_exit" },
			makeCtx(),
		);
		expect(r.state.notesByTab.has(0)).toBe(false);
		expect(r.state.answers.get(0)?.notes).toBeUndefined();
	});

	it("notes_forward emits a single forward_notes_keystroke effect with no state change", () => {
		const s = makeState({ notesVisible: true, notesDraft: "hel" });
		const r = reduce(s, { kind: "notes_forward", data: "l" }, makeCtx());
		expect(r.state).toBe(s);
		expect(r.effects).toEqual([{ kind: "forward_notes_keystroke", data: "l" }]);
	});
});

describe("reduce — submit_nav / ignore", () => {
	it("submit_nav updates submitChoiceIndex with no effects", () => {
		const r = reduce(makeState(), { kind: "submit_nav", nextIndex: 1 }, makeCtx());
		expect(r.state.submitChoiceIndex).toBe(1);
		expect(r.effects).toEqual([]);
	});

	it("ignore is identity (state unchanged, no effects)", () => {
		const s = makeState({ optionIndex: 2 });
		const r = reduce(s, { kind: "ignore" }, makeCtx());
		expect(r.state).toEqual(s);
		expect(r.effects).toEqual([]);
	});
});

describe("confirmHandler — custom answer clears multiSelectChecked (mutual exclusivity)", () => {
	const multiQ: QuestionData = {
		question: "areas?",
		header: "H",
		multiSelect: true,
		options: [
			{ label: "FE", description: "f" },
			{ label: "BE", description: "b" },
		],
	};

	it("custom confirm on a multi-select tab clears pre-existing checks", () => {
		const state = makeState({
			currentTab: 0,
			multiSelectChecked: new Set([0, 1]),
		});
		const ctx = makeCtx({ questions: [multiQ] });
		const result = reduce(
			state,
			{ kind: "confirm", answer: { questionIndex: 0, question: "areas?", kind: "custom", answer: "custom-text" } },
			ctx,
		);
		expect(result.state.multiSelectChecked.size).toBe(0);
		expect(result.state.answers.get(0)?.kind).toBe("custom");
	});

	it("option confirm on a single-select tab leaves multiSelectChecked untouched (no spurious clear)", () => {
		const singleQ: QuestionData = { question: "pick?", header: "H", options: [{ label: "A", description: "a" }] };
		const state = makeState({ currentTab: 0, multiSelectChecked: new Set([0]) });
		const ctx = makeCtx({ questions: [singleQ] });
		const result = reduce(
			state,
			{ kind: "confirm", answer: { questionIndex: 0, question: "pick?", kind: "option", answer: "A" } },
			ctx,
		);
		expect(result.state.multiSelectChecked.size).toBe(1);
	});
});

describe("reduce — toggle_collapsed", () => {
	it("flips false → true and emits set_overlay_hidden(true) so the runtime hides the overlay", () => {
		const r = reduce(makeState(), { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(true);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
	});

	it("flips true → false (expand round-trip) and emits set_overlay_hidden(false)", () => {
		const r = reduce(makeState({ collapsed: true }), { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(false);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: false }]);
	});

	it("preserves orthogonal fields — collapse is a pure render-mode flip, never touches answers/optionIndex/notes", () => {
		// Regression guard: a future refactor that resets nav/notes on collapse would silently
		// drop the user's mid-edit work. The collapse toggle must be additive only.
		const answers = new Map<QuestionAnswer["questionIndex"], QuestionAnswer>([
			[0, { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }],
		]);
		const s = makeState({ optionIndex: 1, notesVisible: true, notesDraft: "in-flight", answers });
		const r = reduce(s, { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(true);
		expect(r.state.optionIndex).toBe(1);
		expect(r.state.notesVisible).toBe(true);
		expect(r.state.notesDraft).toBe("in-flight");
		expect(r.state.answers).toBe(answers);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
	});
});
