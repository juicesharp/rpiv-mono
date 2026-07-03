import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayLabel } from "../../state/i18n-bridge.js";
import type { QuestionData } from "../../tool/types.js";
import type { StatefulView } from "../stateful-view.js";
import { renderInlineInputRow } from "./inline-input.js";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const CHECKED = "[✔]";
const UNCHECKED = "[ ]";
const NUMBER_SEPARATOR = ". ";
const BOX_LABEL_GAP = " ";
// CC parity: description continuation indents to col 2 (past the pointer slot), NOT to the
// full prefix column. Wrap width still uses prefixVisibleWidth so naturalHeight matches render.
const CONTINUATION_INDENT = "  ";

export const MULTI_SUBMIT_LABEL = "Submit";

export interface MultiSelectOtherRowProps {
	/** The "Type something." row is the focused row (optionIndex === options.length). */
	active: boolean;
	/** `state.inputMode` — true once the row has focus and keystrokes append to the buffer. */
	inputMode: boolean;
	/** Live inline-input buffer (read from `runtime.inputBuffer` / `ctx.inputBuffer`). */
	inputBuffer: string;
	inputCursorOffset: number | undefined;
}

export interface MultiSelectViewProps {
	rows: ReadonlyArray<{ checked: boolean; active: boolean }>;
	other: MultiSelectOtherRowProps;
	nextActive: boolean;
	nextLabel: string;
}

/**
 * Renders the multi-select option list (one row per option — pointer + checkbox + label —
 * plus zero or more wrapped continuation lines per description).
 *
 * `naturalHeight(width)` is state-INDEPENDENT (depends only on theme glyph widths,
 * question.options, and width) so the host can compute a stable globalContentHeight
 * without rendering. `naturalHeight(w) === render(w).length` for every props.
 *
 * `setProps(props)` is a pure field reassignment — no render, no invalidate side effects.
 */
export class MultiSelectView implements StatefulView<MultiSelectViewProps> {
	private props: MultiSelectViewProps;

	constructor(
		private readonly theme: Theme,
		private readonly question: QuestionData,
	) {
		this.props = {
			rows: [],
			other: { active: false, inputMode: false, inputBuffer: "", inputCursorOffset: undefined },
			nextActive: false,
			nextLabel: displayLabel("next"),
		};
	}

	setProps(props: MultiSelectViewProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const prefixWidth = this.prefixVisibleWidth();
		const contentWidth = Math.max(1, width - prefixWidth);
		const numberWidth = String(Math.max(1, this.question.options.length + 1)).length;
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			const row = this.props.rows[i];
			if (!opt || !row) continue;
			const pointer = row.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
			// Checked uses the same `accent` hue as the active-row label so checked rows read
			// as "selected" rather than "success" — matches the visual rhythm of the rest of
			// the dialog (active pointer, label, picker rows are all accent).
			const box = row.checked ? this.theme.fg("accent", CHECKED) : this.theme.fg("muted", UNCHECKED);
			const label = truncateToWidth(opt.label, contentWidth, "…");
			const styledLabel = row.active ? this.theme.fg("accent", this.theme.bold(label)) : label;
			const num = String(i + 1).padStart(numberWidth, " ");
			const line = `${pointer}${num}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}${styledLabel}`;
			lines.push(truncateToWidth(line, width, ""));
			if (opt.description) {
				const wrapped = wrapTextWithAnsi(opt.description, contentWidth);
				for (const segment of wrapped) {
					lines.push(CONTINUATION_INDENT + this.theme.fg("muted", segment));
				}
			}
		}

		// "Type something." row — numbered N+1, box always [ ] muted UNCHECKED (never checkable).
		// When focused + inputMode, render the label slot via the shared inline-input helper
		// (single-line); otherwise a static localized label truncated to contentWidth with `…`.
		const other = this.props.other;
		const otherPointer = other.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const otherBox = this.theme.fg("muted", UNCHECKED);
		const otherNum = String(this.question.options.length + 1).padStart(numberWidth, " ");
		let otherLabel: string;
		if (other.active && other.inputMode) {
			const rendered = renderInlineInputRow({
				buffer: other.inputBuffer,
				cursorOffset: other.inputCursorOffset,
				rowPrefix: "",
				continuationPrefix: "",
				contentWidth,
				selectedText: (t) => this.theme.fg("accent", this.theme.bold(t)),
				multiline: false,
			});
			otherLabel = rendered[0] ?? "";
		} else {
			const label = truncateToWidth(displayLabel("other"), contentWidth, "…");
			otherLabel = other.active ? this.theme.fg("accent", this.theme.bold(label)) : label;
		}
		lines.push(
			truncateToWidth(
				`${otherPointer}${otherNum}${NUMBER_SEPARATOR}${otherBox}${BOX_LABEL_GAP}${otherLabel}`,
				width,
				"",
			),
		);

		const nextPointer = this.props.nextActive ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const nextLabel = this.props.nextActive
			? this.theme.fg("accent", this.theme.bold(this.props.nextLabel))
			: this.props.nextLabel;
		lines.push(truncateToWidth(`${nextPointer}${nextLabel}`, width, ""));
		return lines;
	}

	/**
	 * Returns the [startRow, endRow) range of the active (focused) row within
	 * `render(width)`. Labels are always 1 row (truncated); descriptions wrap.
	 */
	focusedItemRowRange(width: number): [number, number] {
		const prefixWidth = this.prefixVisibleWidth();
		const contentWidth = Math.max(1, width - prefixWidth);
		let row = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			const r = this.props.rows[i];
			if (!opt || !r) continue;
			const itemHeight = 1 + (opt.description ? wrapTextWithAnsi(opt.description, contentWidth).length : 0);
			if (r.active) {
				return [row, row + itemHeight];
			}
			row += itemHeight;
		}
		// "Type something." row is always exactly 1 line (truncated, no description).
		if (this.props.other.active) {
			return [row, row + 1];
		}
		row += 1;
		if (this.props.nextActive) {
			return [row, row + 1];
		}
		return [0, 0];
	}

	naturalHeight(width: number): number {
		const contentWidth = Math.max(1, width - this.prefixVisibleWidth());
		let total = 0;
		for (const opt of this.question.options) {
			if (!opt) continue;
			total += 1; // row line
			if (opt.description) {
				total += wrapTextWithAnsi(opt.description, contentWidth).length;
			}
		}
		return total + 2; // "Type something." row + Next sentinel row (neither wraps).
	}

	private prefixVisibleWidth(): number {
		// Canonical prefix for OPTION rows: INACTIVE_POINTER + numberWidth digits + NUMBER_SEPARATOR
		// + UNCHECKED + BOX_LABEL_GAP. State-independent because ACTIVE/INACTIVE pointer share
		// visibleWidth, CHECKED/UNCHECKED share visibleWidth, and numberWidth is constant per question.
		// The number column fits `options.length + 1` so the "Type something." row's N+1 number
		// is never clipped. The Next sentinel uses a bare `pointer + "Next"` shape — its width
		// never exceeds this prefix at any reasonable terminal width, so it's safe to leave it
		// out of the canonical computation.
		const numberWidth = String(Math.max(1, this.question.options.length + 1)).length;
		return (
			visibleWidth(INACTIVE_POINTER) + numberWidth + visibleWidth(`${NUMBER_SEPARATOR}${UNCHECKED}${BOX_LABEL_GAP}`)
		);
	}
}
