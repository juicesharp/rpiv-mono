import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { t } from "../../../state/i18n-bridge.js";
import type { QuestionData } from "../../../tool/types.js";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.js";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.js";
import type { PreviewLayoutMode } from "./preview-layout-decider.js";

/**
 * Affordance text shown below the bordered preview when focused on a preview-bearing option.
 * Re-exported by `preview-pane.ts` for the existing test surface.
 */
export const NOTES_AFFORDANCE_TEXT = "Notes: press n to add notes";
/** Affordance text once the question carries a saved note (#197). */
export const NOTES_EDIT_AFFORDANCE_TEXT = "Note saved: press n to edit";

/**
 * Which notes affordance the block shows under the preview: `add` / `edit` (no note yet /
 * a saved note) while the pane is focused with the notes editor closed, `none` otherwise.
 * Decided by the pane from its props; the row itself is kept either way (height-stable).
 */
export type NotesAffordance = "add" | "edit" | "none";

function affordanceText(affordance: Exclude<NotesAffordance, "none">): string {
	return affordance === "edit"
		? t("preview.notes_edit_affordance", NOTES_EDIT_AFFORDANCE_TEXT)
		: t("preview.notes_affordance", NOTES_AFFORDANCE_TEXT);
}

/** Content row budget for a layout mode: preview cap minus border + affordance overhead. */
function contentBudgetFor(mode: PreviewLayoutMode): number {
	const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
}

/**
 * Rows a preview block uses for `rawRows` of content. Unconstrained (no `maxRows`), content is
 * capped by the layout's fixed budget and the notes affordance is kept. Under a `maxRows`
 * allowance that the full block would exceed, the affordance (2 rows — the footer hint already
 * names the notes key) goes first, then content shrinks so the box still closes with its
 * "N lines hidden" count. Undefined when not even one content row fits inside a border.
 */
function fitBlock(
	rawRows: number,
	mode: PreviewLayoutMode,
	maxRows: number | undefined,
): { contentRows: number; affordance: boolean } | undefined {
	const contentRows = Math.min(rawRows, contentBudgetFor(mode));
	if (maxRows === undefined || BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD <= maxRows) {
		return { contentRows, affordance: true };
	}
	const fitted = Math.min(contentRows, maxRows - BORDER_VERTICAL_OVERHEAD);
	return fitted >= 1 ? { contentRows: fitted, affordance: false } : undefined;
}

/** Inner (padding-aware) content width for a total block width. */
function innerWidthFor(width: number): number {
	return Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
}

export interface PreviewBlockRendererConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
}

/**
 * Renders the bordered markdown preview block for a single question (one block per render call,
 * for the option at `optionIndex`). Owns a per-question `MarkdownContentCache`.
 *
 * NOT a `Component` — pure render-and-measure helper consumed by `PreviewPane`. The layout mode
 * is threaded as an explicit param (never re-derived from column width post-split).
 *
 * The affordance row is always emitted (visually empty when gated) so the preview block's row
 * count is height-stable across affordance-state transitions.
 */
export class PreviewBlockRenderer {
	private readonly theme: Theme;
	private readonly cache: MarkdownContentCache;

	constructor(config: PreviewBlockRendererConfig) {
		this.theme = config.theme;
		this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
	}

	hasAnyPreview(): boolean {
		return this.cache.hasAnyPreview();
	}

	has(optionIndex: number): boolean {
		return this.cache.has(optionIndex);
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	/**
	 * Height contribution of the preview block — always equal to `renderBlock(...).length`
	 * for the same arguments (the affordance overhead is not gated by the `NotesAffordance`).
	 * `maxRows` is the row allowance the dialog can give the block; see `fitBlock`.
	 */
	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode, maxRows?: number): number {
		const rawRows = this.cache.bodyFor(optionIndex, innerWidthFor(width)).length;
		const fit = fitBlock(rawRows, mode, maxRows);
		return fit ? BORDER_VERTICAL_OVERHEAD + fit.contentRows + (fit.affordance ? NOTES_AFFORDANCE_OVERHEAD : 0) : 0;
	}

	/**
	 * Render the preview block at `width`: bordered box, then (when it fits) a blank separator
	 * and the notes-affordance row. `affordance` picks the text (`none` blanks it), shown only when
	 * the option carries a preview; the row is emitted (empty when gated) whenever the block keeps
	 * it, so the row count only depends on the fit. Under a `maxRows` allowance the box always closes and its bottom border
	 * counts the lines left out; with no room for a box the block is empty.
	 */
	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		affordance: NotesAffordance,
		maxRows?: number,
	): string[] {
		const maxInnerWidth = innerWidthFor(width);
		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const fit = fitBlock(raw.length, mode, maxRows);
		if (!fit) return [];
		const hidden = raw.length - fit.contentRows;
		const contentLines = hidden > 0 ? raw.slice(0, fit.contentRows) : raw;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);
		if (!fit.affordance) return boxedLines;

		const text = affordance !== "none" && this.cache.has(optionIndex) ? affordanceText(affordance) : "";
		return [...boxedLines, "", text ? this.theme.fg("muted", text) : ""];
	}
}
