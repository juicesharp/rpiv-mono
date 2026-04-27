import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, type Input, Spacer, Text } from "@mariozechner/pi-tui";
import { FixedHeightBox } from "./fixed-height-box.js";
import type { MultiSelectOptions } from "./multi-select-options.js";
import type { PreviewPane } from "./preview-pane.js";
import type { TabBar } from "./tab-bar.js";
import type { QuestionAnswer, QuestionData } from "./types.js";
import type { WrappingSelect } from "./wrapping-select.js";

// Hint text — these constants are also referenced by tests as substrings of the rendered
// hint line. Keep them as full "contiguous substrings" of the buildHintText() output so the
// `expect(joined).toContain(HINT_*)` assertions remain valid.
//
// Format (per UX spec):
//   <Single>      = "Enter to select · ↑/↓ to navigate · Esc to cancel"
//   <Multi>       = "Enter to select · ↑/↓ to navigate · Tab to switch questions · Esc to cancel"
//   + multiSelect = inserts " · Space to toggle"
//   + answered    = inserts " · n to add notes"
export const HINT_SINGLE = "Enter to select · ↑/↓ to navigate · Esc to cancel";
export const HINT_MULTI = "Enter to select · ↑/↓ to navigate · Tab to switch questions · Esc to cancel";
export const HINT_MULTISELECT_SUFFIX = " · Space to toggle";
export const HINT_NOTES_SUFFIX = " · n to add notes";
export const SUBMIT_READY = "Ready to submit";
export const SUBMIT_HINT_READY = "Enter submit · Esc cancel";
export const SUBMIT_HINT_INCOMPLETE_PREFIX = "Answer remaining questions before submitting:";

export interface DialogState {
	currentTab: number;
	optionIndex: number;
	notesVisible: boolean;
	inputMode: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
}

export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	state: DialogState;
	previewPane: PreviewPane;
	tabBar: TabBar | undefined;
	notesInput: Input;
	chatList: WrappingSelect;
	isMulti: boolean;
	multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined>;
	getBodyHeight: (width: number) => number;
}

export interface DialogComponent extends Component {
	setState(state: DialogState): void;
	setPreviewPane(previewPane: PreviewPane): void;
}

export function buildDialog(config: DialogConfig): DialogComponent {
	let liveConfig: DialogConfig = config;

	const component: DialogComponent = {
		setState(state: DialogState) {
			liveConfig = { ...liveConfig, state };
		},
		setPreviewPane(previewPane: PreviewPane) {
			liveConfig = { ...liveConfig, previewPane };
		},
		handleInput() {},
		invalidate() {
			liveConfig.previewPane.invalidate();
			liveConfig.tabBar?.invalidate();
			liveConfig.notesInput.invalidate();
			liveConfig.chatList.invalidate();
		},
		render(width: number): string[] {
			return renderDialog(liveConfig, width);
		},
	};
	return component;
}

function renderDialog(config: DialogConfig, width: number): string[] {
	const { state, questions, isMulti } = config;
	const onSubmit = isMulti && state.currentTab === questions.length;
	if (onSubmit) {
		return buildSubmitContainer(config).render(width);
	}
	return buildQuestionContainer(config).render(width);
}

/**
 * Submit Tab — shaped to match buildQuestionContainer's chrome line-for-line so the dialog
 * does not collapse / jump in height when the user tab-switches into Submit.
 *
 * Question-tab structure in MULTI mode (the only mode where Submit Tab exists) without notes:
 *   border + tabBar + Spacer + question + Spacer +
 *     FixedHeightBox(body) + Spacer + border + Spacer + chat + Spacer + hint + Spacer
 *
 * (The inner header line is dropped in multi-question mode — the tab bar already shows it,
 * so rendering it again inside the dialog body created a 1–2 line height surplus that made
 * Submit Tab look "collapsed" relative to question tabs.)
 *
 * Submit Tab mirrors that exactly, replacing:
 *   - question text                 → SUBMIT_READY badge (or warning text when missing answers)
 *   - body                          → FixedHeightBox(answer summary, getBodyHeight)
 *   - chat row + bottom hint + tail → 5 empty Spacers ("footer is hidden on Submit Tab")
 */
