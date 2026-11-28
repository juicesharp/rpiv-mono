import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Editor,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	formatKeySpecForShortDisplay,
	formatNotesKeyForDisplay,
} from "../config.ts";
import { t } from "../state/i18n-bridge.ts";
import { selectSavedNote } from "../state/selectors/derivations.ts";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionData } from "../tool/types.ts";
import type { PreviewPane, PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { DialogState } from "./dialog-builder.ts";
import {
	HINT_PART_CANCEL,
	HINT_PART_CLEAR,
	HINT_PART_COLLAPSE_TEMPLATE,
	HINT_PART_ENTER,
	HINT_PART_NAV,
	HINT_PART_NEW_LINE,
	HINT_PART_NOTES_TEMPLATE,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	HINT_SHORT_CANCEL,
	HINT_SHORT_CLEAR,
	HINT_SHORT_COLLAPSE_TEMPLATE,
	HINT_SHORT_ENTER,
	HINT_SHORT_NAV,
	HINT_SHORT_NEW_LINE,
	HINT_SHORT_NOTES_TEMPLATE,
	HINT_SHORT_REVIEW_NOTE_TEMPLATE,
	HINT_SHORT_TAB,
	HINT_SHORT_TOGGLE,
	INCOMPLETE_WARNING_PREFIX,
	KEY_PLACEHOLDER,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-copy.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";

const NOTES_HEADER = "Notes:";
const GLOBAL_NOTES_HEADER = "Global note:";
const REVIEW_GLOBAL_HINT_TEMPLATE = `${KEY_PLACEHOLDER} to add a note`;
const REVIEW_NOTE_LABEL = "Note";
/** Label for a question's saved note — the question tab's resting row and the review entry (#197). */
const SAVED_NOTE_LABEL = "Note for this answer:";

/**
 * Single-row, width-clipped chrome cell. The footer row count is invariant
 * (`QuestionTabStrategy.footerRowCount = 2`) — pi-tui's `Text` word-wraps when
 * the styled hint exceeds `width`, inflating that row count and desyncing the
 * `bodyHeight + footerRowCount` math in `DialogView.render`. Clipping with
 * `truncateToWidth` (ANSI-aware, matches `multi-select-view.ts` usage) keeps
 * the hint on one line; the collapse affordance falls off the right edge with
 * `…` on terminals too narrow to advertise it.
 */
class OneLineClippedText implements Component {
	constructor(
		private readonly text: string,
		private readonly paddingLeft: number = 0,
	) {}

	render(width: number): string[] {
		const pad = " ".repeat(this.paddingLeft);
		const avail = Math.max(0, width - this.paddingLeft);
		return [pad + truncateToWidth(this.text, avail, "…", false)];
	}

	invalidate(): void {}

	handleInput(_data: string): void {}
}

/**
 * Widest dialog that gets the short key hints when the full ones do not fit: a phone's
 * SSH app in portrait (about 45 columns), and Herdr's one-column phone layout (64 and
 * fewer). A wider terminal keeps the full hints, clipped at the right edge as before.
 */
export const SHORT_HINTS_MAX_WIDTH = 64;

/**
 * The key-hint row: one row, like `OneLineClippedText`. On a narrow terminal
 * (`SHORT_HINTS_MAX_WIDTH`) whose width the full hints overflow it holds the short
 * ones, so every key stays in view rather than the last ones clipping with `…`. The
 * short form clips too if even it does not fit.
 */
class HintRow implements Component {
	constructor(
		private readonly build: (form: HintForm) => string,
		private readonly style: (text: string) => string,
		private readonly paddingLeft: number = 0,
	) {}

	render(width: number): string[] {
		const avail = Math.max(0, width - this.paddingLeft);
		const full = this.build("full");
		const text = width > SHORT_HINTS_MAX_WIDTH || visibleWidth(full) <= avail ? full : this.build("short");
		return new OneLineClippedText(this.style(text), this.paddingLeft).render(width);
	}

	invalidate(): void {}

	handleInput(_data: string): void {}
}

/**
 * Per-tab content provider. Pure functional — closes over construction-time
 * config; per-tick state threads through method args. The chrome wrapper
 * enforces height equality across tabs via `bodyHeight + footerRowCount`.
 */
export interface TabContentStrategy {
	/** Total RENDERED footer rows — MUST equal what `footerRows()` actually emits. Drives residual math. */
	readonly footerRowCount: number;

	/** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
	headingRows(state: DialogState): Component[];

	/** Body Component placed at the body slot. */
	bodyComponent(state: DialogState): Component;

	/** Natural rendered height of `bodyComponent(state)` at given width. */
	bodyHeight(width: number, state: DialogState): number;

	/** Optional rows between body's trailing Spacer and the bottom border. */
	midRows(state: DialogState): Component[];

	/** Footer rows below the bottom border. Rendered row count MUST equal `footerRowCount`. */
	footerRows(state: DialogState): Component[];

	/** Row range of the focused item within the body's rendered output, or undefined if no interactive focus. */
	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined;
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	getPreviewPane: () => StatefulView<PreviewPaneProps>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	notesInput: Editor;
	isMulti: boolean;
	getCurrentBodyHeight: (width: number) => number;
	/** Resolved collapse key spec (`"ctrl+]"`, `"alt+o"`, or `"off"`). Drives the footer's collapse hint. */
	collapseKey: string;
	/** Resolved notes key (`resolveNotesKey` output). Named by the footer's notes hint. */
	notesKey: string;
}

export class QuestionTabStrategy implements TabContentStrategy {
	/** Spacer(1) + OneLineClippedText(hint, 1) = 2 rendered rows. */
	readonly footerRowCount = 2;

	constructor(private readonly config: QuestionTabStrategyConfig) {}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		// In multi-question mode the tab bar already shows the header; suppress the inline badge.
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
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso;
		return this.config.getPreviewPane();
	}

	bodyHeight(width: number, _state: DialogState): number {
		return this.config.getCurrentBodyHeight(width);
	}

	midRows(state: DialogState): Component[] {
		if (state.notesVisible) {
			return [
				new Text(this.config.theme.fg("muted", t("notes.header", NOTES_HEADER)), 1, 0),
				this.config.notesInput,
				new Spacer(1),
			];
		}
		// A saved note stays visible once its editor closes (#197): one clipped row, so a long
		// or multi-line note cannot crowd the options — `n` reopens it in full. Mid rows are
		// subtracted from the body allowance (`DialogView.rowsAroundBody`), so the row is
		// height-safe.
		const note = selectSavedNote(state.notesByTab, state.answers, state.currentTab);
		if (note === undefined) return [];
		const [firstLine = "", ...rest] = note.split("\n");
		const text = `${t("notes.saved_label", SAVED_NOTE_LABEL)} ${firstLine}${rest.length > 0 ? " …" : ""}`;
		return [new OneLineClippedText(this.config.theme.fg("dim", text), 1)];
	}

	footerRows(state: DialogState): Component[] {
		const question = this.config.questions[state.currentTab];
		// HintRow (not pi-tui `Text`) — `buildHintText` includes the collapse affordance,
		// pushing the rendered string past 80 columns; `Text` would wrap and break the
		// strategy's `footerRowCount = 2` invariant. A narrow terminal gets the short hints,
		// which clip with `…` only if even they do not fit.
		return [
			new Spacer(1),
			new HintRow(
				(form) =>
					buildHintText(question, this.config.isMulti, state, this.config.collapseKey, this.config.notesKey, form),
				(text) => this.config.theme.fg("dim", text),
				1,
			),
		];
	}

	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso.focusedItemRowRange(width);
		return (this.config.getPreviewPane() as unknown as PreviewPane).focusedItemRowRange(width);
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
	/** Shared notes Editor — mounted into midRows while the global-note editor is open on this tab. */
	notesInput: Editor;
	/** Resolved notes key (`resolveNotesKey` output). Named by the global-note hint. */
	notesKey: string;
}

export class SubmitTabStrategy implements TabContentStrategy {
	/** Spacer(1) + Text(prompt, 1) + submitPicker(2) + OneLineClippedText(hint, 1) = 5 rendered rows. Fallback path lands at 5 via 2 Spacer(1)s in the picker slot. */
	readonly footerRowCount = 5;

	constructor(private readonly config: SubmitTabStrategyConfig) {}

	headingRows(_state: DialogState): Component[] {
		return [
			new Text(this.config.theme.bold(this.config.theme.fg("accent", t("review.heading", REVIEW_HEADING))), 1, 0),
			new Spacer(1),
		];
	}

	bodyComponent(state: DialogState): Component {
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
				c.addChild(
					new Text(
						this.config.theme.fg("dim", `     ${t("notes.saved_label", SAVED_NOTE_LABEL)} ${a.notes}`),
						1,
						0,
					),
				);
			}
		}
		// Committed global note (#182) as a review entry — pressing `n` gets visible
		// feedback and the note is reviewable before submit. Same presence predicate as
		// the reducer's doneFor lift. Hidden while the editor is open: the midRows editor
		// (seeded with this text) is the live surface then, and a stale copy above it
		// would read as a second note.
		const globalNote = state.notesByTab.get(this.config.questions.length);
		if (!state.notesVisible && globalNote && globalNote.length > 0) {
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${t("review.note_label", REVIEW_NOTE_LABEL)}`), 1, 0));
			c.addChild(
				new Text(`   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", globalNote)}`, 1, 0),
			);
		}
		return c;
	}

	bodyHeight(width: number, state: DialogState): number {
		return this.bodyComponent(state).render(width).length;
	}

	midRows(state: DialogState): Component[] {
		// notesVisible-gated mirror of QuestionTabStrategy.midRows: while the global-note
		// editor is open, the shared notesInput mounts below the answer summary under its
		// own header. The pseudo-index draft (notesByTab[questions.length]) is reducer-owned
		// state; the strategy only renders.
		if (!state.notesVisible) return [];
		return [
			new Text(this.config.theme.fg("muted", t("notes.global_header", GLOBAL_NOTES_HEADER)), 1, 0),
			this.config.notesInput,
			new Spacer(1),
		];
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
				? this.config.theme.fg("muted", t("review.ready", READY_PROMPT))
				: this.config.theme.fg(
						"warning",
						`${t("review.incomplete", INCOMPLETE_WARNING_PREFIX)} ${missing.join(", ")}`,
					);
		// One row, never wrapped: `footerRowCount` counts it as one, and a wrapped prompt
		// (long list of unanswered headers) would desync the chrome's row math (#261).
		const out: Component[] = [new Spacer(1), new OneLineClippedText(promptText, 1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			// Padding when the picker isn't wired — keeps rendered row count at footerRowCount=5.
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		// Bottom key-hint row, mirroring QuestionTabStrategy's footer idiom (one dim
		// `·`-joined line below everything) — the prompt reads straight into its picker
		// with no hint wedged between them. Always present so footerRowCount stays
		// exactly 5. OneLineClippedText (not pi-tui Text) — a wrapped hint would inflate
		// the footer past footerRowCount and desync the chrome's cross-tab height math.
		out.push(
			new HintRow(
				(form) => buildSubmitHintText(state, this.config.notesKey, form),
				(text) => this.config.theme.fg("dim", text),
				1,
			),
		);
		return out;
	}

	focusedItemRowRange(_width: number, _state: DialogState): [number, number] | undefined {
		return undefined;
	}
}

/**
 * Build the controls hint line. Order:
 *   Enter · ↑/↓ [· Space toggle] [· n notes] [· Tab switch] · Esc [· <key> collapse]
 *   [· Shift+Enter newline] [· Ctrl+U clear]
 *
 * `NOTES` is part of the resting (notes-closed) core — it drops while the notes
 * editor or custom-answer input has the keyboard. Ctrl+G is Pi's global external-
 * editor shortcut and needs no local hint; the context-specific clear shortcut is
 * appended at the far right while input mode is active.
 *
 * The collapse part interpolates the configured `collapseKey` (display-cased)
 * and is omitted entirely when the shortcut is `"off"` — `routeKey` and the raw
 * terminal listener both refuse to collapse in that case, so advertising a key
 * would be a lie.
 */
export function buildHintText(
	question: QuestionData | undefined,
	isMulti: boolean,
	state: DialogState,
	collapseKey: string,
	notesKey: string,
	form: HintForm = "full",
): string {
	const copy = HINT_COPY[form];
	const parts: string[] = [copy.enter(), copy.navigate()];
	if (question?.multiSelect === true) parts.push(copy.toggle());
	if (question && !state.notesVisible && !state.inputMode) parts.push(copy.notes(notesKey));
	if (isMulti) parts.push(copy.tab());
	parts.push(copy.cancel());
	if (collapseKey !== COLLAPSE_KEY_OFF) parts.push(copy.collapse(collapseKey));
	if (state.notesVisible || state.inputMode) parts.push(copy.newline());
	if (state.inputMode) parts.push(copy.clear());
	return parts.join(" · ");
}

/**
 * Submit-tab counterpart of `buildHintText` — the same `·`-joined bottom-row idiom.
 * Resting: Enter · ↑/↓ · `n to add a note` · Esc. While the global-note editor is
 * open the note part drops (the editor is the affordance then) and the Shift+Enter
 * newline hint is appended after cancel, mirroring the question tabs' notes-open shape.
 */
export function buildSubmitHintText(state: DialogState, notesKey: string, form: HintForm = "full"): string {
	const copy = HINT_COPY[form];
	const parts: string[] = [copy.enter(), copy.navigate()];
	if (!state.notesVisible) parts.push(copy.reviewNote(notesKey));
	parts.push(copy.cancel());
	if (state.notesVisible) parts.push(copy.newline());
	return parts.join(" · ");
}

/** `full`: the key and what it does. `short`: for terminals too narrow for that (see `HINT_SHORT_ENTER`). */
export type HintForm = "full" | "short";

/** Each hint part in each form. Read at render time, so a language switch applies to the next frame. */
const HINT_COPY: Record<HintForm, Record<string, (key?: string) => string>> = {
	full: {
		enter: () => t("hint.enter", HINT_PART_ENTER),
		navigate: () => t("hint.navigate", HINT_PART_NAV),
		toggle: () => t("hint.toggle", HINT_PART_TOGGLE),
		notes: (key = "") => notesHint("hint.notes", HINT_PART_NOTES_TEMPLATE, key),
		tab: () => t("hint.tab", HINT_PART_TAB),
		cancel: () => t("hint.cancel", HINT_PART_CANCEL),
		collapse: (key = "") =>
			t("hint.collapse", HINT_PART_COLLAPSE_TEMPLATE).replace(KEY_PLACEHOLDER, formatKeySpecForDisplay(key)),
		newline: () => t("hint.newline", HINT_PART_NEW_LINE),
		clear: () => t("hint.clear", HINT_PART_CLEAR),
		reviewNote: (key = "") => notesHint("review.global_hint", REVIEW_GLOBAL_HINT_TEMPLATE, key),
	},
	short: {
		enter: () => t("hint.short.enter", HINT_SHORT_ENTER),
		navigate: () => t("hint.short.navigate", HINT_SHORT_NAV),
		toggle: () => t("hint.short.toggle", HINT_SHORT_TOGGLE),
		notes: (key = "") =>
			t("hint.short.notes", HINT_SHORT_NOTES_TEMPLATE).replace(KEY_PLACEHOLDER, shortNotesKey(key)),
		tab: () => t("hint.short.tab", HINT_SHORT_TAB),
		cancel: () => t("hint.short.cancel", HINT_SHORT_CANCEL),
		collapse: (key = "") =>
			t("hint.short.collapse", HINT_SHORT_COLLAPSE_TEMPLATE).replace(
				KEY_PLACEHOLDER,
				formatKeySpecForShortDisplay(key),
			),
		newline: () => t("hint.short.newline", HINT_SHORT_NEW_LINE),
		clear: () => t("hint.short.clear", HINT_SHORT_CLEAR),
		reviewNote: (key = "") =>
			t("hint.short.review_note", HINT_SHORT_REVIEW_NOTE_TEMPLATE).replace(KEY_PLACEHOLDER, shortNotesKey(key)),
	},
};

/** A single-character notes key as configured; a key spec in its shortest display. */
function shortNotesKey(notesKey: string): string {
	return [...notesKey].length === 1 ? notesKey : formatKeySpecForShortDisplay(notesKey);
}

/** A notes hint with the configured key in place of `{key}`. */
function notesHint(key: string, template: string, notesKey: string): string {
	return t(key, template).replace(KEY_PLACEHOLDER, formatNotesKeyForDisplay(notesKey));
}
