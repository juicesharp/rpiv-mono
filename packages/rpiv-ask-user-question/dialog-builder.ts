import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, type Input, Spacer, Text } from "@mariozechner/pi-tui";
import { BodyResidualSpacer } from "./body-residual-spacer.js";
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
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

export interface DialogState {
	currentTab: number;
	optionIndex: number;
	notesVisible: boolean;
	inputMode: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/**
	 * True iff the currently-focused option carries a non-empty `preview` string.
	 * Set by `ask-user-question.ts:snapshotState()` via `computeFocusedOptionHasPreview()`.
	 * Gates the "n to add notes" hint chip in `buildHintText()` (Decision 8).
	 */
	focusedOptionHasPreview: boolean;
	/**
	 * Focused row in the Submit-tab picker (0 = Submit answers, 1 = Cancel).
	 * Mirrored from `QuestionnaireDispatchState.submitChoiceIndex`; consumed by
	 * `SubmitPicker.setState` inside `buildSubmitContainer`. Default 0; reset on every tab switch.
	 */
	submitChoiceIndex: number;
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
	/**
	 * Submit-tab Submit/Cancel picker. Optional so the type stays
	 * compatible with single-question mode (no Submit Tab) and with tests that
	 * exercise non-submit code paths. `buildSubmitContainer` falls back to
	 * Spacer rows when undefined.
	 */
	submitPicker?: Component;
	/**
	 * Worst-case body height across all tabs and (for preview tabs) all options.
	 * Determines the stable overall dialog footprint.
	 */
	getBodyHeight: (width: number) => number;
	/**
	 * Body height of the CURRENTLY active tab/option. Subtracted from `getBodyHeight`
	 * by `BodyResidualSpacer` to absorb the height residual OUTSIDE the bordered
	 * region — the body itself renders at its natural height with no internal padding.
	 */
	getCurrentBodyHeight: (width: number) => number;
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
 *     body + Spacer + border + Spacer + chat(1) + Spacer + hint(1) + BodyResidualSpacer
 *
 * Submit Tab mirrors that exactly:
 *   - "question text" line              → REVIEW_HEADING (bold accent, always shown)
 *   - body                              → bullet+arrow summary container (omits unanswered)
 *   - chat row + hint footer            → Spacer(1) + prompt-or-warning(1) + Spacer(1) +
 *                                         submitPicker(2) — 5 lines below the bottom border
 *                                         vs question footer's 4. The extra row is offset by
 *                                         `submitBodyHeight = summary + 1` so total height
 *                                         still matches a question tab's.
 */
function buildSubmitContainer(config: DialogConfig): Container {
	const { theme, questions, state, tabBar, isMulti, submitPicker } = config;
	const container = new Container();
	const border = () => new DynamicBorder((s) => theme.fg("accent", s));

	// Walk questions once: collect missing labels for the warning, build the bullet+arrow
	// summary for answered questions only (CC parity — unanswered rows are omitted; the
	// warning header is the sole signal of incompleteness).
	const missing: string[] = [];
	const summary = new Container();
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
		const a = state.answers.get(i);
		if (!a) {
			missing.push(label);
			continue;
		}
		const answerText = formatAnswerForSummary(a);
		summary.addChild(new Text(theme.fg("muted", ` ● ${label}`), 1, 0));
		summary.addChild(new Text(`   ${theme.fg("muted", "→")} ${theme.fg("text", answerText)}`, 1, 0));
		if (a.notes && a.notes.length > 0) {
			summary.addChild(new Text(theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
		}
	}

	// Top chrome — mirrors buildQuestionContainer.
	container.addChild(border());
	if (isMulti && tabBar) container.addChild(tabBar);
	container.addChild(new Spacer(1));

	// Heading — always shown.
	container.addChild(new Text(theme.bold(theme.fg("accent", REVIEW_HEADING)), 1, 0));
	container.addChild(new Spacer(1));

	// Body — bullet+arrow summary at natural height; residual absorbed below the bottom
	// border by BodyResidualSpacer (mirrors buildQuestionContainer).
	container.addChild(summary);
	container.addChild(new Spacer(1));

	// Bottom border + chrome-mirror layout. Below-border lines:
	//   Spacer(1) + prompt-or-warning(1) + Spacer(1) + submitPicker(2) = 5 lines
	// vs question-tab's Spacer + chat(1) + Spacer + hint(1) = 4 lines.
	// The +1 below-border row is absorbed by `submitBodyHeight + 1` so total dialog
	// height still matches a question tab's.
	container.addChild(border());
	container.addChild(new Spacer(1));
	const promptText =
		missing.length === 0
			? theme.fg("muted", READY_PROMPT)
			: theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
	container.addChild(new Text(promptText, 1, 0));
	container.addChild(new Spacer(1));
	if (submitPicker) {
		container.addChild(submitPicker);
	} else {
		// Fallback when host hasn't wired the picker (defensive — Phase 4 always wires it
		// in multi-question mode). Keeps the line count at 5 so height equality holds.
		container.addChild(new Spacer(1));
		container.addChild(new Spacer(1));
	}

	// +1 absorbs the extra Spacer added between prompt and submitPicker so total
	// submit-tab height equals a question tab's.
	const submitBodyHeight = (w: number) => summary.render(w).length + 1;
	container.addChild(new BodyResidualSpacer(config.getBodyHeight, submitBodyHeight));
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
		container.addChild(mso);
	} else {
		container.addChild(previewPane);
	}
	container.addChild(new Spacer(1));

	if (state.notesVisible) {
		container.addChild(new Text(theme.fg("muted", "Notes:"), 1, 0));
		container.addChild(notesInput);
		container.addChild(new Spacer(1));
	}

	container.addChild(border());
	// Footer sits IMMEDIATELY after the bottom border on every tab: one blank line,
	// chat row, one blank, controls hint. The residual height absorber is appended
	// AFTER the controls so any extra rows fall at the very bottom of the dialog
	// (where they're least visible) rather than between the bordered region and
	// the footer.
	container.addChild(new Spacer(1));
	container.addChild(chatList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", buildHintText(question, isMulti, state)), 1, 0));
	container.addChild(new BodyResidualSpacer(config.getBodyHeight, config.getCurrentBodyHeight));
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
	// Notes hint visible whenever focused option has preview AND not currently editing notes.
	// Pre-answer notes are now reachable (no `answers.has(currentTab)` gate) per Decision 8.
	if (question && question.multiSelect !== true && state.focusedOptionHasPreview && !state.notesVisible) {
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
