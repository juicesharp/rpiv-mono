import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Scroll-window row math shared by `DialogView` (the dialog's middle region) and
 * `PreviewPane` (an options column fitted to the row allowance the dialog gives it) —
 * one implementation, so both windows centre, clamp and mark overflow identically.
 */

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

/** Scroll window start, centered on the focused option; top-anchored when there is no interactive focus. */
export function computeScrollStart(
	bodyRange: [number, number] | undefined,
	rowsBeforeBody: number,
	availableMiddle: number,
	middleRows: number,
): number {
	if (!bodyRange) return 0;
	const focusedRowInMiddle = rowsBeforeBody + bodyRange[0];
	const focusedHeight = bodyRange[1] - bodyRange[0];
	// Center the focused item vertically in the available middle space.
	const idealStart = focusedRowInMiddle - Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
	return Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
}

/**
 * Mark the scroll window edges with overflow arrows; combined ↕ on a single-row middle.
 * An arrow replaces the row it lands on, so rows inside `protectedRows` (the focused item,
 * in window coordinates, end-exclusive) are never drawn over — losing the affordance beats
 * losing the row the user is on (#261).
 */
export function decorateOverflow(
	scrollableMiddle: string[],
	hasUp: boolean,
	hasDown: boolean,
	theme: Theme,
	protectedRows: readonly [number, number] | undefined,
): void {
	const drawable = (row: number) => !protectedRows || row < protectedRows[0] || row >= protectedRows[1];
	if (hasUp && hasDown && scrollableMiddle.length === 1) {
		// Single-row middle: combined ↕ avoids the prior collision where ↓ overwrote ↑.
		if (drawable(0)) scrollableMiddle[0] = theme.fg("dim", OVERFLOW_BOTH);
		return;
	}
	if (hasUp && scrollableMiddle.length > 0 && drawable(0)) {
		scrollableMiddle[0] = theme.fg("dim", OVERFLOW_UP);
	}
	const last = scrollableMiddle.length - 1;
	if (hasDown && last > 0 && drawable(last)) {
		scrollableMiddle[last] = theme.fg("dim", OVERFLOW_DOWN);
	}
}

/**
 * Window `lines` to at most `rows` rows, centred on `focus` (end-exclusive row range),
 * with overflow arrows that never cover the focused rows. Returns the visible lines and
 * the focus range in window coordinates. Lines that already fit are returned unchanged.
 */
export function windowLines(
	lines: readonly string[],
	rows: number,
	focus: [number, number] | undefined,
	theme: Theme,
): { lines: string[]; focus: [number, number] | undefined } {
	if (lines.length <= rows) return { lines: [...lines], focus };
	const start = computeScrollStart(focus, 0, rows, lines.length);
	const visible = lines.slice(start, start + rows);
	const inWindow: [number, number] | undefined = focus && [focus[0] - start, focus[1] - start];
	decorateOverflow(visible, start > 0, start + rows < lines.length, theme, inWindow);
	return { lines: visible, focus: inWindow };
}
