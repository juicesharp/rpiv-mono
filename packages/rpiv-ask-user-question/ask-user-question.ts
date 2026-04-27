import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { getKeybindings, Input } from "@mariozechner/pi-tui";
import { buildDialog, type DialogState } from "./dialog-builder.js";
import { handleQuestionnaireInput, type QuestionnaireDispatchState } from "./dispatch.js";
import { MultiSelectOptions } from "./multi-select-options.js";
import { PreviewPane } from "./preview-pane.js";
import { TabBar } from "./tab-bar.js";
import {
	MAX_QUESTIONS,
	type QuestionAnswer,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./types.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

const TYPE_SOMETHING_LABEL = "Type something.";
const CHAT_ABOUT_THIS_LABEL = "Chat about this";
const DECLINE_MESSAGE = "User declined to answer questions";
const CHAT_CONTINUATION_MESSAGE = "User wants to chat about this. Continue the conversation to help them decide.";
const NO_INPUT_PLACEHOLDER = "(no input)";
const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";
const ERROR_NO_OPTIONS = "Error: One or more questions have no options";
const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
const ERROR_NO_QUESTIONS = "Error: At least one question is required";

const BACKSPACE_CHARS = new Set(["\x7f", "\b"]);
const ESC_SEQUENCE_PREFIX = "\x1b";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items = question.options.map((o) => ({ label: o.label, description: o.description }));
	if (question.multiSelect) return items;
	return [...items, { label: TYPE_SOMETHING_LABEL, isOther: true }];
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more structured questions. Use when you need user input to proceed — " +
			"choosing between approaches, confirming scope, resolving ambiguities. Each question can be " +
			"single-select (one answer), multi-select (checkbox-style), or include a side-by-side markdown " +
			"`preview` per option. The user can also type a custom answer or chat about a question.",
		promptSnippet:
			"Ask the user one or more structured questions when requirements are ambiguous (1–4 questions per call)",
		promptGuidelines: [
			"Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions in a single invocation.",
			"Each question MUST have at least one option; the user can also type a custom answer (sentinel option auto-appended) or pick 'Chat about this' to switch to free-form conversation.",
			"Set `multiSelect: true` on a question when multiple answers are valid. Provide an `options[].preview` markdown string when an option deserves richer side-by-side context (Architecture / scope-trade-off questions).",
			"This replaces the AskUserQuestion tool from Claude Code. Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation when possible.",
		],
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
			if (typed.questions.length === 0)
				return buildToolResult(ERROR_NO_QUESTIONS, { answers: [], cancelled: true, error: "no_questions" });
			if (typed.questions.length > MAX_QUESTIONS)
				return buildToolResult(ERROR_TOO_MANY_QUESTIONS, {
					answers: [],
					cancelled: true,
					error: "too_many_questions",
				});
			for (const q of typed.questions) {
				if (q.options.length === 0)
					return buildToolResult(ERROR_NO_OPTIONS, { answers: [], cancelled: true, error: "empty_options" });
			}

			const questions = typed.questions;
			const isMulti = questions.length > 1;
			const itemsByTab: WrappingSelectItem[][] = questions.map((q) => buildItemsForQuestion(q));

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				const selectTheme: WrappingSelectTheme = {
					selectedText: (t) => theme.fg("accent", theme.bold(t)),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
				};
				// Chat row lives in its own one-item WrappingSelect. Its `numberStartOffset` /
				// `totalItemsForNumbering` are updated on every tab switch (see `applySelection` below)
				// so the chat row renders as `(N+1). Chat about this`, where N is the active tab's
				// items.length — i.e. continuous numbering across the divider, never a stale `1.`.
				const chatList = new WrappingSelect([{ label: CHAT_ABOUT_THIS_LABEL, isChat: true }], 1, selectTheme);
				const notesInput = new Input();
				const markdownTheme = getMarkdownTheme();
				const getTerminalWidth = () => tui.terminal.columns;

				const previewPanes: PreviewPane[] = questions.map(
					(q, i) =>
						new PreviewPane({
							items: itemsByTab[i],
							question: q,
							theme,
							markdownTheme,
							getTerminalWidth,
						}),
				);

				const initialDialogState: DialogState = {
					currentTab: 0,
					optionIndex: 0,
					notesVisible: false,
					inputMode: false,
					answers: new Map(),
					multiSelectChecked: new Set(),
				};
				const multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined> = questions.map((q) =>
					q.multiSelect ? new MultiSelectOptions(theme, q, initialDialogState) : undefined,
				);

				const tabBar: TabBar | undefined = isMulti
					? new TabBar(
							{
								questions,
								answers: new Map(),
								activeTabIndex: 0,
								totalTabs: questions.length + 1,
							},
							theme,
						)
					: undefined;

				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let notesMode = false;
				let chatFocused = false;
				const answers = new Map<number, QuestionAnswer>();
				let multiSelectChecked = new Set<number>();

				const items = (): WrappingSelectItem[] => itemsByTab[currentTab] ?? [];
				const currentItem = (): WrappingSelectItem | undefined => {
					if (chatFocused) return { label: CHAT_ABOUT_THIS_LABEL, isChat: true };
					const arr = items();
					if (optionIndex < arr.length) return arr[optionIndex];
					return { label: CHAT_ABOUT_THIS_LABEL, isChat: true };
				};

				function snapshotState(): DialogState {
					return {
						currentTab,
						optionIndex,
						notesVisible: notesMode,
						inputMode,
						answers: new Map(answers),
						multiSelectChecked: new Set(multiSelectChecked),
					};
				}

				function computeGlobalContentHeight(width: number): number {
					let max = 0;
					for (let i = 0; i < questions.length; i++) {
						const q = questions[i];
						const h = q?.multiSelect
							? (multiSelectOptionsByTab[i]?.naturalHeight(width) ?? 0)
							: (previewPanes[i]?.naturalHeight(width) ?? 0);
						if (h > max) max = h;
					}
					return Math.max(1, max);
				}

				const dialog = buildDialog({
					theme,
					questions,
					state: snapshotState(),
					previewPane: previewPanes[0],
					tabBar,
					notesInput,
					chatList,
					isMulti,
					multiSelectOptionsByTab,
					getBodyHeight: (w) => computeGlobalContentHeight(w),
				});

				const component = {
					render: (w: number) => dialog.render(w),
					invalidate: () => dialog.invalidate(),
					handleInput: (data: string) => onInput(data),
				};

				function refreshDialog() {
					dialog.setState(snapshotState());
					applySelection();
					tui.requestRender();
				}

				function applySelection() {
					const pane = previewPanes[Math.min(currentTab, questions.length - 1)] ?? previewPanes[0];
					pane.setSelectedIndex(optionIndex);
					const optionsFocused = !notesMode && !chatFocused;
					pane.setFocused(optionsFocused);
					// Mirror focus into the multi-select renderer too, otherwise its active-row pointer
					// stays drawn while the user is on the chat row / notes input, producing a doubled
					// cursor (`❯ ☑  HTMX` AND `❯ Chat about this` lit at the same time).
					for (const mso of multiSelectOptionsByTab) mso?.setFocused(optionsFocused);
					chatList.setFocused(chatFocused);
					// Keep the chat row's number aligned with whichever tab is active. The chat row
					// is always the (last + 1) entry in the logical numbering for that tab.
					const activeTabItems = itemsByTab[Math.min(currentTab, questions.length - 1)] ?? [];
					chatList.setNumbering(activeTabItems.length, activeTabItems.length + 1);
					// Multi-select option rows show a checkbox instead of a number, so the chat row
					// must hide its `N. ` prefix on those tabs to match the un-numbered visual rhythm.
					const activeQuestion = questions[Math.min(currentTab, questions.length - 1)];
					chatList.setShowNumbering(activeQuestion?.multiSelect !== true);
					if (tabBar) {
						tabBar.setConfig({
							questions,
							answers: new Map(answers),
							activeTabIndex: currentTab,
							totalTabs: questions.length + 1,
						});
					}
				}

				function syncMultiSelectFromAnswers() {
					const q = questions[currentTab];
					if (!q?.multiSelect) {
						multiSelectChecked = new Set();
						return;
					}
					const saved = answers.get(currentTab);
					const labels = saved?.selected ?? [];
					const indices = new Set<number>();
					for (let i = 0; i < q.options.length; i++) {
						if (labels.includes(q.options[i].label)) indices.add(i);
					}
					multiSelectChecked = indices;
				}

				function switchTab(nextTab: number) {
					currentTab = nextTab;
					optionIndex = 0;
					inputMode = false;
					notesMode = false;
					chatFocused = false;
					notesInput.focused = false;
					notesInput.setValue(answers.get(currentTab)?.notes ?? "");
					syncMultiSelectFromAnswers();
					const paneIndex = Math.min(currentTab, questions.length - 1);
					const nextPane = previewPanes[paneIndex] ?? previewPanes[0];
					dialog.setPreviewPane(nextPane);
					dialog.setState(snapshotState());
					refreshDialog();
				}

				function submitFinal() {
					done({ answers: orderedAnswers(), cancelled: false });
				}

				function cancel() {
					done({ answers: orderedAnswers(), cancelled: true });
				}

				function orderedAnswers(): QuestionAnswer[] {
					const out: QuestionAnswer[] = [];
					for (let i = 0; i < questions.length; i++) {
						const a = answers.get(i);
						if (a) out.push(a);
					}
					return out;
				}

				function onInput(data: string) {
					if (notesMode) {
						const preAction = handleQuestionnaireInput(data, dispatchSnapshot());
						if (preAction.kind === "notes_exit") {
							commitNotes();
							notesMode = false;
							notesInput.focused = false;
							refreshDialog();
							return;
						}
						notesInput.handleInput(data);
						tui.requestRender();
						return;
					}

					const action = handleQuestionnaireInput(data, dispatchSnapshot());
					switch (action.kind) {
						case "nav":
							optionIndex = action.nextIndex;
							inputMode = !!currentItem()?.isOther;
							if (!inputMode) {
								previewPanes[currentTab]?.clearInputBuffer();
							}
							refreshDialog();
							return;
						case "tab_switch":
							switchTab(action.nextTab);
							return;
						case "confirm":
							answers.set(action.answer.questionIndex, action.answer);
							if (action.autoAdvanceTab !== undefined) {
								switchTab(action.autoAdvanceTab);
							} else {
								submitFinal();
							}
							return;
						case "toggle":
							if (multiSelectChecked.has(action.index)) multiSelectChecked.delete(action.index);
							else multiSelectChecked.add(action.index);
							refreshDialog();
							return;
						case "multi_confirm": {
							const q = questions[currentTab];
							if (!q) return;
							answers.set(currentTab, {
								questionIndex: currentTab,
								question: q.question,
								answer: null,
								selected: action.selected,
							});
							syncMultiSelectFromAnswers();
							// Mirror the single-select `confirm` lifecycle: advance to the next tab in
							// multi-question mode, OR submit the dialog in single-question mode
							// (autoAdvanceTab === undefined when !isMulti).
							if (action.autoAdvanceTab !== undefined) {
								switchTab(action.autoAdvanceTab);
							} else {
								submitFinal();
							}
							return;
						}
						case "cancel":
							cancel();
							return;
						case "notes_enter":
							notesMode = true;
							notesInput.focused = true;
							notesInput.setValue(answers.get(currentTab)?.notes ?? "");
							refreshDialog();
							return;
						case "notes_exit":
							commitNotes();
							notesMode = false;
							notesInput.focused = false;
							refreshDialog();
							return;
						case "focus_chat":
							chatFocused = true;
							refreshDialog();
							return;
						case "focus_options":
							chatFocused = false;
							refreshDialog();
							return;
						case "submit":
							submitFinal();
							return;
						case "ignore":
							if (inputMode) {
								const pane = previewPanes[currentTab];
								if (!pane) return;
								if (BACKSPACE_CHARS.has(data)) {
									pane.backspaceInput();
									tui.requestRender();
								} else if (data && !data.startsWith(ESC_SEQUENCE_PREFIX)) {
									pane.appendInput(data);
									tui.requestRender();
								}
							}
							return;
					}
				}

				function commitNotes() {
					const trimmed = notesInput.getValue().trim();
					const q = questions[currentTab];
					if (!q) return;
					const prev = answers.get(currentTab);
					if (!prev) return;
					const next: QuestionAnswer = trimmed.length > 0 ? { ...prev, notes: trimmed } : { ...prev };
					if (trimmed.length === 0 && "notes" in next) delete (next as { notes?: string }).notes;
					answers.set(currentTab, next);
				}

				function dispatchSnapshot(): QuestionnaireDispatchState {
					return {
						currentTab,
						optionIndex,
						inputMode,
						notesMode,
						chatFocused,
						answers,
						multiSelectIndices: multiSelectChecked,
						questions,
						isMulti,
						keybindings: getKeybindings(),
						currentItem: currentItem(),
						inputBuffer: previewPanes[currentTab]?.getInputBuffer() ?? "",
						items: items(),
					};
				}

				applySelection();
				dialog.setState(snapshotState());
				return component;
			});

			return buildQuestionnaireResponse(result, typed);
		},
	});
}

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
		});
	}
	const lines: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (!a) continue;
		const header = params.questions[i].header;
		const label = header && header.length > 0 ? header : `Q${i + 1}`;
		lines.push(`${label}: ${formatAnswerText(a)}`);
	}
	if (lines.length === 0) return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	return buildToolResult(lines.join("\n"), result);
}

function formatAnswerText(a: QuestionAnswer): string {
	if (a.wasChat) return CHAT_CONTINUATION_MESSAGE;
	if (a.selected && a.selected.length > 0) return `User selected: ${a.selected.join(", ")}`;
	if (a.wasCustom) return `User answered: ${a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER}`;
	return `User selected: ${a.answer ?? NO_INPUT_PLACEHOLDER}`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
