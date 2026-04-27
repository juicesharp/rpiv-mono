import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { QuestionData } from "./types.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

export const PREVIEW_MIN_WIDTH = 100;
export const MAX_PREVIEW_HEIGHT = 15;
export const NO_PREVIEW_TEXT = "No preview available";
export const MAX_VISIBLE_OPTIONS = 10;
/** Max width of the options column when a side-by-side preview is shown. */
export const PREVIEW_LEFT_COLUMN_MAX_WIDTH = 40;
/** Visual gap between the options column and the preview column in side-by-side layout. */
export const PREVIEW_COLUMN_GAP = 2;
/** Padding inside the preview column — one blank line on top, one space on the left. */
export const PREVIEW_PADDING_TOP = 1;
export const PREVIEW_PADDING_LEFT = 1;
/** Empty rows between the options block and the preview block in stacked (narrow) layout. */
export const STACKED_GAP_ROWS = 1;

export interface PreviewPaneConfig {
	items: readonly WrappingSelectItem[];
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	getTerminalWidth: () => number;
}

function oneLine(s: string): string {
	return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
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
			if (raw && raw.length > 0) this.previewTexts.set(i, oneLine(raw));
		}
		this.markdownCache = new Map();
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = index;
		this.options.setSelectedIndex(index);
	}

	setFocused(focused: boolean): void {
		this.options.setFocused(focused);
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

		// Stacked: options, then a blank gap row, then the preview block.
		return [...this.options.render(width), ...Array(STACKED_GAP_ROWS).fill(""), ...this.renderPreviewLines(width)];
	}

	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) {
			return this.options.render(width).length;
		}
		const optionsHeight = this.options.render(width).length;
		if (!this.hasAnyPreview()) {
			return optionsHeight;
		}
		const sideBySide = this.getTerminalWidth() >= PREVIEW_MIN_WIDTH && width >= PREVIEW_MIN_WIDTH;
		if (sideBySide) {
			return Math.max(optionsHeight, MAX_PREVIEW_HEIGHT);
		}
		return optionsHeight + STACKED_GAP_ROWS + MAX_PREVIEW_HEIGHT;
	}

	/**
	 * Renders the side-by-side layout manually (rather than via Columns) so we can pin the
	 * options column to a fixed max width (PREVIEW_LEFT_COLUMN_MAX_WIDTH) regardless of total
	 * dialog width — instead of a ratio split.
	 */
	private renderSideBySide(width: number): string[] {
		const { leftWidth, rightWidth, gap } = this.sideBySideWidths(width);
		const leftLines = this.options.render(leftWidth);
		const rightLines = this.renderPaddedPreviewLines(rightWidth);
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

	private renderPreviewLines(width: number): string[] {
		if (this.cachedWidth !== width) {
			for (const md of this.markdownCache.values()) md.invalidate();
			this.cachedWidth = width;
		}

		const raw: string[] = this.computePreviewBody(width);
		const clamped = raw.map((line) => truncateToWidth(line, width, ""));
		const trimmed = clamped.length > MAX_PREVIEW_HEIGHT ? clamped.slice(0, MAX_PREVIEW_HEIGHT) : clamped;
		while (trimmed.length < MAX_PREVIEW_HEIGHT) trimmed.push("");
		return trimmed;
	}

	/**
	 * Side-by-side preview block with `padding-top` (PREVIEW_PADDING_TOP empty rows on top) and
	 * `padding-left` (PREVIEW_PADDING_LEFT spaces in front of every non-empty content row).
	 * The total height is still MAX_PREVIEW_HEIGHT so the dialog body stays a stable size.
	 */
	private renderPaddedPreviewLines(colWidth: number): string[] {
		const innerWidth = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.renderPreviewLines(innerWidth);
		const pad = " ".repeat(PREVIEW_PADDING_LEFT);
		const body = contentLines.map((l) => (l === "" ? "" : `${pad}${l}`));
		const topPad: string[] = Array(PREVIEW_PADDING_TOP).fill("");
		const combined = [...topPad, ...body];
		const trimmed = combined.length > MAX_PREVIEW_HEIGHT ? combined.slice(0, MAX_PREVIEW_HEIGHT) : combined;
		while (trimmed.length < MAX_PREVIEW_HEIGHT) trimmed.push("");
		return trimmed;
	}

	private computePreviewBody(width: number): string[] {
		const text = this.previewTexts.get(this.selectedIndex);
		if (!text) {
			const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
			const pad = Math.max(0, width - visibleWidth(placeholder));
			return [placeholder + " ".repeat(pad)];
		}
		let md = this.markdownCache.get(this.selectedIndex);
		if (!md) {
			md = new Markdown(text, 0, 0, this.markdownTheme);
			this.markdownCache.set(this.selectedIndex, md);
		}
		return md.render(width);
	}
}
