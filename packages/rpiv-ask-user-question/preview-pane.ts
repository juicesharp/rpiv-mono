import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { QuestionData } from "./types.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

export const PREVIEW_MIN_WIDTH = 100;
/** CC parity in side-by-side layout. */
export const MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE = 20;
/** Preserves narrow-terminal protection in stacked layout. */
export const MAX_PREVIEW_HEIGHT_STACKED = 15;
export const NO_PREVIEW_TEXT = "No preview available";
export const MAX_VISIBLE_OPTIONS = 10;
/** Max width of the options column when a side-by-side preview is shown. */
export const PREVIEW_LEFT_COLUMN_MAX_WIDTH = 40;
/** Visual gap between the options column and the preview column in side-by-side layout. */
export const PREVIEW_COLUMN_GAP = 2;
/** 1 col padding inside the preview column (between gap and `│`). */
export const PREVIEW_PADDING_LEFT = 1;
/** Empty rows between the options block and the preview block in stacked (narrow) layout. */
export const STACKED_GAP_ROWS = 1;
/** Top + bottom border rows consumed by `renderBorderedBox`. */
export const BORDER_VERTICAL_OVERHEAD = 2;
/** Left + right vertical bar columns (`│ ... │`) consumed by `renderBorderedBox`. */
export const BORDER_HORIZONTAL_OVERHEAD = 2;
/** Inner horizontal padding (1 col) between each border bar and the content area. */
export const BORDER_INNER_PADDING_HORIZONTAL = 1;
/** Floor for the preview box's inner content width — CC parity (`PreviewBox.minWidth`). */
export const BOX_MIN_CONTENT_WIDTH = 40;
/** 1 blank separator + 1 affordance text row reserved constantly when `hasAnyPreview` (height stability). */
export const NOTES_AFFORDANCE_OVERHEAD = 2;
/** Affordance text shown below the bordered preview when focused on a preview-bearing option. */
export const NOTES_AFFORDANCE_TEXT = "Notes: press n to add notes";

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FENCE_MARKER_RE = /^`{3}/;

/**
 * Drops fenced-code-block marker lines (`` ``` `` opener/closer) from rendered markdown
 * output. pi-tui's Markdown emits literal opening ` ```lang ` and closing ` ``` ` lines
 * around code blocks; this strip leaves only the highlighted code body. Inline code
 * (`codespan`) is unaffected — pi-tui already renders it without backticks.
 */
export function stripFenceMarkers(lines: readonly string[]): string[] {
	return lines.filter((line) => {
		const clean = line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "");
		return !FENCE_MARKER_RE.test(clean);
	});
}

export interface PreviewPaneConfig {
	items: readonly WrappingSelectItem[];
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	getTerminalWidth: () => number;
}

/**
 * Wraps `lines` in a 4-sided ASCII border with 1 col of inner horizontal padding on each side.
 * Layout per content row: `│` + ` ` + content padded to `contentInner` + ` ` + `│`,
 * where `contentInner = width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL`.
 * Top/bottom dash runs span corner-to-corner (`width - BORDER_HORIZONTAL_OVERHEAD`). When
 * `hidden > 0`, the bottom-row dash run is replaced with ` ✂ ── N lines hidden ── ` (corners stay).
 */
export function renderBorderedBox(
	lines: readonly string[],
	width: number,
	colorFn: (s: string) => string,
	hidden = 0,
): string[] {
	const dashSpan = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD);
	const contentInner = Math.max(1, dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL);
	const pad = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
	const top = colorFn(`┌${"─".repeat(dashSpan)}┐`);
	const out: string[] = [top];
	for (const line of lines) {
		const padded = truncateToWidth(line, contentInner, "", true);
		out.push(`${colorFn("│")}${pad}${padded}${pad}${colorFn("│")}`);
	}
	if (hidden > 0) {
		const indicator = ` ✂ ── ${hidden} lines hidden ── `;
		const space = dashSpan - indicator.length;
		const leftFill = "─".repeat(Math.max(0, Math.floor(space / 2)));
		const rightFill = "─".repeat(Math.max(0, dashSpan - leftFill.length - indicator.length));
		out.push(colorFn(`└${leftFill}${indicator}${rightFill}┘`));
	} else {
		out.push(colorFn(`└${"─".repeat(dashSpan)}┘`));
	}
	return out;
}

