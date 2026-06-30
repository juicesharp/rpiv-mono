import type { QuestionAnswer, QuestionData } from "../../tool/types.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";

/**
 * Pure derivation: does the option focused by `(currentTab, optionIndex)` carry a
 * non-empty `preview` string? Mode gates (notes mode, multiSelect) layer
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
 * Which row in the active tab should be marked as "previously confirmed"? Drives the
 * `WrappingSelect` confirmed-row indicator (label + ` ✔`) when the user navigates back
 * to a question they already answered. Returns `undefined` when no marker should be drawn —
 * multi-select handles its own `[✔]` boxes via `multiSelectChecked`, and a missing/non-matching
 * answer (defensive) silently skips the marker.
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
	if (!prior) return undefined;
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
 * Index of the preview pane to display for the current tab. The Submit tab (currentTab ===
 * questions.length) reuses the last question's pane purely for layout — the strategy
 * machinery picks the right body component independently. Defensive against `totalQuestions === 0`.
 */
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
	if (totalQuestions <= 0) return 0;
	return Math.min(currentTab, totalQuestions - 1);
}
