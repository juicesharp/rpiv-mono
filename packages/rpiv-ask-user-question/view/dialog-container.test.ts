import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Input } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import {
	makeMultiSelectPropsFromState as msoPropsFromState,
	makeSubmitPickerPropsFromState as submitPickerPropsFromState,
} from "../test-fixtures.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import { ChatRowView } from "./components/chat-row-view.js";
import { MultiSelectView } from "./components/multi-select-view.js";
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import { CANCEL_LABEL, SUBMIT_LABEL, SubmitPicker } from "./components/submit-picker.js";
import type { TabBar } from "./components/tab-bar.js";
import type { WrappingSelectTheme } from "./components/wrapping-select.js";
import {
	type DialogConfig,
	type DialogProps,
	type DialogState,
	DialogView,
	HINT_MULTI,
	HINT_MULTISELECT_SUFFIX,
	HINT_NOTES_SUFFIX,
	HINT_SINGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.js";
import type { TabComponents } from "./tab-components.js";

const theme = makeTheme() as unknown as Theme;

function stubComponent(lines: string[]): Component {
	return {
		render: () => lines,
		handleInput() {},
		invalidate() {},
	};
}

function stubOptionList(): OptionListView {
	return stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView;
}

type MakeConfigOverrides = Partial<Omit<DialogConfig, "chatRow" | "tabsByIndex">> & {
	state?: DialogState;
	previewPane?: PreviewPane;
	initialProps?: DialogProps;
	chatList?: DialogConfig["chatRow"];
	tabsByIndex?: ReadonlyArray<TabComponents>;
	multiSelectByTab?: ReadonlyArray<MultiSelectView | undefined>;
};

interface DialogParts {
	config: DialogConfig;
	initialProps: DialogProps;
}

function makeConfig(over: MakeConfigOverrides = {}): DialogParts {
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
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
	};
	const previewPane = over.previewPane ?? (stubComponent(["<PREVIEW>"]) as unknown as PreviewPane);
	const tabsByIndex: ReadonlyArray<TabComponents> =
		over.tabsByIndex ??
		questions.map((_, i) => ({
			optionList: stubOptionList(),
			preview: previewPane,
			multiSelect: over.multiSelectByTab?.[i],
			bodyHeights: () => ({ current: 0, max: 0 }),
		}));
	const config: DialogConfig = {
		theme: over.theme ?? theme,
		questions,
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Input),
		chatRow: over.chatList ?? (stubComponent(["<CHAT_ROW>"]) as unknown as DialogConfig["chatRow"]),
		isMulti: over.isMulti ?? questions.length > 1,
		tabsByIndex,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight:
			over.getCurrentBodyHeight ??
			((w) => {
				const idx = state.currentTab;
				const q = questions[idx];
				const mso = tabsByIndex[idx]?.multiSelect;
				if (q?.multiSelect === true && mso) return (mso as unknown as Component).render(w).length;
				return (previewPane as unknown as Component).render(w).length;
			}),
	};
	const initialProps: DialogProps = over.initialProps ?? { state, activePreviewPane: previewPane };
	return { config, initialProps };
}

function makeDialog(parts: DialogParts): DialogView {
	return new DialogView(parts.config, parts.initialProps);
}

