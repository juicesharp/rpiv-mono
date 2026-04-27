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
	SUBMIT_HINT_INCOMPLETE_PREFIX,
	SUBMIT_HINT_READY,
	SUBMIT_READY,
} from "./dialog-builder.js";
import { MultiSelectOptions } from "./multi-select-options.js";
import type { PreviewPane } from "./preview-pane.js";
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
	};
	return {
		theme: over.theme ?? theme,
		questions,
		state,
		previewPane: over.previewPane ?? (stubComponent(["<PREVIEW>"]) as unknown as PreviewPane),
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Input),
		chatList: over.chatList ?? (stubComponent(["<CHAT_ROW>"]) as unknown as WrappingSelect),
		isMulti: over.isMulti ?? questions.length > 1,
		multiSelectOptionsByTab:
			over.multiSelectOptionsByTab ?? questions.map(() => undefined as MultiSelectOptions | undefined),
		getBodyHeight: over.getBodyHeight ?? (() => 1),
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
			},
		});
		const visible = buildDialog(visibleCfg).render(80);
		expect(visible.length).toBeGreaterThan(hidden.length);
		expect(visible.join("\n")).toContain("<NOTES_INPUT>");
		expect(hidden.join("\n")).not.toContain("<NOTES_INPUT>");
	});

	it("renders multiSelect checkboxes inline (☑ / ☐) in place of PreviewPane", () => {
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
		expect(joined).toContain("☑");
		expect(joined).toContain("☐");
		expect(joined).not.toContain("<PREVIEW>");
	});
});

describe("buildDialog — Submit tab", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", answer: null, selected: ["X", "Y"] }],
	]);

	// Submit Tab now wraps its answer summary in FixedHeightBox(getBodyHeight) and structurally
	// mirrors the question-tab chrome line-for-line so the dialog does not collapse / jump when
	// the user switches into Submit. Tests must therefore pass a getBodyHeight large enough to
	// fit the rendered summary lines.
	it("shows the Submit-ready badge + Q→A summary when all answered", () => {
		const dlg = buildDialog(
			makeConfig({
				state: {
					currentTab: 2,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(SUBMIT_READY);
		expect(joined).toContain("H1");
		expect(joined).toContain("A");
		expect(joined).toContain("X, Y");
		// Footer (chat row + controls hint) is suppressed on Submit Tab — SUBMIT_HINT_READY is
		// no longer rendered anywhere.
		expect(joined).not.toContain(SUBMIT_HINT_READY);
	});

	it("warns + names missing questions when not all answered", () => {
		const partial = new Map<number, QuestionAnswer>([[0, { questionIndex: 0, question: "Q1?", answer: "A" }]]);
		const dlg = buildDialog(
			makeConfig({
				state: {
					currentTab: 2,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers: partial,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).toContain(SUBMIT_HINT_INCOMPLETE_PREFIX);
		expect(joined).toContain("H2");
	});

	// New regression: per spec, the Submit Tab must not show the chat row or the controls hint.
	it("does NOT render the chat row or the controls hint on Submit Tab (footer suppressed)", () => {
		const dlg = buildDialog(
			makeConfig({
				state: {
					currentTab: 2,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		);
		const joined = dlg.render(80).join("\n");
		expect(joined).not.toContain("<CHAT_ROW>");
		// HINT_MULTI lives at the bottom of question tabs only.
		expect(joined).not.toContain(HINT_MULTI);
	});

	// New regression: dialog total line count must MATCH a question tab across mixed shapes
	// (with/without headers, single/multi-select, multiple questions). Before the multi-mode
	// inner-header was suppressed, the question tab rendered 2 extra lines for the header
	// badge while Submit Tab did not — hence "submit one line smaller, dialog jumps".
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
		const submitDlg = buildDialog(
			makeConfig({
				questions,
				state: {
					currentTab: 2,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		).render(120);
		const questionDlg = buildDialog(
			makeConfig({
				questions,
				state: {
					currentTab: 0,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		).render(120);
		expect(submitDlg.length).toBe(questionDlg.length);
	});

	// Original simple-equality test (kept for clarity — it covers the default "both with headers" fixture).
	it("total dialog height equals a question tab's height (no collapse / no jump)", () => {
		const submit = buildDialog(
			makeConfig({
				state: {
					currentTab: 2,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
		).render(120);
		const questionTab = buildDialog(
			makeConfig({
				state: {
					currentTab: 0,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers,
					multiSelectChecked: new Set(),
					focusedOptionHasPreview: false,
				},
				getBodyHeight: () => 6,
			}),
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
						},
					}),
				);
				for (const line of dlg.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}
	});
});

describe("buildDialog — FixedHeightBox body wrapping", () => {
	it("body wrapped in FixedHeightBox produces getBodyHeight() lines (delta = expected delta)", () => {
		const a = buildDialog(makeConfig({ getBodyHeight: () => 5 })).render(80);
		const b = buildDialog(makeConfig({ getBodyHeight: () => 20 })).render(80);
		expect(b.length - a.length).toBe(15);
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
		};
		const stateTab1: DialogState = { ...stateTab0, currentTab: 1 };
		const mso = new MultiSelectOptions(theme, multiQ, stateTab0);
		const multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined> = [undefined, mso];
		const getBodyHeight = (_w: number) => 7;

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