function buildSubmitContainer(config: DialogConfig): Container {
	const { theme, questions, state, tabBar, isMulti } = config;
	const container = new Container();
	const border = () => new DynamicBorder((s) => theme.fg("accent", s));

	const missing: string[] = [];
	const summary = new Container();
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
		const a = state.answers.get(i);
		if (!a) {
			missing.push(label);
			summary.addChild(new Text(theme.fg("warning", `✖ ${label}: — unanswered`), 1, 0));
			continue;
		}
		const answerText = formatAnswerForSummary(a);
		const line = `${theme.fg("muted", `${label}: `)}${theme.fg("text", answerText)}`;
		summary.addChild(new Text(line, 1, 0));
		if (a.notes && a.notes.length > 0) {
			summary.addChild(new Text(theme.fg("dim", `    notes: ${a.notes}`), 1, 0));
		}
	}

	// Top chrome — mirrors buildQuestionContainer.
	container.addChild(border());
	if (isMulti && tabBar) container.addChild(tabBar);
	container.addChild(new Spacer(1));

	// "Question text"-equivalent line — SUBMIT_READY when complete, warning text when missing.
	const headerText =
		missing.length === 0
			? theme.bold(theme.fg("accent", SUBMIT_READY))
			: theme.fg("warning", `${SUBMIT_HINT_INCOMPLETE_PREFIX} ${missing.join(", ")}`);
	container.addChild(new Text(headerText, 1, 0));
	container.addChild(new Spacer(1));

	// Body — same height contract as the question tabs.
	container.addChild(new FixedHeightBox(summary, config.getBodyHeight));
	container.addChild(new Spacer(1));

	// Bottom border + suppressed footer.
	// Question-tab footer = Spacer + chat + Spacer + hint + Spacer (5 lines). Submit Tab
	// replaces all five with empty Spacers — keeps the dialog height identical without showing
	// the chat row or controls hint.
	container.addChild(border());
	container.addChild(new Spacer(1)); // matches Spacer before chat row
	container.addChild(new Spacer(1)); // matches chat row
	container.addChild(new Spacer(1)); // matches Spacer between chat & hint
	container.addChild(new Spacer(1)); // matches hint line
	container.addChild(new Spacer(1)); // matches trailing post-hint Spacer (#3)
	return container;
}

function buildQuestionContainer(config: DialogConfig): Container {
	const { theme, questions, state, previewPane, tabBar, notesInput, chatList, isMulti } = config;
	const question = questions[state.currentTab];
	const container = new Container();
	const border = () => new DynamicBorder((s) => theme.fg("accent", s));

	container.addChild(border());
	if (isMulti && tabBar) container.addChild(tabBar);
	container.addChild(new Spacer(1));

	// In MULTI-question mode the tab bar already shows the per-tab header (e.g. "H1", "H2"),
	// so rendering it again inside the dialog body adds 2 redundant lines that make the
	// Submit Tab look "collapsed" by comparison. Skip the inner header in multi mode.
	if (!isMulti && question?.header && question.header.length > 0) {
		container.addChild(new Text(theme.bg("selectedBg", ` ${question.header} `), 1, 0));
		container.addChild(new Spacer(1));
	}
	if (question) {
		container.addChild(new Text(theme.bold(question.question), 1, 0));
		container.addChild(new Spacer(1));
	}

	const mso = config.multiSelectOptionsByTab[state.currentTab];
	if (question?.multiSelect === true && mso) {
		mso.setState(state);
		container.addChild(new FixedHeightBox(mso, config.getBodyHeight));
	} else {
		container.addChild(new FixedHeightBox(previewPane, config.getBodyHeight));
	}
	container.addChild(new Spacer(1));

	if (state.notesVisible) {
		container.addChild(new Text(theme.fg("muted", "Notes:"), 1, 0));
		container.addChild(notesInput);
		container.addChild(new Spacer(1));
	}

	container.addChild(border());
	// Footer per spec: blank line, then chat row, then blank line, then controls hint, then
	// one trailing blank line below the controls (visual breathing room).
	container.addChild(new Spacer(1));
	container.addChild(chatList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", buildHintText(question, isMulti, state)), 1, 0));
	container.addChild(new Spacer(1));
	return container;
}

/**
 * Build the controls hint line. Order is fixed so HINT_SINGLE / HINT_MULTI remain contiguous
 * substrings of the rendered output:
 *
 *   Enter to select · ↑/↓ to navigate                                 (← HINT_SINGLE prefix)
 *     [· Space to toggle]                                              (multiSelect only)
 *     [· n to add notes]                                               (single-select + answered)
 *     [· Tab to switch questions]                                      (multi-question only)
 *   · Esc to cancel
 */
function buildHintText(question: QuestionData | undefined, isMulti: boolean, state: DialogState): string {
	const parts: string[] = ["Enter to select", "↑/↓ to navigate"];
	if (question?.multiSelect === true) parts.push("Space to toggle");
	if (question && question.multiSelect !== true && state.answers.has(state.currentTab) && !state.notesVisible) {
		parts.push("n to add notes");
	}
	if (isMulti) parts.push("Tab to switch questions");
	parts.push("Esc to cancel");
	return parts.join(" · ");
}

function formatAnswerForSummary(a: QuestionAnswer): string {
	if (a.wasChat) return "User wants to chat about this";
	if (a.selected && a.selected.length > 0) return a.selected.join(", ");
	if (a.wasCustom) return a.answer ?? "(no input)";
	return a.answer ?? "(no answer)";
}
