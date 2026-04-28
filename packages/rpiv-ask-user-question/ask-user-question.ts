import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { getKeybindings, Input } from "@mariozechner/pi-tui";
import { buildDialog, type DialogState } from "./dialog-builder.js";
import { handleQuestionnaireInput, type QuestionnaireDispatchState } from "./dispatch.js";
import { MultiSelectOptions } from "./multi-select-options.js";
import { PreviewPane } from "./preview-pane.js";
import { SubmitPicker } from "./submit-picker.js";
import { TabBar } from "./tab-bar.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionAnswer,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
	RESERVED_LABELS,
} from "./types.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

const TYPE_SOMETHING_LABEL = "Type something.";
const CHAT_ABOUT_THIS_LABEL = "Chat about this";
const NEXT_LABEL = "Next";
const DECLINE_MESSAGE = "User declined to answer questions";
const CHAT_CONTINUATION_MESSAGE = "User wants to chat about this. Continue the conversation to help them decide.";
const NO_INPUT_PLACEHOLDER = "(no input)";
const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";
const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
const ERROR_NO_QUESTIONS = "Error: At least one question is required";
const ERROR_DUPLICATE_QUESTION = "Error: Question text must be unique within an invocation";
const ERROR_DUPLICATE_OPTION_LABEL = "Error: Option labels must be unique within a question";
const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`;
const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

const BACKSPACE_CHARS = new Set(["\x7f", "\b"]);
const ESC_SEQUENCE_PREFIX = "\x1b";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items = question.options.map((o) => ({ label: o.label, description: o.description }));
	// Multi-select gets a "Next" sentinel row at the bottom so `Enter` on regular option rows
	// can be repurposed as a per-row toggle (matching `Space`); committing + advancing to the
	// next tab requires moving focus onto the Next row first. Mirrors the `isOther` pattern.
	if (question.multiSelect) return [...items, { label: NEXT_LABEL, isNext: true }];
	// Side-by-side preview layout pins the options column to PREVIEW_LEFT_COLUMN_MAX_WIDTH (~40
	// cols), which truncates inline custom-text input. CC suppresses the row in this layout for
	// the same reason — the "Chat about this" row remains as the free-form escape hatch.
	const hasAnyPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	if (hasAnyPreview) return items;
	return [...items, { label: TYPE_SOMETHING_LABEL, isOther: true }];
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
		promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
		promptGuidelines: [
			`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
			`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
			`Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
			"This replaces the AskUserQuestion tool from Claude Code. Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
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

			const seenQuestions = new Set<string>();
			for (const q of typed.questions) {
				if (seenQuestions.has(q.question)) {
					return buildToolResult(ERROR_DUPLICATE_QUESTION, {
						answers: [],
						cancelled: true,
						error: "duplicate_question",
					});
				}
				seenQuestions.add(q.question);
			}

			for (const q of typed.questions) {
				if (q.options.length < MIN_OPTIONS)
					return buildToolResult(ERROR_TOO_FEW_OPTIONS, {
						answers: [],
						cancelled: true,
						error: "empty_options",
					});
				const seenLabels = new Set<string>();
				for (const o of q.options) {
					if (RESERVED_LABEL_SET.has(o.label)) {
						return buildToolResult(ERROR_RESERVED_LABEL, {
							answers: [],
							cancelled: true,
							error: "reserved_label",
						});
					}
					if (seenLabels.has(o.label)) {
						return buildToolResult(ERROR_DUPLICATE_OPTION_LABEL, {
							answers: [],
							cancelled: true,
							error: "duplicate_option_label",
						});
					}
					seenLabels.add(o.label);
				}
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
					focusedOptionHasPreview: false,
					submitChoiceIndex: 0,
				};
				const multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined> = questions.map((q) =>
					q.multiSelect ? new MultiSelectOptions(theme, q, initialDialogState) : undefined,
				);
				// Submit-tab Submit/Cancel picker. Multi-question only — single-question dialogs
				// have no Submit Tab so the picker is undefined.
				const submitPicker = isMulti ? new SubmitPicker(theme, initialDialogState) : undefined;

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
				let submitChoiceIndex = 0;
				const answers = new Map<number, QuestionAnswer>();
				let multiSelectChecked = new Set<number>();
				// notesByTab: transient pre-answer notes side-map. Decoupled from `answers` so adding notes
				// does NOT make `answers.has(currentTab)` true (otherwise Submit-tab missing-check + allAnswered()
				// would falsely report the question as answered). Merged into the answer at confirm time.
				const notesByTab = new Map<number, string>();

				const items = (): WrappingSelectItem[] => itemsByTab[currentTab] ?? [];
				const currentItem = (): WrappingSelectItem | undefined => {
					if (chatFocused) return { label: CHAT_ABOUT_THIS_LABEL, isChat: true };
					const arr = items();
					if (optionIndex < arr.length) return arr[optionIndex];
					return { label: CHAT_ABOUT_THIS_LABEL, isChat: true };
				};

				// Mode-agnostic: just checks "does the currently-focused option carry a preview?".
				// Mode gates (chat focus, input mode, notes mode, multiSelect) layer on top via
				// existing dispatch branches.
				function computeFocusedOptionHasPreview(): boolean {
					const q = questions[currentTab];
					if (!q) return false;
					const opt = q.options[optionIndex];
					return !!opt && typeof opt.preview === "string" && opt.preview.length > 0;
				}

				function snapshotState(): DialogState {
					return {
						currentTab,
						optionIndex,
						notesVisible: notesMode,
						inputMode,
						answers: new Map(answers),
						multiSelectChecked: new Set(multiSelectChecked),
						focusedOptionHasPreview: computeFocusedOptionHasPreview(),
						submitChoiceIndex,
					};
				}

				// Worst case across all tabs and all options — drives the stable dialog footprint.
				function computeGlobalContentHeight(width: number): number {
					let max = 0;
					for (let i = 0; i < questions.length; i++) {
						const q = questions[i];
						const h = q?.multiSelect
							? (multiSelectOptionsByTab[i]?.naturalHeight(width) ?? 0)
							: (previewPanes[i]?.maxNaturalHeight(width) ?? 0);
						if (h > max) max = h;
					}
					return Math.max(1, max);
				}

				// Body height of the currently-active tab/option — drives the residual spacer
				// so the bordered region hugs the actual content with no internal `""` padding.
				function computeCurrentContentHeight(width: number): number {
					const idx = Math.min(currentTab, questions.length - 1);
					const q = questions[idx];
					if (!q) return 0;
					const h = q.multiSelect
						? (multiSelectOptionsByTab[idx]?.naturalHeight(width) ?? 0)
						: (previewPanes[idx]?.naturalHeight(width) ?? 0);
					return Math.max(0, h);
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
					submitPicker,
					getBodyHeight: (w) => computeGlobalContentHeight(w),
					getCurrentBodyHeight: (w) => computeCurrentContentHeight(w),
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
					pane.setNotesVisible(notesMode);
					// Mirror focus into the multi-select renderer too, otherwise its active-row pointer
					// stays drawn while the user is on the chat row / notes input, producing a doubled
					// cursor (`❯ ☑  HTMX` AND `❯ Chat about this` lit at the same time).
					for (const mso of multiSelectOptionsByTab) mso?.setFocused(optionsFocused);
					chatList.setFocused(chatFocused);
					// Keep the chat row's number aligned with whichever tab is active. The chat row
					// is always the (last + 1) entry in the logical numbering for that tab.
					const activeTabItems = itemsByTab[Math.min(currentTab, questions.length - 1)] ?? [];
					chatList.setNumbering(activeTabItems.length, activeTabItems.length + 1);
					// Multi-select rows now carry their own `N.` numbers (CC parity), so the chat row
					// continues that contiguous numbering on every tab — no special-case suppression.
					chatList.setShowNumbering(true);
					if (submitPicker) {
						submitPicker.setState(snapshotState());
						submitPicker.setFocused(currentTab === questions.length);
					}
					if (tabBar) {
						tabBar.setConfig({
							questions,
							answers: new Map(answers),
							activeTabIndex: currentTab,
							totalTabs: questions.length + 1,
						});
					}
				}

				/**
				 * Mirror the current multi-select toggle state into `answers` so it survives tab
				 * switches and surfaces in the Submit-tab summary even before the user explicitly
				 * commits via `Enter` on the Next sentinel. Called from the `toggle` handler.
				 *
				 * Conventions:
				 * - Non-empty selection → write `{ selected: [labels in option order] }`. Pending
				 *   notes from `notesByTab` are merged in so a tab-away doesn't drop them.
				 * - Empty selection → delete the entry. Distinguishes "I haven't decided yet"
				 *   (no answer) from "I want to commit empty" (Enter on Next, which always writes).
				 */
				function persistMultiSelectAnswer() {
					const q = questions[currentTab];
					if (!q?.multiSelect) return;
					const selected: string[] = [];
					for (let i = 0; i < q.options.length; i++) {
						if (multiSelectChecked.has(i)) selected.push(q.options[i].label);
					}
					if (selected.length === 0) {
						answers.delete(currentTab);
						return;
					}
					const pendingNotes = notesByTab.get(currentTab);
					answers.set(currentTab, {
						questionIndex: currentTab,
						question: q.question,
						answer: null,
						selected,
						...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
					});
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
					submitChoiceIndex = 0;
					notesInput.focused = false;
					notesInput.setValue(notesByTab.get(currentTab) ?? answers.get(currentTab)?.notes ?? "");
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
						case "confirm": {
							let answer = action.answer;
							if (!answer.wasChat && !answer.wasCustom && answer.answer) {
								const q = questions[answer.questionIndex];
								const matched = q?.options.find((o) => o.label === answer.answer);
								if (matched?.preview && matched.preview.length > 0) {
									answer = { ...answer, preview: matched.preview };
								}
							}
							const pendingNotes = notesByTab.get(answer.questionIndex);
							if (pendingNotes && pendingNotes.length > 0) {
								answer = { ...answer, notes: pendingNotes };
							}
							answers.set(answer.questionIndex, answer);
							if (action.autoAdvanceTab !== undefined) {
								switchTab(action.autoAdvanceTab);
							} else {
								submitFinal();
							}
							return;
						}
						case "toggle":
							if (multiSelectChecked.has(action.index)) multiSelectChecked.delete(action.index);
							else multiSelectChecked.add(action.index);
							// Persist on every toggle so tab-switching away (without Enter on Next) doesn't
							// drop the in-progress selection. The Submit-tab summary + tab-back restore both
							// read from `answers`, so this single write keeps both views consistent.
							persistMultiSelectAnswer();
							refreshDialog();
							return;
						case "multi_confirm": {
							const q = questions[currentTab];
							if (!q) return;
							const pendingNotes = notesByTab.get(currentTab);
							answers.set(currentTab, {
								questionIndex: currentTab,
								question: q.question,
								answer: null,
								selected: action.selected,
								...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
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
						case "submit_nav":
							submitChoiceIndex = action.nextIndex;
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
					if (!questions[currentTab]) return;
					if (trimmed.length === 0) {
						notesByTab.delete(currentTab);
						const prev = answers.get(currentTab);
						if (prev?.notes) {
							const next = { ...prev };
							delete (next as { notes?: string }).notes;
							answers.set(currentTab, next);
						}
						return;
					}
					notesByTab.set(currentTab, trimmed);
					const prev = answers.get(currentTab);
					if (prev) answers.set(currentTab, { ...prev, notes: trimmed });
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
						focusedOptionHasPreview: computeFocusedOptionHasPreview(),
						submitChoiceIndex,
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
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (segments.length === 0) return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

function formatAnswerScalar(a: QuestionAnswer): string {
	if (a.wasChat) return CHAT_CONTINUATION_MESSAGE;
	if (a.selected && a.selected.length > 0) return a.selected.join(", ");
	if (a.wasCustom) return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
	return a.answer ?? NO_INPUT_PLACEHOLDER;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
