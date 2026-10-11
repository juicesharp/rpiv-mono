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

/** Content row budget for a layout mode: preview cap minus border + affordance overhead. */
function contentBudgetFor(mode: PreviewLayoutMode): number {
	const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
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
	/**
	 * The scroll offset most recently used by `renderBlock` after clamping to the real
	 * overflow (0 when the last render had no overflow). Read by `PreviewPane` so the
	 * session can re-sync its canonical `previewScroll` to the actually rendered offset.
	 */
	lastClampedScroll = 0;
	/**
	 * Total overflow rows (content rows above the budget) of the last rendered block,
	 * 0 when the last render fit. Read together with `lastClampedScroll` by the session
	 * so PageDown can clamp to the real scrollable range (no phantom overscroll).
	 */
	lastTotalHidden = 0;

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
	 * Height contribution of the preview block: `BORDER_VERTICAL_OVERHEAD + contentRows +
	 * NOTES_AFFORDANCE_OVERHEAD`. Always returns the same value as `renderBlock(...).length`
	 * — the affordance overhead is constant, not gated by `focused`/`notesVisible`.
	 */
	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode): number {
		const contentBudget = contentBudgetFor(mode);
		const innerWidth = innerWidthFor(width);
		const rawRows = this.cache.bodyFor(optionIndex, innerWidth).length;
		const contentRows = Math.min(rawRows, contentBudget);
		return BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD;
	}

	/**
	 * Render the full preview block at `width`: bordered box + blank separator + affordance row.
	 * `focused` and `notesVisible` together gate the affordance text (visible only when the
	 * focused option carries a preview AND notes mode is inactive). The affordance row is ALWAYS
	 * emitted (as an empty string when gated) so the row count is invariant.
	 *
	 * `scrollOffset` (rows, clamped to the actual overflow) scrolls the box body when the
	 * rendered preview exceeds `contentBudget`: the bottom border then reports remaining
	 * lines above/below (▲/▼) instead of the plain ✂ marker. Optional for caller convenience
	 * and test ergonomics — absent means offset 0 (top).
	 */
	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		focused: boolean,
		notesVisible: boolean,
		scrollOffset = 0,
	): string[] {
		const contentBudget = contentBudgetFor(mode);
		const maxInnerWidth = innerWidthFor(width);

		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const totalHidden = Math.max(0, raw.length - contentBudget);
		const offset = totalHidden > 0 ? Math.max(0, Math.min(scrollOffset, totalHidden)) : 0;
		this.lastClampedScroll = offset;
		this.lastTotalHidden = totalHidden;
		const contentLines = totalHidden > 0 ? raw.slice(offset, offset + contentBudget) : raw;
		const canUp = offset > 0;
		const canDown = offset < totalHidden;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, totalHidden, {
			up: canUp,
			down: canDown,
		});

		const showAffordance = focused && !notesVisible && this.cache.has(optionIndex);
		const affordance = showAffordance
			? this.theme.fg("muted", t("preview.notes_affordance", NOTES_AFFORDANCE_TEXT))
			: "";
		return [...boxedLines, "", affordance];
	}
}
