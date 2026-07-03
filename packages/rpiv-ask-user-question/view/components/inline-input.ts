import { CURSOR_MARKER, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Grapheme-aware extraction at the cursor: pi-tui's Input advances `cursor` by
// grapheme-cluster code-unit length, so the cursor can land between code units of
// one cluster (emoji, ZWJ, combining marks). Single-code-unit slicing would split
// the cluster across the SGR 7/27 boundary. Moved here from wrapping-select.ts so
// both the single-select (wrap) and multi-select (truncate-to-one-line) inline
// inputs share one cursor-building core.
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
	/**
	 * `true` (single-select): wrap across lines at `contentWidth` (byte-identical to the
	 * pre-extraction wrapping-select behavior).
	 * `false` (multi-select): collapse to ONE line — truncate the plain buffer to
	 * `contentWidth` with `…` when the cursor-marked content would overflow, keeping the
	 * dialog height state-independent. The cursor is clipped past the visible window
	 * (accepted trade): when the cursor-marked content fits it is rendered in full.
	 */
	multiline: boolean;
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
	// NBSP (U+00A0) fallback: visually identical to a space, wrap-safe.
	const atCursor = rawAt === "" || rawAt === " " ? "\xa0" : rawAt;
	const after = buffer.slice(offset + rawAt.length);
	return `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
}

/**
 * Render the inline-input row. `multiline: true` wraps (single-select, byte-identical to
 * the pre-extraction output); `multiline: false` collapses to a single line.
 *
 * Cursor visualization follows the standard TUI input-widget pattern (ECMA-48 SGR 7
 * reverse-video on the cell AT the cursor, not an inserted glyph) — same approach used by
 * pi-tui Input.render, ink-text-input, terkelg/prompts, ratatui's user-input example.
 */
export function renderInlineInputRow(opts: RenderInlineInputOptions): string[] {
	const { buffer, cursorOffset, rowPrefix, continuationPrefix, contentWidth, selectedText, multiline } = opts;
	const offset = resolveCursorOffset(buffer, cursorOffset);

	if (multiline) {
		// Single-select: wrap at contentWidth. Byte-identical to the original
		// wrapping-select.renderInlineInputRow output (same raw, same wrapTextWithAnsi,
		// same prefix/selectedText per line).
		const raw = buildCursorRaw(buffer, offset);
		const wrapped = wrapTextWithAnsi(raw, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			return selectedText(`${prefix}${segment}`);
		});
	}

	// Multi-select: single line. Build the cursor markup on the full buffer; if it fits
	// contentWidth, emit it as one line. If it overflows, fall back to truncating the PLAIN
	// buffer (ANSI-safe — never cut a CURSOR_MARKER/SGR sequence) with `…` and clip the
	// cursor. This keeps the row at exactly one line so naturalHeight stays state-independent.
	const cursorRaw = buildCursorRaw(buffer, offset);
	if (visibleWidth(cursorRaw) <= contentWidth) {
		return [selectedText(`${rowPrefix}${cursorRaw}`)];
	}
	const clipped = truncateToWidth(buffer, contentWidth, "…");
	return [selectedText(`${rowPrefix}${clipped}`)];
}