export class PreviewPane implements Component {
	private readonly question: QuestionData;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly getTerminalWidth: () => number;
	private readonly options: WrappingSelect;
	private readonly previewTexts: Map<number, string>;
	private readonly markdownCache: Map<number, Markdown>;
	private cachedWidth: number | undefined;
	private selectedIndex = 0;
	private focused = false;
	private notesVisible = false;

	constructor(config: PreviewPaneConfig) {
		this.question = config.question;
		this.theme = config.theme;
		this.markdownTheme = config.markdownTheme;
		this.getTerminalWidth = config.getTerminalWidth;

		const selectTheme: WrappingSelectTheme = {
			selectedText: (t) => this.theme.fg("accent", this.theme.bold(t)),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
		};
		// Reserve a slot for the chat row so the number column is wide enough whether or not the
		// user navigates into chat. Chat row uses (items.length + 1); options use 1..items.length.
		this.options = new WrappingSelect(config.items, Math.min(config.items.length, MAX_VISIBLE_OPTIONS), selectTheme, {
			numberStartOffset: 0,
			totalItemsForNumbering: config.items.length + 1,
		});

		this.previewTexts = new Map();
		for (let i = 0; i < config.question.options.length; i++) {
			const raw = config.question.options[i]?.preview;
			if (raw && raw.length > 0) this.previewTexts.set(i, raw);
		}
		this.markdownCache = new Map();
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = index;
		this.options.setSelectedIndex(index);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.options.setFocused(focused);
	}

	setNotesVisible(visible: boolean): void {
		this.notesVisible = visible;
	}

	invalidateCache(): void {
		for (const md of this.markdownCache.values()) md.invalidate();
		this.cachedWidth = undefined;
	}

	getInputBuffer(): string {
		return this.options.getInputBuffer();
	}

	appendInput(text: string): void {
		this.options.appendInput(text);
	}

	backspaceInput(): void {
		this.options.backspaceInput();
	}

	clearInputBuffer(): void {
		this.options.clearInputBuffer();
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.invalidateCache();
		this.options.invalidate();
	}

	/**
	 * True when at least one option in this question carries a `preview` string.
	 * Drives the "hide preview pane when no option provides a preview" rule from the spec.
	 */
	private hasAnyPreview(): boolean {
		return this.previewTexts.size > 0;
	}

	/**
	 * Width allocation for side-by-side mode:
	 *   leftWidth  = min(PREVIEW_LEFT_COLUMN_MAX_WIDTH, width - gap - 1)
	 *   rightWidth = remainder after left + gap
	 * The Math.max(1, …) calls keep both columns >= 1 col wide on extreme inputs.
	 */
	private sideBySideWidths(width: number): { leftWidth: number; rightWidth: number; gap: number } {
		const gap = PREVIEW_COLUMN_GAP;
		const leftWidth = Math.min(PREVIEW_LEFT_COLUMN_MAX_WIDTH, Math.max(1, width - gap - 1));
		const rightWidth = Math.max(1, width - leftWidth - gap);
		return { leftWidth, rightWidth, gap };
	}

	render(width: number): string[] {
		if (this.question.multiSelect === true) {
			return this.options.render(width);
		}
		// Spec: hide the preview pane entirely when no option in this question provides a preview.
		if (!this.hasAnyPreview()) {
			return this.options.render(width);
		}

		const sideBySide = this.getTerminalWidth() >= PREVIEW_MIN_WIDTH && width >= PREVIEW_MIN_WIDTH;

		if (sideBySide) {
			return this.renderSideBySide(width);
		}

		// Stacked: options, then a blank gap row, then the preview block. The stacked branch
		// uses MAX_PREVIEW_HEIGHT_STACKED — communicated via `useFullCap = false`.
		return [
			...this.options.render(width),
			...Array(STACKED_GAP_ROWS).fill(""),
			...this.renderPreviewLines(width, false),
		];
	}

