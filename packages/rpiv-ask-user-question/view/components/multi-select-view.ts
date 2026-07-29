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
 * `naturalHeight(width)` is the rendered height for the current props. It grows when
 * the custom-answer editor contains logical or visually wrapped lines, allowing the
 * dialog to reserve exactly the space the active draft needs.
 *
 * One width-keyed layout supplies rendering, height, and focused-row measurement;
 * `setProps` and `invalidate` discard that derived cache.
 */
interface MultiSelectLayout {
	lines: string[];
	focusedRange: [number, number];
}

export class MultiSelectView implements StatefulView<MultiSelectViewProps> {
	private props: MultiSelectViewProps;
	private cachedLayout: { width: number; value: MultiSelectLayout } | undefined;

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
		this.cachedLayout = undefined;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.cachedLayout = undefined;
	}

	render(width: number): string[] {
		return this.layout(width).lines;
	}

	focusedItemRowRange(width: number): [number, number] {
		return this.layout(width).focusedRange;
	}

	naturalHeight(width: number): number {
		return this.layout(width).lines.length;
	}

	private layout(width: number): MultiSelectLayout {
		if (this.cachedLayout?.width === width) return this.cachedLayout.value;

		const lines: string[] = [];
		let focusedRange: [number, number] = [0, 0];
		const contentWidth = Math.max(1, width - this.prefixVisibleWidth());
		const numberWidth = String(Math.max(1, this.question.options.length + 1)).length;
		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i];
			const row = this.props.rows[i];
			if (!opt || !row) continue;
			const start = lines.length;
			const pointer = row.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
			// Checked and active rows share the accent hue, matching the dialog's selection rhythm.
			const box = row.checked ? this.theme.fg("accent", CHECKED) : this.theme.fg("muted", UNCHECKED);
			const label = truncateToWidth(opt.label, contentWidth, "…");
			const styledLabel = row.active ? this.theme.fg("accent", this.theme.bold(label)) : label;
			const number = String(i + 1).padStart(numberWidth, " ");
			lines.push(
				truncateToWidth(`${pointer}${number}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}${styledLabel}`, width, ""),
			);
			if (opt.description) {
				for (const segment of wrapTextWithAnsi(opt.description, contentWidth)) {
					lines.push(CONTINUATION_INDENT + this.theme.fg("muted", segment));
				}
			}
			if (row.active) focusedRange = [start, lines.length];
		}

		const otherStart = lines.length;
		lines.push(...this.renderOtherRow(contentWidth, numberWidth));
		if (this.props.other.active) focusedRange = [otherStart, lines.length];

		const nextStart = lines.length;
		const nextPointer = this.props.nextActive ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const nextLabel = this.props.nextActive
			? this.theme.fg("accent", this.theme.bold(this.props.nextLabel))
			: this.props.nextLabel;
		lines.push(truncateToWidth(`${nextPointer}${nextLabel}`, width, ""));
		if (this.props.nextActive) focusedRange = [nextStart, lines.length];

		const value = { lines, focusedRange };
		this.cachedLayout = { width, value };
		return value;
	}

	private renderOtherRow(contentWidth: number, numberWidth: number): string[] {
		const other = this.props.other;
		const pointer = other.active ? this.theme.fg("accent", ACTIVE_POINTER) : INACTIVE_POINTER;
		const box = this.theme.fg("muted", UNCHECKED);
		const number = String(this.question.options.length + 1).padStart(numberWidth, " ");
		const rowPrefix = `${pointer}${number}${NUMBER_SEPARATOR}${box}${BOX_LABEL_GAP}`;
		const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
		const selectedText = (text: string) => this.theme.fg("accent", this.theme.bold(text));

		if (other.active && other.inputMode) {
			return renderInlineInputRow({
				buffer: other.inputBuffer,
				cursorOffset: other.inputCursorOffset,
				rowPrefix,
				continuationPrefix,
				contentWidth,
				selectedText,
			});
		}

		return wrapTextWithAnsi(other.inputBuffer || displayLabel("other"), contentWidth).map((segment, index) => {
			const line = `${index === 0 ? rowPrefix : continuationPrefix}${segment}`;
			return other.active ? selectedText(line) : line;
		});
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
