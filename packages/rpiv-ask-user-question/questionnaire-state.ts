import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionAnswer, QuestionData } from "./types.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`handleQuestionnaireInput`) and the view layer (`buildDialog`,
 * `MultiSelectOptions.setState`, `SubmitPicker.setState`) read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	chatFocused: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/**
	 * Pre-answer notes side-band, keyed by tab index. OPTIONAL on the canonical type to
	 * preserve existing test-factory shapes (`dispatch.test.ts:43-63`,
	 * `multi-select-options.test.ts:11-23`, `submit-picker.test.ts:13-25`); the reducer
	 * treats `undefined` as an empty map. Decoupled from `answers` so adding notes does NOT
	 * make `answers.has(currentTab)` true (otherwise Submit-tab missing-check + `allAnswered()`
	 * would falsely report the question as answered). Merged into the answer at confirm time.
	 */
	notesByTab?: ReadonlyMap<number, string>;
	/**
	 * True iff the currently-focused option carries a non-empty `preview` string.
	 * Computed via `computeFocusedOptionHasPreview` below. Stored on state because it
	 * gates the `notes_enter` action and the "n to add notes" hint chip.
	 */
	focusedOptionHasPreview: boolean;
	/**
	 * Focused row in the Submit-tab picker (0 = Submit answers, 1 = Cancel). Default 0;
	 * reset on every tab switch.
	 */
	submitChoiceIndex: number;
}

/**
 * Per-tick context the dispatcher needs alongside the canonical state. Lives separately
 * from `QuestionnaireState` because these fields don't belong on the view-side state
 * (the view's `setState` consumers should not see `keybindings` or `inputBuffer`).
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
}

/**
 * Combined snapshot read by the dispatcher. The view receives the same object —
 * structural typing accepts the superset wherever a `QuestionnaireState` is expected
 * (covariance), so a single `snapshot()` call serves both consumers.
 */
export type QuestionnaireDispatchSnapshot = QuestionnaireState & QuestionnaireRuntime;

/**
 * Pure derivation: does the option focused by `(currentTab, optionIndex)` carry a
 * non-empty `preview` string? Mode gates (chat focus, notes mode, multiSelect) layer
 * on top via dispatch branches; this predicate is intentionally mode-agnostic.
 */
export function computeFocusedOptionHasPreview(
	questions: readonly QuestionData[],
	currentTab: number,
	optionIndex: number,
): boolean {
	const q = questions[currentTab];
	if (!q) return false;
	const opt = q.options[optionIndex];
	return !!opt && typeof opt.preview === "string" && opt.preview.length > 0;
}

/**
 * Numbering for the chat row's WrappingSelect, computed from the active tab's items.
 *
 * The chat row lives in its own one-item WrappingSelect; the host calls this on every tab
 * switch / selection update to keep the chat row's `N. ` label continuous with the visible
 * numbered rows of the active tab. The shape `{ offset, total }` mirrors `WrappingSelect.setNumbering(numberStartOffset, totalItemsForNumbering)` directly.
 */
export function chatNumberingFor(items: readonly WrappingSelectItem[]): {
	offset: number;
	total: number;
} {
	// Count only the visible-numbered rows. The Next sentinel renders without a number
	// (see MultiSelectOptions), so it must NOT advance the chat row's number — otherwise
	// chat reads as "6." next to options labeled 1-4. Sourced from `ROW_INTENT_META[kind].numbered`
	// so adding a new non-numbered kind is a single META edit.
	const count = items.filter((i) => ROW_INTENT_META[i.kind].numbered).length;
	return { offset: count, total: count + 1 };
}

/**
 * Which row in the active tab should be marked as "previously confirmed"? Drives the
 * `WrappingSelect` confirmed-row indicator (label + ` ✔`) when the user navigates back
 * to a question they already answered. Returns `undefined` when no marker should be drawn —
 * multi-select handles its own `[✔]` boxes via `multiSelectChecked`, `kind: "chat"` ends the
 * dialog so the row can never be re-entered, and a missing/non-matching answer (defensive)
 * silently skips the marker.
 */
export function selectConfirmedIndicator(
	questions: readonly QuestionData[],
	currentTab: number,
	answers: ReadonlyMap<number, QuestionAnswer>,
	items: readonly WrappingSelectItem[],
): { index: number; labelOverride?: string } | undefined {
	const q = questions[currentTab];
	if (!q || q.multiSelect === true) return undefined;
	const prior = answers.get(currentTab);
	if (!prior || prior.kind === "chat") return undefined;
	if (prior.kind === "custom") {
		const otherIndex = items.findIndex((it) => it.kind === "other");
		if (otherIndex < 0) return undefined;
		return { index: otherIndex, labelOverride: prior.answer ?? "" };
	}
	if (prior.kind !== "option" || typeof prior.answer !== "string") return undefined;
	const index = items.findIndex((it) => it.kind === "option" && it.label === prior.answer);
	if (index < 0) return undefined;
	return { index };
}

/**
 * Are the focusable option rows the current focus target? False when the chat row owns focus
 * or the notes input is visible. Drives the active-pointer suppression on `WrappingSelect` /
 * `MultiSelectOptions` so the cursor doesn't render in two places at once.
 */
export function selectOptionsFocused(state: { notesVisible: boolean; chatFocused: boolean }): boolean {
	return !state.notesVisible && !state.chatFocused;
}

/**
 * Index of the preview pane to display for the current tab. The Submit tab (currentTab ===
 * questions.length) reuses the last question's pane purely for layout — the strategy
 * machinery picks the right body component independently. Defensive against `totalQuestions === 0`.
 */
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
	if (totalQuestions <= 0) return 0;
	return Math.min(currentTab, totalQuestions - 1);
}

/**
 * Items array for the active tab, with the same Submit-tab clamp as `selectActivePreviewPaneIndex`.
 * Falls back to an empty array if the index lands outside the items array (defensive).
 */
export function selectActiveTabItems(
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	currentTab: number,
	totalQuestions: number,
): readonly WrappingSelectItem[] {
	const idx = selectActivePreviewPaneIndex(currentTab, totalQuestions);
	return itemsByTab[idx] ?? [];
}

/**
 * Is the Submit tab the active tab? Drives the `SubmitPicker.setFocused` projection so
 * its active pointer renders only on the Submit tab.
 */
export function selectSubmitPickerFocused(currentTab: number, totalQuestions: number): boolean {
	return currentTab === totalQuestions;
}