	/**
	 * Height of THIS render, given the currently-selected option. Used by the
	 * residual spacer to know how many rows the body actually consumes RIGHT NOW.
	 *
	 * IMPORTANT: must mirror the per-column widths used in `render()` exactly,
	 * otherwise the markdown wraps differently here and inside the body and the
	 * residual spacer over- or under-shoots — visible as dialog "jumping" when
	 * the user arrows between options.
	 */
	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) {
			return this.options.render(width).length;
		}
		if (!this.hasAnyPreview()) return this.options.render(width).length;
		const sideBySide = this.getTerminalWidth() >= PREVIEW_MIN_WIDTH && width >= PREVIEW_MIN_WIDTH;
		const { optionsWidth, previewWidth } = this.layoutWidths(width, sideBySide);
		const optionsHeight = this.options.render(optionsWidth).length;
		// Cap tracks the LAYOUT decision (sideBySide vs stacked), not the column width.
		// Pass `sideBySide` through as `useFullCap` so the helper picks the right cap.
		const previewBlock = this.previewBlockHeight(previewWidth, this.selectedIndex, sideBySide);
		if (sideBySide) return Math.max(optionsHeight, previewBlock);
		return optionsHeight + STACKED_GAP_ROWS + previewBlock;
	}

	/**
	 * Worst-case height across ALL options for this question. Used by the global
	 * dialog-height computation so the overall footprint covers every tab's
	 * tallest option-preview combination.
	 */
	maxNaturalHeight(width: number): number {
		if (this.question.multiSelect === true) {
			return this.options.render(width).length;
		}
		if (!this.hasAnyPreview()) return this.options.render(width).length;
		const sideBySide = this.getTerminalWidth() >= PREVIEW_MIN_WIDTH && width >= PREVIEW_MIN_WIDTH;
		const { optionsWidth, previewWidth } = this.layoutWidths(width, sideBySide);
		const optionsHeight = this.options.render(optionsWidth).length;
		let maxPreviewBlock = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const h = this.previewBlockHeight(previewWidth, i, sideBySide);
			if (h > maxPreviewBlock) maxPreviewBlock = h;
		}
		if (sideBySide) return Math.max(optionsHeight, maxPreviewBlock);
		return optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
	}

	/**
	 * Returns the widths actually passed to `this.options.render(...)` and
	 * `this.renderPreviewLines(...)` inside `render()`. Stacked mode uses the
	 * full pane width for both; side-by-side splits into a capped left column
	 * and a right column where the preview is offset by PREVIEW_PADDING_LEFT.
	 */
	private layoutWidths(width: number, sideBySide: boolean): { optionsWidth: number; previewWidth: number } {
		if (!sideBySide) return { optionsWidth: width, previewWidth: width };
		const { leftWidth, rightWidth } = this.sideBySideWidths(width);
		return { optionsWidth: leftWidth, previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT) };
	}

	/**
	 * Height (in rendered rows) of the preview block for a given option index:
	 * border + content (capped) + notes-affordance footer. The MAX_PREVIEW_HEIGHT_*
	 * cap remains the upper bound; below that we hug actual markdown rows so short
	 * previews no longer pad the bordered box with `""` rows. `width` here is the
	 * width passed to `renderPreviewLines` — see `layoutWidths()`. `useFullCap`
	 * is the LAYOUT decision threaded down from `render()` / `naturalHeight()` so
	 * the cap matches the layout instead of being re-derived from column width
	 * (which would always pick the stacked cap once side-by-side splits the pane).
	 */
	private previewBlockHeight(width: number, optionIndex: number, useFullCap: boolean): number {
		const cap = useFullCap ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
		const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
		const innerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
		const rawRows = this.computePreviewBodyFor(optionIndex, innerWidth).length;
		const contentRows = Math.min(rawRows, contentBudget);
		return BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD;
	}

	/**
	 * Renders the side-by-side layout manually (rather than via Columns) so we can pin the
	 * options column to a fixed max width (PREVIEW_LEFT_COLUMN_MAX_WIDTH) regardless of total
	 * dialog width — instead of a ratio split.
	 */
	private renderSideBySide(width: number): string[] {
		const { leftWidth, rightWidth, gap } = this.sideBySideWidths(width);
		const leftLines = this.options.render(leftWidth);
		// Side-by-side branch → the preview gets MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE (full cap).
		const rightLines = this.renderPaddedPreviewLines(rightWidth, true);
		const rows = Math.max(leftLines.length, rightLines.length);
		const gapStr = " ".repeat(gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const leftRaw = leftLines[i] ?? "";
			const rightRaw = rightLines[i] ?? "";
			const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
			const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
			const joined = `${leftClamped}${leftPad}${gapStr}${rightRaw}`;
			out.push(truncateToWidth(joined, width, ""));
		}
		return out;
	}

	private renderPreviewLines(width: number, useFullCap: boolean): string[] {
		if (this.cachedWidth !== width) {
			for (const md of this.markdownCache.values()) md.invalidate();
			this.cachedWidth = width;
		}

		const cap = useFullCap ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
		const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
		const maxInnerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);

		// Hug actual content rows; cap (with truncation indicator) is the only upper bound.
		// No more "pad short previews to contentBudget with empty rows" — the bordered box
		// shrinks to fit, and the dialog-level residual spacer absorbs the height difference.
		const raw = this.computePreviewBodyFor(this.selectedIndex, maxInnerWidth);
		const truncated = raw.length > contentBudget;
		const hidden = truncated ? raw.length - contentBudget : 0;
		const contentLines = truncated ? raw.slice(0, contentBudget) : raw;

		// Per-option box sizing (CC parity: `contentWidth = max(minWidth, widestRenderedLine)`,
		// `boxWidth = min(contentWidth + 4, effectiveMaxWidth)`). Box hugs THIS option's widest
		// visible line, floored at BOX_MIN_CONTENT_WIDTH and capped at maxInnerWidth. Trailing
		// whitespace is stripped before measuring because pi-tui's `Markdown.render(width)` pads
		// every line to `width` (markdown.js — `paddingNeeded = width - visibleLen`), which would
		// otherwise force the box to fill the whole column allocation.
		let widest = Math.min(BOX_MIN_CONTENT_WIDTH, maxInnerWidth);
		for (const line of contentLines) {
			const w = visibleWidth(line.replace(/\s+$/, ""));
			if (w > widest) widest = w;
		}
		const innerWidth = Math.min(widest, maxInnerWidth);
		const boxWidth = innerWidth + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL;

		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);

		// Notes affordance row — reserved CONSTANTLY when hasAnyPreview (height stability of
		// the affordance row's offset relative to the box). Text appears only when focused on a
		// preview-bearing option AND not in notes mode.
		const showAffordance = this.focused && !this.notesVisible && this.previewTexts.has(this.selectedIndex);
		const affordance = showAffordance ? this.theme.fg("muted", NOTES_AFFORDANCE_TEXT) : "";
		return [...boxedLines, "", affordance];
	}

	private renderPaddedPreviewLines(colWidth: number, useFullCap: boolean): string[] {
		const contentLines = this.renderPreviewLines(Math.max(1, colWidth - PREVIEW_PADDING_LEFT), useFullCap);
		const pad = " ".repeat(PREVIEW_PADDING_LEFT);
		return contentLines.map((l) => (l === "" ? "" : `${pad}${l}`));
	}

	private computePreviewBodyFor(optionIndex: number, width: number): string[] {
		const text = this.previewTexts.get(optionIndex);
		if (!text) {
			const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
			const pad = Math.max(0, width - visibleWidth(placeholder));
			return [placeholder + " ".repeat(pad)];
		}
		let md = this.markdownCache.get(optionIndex);
		if (!md) {
			md = new Markdown(text, 0, 0, this.markdownTheme);
			this.markdownCache.set(optionIndex, md);
		}
		return stripFenceMarkers(md.render(width));
	}
}
