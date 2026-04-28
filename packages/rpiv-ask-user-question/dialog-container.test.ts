import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Input } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import {
	buildDialog,
	type DialogConfig,
	type DialogState,
	HINT_MULTI,
	HINT_MULTISELECT_SUFFIX,
	HINT_NOTES_SUFFIX,
	HINT_SINGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.js";
import { MultiSelectOptions } from "./multi-select-options.js";
import type { PreviewPane } from "./preview-pane.js";
import { CANCEL_LABEL, SUBMIT_LABEL, SubmitPicker } from "./submit-picker.js";
import type { TabBar } from "./tab-bar.js";
import type { QuestionAnswer, QuestionData } from "./types.js";
import { WrappingSelect } from "./wrapping-select.js";

const theme = makeTheme() as unknown as Theme;

function stubComponent(lines: string[]): Component {
	return {
		render: () => lines,
		handleInput() {},
		invalidate() {},
	};
}

function makeConfig(over: Partial<DialogConfig> = {}): DialogConfig {
	const questions: QuestionData[] = over.questions
		? [...over.questions]
		: [
				{
					question: "Q1?",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			];
	const state: DialogState = over.state ?? {
		currentTab: 0,
		optionIndex: 0,
		notesVisible: false,
		inputMode: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
	};
	const previewPane = over.previewPane ?? (stubComponent(["<PREVIEW>"]) as unknown as PreviewPane);
	const multiSelectOptionsByTab =
		over.multiSelectOptionsByTab ?? questions.map(() => undefined as MultiSelectOptions | undefined);
	return {
		theme: over.theme ?? theme,
		questions,
		state,
		previewPane,
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Input),
		chatList: over.chatList ?? (stubComponent(["<CHAT_ROW>"]) as unknown as WrappingSelect),
		isMulti: over.isMulti ?? questions.length > 1,
		multiSelectOptionsByTab,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight:
			over.getCurrentBodyHeight ??
			((w) => {
				const idx = state.currentTab;
				const q = questions[idx];
				const mso = multiSelectOptionsByTab[idx];
				if (q?.multiSelect === true && mso) return (mso as unknown as Component).render(w).length;
				return (previewPane as unknown as Component).render(w).length;
			}),
	};
}

describe("buildDialog — single-question mode", () => {
	it("omits the TabBar entirely", () => {
		const tabBar = stubComponent(["<TABBAR>", ""]) as unknown as TabBar;
		const dlg = buildDialog(
			makeConfig({
				questions: [
					{
						question: "only?",
						header: "Only",
						options: [
							{ label: "yes", description: "y" },
							{ label: "no", description: "n" },
						],
					},
				],
				isMulti: false,
				tabBar,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("<TABBAR>");
		expect(joined).toContain("<PREVIEW>");
		expect(joined).toContain("<CHAT_ROW>");
		expect(joined).toContain(HINT_SINGLE);
	});

	// In single-question mode the tab bar is hidden, so the inner header badge IS rendered
	// (otherwise the user would never see the question header).
	it("renders the inner header badge in the dialog body (no tab bar to show it)", () => {
		const dlg = buildDialog(
			makeConfig({
				questions: [
					{
						question: "only?",
						header: "H-only",
						options: [
							{ label: "yes", description: "y" },
							{ label: "no", description: "n" },
						],
					},
				],
				isMulti: false,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(" H-only ");
	});
});

describe("buildDialog — multi-question (question tab)", () => {
	it("includes TabBar + PreviewPane + chat row + multi hint", () => {
		const dlg = buildDialog(makeConfig());
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("<TABBAR>");
		expect(joined).toContain("<PREVIEW>");
		expect(joined).toContain("<CHAT_ROW>");
		expect(joined).toContain(HINT_MULTI);
	});

	// Inner header (the `selectedBg` ` H1 ` badge) is intentionally suppressed in multi mode —
	// the tab bar already shows the per-tab header, so rendering it again created a chrome-
	// height surplus that made the Submit Tab look collapsed.
	it("does NOT render the inner header badge inside the dialog body in multi-question mode", () => {
		const dlg = buildDialog(makeConfig());
		const lines = dlg.render(80);
		// The inner header was rendered via theme.bg("selectedBg", ` H1 `). Headers are still
		// available via the tab bar (which our stub joins as `<TABBAR>`).
		const innerHeaderBadge = lines.some((l) => l.includes(" H1 ") && !l.includes("<TABBAR>"));
		expect(innerHeaderBadge).toBe(false);
	});

	it("appends 'Space toggle' suffix when current question is multiSelect", () => {
		const multiQ: QuestionData = {
			question: "areas?",
			header: "Areas",
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
			],
		};
		const initialState: DialogState = {
			currentTab: 0,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers: new Map(),
			multiSelectChecked: new Set(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const mso = new MultiSelectOptions(theme, multiQ, initialState);
		const dlg = buildDialog(
			makeConfig({
				questions: [
					multiQ,
					{
						question: "second?",
						header: "S",
						options: [
							{ label: "x", description: "x" },
							{ label: "y", description: "y" },
						],
					},
				],
				state: initialState,
				multiSelectOptionsByTab: [mso, undefined],
				getBodyHeight: () => 4,
			}),
		);
		const joined = dlg.render(120).join("\n");
		expect(joined).toContain(HINT_MULTISELECT_SUFFIX.trim());
	});

	it("appends 'n for notes' when focused option carries a preview", () => {
		const answer: QuestionAnswer = { questionIndex: 0, question: "Q1?", answer: "A" };
		const dlg = buildDialog(
			makeConfig({
				state: {
					currentTab: 0,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers: new Map([[0, answer]]),
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: true,
					submitChoiceIndex: 0,
				},
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(HINT_NOTES_SUFFIX.trim());
	});

	it("notesVisible adds the notes Input below the preview (line count grows)", () => {
		const hidden = buildDialog(makeConfig()).render(80);
		const visibleCfg = makeConfig({
			state: {
				currentTab: 0,
				optionIndex: 0,
				notesVisible: true,
				inputMode: false,
				answers: new Map(),
				multiSelectChecked: new Set(),
				focusedOptionHasPreview: false,
				submitChoiceIndex: 0,
			},
		});
		const visible = buildDialog(visibleCfg).render(80);
		expect(visible.length).toBeGreaterThan(hidden.length);
		expect(visible.join("\n")).toContain("<NOTES_INPUT>");
		expect(hidden.join("\n")).not.toContain("<NOTES_INPUT>");
	});

	it("renders multiSelect checkboxes inline ([✔] / [ ]) in place of PreviewPane", () => {
		const multiQ: QuestionData = {
			question: "areas?",
			header: "Areas",
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
			],
		};
		const state: DialogState = {
			currentTab: 0,
			optionIndex: 1,
			notesVisible: false,
			inputMode: false,
			answers: new Map(),
			multiSelectChecked: new Set([0]),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const mso = new MultiSelectOptions(theme, multiQ, state);
		const dlg = buildDialog(
			makeConfig({
				questions: [
					multiQ,
					{
						question: "q?",
						header: "Q",
						options: [
							{ label: "a", description: "a" },
							{ label: "b", description: "b" },
						],
					},
				],
				state,
				multiSelectOptionsByTab: [mso, undefined],
				getBodyHeight: () => 4,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("[✔]");
		expect(joined).toContain("[ ]");
		expect(joined).not.toContain("<PREVIEW>");
	});
});

describe("buildDialog — Submit tab", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", answer: null, selected: ["X", "Y"] }],
	]);

	function makePicker(state: DialogState, focused = true): SubmitPicker {
		const picker = new SubmitPicker(theme, state);
		picker.setFocused(focused);
		return picker;
	}

	function submitState(over: Partial<DialogState> = {}): DialogState {
		return {
			currentTab: 2,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers,
			multiSelectChecked: new Set(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
			...over,
		};
	}

	it("renders REVIEW_HEADING always", () => {
		const state = submitState();
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		expect(dlg.render(80).join("\n")).toContain(REVIEW_HEADING);
	});

	it("renders bullet+arrow summary for answered questions", () => {
		const state = submitState();
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("● H1");
		expect(joined).toContain("→");
		expect(joined).toContain("A");
		expect(joined).toContain("● H2");
		expect(joined).toContain("X, Y");
	});

	it("omits unanswered rows from summary (no ✖)", () => {
		const partial = new Map<number, QuestionAnswer>([[0, { questionIndex: 0, question: "Q1?", answer: "A" }]]);
		const state = submitState({ answers: partial });
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state, false), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("✖");
		expect(joined).not.toContain("unanswered");
		expect(joined).toContain("● H1");
		expect(joined).not.toContain("● H2");
	});

	it("shows READY_PROMPT when complete", () => {
		const state = submitState();
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		expect(dlg.render(80).join("\n")).toContain(READY_PROMPT);
	});

	it("shows INCOMPLETE_WARNING_PREFIX + missing labels when incomplete", () => {
		const partial = new Map<number, QuestionAnswer>([[0, { questionIndex: 0, question: "Q1?", answer: "A" }]]);
		const state = submitState({ answers: partial });
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state, false), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(INCOMPLETE_WARNING_PREFIX);
		expect(joined).toContain("H2");
		expect(joined).not.toContain(READY_PROMPT);
	});

	it("renders SubmitPicker rows (1. Submit answers / 2. Cancel)", () => {
		const state = submitState();
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(SUBMIT_LABEL);
		expect(joined).toContain(CANCEL_LABEL);
	});

	it("Submit row renders normal regardless of completeness (D1 revised)", () => {
		const incomplete = submitState({
			answers: new Map([[0, { questionIndex: 0, question: "Q1?", answer: "A" }]]),
		});
		const dlgIncomplete = buildDialog(
			makeConfig({ state: incomplete, submitPicker: makePicker(incomplete), getBodyHeight: () => 6 }),
		);
		const joinedIncomplete = dlgIncomplete.render(80).join("\n");
		const submitLine = joinedIncomplete.split("\n").find((l) => l.includes(SUBMIT_LABEL));
		expect(submitLine).not.toMatch(/<dim>/i);
	});

	it("active pointer follows state.submitChoiceIndex", () => {
		const stateRow0 = submitState({ submitChoiceIndex: 0 });
		const dlg0 = buildDialog(
			makeConfig({ state: stateRow0, submitPicker: makePicker(stateRow0), getBodyHeight: () => 6 }),
		);
		const joined0 = dlg0.render(80).join("\n");
		const submitLine0 = joined0.split("\n").find((l) => l.includes(SUBMIT_LABEL));
		const cancelLine0 = joined0.split("\n").find((l) => l.includes(CANCEL_LABEL));
		expect(submitLine0).toContain("❯");
		expect(cancelLine0).not.toContain("❯");

		const stateRow1 = submitState({ submitChoiceIndex: 1 });
		const dlg1 = buildDialog(
			makeConfig({ state: stateRow1, submitPicker: makePicker(stateRow1), getBodyHeight: () => 6 }),
		);
		const joined1 = dlg1.render(80).join("\n");
		const submitLine1 = joined1.split("\n").find((l) => l.includes(SUBMIT_LABEL));
		const cancelLine1 = joined1.split("\n").find((l) => l.includes(CANCEL_LABEL));
		expect(submitLine1).not.toContain("❯");
		expect(cancelLine1).toContain("❯");
	});

	it("does NOT render the chat row or HINT_MULTI on Submit Tab (regression)", () => {
		const state = submitState();
		const dlg = buildDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("<CHAT_ROW>");
		expect(joined).not.toContain(HINT_MULTI);
	});

	it.each<[string, ReturnType<typeof makeConfig>["questions"]]>([
		["both with headers", undefined as never],
		[
			"both with short single-char headers",
			[
				{
					question: "Q1?",
					header: "1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			],
		],
		[
			"mixed: tab 0 short header, tab 1 longer header",
			[
				{
					question: "Q1?",
					header: "1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			],
		],
	])("submit + question tab heights stay equal across fixtures: %s", (_label, qs) => {
		const questions = qs ?? undefined;
		const submitS = submitState();
		const submitDlg = buildDialog(
			makeConfig({
				questions,
				state: submitS,
				submitPicker: makePicker(submitS),
				getBodyHeight: () => 6,
			}),
		).render(120);
		const questionDlg = buildDialog(
			makeConfig({
				questions,
				state: submitState({ currentTab: 0 }),
				getBodyHeight: () => 6,
			}),
		).render(120);
		expect(submitDlg.length).toBe(questionDlg.length);
	});

	it("total dialog height equals a question tab's height (no collapse / no jump)", () => {
		const submitS = submitState();
		const submit = buildDialog(
			makeConfig({ state: submitS, submitPicker: makePicker(submitS), getBodyHeight: () => 6 }),
		).render(120);
		const questionTab = buildDialog(
			makeConfig({ state: submitState({ currentTab: 0 }), getBodyHeight: () => 6 }),
		).render(120);
		expect(submit.length).toBe(questionTab.length);
	});
});

describe("buildDialog — setPreviewPane swap", () => {
	it("setPreviewPane replaces the rendered pane on subsequent render() calls", () => {
		const paneA = stubComponent(["<PANE_A>"]) as unknown as PreviewPane;
		const paneB = stubComponent(["<PANE_B>"]) as unknown as PreviewPane;
		const dlg = buildDialog(makeConfig({ previewPane: paneA }));
		expect(dlg.render(80).join("\n")).toContain("<PANE_A>");
		dlg.setPreviewPane(paneB);
		expect(dlg.render(80).join("\n")).toContain("<PANE_B>");
		expect(dlg.render(80).join("\n")).not.toContain("<PANE_A>");
	});
});

describe("buildDialog — width safety", () => {
	it("every emitted line satisfies visibleWidth(line) <= width across all modes", () => {
		for (const w of [60, 80, 120]) {
			for (const ct of [0, 1, 2]) {
				const dlg = buildDialog(
					makeConfig({
						state: {
							currentTab: ct,
							optionIndex: 0,
							notesVisible: ct === 0,
							inputMode: false,
							answers: new Map([[0, { questionIndex: 0, question: "q", answer: "A" }]]),
							multiSelectChecked: new Set(),
							focusedOptionHasPreview: false,
							submitChoiceIndex: 0,
						},
					}),
				);
				for (const line of dlg.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}
	});
});

describe("buildDialog — body residual padding", () => {
	it("dialog total grows by (getBodyHeight delta) when getCurrentBodyHeight stays constant", () => {
		// Body renders at natural height (1 line for the stub); residual spacer absorbs
		// `getBodyHeight - getCurrentBodyHeight`. Doubling getBodyHeight should grow the dialog
		// by exactly that delta as long as getCurrentBodyHeight is held constant.
		const a = buildDialog(makeConfig({ getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 })).render(80);
		const b = buildDialog(makeConfig({ getBodyHeight: () => 20, getCurrentBodyHeight: () => 1 })).render(80);
		expect(b.length - a.length).toBe(15);
	});

	it("residual rows live AFTER the controls hint (very bottom of the dialog)", () => {
		// Body stub = 1 row "<PREVIEW>"; residual = 5 rows. Footer order is:
		//   <bottom border> · Spacer · <CHAT_ROW> · Spacer · hint · <5 residual blanks>
		const lines = buildDialog(makeConfig({ getBodyHeight: () => 6, getCurrentBodyHeight: () => 1 })).render(80);
		const chatIdx = lines.findIndex((l) => l.includes("<CHAT_ROW>"));
		const hintIdx = lines.findIndex((l) => l.includes(HINT_MULTI));
		expect(chatIdx).toBeGreaterThan(0);
		expect(hintIdx).toBeGreaterThan(chatIdx);
		// Everything after the hint should be empty residual rows. Tail length === residual size (5).
		const tail = lines.slice(hintIdx + 1);
		expect(tail.length).toBe(5);
		expect(tail.every((l) => l.trim() === "")).toBe(true);
		// And there must NOT be a long blank gap between the bottom border and the chat row.
		// The footer should sit immediately after the bottom border with a single Spacer in between.
		const previewIdx = lines.findIndex((l) => l.includes("<PREVIEW>"));
		const between = lines.slice(previewIdx + 1, chatIdx);
		const blanksBetween = between.filter((l) => l.trim() === "").length;
		expect(blanksBetween).toBeLessThanOrEqual(2); // bottom-border row is non-blank; ≤2 spacers.
	});

	it("dialog total line count is identical across tab switches with mixed single/multi fixture", () => {
		// Both questions have headers (symmetric header block) and we render at width 120 so neither
		// hint string wraps (HINT_MULTI ~56 chars; HINT_MULTI + HINT_MULTISELECT_SUFFIX ~87 chars).
		const multiQ: QuestionData = {
			question: "areas?",
			header: "H2",
			multiSelect: true,
			options: [
				{ label: "FE", description: "FE" },
				{ label: "BE", description: "BE" },
				{ label: "DB", description: "DB" },
				{ label: "QA", description: "QA" },
				{ label: "Ops", description: "Ops" },
			],
		};
		const singleQ: QuestionData = {
			question: "Q1",
			header: "H1",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		};
		const questions: QuestionData[] = [singleQ, multiQ];
		const stateTab0: DialogState = {
			currentTab: 0,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers: new Map(),
			multiSelectChecked: new Set(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const stateTab1: DialogState = { ...stateTab0, currentTab: 1 };
		const mso = new MultiSelectOptions(theme, multiQ, stateTab0);
		const multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined> = [undefined, mso];
		// Drive getBodyHeight off the actual worst-case body height so the residual fully
		// absorbs the difference on shorter tabs (mirrors `computeGlobalContentHeight` in
		// ask-user-question.ts).
		const getBodyHeight = (w: number) => Math.max(1, (mso as unknown as Component).render(w).length);

		const dlgTab0 = buildDialog(makeConfig({ questions, state: stateTab0, multiSelectOptionsByTab, getBodyHeight }));
		const dlgTab1 = buildDialog(makeConfig({ questions, state: stateTab1, multiSelectOptionsByTab, getBodyHeight }));
		expect(dlgTab0.render(120).length).toBe(dlgTab1.render(120).length);
	});
});

describe("buildDialog — chatList focus visual", () => {
	it("chatList shows active ❯ pointer when setFocused(true); inactive when setFocused(false)", () => {
		const chatList = new WrappingSelect([{ label: "Chat about this", isChat: true }], 1, {
			selectedText: (t) => t,
			description: (t) => t,
			scrollInfo: (t) => t,
		});

		chatList.setFocused(true);
		const focused = buildDialog(makeConfig({ chatList })).render(80);
		const focusedChatLine = focused.find((l) => l.includes("Chat about this"));
		expect(focusedChatLine).toBeDefined();
		expect(focusedChatLine?.includes("❯ ")).toBe(true);

		chatList.setFocused(false);
		const blurred = buildDialog(makeConfig({ chatList })).render(80);
		const blurredChatLine = blurred.find((l) => l.includes("Chat about this"));
		expect(blurredChatLine).toBeDefined();
		expect(blurredChatLine?.includes("❯ ")).toBe(false);
	});
});
