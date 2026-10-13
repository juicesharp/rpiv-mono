import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.js";
import { windowLines } from "../../scroll-window.js";
import type { StatefulView } from "../../stateful-view.js";
import type { OptionListView } from "../option-list-view.js";
import type { NotesAffordance, PreviewBlockRenderer } from "./preview-block-renderer.js";
import {
	bodyWidths,
	columnWidths,
	decideLayout,
	PREVIEW_PADDING_LEFT,
	type PreviewLayoutMode,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.js";

/** Smallest preview box worth showing: top border, one content line, bottom border. */
const MIN_BOX_ROWS = 3;

// ----- Re-exports for test imports — keep `./preview-pane.js` as the public surface -----
export {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.js";
export { NOTES_AFFORDANCE_TEXT, NOTES_EDIT_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.js";
export {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	BOX_MIN_CONTENT_WIDTH,
	renderBorderedBox,
	stripFenceMarkers,
} from "./preview-box-renderer.js";
export {
	PREVIEW_COLUMN_GAP,
	PREVIEW_MIN_WIDTH,
	PREVIEW_PADDING_LEFT,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.js";

/**
 * Per-tick projection of PreviewPane state. Replaces the prior
 * `setNotesVisible(boolean)` sliver-setter and the sibling reads of
 * `optionListView.getSelectedIndex()` / `isFocused()`. The pane now reads
 * `selectedIndex` and `focused` from its own props — both derived from
 * canonical state via `selectPreviewPaneProps`. `OptionListView` and
 * `PreviewPane` see the same source of truth without the cross-component
 * live read.
 */
export interface PreviewPaneProps {
	notesVisible: boolean;
	/** The question carries a saved note — the affordance offers to edit it rather than add one (#197). */
	hasNote: boolean;
	selectedIndex: number;
	focused: boolean;
	/**
	 * True while the "other" (custom-answer) row is focused and accepting input
	 * (`state.inputMode`, set by the reducer via `ROW_INTENT_META.other.activatesInputMode`).
	 * Surfaced by `selectPreviewPaneProps` from canonical state; drives the full-width
	 * early-returns below so the inline input isn't cramped into the narrow left column.
	 */
	inputMode: boolean;
}

export interface PreviewPaneConfig {
	question: QuestionData;
	theme: Theme;
	getTerminalWidth: () => number;
	optionListView: OptionListView;
	previewBlock: PreviewBlockRenderer;
}

/**
 * Thin layout composer. Receives `selectedIndex` / `focused` / `notesVisible`
 * via `setProps` per tick (computed by `selectPreviewPaneProps` from canonical
 * state). Delegates option-side rendering to `OptionListView` (which still
 * owns its render-time state — input buffer, confirmedIndex) and preview-side
 * rendering to `PreviewBlockRenderer` (which owns the markdown cache and
 * bordered-box composition).
 *
 * `naturalHeight` and `maxNaturalHeight` query both children's heights; `render`
 * combines them via `decideLayout` (mode threaded into both calls — never
 * re-derived).
 */
export class PreviewPane implements StatefulView<PreviewPaneProps>, Component {
	private readonly question: QuestionData;
	private readonly getTerminalWidth: () => number;
	private readonly optionListView: OptionListView;
	private readonly previewBlock: PreviewBlockRenderer;
	private readonly theme: Theme;
	private props: PreviewPaneProps;
	/**
	 * Rows the dialog can give this body this frame, set by `DialogView` before each render;
	 * undefined when unconstrained. A body taller than this fits itself instead of being cut
	 * by the dialog's scroll window: the options scroll within their column around the focused
	 * option, and the preview box shrinks but always closes (#210).
	 */
	private rowAllowance: number | undefined;
	/**
	 * Cross-tab max left-width getter. Set exactly once by `buildQuestionnaire.injectGlobalLeftWidth`
	 * before any render. Initialized to a throwing sentinel so missing injection is a hard fail
	 * rather than a silent fallback to a magic constant — render is illegal until injected.
	 */
	private globalLeftWidth: (paneWidth: number) => number = () => {
		throw new Error("PreviewPane.setGlobalLeftWidth must be called before render()");
	};

	constructor(config: PreviewPaneConfig) {
		this.question = config.question;
		this.getTerminalWidth = config.getTerminalWidth;
		this.optionListView = config.optionListView;
		this.previewBlock = config.previewBlock;
		this.theme = config.theme;
		this.props = { notesVisible: false, hasNote: false, selectedIndex: 0, focused: false, inputMode: false };
	}

	setGlobalLeftWidth(getter: (paneWidth: number) => number): void {
		this.globalLeftWidth = getter;
	}

	private getAdaptiveLeft(paneWidth: number): number {
		return this.globalLeftWidth(paneWidth);
	}

	setProps(props: PreviewPaneProps): void {
		this.props = props;
	}

	/** Render-time geometry from `DialogView` (not canonical state, so not a prop). */
	/** The notes affordance under the preview: shown while focused with the notes editor closed. */
	private notesAffordance(): NotesAffordance {
		const { focused, notesVisible, hasNote } = this.props;
		if (!focused || notesVisible) return "none";
		return hasNote ? "edit" : "add";
	}

	setRowAllowance(rows: number | undefined): void {
		this.rowAllowance = rows;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.previewBlock.invalidate();
		this.optionListView.invalidate();
	}

	render(width: number): string[] {
		if (this.question.multiSelect === true) return this.optionListView.render(width);
		// Spec: hide the preview pane entirely when no option carries a `preview`.
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width);
		// `inputMode` (typing on the "other" custom-answer row): the preview is irrelevant —
		// the row sits at index `options.length`, out of bounds for any option's preview — so
		// render the option list at the full pane width instead of the cramped left column.
		// Side-by-side + preview block resume verbatim on nav-away (inputMode clears).
		if (this.props.inputMode) return this.optionListView.render(width);

		return this.layout(width).lines;
	}

	/**
	 * Options + preview for the current layout mode, fitted to `rowAllowance` when set. The
	 * returned focus range is in the same row coordinates as `lines`, so `render`,
	 * `focusedItemRowRange` and `naturalHeight` agree by construction.
	 */
	private layout(width: number): { lines: string[]; focus: [number, number] | undefined } {
		const mode = decideLayout(this.getTerminalWidth(), width);
		return mode === "side-by-side" ? this.layoutSideBySide(width, mode) : this.layoutStacked(width, mode);
	}

	/**
	 * Stacked: options, a blank gap, then the preview block. When that exceeds the allowance,
	 * keep the focused option (plus a row either side for the overflow arrows) and give the
	 * preview the rest, so the preview of the option being considered stays in view instead
	 * of falling below the dialog's scroll window.
	 */
	private layoutStacked(
		width: number,
		mode: PreviewLayoutMode,
	): { lines: string[]; focus: [number, number] | undefined } {
		const { selectedIndex } = this.props;
		const affordance = this.notesAffordance();
		const options = this.optionListView.render(width);
		const focus = this.optionListView.focusedItemRowRange(width);
		const gap = Array<string>(STACKED_GAP_ROWS).fill("");
		const allowance = this.rowAllowance;
		const fullBlock = this.previewBlock.blockHeight(width, selectedIndex, mode);
		if (allowance === undefined || options.length + STACKED_GAP_ROWS + fullBlock <= allowance) {
			return {
				lines: [...options, ...gap, ...this.previewBlock.renderBlock(width, selectedIndex, mode, affordance)],
				focus,
			};
		}
		// Prefer keeping a row either side of the focused option for the overflow arrows; give
		// those up only when they are what keeps the preview box (border + 1 line) from fitting.
		const focusRows = focus ? focus[1] - focus[0] : 1;
		const previewRowsWith = (optionsFloor: number) =>
			Math.min(fullBlock, allowance - STACKED_GAP_ROWS - Math.min(options.length, optionsFloor));
		const roomy = previewRowsWith(focusRows + 2);
		const previewRows = roomy >= MIN_BOX_ROWS ? roomy : previewRowsWith(focusRows);
		const block = this.previewBlock.renderBlock(width, selectedIndex, mode, affordance, previewRows);
		const optionRows = allowance - (block.length > 0 ? STACKED_GAP_ROWS + block.length : 0);
		const windowed = windowLines(options, Math.max(1, optionRows), focus, this.theme);
		return {
			lines: block.length > 0 ? [...windowed.lines, ...gap, ...block] : windowed.lines,
			focus: windowed.focus,
		};
	}

	/**
	 * Side-by-side: options column left, preview block right. Under an allowance the options
	 * column scrolls around the focused option and the preview block shrinks, so neither
	 * column exceeds it and the dialog never slices through the preview box.
	 */
	private layoutSideBySide(
		width: number,
		mode: PreviewLayoutMode,
	): { lines: string[]; focus: [number, number] | undefined } {
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth, rightWidth, gap } = columnWidths(width, adaptiveLeft);
		const allowance = this.rowAllowance;
		const left =
			allowance === undefined
				? {
						lines: this.optionListView.render(leftWidth),
						focus: this.optionListView.focusedItemRowRange(leftWidth),
					}
				: windowLines(
						this.optionListView.render(leftWidth),
						allowance,
						this.optionListView.focusedItemRowRange(leftWidth),
						this.theme,
					);
		const rightLines = this.renderPaddedPreviewLines(rightWidth, mode, allowance);
		const rows = Math.max(left.lines.length, rightLines.length);
		const gapStr = " ".repeat(gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const leftRaw = left.lines[i] ?? "";
			const rightRaw = rightLines[i] ?? "";
			const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
			const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
			const joined = `${leftClamped}${leftPad}${gapStr}${rightRaw}`;
			out.push(truncateToWidth(joined, width, ""));
		}
		return { lines: out, focus: left.focus };
	}

	focusedItemRowRange(width: number): [number, number] {
		if (this.question.multiSelect === true) return this.optionListView.focusedItemRowRange(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.focusedItemRowRange(width);
		// `inputMode`: compute the focused row range against the FULL pane width (not the
		// side-by-side leftWidth), mirroring `render`'s full-width option list.
		if (this.props.inputMode) return this.optionListView.focusedItemRowRange(width);
		return this.layout(width).focus ?? [0, 1];
	}

	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		// `inputMode`: height is the full-width option list only (no preview block) — preserves
		// the `naturalHeight === render.length` parity invariant.
		if (this.props.inputMode) return this.optionListView.render(width).length;
		if (this.rowAllowance !== undefined) return this.layout(width).lines.length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		const previewBlockHeight = this.previewBlock.blockHeight(previewWidth, this.props.selectedIndex, mode);
		if (mode === "side-by-side") return Math.max(optionsHeight, previewBlockHeight);
		return optionsHeight + STACKED_GAP_ROWS + previewBlockHeight;
	}

	maxNaturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		// `inputMode`: like naturalHeight — full-width option list only, so the
		// `maxNaturalHeight >= naturalHeight` parity invariant holds (both equal the list height).
		if (this.props.inputMode) return this.optionListView.render(width).length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		let maxPreviewBlock = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const h = this.previewBlock.blockHeight(previewWidth, i, mode);
			if (h > maxPreviewBlock) maxPreviewBlock = h;
		}
		const max =
			mode === "side-by-side"
				? Math.max(optionsHeight, maxPreviewBlock)
				: optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
		// A fitted body never exceeds the allowance, whichever option is focused.
		return this.rowAllowance === undefined ? max : Math.min(max, this.rowAllowance);
	}

	private renderPaddedPreviewLines(colWidth: number, mode: PreviewLayoutMode, maxRows: number | undefined): string[] {
		const inner = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.previewBlock.renderBlock(
			inner,
			this.props.selectedIndex,
			mode,
			this.notesAffordance(),
			maxRows,
		);
		const boxWidth = Math.max(1, visibleWidth(contentLines[0] ?? ""));
		const boxAlignedPad = Math.max(PREVIEW_PADDING_LEFT, colWidth - boxWidth);
		return contentLines.map((line) => {
			if (line === "") return "";
			// A line wider than the box (a long-locale notes affordance) slides left to
			// stay fully visible; truncation engages only when the column itself runs out.
			const pad = Math.max(PREVIEW_PADDING_LEFT, Math.min(boxAlignedPad, colWidth - visibleWidth(line)));
			return `${" ".repeat(pad)}${truncateToWidth(line, colWidth - pad, "")}`;
		});
	}
}
