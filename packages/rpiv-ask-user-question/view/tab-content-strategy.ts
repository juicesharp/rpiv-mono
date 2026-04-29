import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, type Input, Spacer, Text } from "@mariozechner/pi-tui";
import { formatAnswerScalar } from "../tool/format-answer.js";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import {
	type DialogState,
	HINT_PART_CANCEL,
	HINT_PART_ENTER,
	HINT_PART_NAV,
	HINT_PART_NOTES,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.js";

/**
 * Per-tab content provider for the dialog. The role-rename makes it explicit
 * that this is a content provider, not a `Component` (no render/handleInput/
 * invalidate, no state cell). Pure functional: implementations close over
 * construction-time config; per-tick state is threaded through method args.
 *
 * The chrome wrapper (`buildContainerFromStrategy`) enforces height equality
 * across tabs by computing each strategy's natural footprint
 * (`bodyHeight + footerRowCount`) and absorbing the residual via
 * `BodyResidualSpacer`.
 */
export interface TabContentStrategy {
	/** Total RENDERED footer row count (NOT Component[].length — submitPicker renders to 2 rows). Constant per strategy regardless of state. Drives the chrome wrapper's residual math. */
	readonly footerRowCount: number;

	/** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
	headingRows(state: DialogState): Component[];

	/** Body Component placed at the body slot. */
	bodyComponent(state: DialogState): Component;

	/** Natural rendered height of `bodyComponent(state)` at given width. */
	bodyHeight(width: number, state: DialogState): number;

	/** Optional rows between body's trailing Spacer and the bottom border (Question's notes block when notesVisible; empty otherwise). */
	midRows(state: DialogState): Component[];

	/** Footer rows below the bottom border. Total RENDERED rows MUST equal `footerRowCount`. */
	footerRows(state: DialogState): Component[];
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	/** Live getter — `dialog.setPreviewPane()` updates the closure's reference. */
	getPreviewPane: () => PreviewPane;
	multiSelectOptionsByTab: ReadonlyArray<MultiSelectView | undefined>;
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
	getCurrentBodyHeight: (width: number) => number;
}

export class QuestionTabStrategy implements TabContentStrategy {
	/** Spacer(1) + chatRow(1) + Spacer(1) + Text(hint, 1) = 4 rendered rows. */
	readonly footerRowCount = 4;

	constructor(private readonly config: QuestionTabStrategyConfig) {}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		// Single-mode badge — suppressed in multi mode (tab bar already shows the header).
		if (!this.config.isMulti && question?.header && question.header.length > 0) {
			out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
			out.push(new Spacer(1));
		}
		if (question) {
			out.push(new Text(this.config.theme.bold(question.question), 1, 0));
			out.push(new Spacer(1));
		}
		return out;
	}

	bodyComponent(state: DialogState): Component {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.multiSelectOptionsByTab[state.currentTab];
		if (question?.multiSelect === true && mso) return mso;
		return this.config.getPreviewPane();
	}

	bodyHeight(width: number, _state: DialogState): number {
		return this.config.getCurrentBodyHeight(width);
	}

	midRows(state: DialogState): Component[] {
		if (!state.notesVisible) return [];
		return [new Text(this.config.theme.fg("muted", "Notes:"), 1, 0), this.config.notesInput, new Spacer(1)];
	}

	footerRows(state: DialogState): Component[] {
		const question = this.config.questions[state.currentTab];
		return [
			new Spacer(1),
			this.config.chatRow,
			new Spacer(1),
			new Text(this.config.theme.fg("dim", buildHintText(question, this.config.isMulti, state)), 1, 0),
		];
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
}

export class SubmitTabStrategy implements TabContentStrategy {
	/** Spacer(1) + Text(prompt, 1) + Spacer(1) + submitPicker(2) = 5 rendered rows. Fallback path also lands at 5 via 2 trailing Spacer(1)s. */
	readonly footerRowCount = 5;

	constructor(private readonly config: SubmitTabStrategyConfig) {}

	headingRows(_state: DialogState): Component[] {
		return [new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)), 1, 0), new Spacer(1)];
	}

	bodyComponent(state: DialogState): Component {
		// Walk questions once: build the bullet+arrow summary container (omits unanswered).
		// CC parity — the warning header in the footer is the sole signal of incompleteness.
		const c = new Container();
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			const a = state.answers.get(i);
			if (!a) continue;
			const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
			const answerText = formatAnswerScalar(a, "summary");
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${label}`), 1, 0));
			c.addChild(
				new Text(`   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`, 1, 0),
			);
			if (a.notes && a.notes.length > 0) {
				c.addChild(new Text(this.config.theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
			}
		}
		return c;
	}

	bodyHeight(width: number, state: DialogState): number {
		// Re-render the summary to count rows. Same per-frame cost as the previous
		// `summary.render(w).length` call — no perf delta.
		return this.bodyComponent(state).render(width).length;
	}

	midRows(_state: DialogState): Component[] {
		return [];
	}

	footerRows(state: DialogState): Component[] {
		const missing: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			if (!state.answers.has(i)) {
				missing.push(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`);
			}
		}
		const promptText =
			missing.length === 0
				? this.config.theme.fg("muted", READY_PROMPT)
				: this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
		const out: Component[] = [new Spacer(1), new Text(promptText, 1, 0), new Spacer(1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			// Fallback when host hasn't wired the picker — keeps rendered row count at 5.
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		return out;
	}
}

/**
 * Build the controls hint line from `HINT_PART_*` phrase tokens. Order is fixed so
 * `HINT_SINGLE` / `HINT_MULTI` (the constant joins) remain contiguous substrings:
 *
 *   Enter to select · ↑/↓ to navigate
 *     [· Space to toggle]                  (multiSelect only)
 *     [· n to add notes]                   (single-select + preview-bearing focus)
 *     [· Tab to switch questions]          (multi-question only)
 *   · Esc to cancel
 */
export function buildHintText(question: QuestionData | undefined, isMulti: boolean, state: DialogState): string {
	const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
	if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
	if (question && question.multiSelect !== true && state.focusedOptionHasPreview && !state.notesVisible) {
		parts.push(HINT_PART_NOTES);
	}
	if (isMulti) parts.push(HINT_PART_TAB);
	parts.push(HINT_PART_CANCEL);
	return parts.join(" · ");
}
