import { CURSOR_MARKER, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Grapheme-aware extraction at the cursor: pi-tui's Editor reports UTF-16
// line/column positions, so the cursor can land between code units of one cluster
// (emoji, ZWJ, combining marks). Single-code-unit slicing would split the cluster
// across the SGR 7/27 boundary. Both single- and multi-select views share this
// cursor-building core.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RenderInlineInputOptions {
	/** Live inline-input buffer. */
	buffer: string;
	/** Cursor offset; `undefined` / out-of-range → end-of-buffer fallback. */
	cursorOffset: number | undefined;
	/** Prefix for the first emitted line (e.g. `❯ 4. `). */
	rowPrefix: string;
	/** Prefix for continuation lines (whitespace of equal visible width). */
	continuationPrefix: string;
	/** Visible columns available for the buffer content (width − prefix width). */
	contentWidth: number;
	/** Per-line styling (single-select: `theme.selectedText`; multi-select: accent+bold). */
	selectedText: (text: string) => string;
}

/**
 * Resolve the cursor offset, falling back to end-of-buffer for `undefined`/out-of-range.
 * Mirrors the original wrapping-select.resolveOffset exactly.
 */
function resolveCursorOffset(buffer: string, requested: number | undefined): number {
	if (requested !== undefined && requested >= 0 && requested <= buffer.length) return requested;
	return buffer.length;
}

/**
 * Build the cursor-marked raw string for the whole buffer: `before | CURSOR_MARKER |
 * SGR-7 reverse-video cell | SGR-27 | after`. The cell UNDER the cursor is the single
 * grapheme at the offset (or U+00A0 NBSP at end-of-buffer / on a literal space — NBSP is
 * wrap-safe where a literal space would tokenize as a wrap break). Zero characters shift;
 * the column under the cursor inverts. `CURSOR_MARKER` is zero-width so wrap/truncate math
 * is preserved.
 */
function buildCursorRaw(buffer: string, offset: number): string {
	const before = buffer.slice(0, offset);
	const [firstGrapheme] = graphemeSegmenter.segment(buffer.slice(offset));
	const rawAt = firstGrapheme ? firstGrapheme.segment : "";
	// A logical newline has no visible cell. Draw the cursor on an NBSP immediately
	// before it and leave the newline unconsumed so the next logical line still renders.
	const cursorAtLineEnd = rawAt === "\n";
	const atCursor = rawAt === "" || rawAt === " " || cursorAtLineEnd ? "\xa0" : rawAt;
	const after = buffer.slice(offset + (cursorAtLineEnd ? 0 : rawAt.length));
	return `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
}

/**
 * Render the inline editor across logical and visually wrapped lines.
 * Cursor visualization follows Pi's editor pattern: reverse-video on the cell at
 * the cursor, with a non-breaking-space cell at end-of-line/end-of-buffer.
 */
export function renderInlineInputRow(opts: RenderInlineInputOptions): string[] {
	const { buffer, cursorOffset, rowPrefix, continuationPrefix, contentWidth, selectedText } = opts;
	const raw = buildCursorRaw(buffer, resolveCursorOffset(buffer, cursorOffset));
	return wrapTextWithAnsi(raw, contentWidth).map((segment, index) => {
		const prefix = index === 0 ? rowPrefix : continuationPrefix;
		return selectedText(`${prefix}${segment}`);
	});
}