describe("makeDialog — single-question mode", () => {
	it("omits the TabBar entirely", () => {
		const tabBar = stubComponent(["<TABBAR>", ""]) as unknown as TabBar;
		const dlg = makeDialog(
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

	it("renders the inner header badge in the dialog body (no tab bar to show it)", () => {
		const dlg = makeDialog(
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

describe("makeDialog — multi-question (question tab)", () => {
	it("includes TabBar + PreviewPane + chat row + multi hint", () => {
		const dlg = makeDialog(makeConfig());
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("<TABBAR>");
		expect(joined).toContain("<PREVIEW>");
		expect(joined).toContain("<CHAT_ROW>");
		expect(joined).toContain(HINT_MULTI);
	});

	it("does NOT render the inner header badge inside the dialog body in multi-question mode", () => {
		const dlg = makeDialog(makeConfig());
		const lines = dlg.render(80);
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
			chatFocused: false,
			answers: new Map(),
			multiSelectChecked: new Set(),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const mso = new MultiSelectView(theme, multiQ);
		mso.setProps(msoPropsFromState(multiQ, initialState));
		const dlg = makeDialog(
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
				multiSelectByTab: [mso, undefined],
				getBodyHeight: () => 4,
			}),
		);
		const joined = dlg.render(120).join("\n");
		expect(joined).toContain(HINT_MULTISELECT_SUFFIX.trim());
	});

	it("appends 'n for notes' when focused option carries a preview", () => {
		const answer: QuestionAnswer = { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" };
		const dlg = makeDialog(
			makeConfig({
				state: {
					currentTab: 0,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					chatFocused: false,
					answers: new Map([[0, answer]]),
					multiSelectChecked: new Set(),
					notesByTab: new Map(),
					focusedOptionHasPreview: true,
					submitChoiceIndex: 0,
				},
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(HINT_NOTES_SUFFIX.trim());
	});

	it("notesVisible adds the notes Input below the preview (line count grows)", () => {
		const hidden = makeDialog(makeConfig()).render(80);
		const visibleCfg = makeConfig({
			state: {
				currentTab: 0,
				optionIndex: 0,
				notesVisible: true,
				inputMode: false,
				chatFocused: false,
				answers: new Map(),
				multiSelectChecked: new Set(),
				notesByTab: new Map(),
				focusedOptionHasPreview: false,
				submitChoiceIndex: 0,
			},
		});
		const visible = makeDialog(visibleCfg).render(80);
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
			chatFocused: false,
			answers: new Map(),
			multiSelectChecked: new Set([0]),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const mso = new MultiSelectView(theme, multiQ);
		mso.setProps(msoPropsFromState(multiQ, state));
		const dlg = makeDialog(
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
				multiSelectByTab: [mso, undefined],
				getBodyHeight: () => 4,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("[✔]");
		expect(joined).toContain("[ ]");
		expect(joined).not.toContain("<PREVIEW>");
	});
});

describe("makeDialog — Submit tab", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", kind: "multi", answer: null, selected: ["X", "Y"] }],
	]);

	function makePicker(state: DialogState, focused = true): SubmitPicker {
		const picker = new SubmitPicker(theme);
		picker.setProps(submitPickerPropsFromState(state, focused));
		return picker;
	}

	function submitState(over: Partial<DialogState> = {}): DialogState {
		return {
			currentTab: 2,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			chatFocused: false,
			answers,
			multiSelectChecked: new Set(),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
			...over,
		};
	}

	it("renders REVIEW_HEADING always", () => {
		const state = submitState();
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		expect(dlg.render(80).join("\n")).toContain(REVIEW_HEADING);
	});

	it("renders bullet+arrow summary for answered questions", () => {
		const state = submitState();
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain("● H1");
		expect(joined).toContain("→");
		expect(joined).toContain("A");
		expect(joined).toContain("● H2");
		expect(joined).toContain("X, Y");
	});

	it("omits unanswered rows from summary (no ✖)", () => {
		const partial = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		]);
		const state = submitState({ answers: partial });
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state, false), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("✖");
		expect(joined).not.toContain("unanswered");
		expect(joined).toContain("● H1");
		expect(joined).not.toContain("● H2");
	});

	it("shows READY_PROMPT when complete", () => {
		const state = submitState();
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		expect(dlg.render(80).join("\n")).toContain(READY_PROMPT);
	});

	it("shows INCOMPLETE_WARNING_PREFIX + missing labels when incomplete", () => {
		const partial = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		]);
		const state = submitState({ answers: partial });
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state, false), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(INCOMPLETE_WARNING_PREFIX);
		expect(joined).toContain("H2");
		expect(joined).not.toContain(READY_PROMPT);
	});

	it("renders SubmitPicker rows (1. Submit answers / 2. Cancel)", () => {
		const state = submitState();
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(SUBMIT_LABEL);
		expect(joined).toContain(CANCEL_LABEL);
	});

	it("Submit row renders normal regardless of completeness (D1 revised)", () => {
		const incomplete = submitState({
			answers: new Map([[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }]]),
		});
		const dlgIncomplete = makeDialog(
			makeConfig({ state: incomplete, submitPicker: makePicker(incomplete), getBodyHeight: () => 6 }),
		);
		const joinedIncomplete = dlgIncomplete.render(80).join("\n");
		const submitLine = joinedIncomplete.split("\n").find((l) => l.includes(SUBMIT_LABEL));
		expect(submitLine).not.toMatch(/<dim>/i);
	});

	it("active pointer follows state.submitChoiceIndex", () => {
		const stateRow0 = submitState({ submitChoiceIndex: 0 });
		const dlg0 = makeDialog(
			makeConfig({ state: stateRow0, submitPicker: makePicker(stateRow0), getBodyHeight: () => 6 }),
		);
		const joined0 = dlg0.render(80).join("\n");
		const submitLine0 = joined0.split("\n").find((l) => l.includes(SUBMIT_LABEL));
		const cancelLine0 = joined0.split("\n").find((l) => l.includes(CANCEL_LABEL));
		expect(submitLine0).toContain("❯");
		expect(cancelLine0).not.toContain("❯");

		const stateRow1 = submitState({ submitChoiceIndex: 1 });
		const dlg1 = makeDialog(
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
		const dlg = makeDialog(makeConfig({ state, submitPicker: makePicker(state), getBodyHeight: () => 6 }));
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("<CHAT_ROW>");
		expect(joined).not.toContain(HINT_MULTI);
	});

	it.each<[string, ReturnType<typeof makeConfig>["config"]["questions"]]>([
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
		const submitDlg = makeDialog(
			makeConfig({
				questions,
				state: submitS,
				submitPicker: makePicker(submitS),
				getBodyHeight: () => 6,
			}),
		).render(120);
		const questionDlg = makeDialog(
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
		const submit = makeDialog(
			makeConfig({ state: submitS, submitPicker: makePicker(submitS), getBodyHeight: () => 6 }),
		).render(120);
		const questionTab = makeDialog(
			makeConfig({ state: submitState({ currentTab: 0 }), getBodyHeight: () => 6 }),
		).render(120);
		expect(submit.length).toBe(questionTab.length);
	});
});

describe("makeDialog — setProps swap", () => {
	it("setProps replaces the rendered pane on subsequent render() calls", () => {
		const paneA = stubComponent(["<PANE_A>"]) as unknown as PreviewPane;
		const paneB = stubComponent(["<PANE_B>"]) as unknown as PreviewPane;
		const cfg = makeConfig({ previewPane: paneA });
		const dlg = makeDialog(cfg);
		expect(dlg.render(80).join("\n")).toContain("<PANE_A>");
		dlg.setProps({ state: cfg.initialProps.state, activePreviewPane: paneB });
		expect(dlg.render(80).join("\n")).toContain("<PANE_B>");
		expect(dlg.render(80).join("\n")).not.toContain("<PANE_A>");
	});
});

describe("makeDialog — width safety", () => {
	it("every emitted line satisfies visibleWidth(line) <= width across all modes", () => {
		for (const w of [60, 80, 120]) {
			for (const ct of [0, 1, 2]) {
				const dlg = makeDialog(
					makeConfig({
						state: {
							currentTab: ct,
							optionIndex: 0,
							notesVisible: ct === 0,
							inputMode: false,
							chatFocused: false,
							answers: new Map([[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }]]),
							multiSelectChecked: new Set(),
							notesByTab: new Map(),
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

describe("makeDialog — body residual padding", () => {
	it("dialog total grows by (getBodyHeight delta) when getCurrentBodyHeight stays constant", () => {
		const a = makeDialog(makeConfig({ getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 })).render(80);
		const b = makeDialog(makeConfig({ getBodyHeight: () => 20, getCurrentBodyHeight: () => 1 })).render(80);
		expect(b.length - a.length).toBe(15);
	});

	it("residual rows live AFTER the controls hint (very bottom of the dialog)", () => {
		// Residual = (getBodyHeight + maxFooterRowCount) - (currentBodyHeight + footerRowCount)
		//          = (6 + 5) - (1 + 4) = 6
		const lines = makeDialog(makeConfig({ getBodyHeight: () => 6, getCurrentBodyHeight: () => 1 })).render(80);
		const chatIdx = lines.findIndex((l) => l.includes("<CHAT_ROW>"));
		const hintIdx = lines.findIndex((l) => l.includes(HINT_MULTI));
		expect(chatIdx).toBeGreaterThan(0);
		expect(hintIdx).toBeGreaterThan(chatIdx);
		const tail = lines.slice(hintIdx + 1);
		expect(tail.length).toBe(6);
		expect(tail.every((l) => l.trim() === "")).toBe(true);
		const previewIdx = lines.findIndex((l) => l.includes("<PREVIEW>"));
		const between = lines.slice(previewIdx + 1, chatIdx);
		const blanksBetween = between.filter((l) => l.trim() === "").length;
		expect(blanksBetween).toBeLessThanOrEqual(2);
	});

	it("dialog total line count is identical across tab switches with mixed single/multi fixture", () => {
		// Render at width 120 so HINT_MULTI (+ HINT_MULTISELECT_SUFFIX) doesn't wrap on either tab.
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
			chatFocused: false,
			answers: new Map(),
			multiSelectChecked: new Set(),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
		};
		const stateTab1: DialogState = { ...stateTab0, currentTab: 1 };
		const mso = new MultiSelectView(theme, multiQ);
		mso.setProps(msoPropsFromState(multiQ, stateTab0));
		const multiSelectByTab: ReadonlyArray<MultiSelectView | undefined> = [undefined, mso];
		const getBodyHeight = (w: number) => Math.max(1, (mso as unknown as Component).render(w).length);

		const dlgTab0 = makeDialog(makeConfig({ questions, state: stateTab0, multiSelectByTab, getBodyHeight }));
		const dlgTab1 = makeDialog(makeConfig({ questions, state: stateTab1, multiSelectByTab, getBodyHeight }));
		expect(dlgTab0.render(120).length).toBe(dlgTab1.render(120).length);
	});
});

describe("makeDialog — chatRow focus visual", () => {
	it("chatRow shows active ❯ pointer when focused: true; inactive when focused: false", () => {
		const theme: WrappingSelectTheme = {
			selectedText: (t) => t,
			description: (t) => t,
			scrollInfo: (t) => t,
		};
		const focusedChat = new ChatRowView({
			item: { kind: "chat", label: "Chat about this" },
			theme,
		});
		focusedChat.setProps({ focused: true, numbering: { offset: 0, total: 1 } });
		const focused = makeDialog(makeConfig({ chatList: focusedChat })).render(80);
		const focusedChatLine = focused.find((l) => l.includes("Chat about this"));
		expect(focusedChatLine).toBeDefined();
		expect(focusedChatLine?.includes("❯ ")).toBe(true);

		const blurredChat = new ChatRowView({
			item: { kind: "chat", label: "Chat about this" },
			theme,
		});
		blurredChat.setProps({ focused: false, numbering: { offset: 0, total: 1 } });
		const blurred = makeDialog(makeConfig({ chatList: blurredChat })).render(80);
		const blurredChatLine = blurred.find((l) => l.includes("Chat about this"));
		expect(blurredChatLine).toBeDefined();
		expect(blurredChatLine?.includes("❯ ")).toBe(false);
	});
});
