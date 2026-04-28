import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { DialogState } from "./dialog-builder.js";
import type { QuestionData } from "./types.js";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const CHECKED = "[✔]";
const UNCHECKED = "[ ]";
const NUMBER_SEPARATOR = ". ";
const BOX_LABEL_GAP = " ";
// CC parity: description continuation indents to col 2 (past the pointer slot), NOT to the
// full prefix column. Wrap width still uses prefixVisibleWidth so naturalHeight matches render.
const CONTINUATION_INDENT = "  ";

/**
 * Renders the multi-select option list (one row per option — pointer + checkbox + label —
 * plus zero or more wrapped continuation lines per description).
 *
 * `naturalHeight(width)` is state-INDEPENDENT (depends only on theme glyph widths,
 * question.options, and width) so the host can compute a stable globalContentHeight
 * without rendering. `naturalHeight(w) === render(w).length` for every state.
 *
 * `setState(state)` is a pure field reassignment — no render, no invalidate side effects.
 */
export class MultiSelectOptions implements Component {
	private state: DialogState;
	/**
	 * When false, the active-row pointer (`❯`) and the active-row accent/bold styling are
	 * suppressed — every row renders as if it were inactive. Used by the host to avoid a
	 * "double cursor" effect when focus moves to the chat row (or notes input) below.
	 * Mirrors `WrappingSelect.setFocused()` semantics for visual parity.
	 */
	private focused = true;

	constructor(
		private readonly theme: Theme,
		private readonly question: QuestionData,
		initialState: DialogState,
	) {
		this.state = initialState;
	}

	setState(state: DialogState): void {
		this.state = state;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const prefixWidth = this.prefixVisibleWidth();
		const contentWidth = Math.max(1, width - prefixWidth);
		const numberWidth = String(Math.max(1, this.question.options.length)).length;
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			if (!opt) continue;
			const checked = this.state.multiSelectChecked.has(i);
			// Match WrappingSelect: only the SELECTED row in a FOCUSED list shows the active pointer
			// + accent label. Without this gate, the multi-select pane would render its `❯` even
			// while the user is on the chat row — producing the doubled-cursor screenshot.
			const active = this.focused && i === this.state.optionIndex;
			const pointer = active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
			const box = checked ? this.theme.fg("success", CHECKED) : this.theme.fg("muted", UNCHECKED);
			const label = truncateToWidth(opt.label, contentWidth, "…");
			const styledLabel = active ? this.theme.fg("accent", this.theme.bold(label)) : label;
			const num = String(i + 1).padStart(numberWidth, " ");
			const row = `${pointer}${num}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}${styledLabel}`;
			lines.push(truncateToWidth(row, width, ""));
			if (opt.description) {
				const wrapped = wrapTextWithAnsi(opt.description, contentWidth);
				for (const segment of wrapped) {
					lines.push(CONTINUATION_INDENT + this.theme.fg("muted", segment));
				}
			}
		}
		return lines;
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
		return total;
	}

	private prefixVisibleWidth(): number {
		// Canonical prefix: INACTIVE_POINTER + numberWidth digits + NUMBER_SEPARATOR + UNCHECKED + BOX_LABEL_GAP.
		// State-independent because ACTIVE/INACTIVE pointer share visibleWidth, CHECKED/UNCHECKED share
		// visibleWidth, and numberWidth is constant per question (derived from options.length).
		const numberWidth = String(Math.max(1, this.question.options.length)).length;
		return (
			visibleWidth(INACTIVE_POINTER) + numberWidth + visibleWidth(`${NUMBER_SEPARATOR}${UNCHECKED}${BOX_LABEL_GAP}`)
		);
	}
}
