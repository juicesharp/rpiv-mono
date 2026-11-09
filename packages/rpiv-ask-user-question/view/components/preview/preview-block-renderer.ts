import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { DEFAULT_NOTES_KEY, formatNotesKeyForDisplay } from "../../../config.ts";
import { t } from "../../../state/i18n-bridge.ts";
import type { QuestionData } from "../../../tool/types.ts";
import { KEY_PLACEHOLDER } from "../../dialog-copy.ts";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.ts";
import type { PreviewLayoutMode } from "./preview-layout-decider.ts";

/**
 * Affordance text shown below the bordered preview when focused on a preview-bearing option.
 * Re-exported by `preview-pane.ts` for the existing test surface.
 */
export const NOTES_AFFORDANCE_TEMPLATE = `Notes: press ${KEY_PLACEHOLDER} to add notes`;
/** Affordance text once the question carries a saved note (#197). */
export const NOTES_EDIT_AFFORDANCE_TEMPLATE = `Note saved: press ${KEY_PLACEHOLDER} to edit`;
/** Default-key (`n`) renderings of the two affordance templates. */
export const NOTES_AFFORDANCE_TEXT = NOTES_AFFORDANCE_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_NOTES_KEY);
export const NOTES_EDIT_AFFORDANCE_TEXT = NOTES_EDIT_AFFORDANCE_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_NOTES_KEY);

/**
 * Which notes affordance the block shows under the preview: `add` / `edit` (no note yet /
 * a saved note) while the pane is focused with the notes editor closed, `none` otherwise.
 * Decided by the pane from its props; the row itself is kept either way (height-stable).
 */
export type NotesAffordance = "add" | "edit" | "none";

function affordanceText(affordance: Exclude<NotesAffordance, "none">, notesKey: string): string {
	const text =
		affordance === "edit"
			? t("preview.notes_edit_affordance", NOTES_EDIT_AFFORDANCE_TEMPLATE)
			: t("preview.notes_affordance", NOTES_AFFORDANCE_TEMPLATE);
	return text.replace(KEY_PLACEHOLDER, formatNotesKeyForDisplay(notesKey));
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
	/** Resolved notes key (`resolveNotesKey` output), named by the affordance. */
	notesKey: string;
	/** Display label for the preview-scroll-up key (e.g. `"PgUp"`, `"Ctrl+U"`). */
	scrollUpLabel?: string;
	/** Display label for the preview-scroll-down key. */
	scrollDownLabel?: string;
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
	private readonly notesKey: string;
	private readonly scrollUpLabel: string | undefined;
	private readonly scrollDownLabel: string | undefined;
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
		this.notesKey = config.notesKey;
		this.scrollUpLabel = config.scrollUpLabel;
		this.scrollDownLabel = config.scrollDownLabel;
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
		affordance: NotesAffordance,
		maxRows?: number,
		scrollOffset = 0,
	): string[] {
		const maxInnerWidth = innerWidthFor(width);
		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const fit = fitBlock(raw.length, mode, maxRows);
		if (!fit) return [];
		const totalHidden = Math.max(0, raw.length - fit.contentRows);
		const offset = totalHidden > 0 ? Math.max(0, Math.min(scrollOffset, totalHidden)) : 0;
		this.lastClampedScroll = offset;
		this.lastTotalHidden = totalHidden;
		const contentLines = totalHidden > 0 ? raw.slice(offset, offset + fit.contentRows) : raw;
		const canUp = offset > 0;
		const canDown = offset < totalHidden;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, totalHidden, {
			up: canUp,
			down: canDown,
			upLabel: this.scrollUpLabel,
			downLabel: this.scrollDownLabel,
		});
		if (!fit.affordance) return boxedLines;

		const text =
			affordance !== "none" && this.cache.has(optionIndex) ? affordanceText(affordance, this.notesKey) : "";
		return [...boxedLines, "", text ? this.theme.fg("muted", text) : ""];
	}
}
