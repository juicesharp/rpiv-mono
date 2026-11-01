import { visibleWidth } from "@earendil-works/pi-tui";
import type { WrappingSelectItem } from "../wrapping-select.ts";

/** Min terminal/pane width for the side-by-side layout to engage. */
export const PREVIEW_MIN_WIDTH = 100;
/** Visual gap between options column and preview column in side-by-side. */
export const PREVIEW_COLUMN_GAP = 2;
/** 1 col padding inside the preview column (between gap and `│`). */
export const PREVIEW_PADDING_LEFT = 1;
/** Empty rows between options and preview blocks in stacked (narrow) layout. */
export const STACKED_GAP_ROWS = 1;

/** Floor for the adaptive left column width — prevents collapse on short labels. */
export const MIN_LEFT = 30;
/** Ceiling ratio: left column never exceeds this fraction of pane width. */
export const MAX_LEFT_RATIO = 0.5;
/** Floor for the preview column width — prevents right-side collapse on narrow terminals. */
export const MIN_PREVIEW_WIDTH = 45;
/** visibleWidth(" ✔") = 2 (space + ✔ codepoint). Reserved on the longest-label measurement
 *  so a confirmed row never gets truncated when MIN_LEFT clamps the column. */
export const CONFIRMED_OVERHEAD = 2;

export type PreviewLayoutMode = "side-by-side" | "stacked";

/**
 * Decide layout mode from terminal + pane widths. Pure of inputs.
 *
 * The terminal-width gate is the AND check from the previous `preview-pane.ts` —
 * lifted here so the decision is computed ONCE per render and threaded explicitly
 * through `previewBlockHeight`. Removes the bug class where `previewBlockHeight`
 * re-derived `sideBySide` from a column width (already < pane width post-split),
 * capping height too short.
 */
export function decideLayout(terminalWidth: number, paneWidth: number): PreviewLayoutMode {
	return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH ? "side-by-side" : "stacked";
}

/**
 * Compute the adaptive left column width from option labels and descriptions.
 * Pure function — deterministic for a given (items, totalForNumbering, paneWidth).
 *
 * Pipeline:
 *   1. Measure: max of the longest visible label and half the longest description
 *      width (target: the longest description wraps to at most 2 lines), plus the
 *      prefix overhead and the confirmed-mark overhead
 *   2. Clamp: floor MIN_LEFT, ceiling paneWidth * MAX_LEFT_RATIO
 *   3. Safety net: never exceed available = paneWidth - GAP - MIN_PREVIEW_WIDTH
 *
 * Descriptions are measured because they share the column with the label rows:
 * sizing from labels alone leaves a sentence-length description only
 * (columnWidth − prefix) columns wide, wrapping it into a few characters per
 * line and ballooning the dialog height (which is content-driven).
 */
export function adaptiveLeftWidth(
	items: readonly WrappingSelectItem[],
	totalForNumbering: number,
	paneWidth: number,
): number {
	const prefixW = String(Math.max(1, totalForNumbering)).length + 4; // digits + "❯ " + ". "
	const confirmedOverhead = CONFIRMED_OVERHEAD; // visibleWidth(" ✔") = 2 (space + ✔ codepoint)
	let maxLabel = 0;
	let maxDesc = 0;
	for (const item of items) {
		const w = visibleWidth(item.label);
		if (w > maxLabel) maxLabel = w;
		const d = item.description ? visibleWidth(item.description) : 0;
		if (d > maxDesc) maxDesc = d;
	}
	const desired = Math.max(maxLabel, Math.ceil(maxDesc / 2)) + prefixW + confirmedOverhead;
	const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
	const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.max(MIN_LEFT, Math.min(ratioCapped, Math.max(1, available)));
}

/**
 * Cross-tab maximum left-column width. Aggregates `adaptiveLeftWidth` over every tab
 * and returns the widest result, so the options column stays stable on tab switch.
 *
 * Pure function — `tabs.length` MUST equal `itemsByTab.length`. Numbering uses
 * `items.length` for every tab (the chat row slot that once added +1 on single-select
 * has been removed).
 * Floor is `MIN_LEFT` so an all-empty input still produces a usable column.
 */
export function crossTabMaxLeftWidth(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	paneWidth: number,
): number {
	let max = MIN_LEFT;
	for (let i = 0; i < tabs.length; i++) {
		const items = itemsByTab[i] ?? [];
		const totalForNumbering = items.length;
		const tabWidth = adaptiveLeftWidth(items, totalForNumbering, paneWidth);
		if (tabWidth > max) max = tabWidth;
	}
	return max;
}

/**
 * Cross-tab left-column width, sized by the options column's own content — the
 * cross-tab aggregate of `adaptiveLeftWidth` (labels + descriptions), clamped by
 * the same ceilings. Preview appetite no longer participates: the previous slack
 * donation grew the options column to "all the width the preview doesn't need",
 * which left a wide empty void between the columns whenever the preview box was
 * narrower than its allocation.
 *
 * Invariants (hold at side-by-side widths, paneWidth ≥ PREVIEW_MIN_WIDTH — the only
 * mode that consumes this value):
 *   - Floor: result ≥ MIN_LEFT (adaptiveLeftWidth's own floor; ratioCeiling ≥ 50
 *     once paneWidth ≥ 100)
 *   - Options cap: left column ≤ paneWidth × MAX_LEFT_RATIO
 *   - Preview floor: right column ≥ MIN_PREVIEW_WIDTH — enforced transitively by
 *     the MAX_LEFT_RATIO cap; previewSafetyCeiling is defensive depth that binds
 *     only if MAX_LEFT_RATIO ever rises above ~0.53, or on narrow panes where the
 *     MIN_LEFT floor can exceed what a side-by-side split would allow
 *   - Cross-tab stability: the reduction is tab-independent
 *   - Determinism: pure of (itemsByTab, paneWidth)
 */
export function crossTabLeftWidth(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	paneWidth: number,
): number {
	const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, paneWidth);
	const previewSafetyCeiling = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	const ratioCeiling = Math.floor(paneWidth * MAX_LEFT_RATIO);
	const ceiling = Math.min(previewSafetyCeiling, ratioCeiling);
	return Math.min(labelDriven, Math.max(1, ceiling));
}

/**
 * Width allocation for side-by-side mode.
 * `adaptiveLeft` is the pre-computed left column width (from `adaptiveLeftWidth`,
 * cross-tab aggregated). The Math.max(1, ...) calls keep both columns >= 1 col on
 * extreme inputs.
 */
export function columnWidths(
	paneWidth: number,
	adaptiveLeft: number,
): { leftWidth: number; rightWidth: number; gap: number } {
	const gap = PREVIEW_COLUMN_GAP;
	const leftWidth = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
	const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
	return { leftWidth, rightWidth, gap };
}

/**
 * Returns the widths actually passed to `options.render` and `previewLines` inside
 * `render()`. Stacked uses the full pane width for both; side-by-side splits via
 * `columnWidths`, with the preview column offset by `PREVIEW_PADDING_LEFT`.
 */
export function bodyWidths(
	paneWidth: number,
	mode: PreviewLayoutMode,
	adaptiveLeft: number,
): { optionsWidth: number; previewWidth: number } {
	if (mode === "stacked") return { optionsWidth: paneWidth, previewWidth: paneWidth };
	const { leftWidth, rightWidth } = columnWidths(paneWidth, adaptiveLeft);
	return { optionsWidth: leftWidth, previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT) };
}
