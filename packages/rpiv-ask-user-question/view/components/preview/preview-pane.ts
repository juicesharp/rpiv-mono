import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.js";
import type { StatefulView } from "../../stateful-view.js";
import type { OptionListView } from "../option-list-view.js";
import type { PreviewBlockRenderer } from "./preview-block-renderer.js";
import {
	bodyWidths,
	columnWidths,
	decideLayout,
	PREVIEW_PADDING_LEFT,
	type PreviewLayoutMode,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.js";

// ----- Re-exports for test imports — keep `./preview-pane.js` as the public surface -----
export {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.js";
export { NOTES_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.js";
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
	selectedIndex: number;
	focused: boolean;
	/**
	 * True while the "other" (custom-answer) row is focused and accepting input
	 * (`state.inputMode`, set by the reducer via `ROW_INTENT_META.other.activatesInputMode`).
	 * Surfaced by `selectPreviewPaneProps` from canonical state; drives the full-width
	 * early-returns below so the inline input isn't cramped into the narrow left column.
	 */
	inputMode: boolean;
	/**
	 * Scroll offset inside the focused option's preview block (rows). Optional for
	 * construction-time compatibility — absent means "from the top" (offset 0).
	 */
	previewScroll?: number;
}

export interface PreviewPaneConfig {
	question: QuestionData;
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
	private props: PreviewPaneProps;
	/**
	 * Render-report channel for scroll de-accumulation: after every preview render,
	 * `lastRenderedScroll` holds the offset the preview block actually used (clamped)
	 * and `renderedScrollForIndex` the option index that offset belongs to. The session
	 * re-syncs its canonical `previewScroll` to this pair before each key dispatch, so
	 * PageDown/PageUp overscroll past the end can never accumulate phantom rows.
	 */
	lastRenderedScroll = 0;
	renderedScrollForIndex = -1;
	/** Total overflow rows of the last rendered preview (see PreviewBlockRenderer.lastTotalHidden). */
	lastTotalHidden = 0;
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
		this.props = { notesVisible: false, selectedIndex: 0, focused: false, inputMode: false, previewScroll: 0 };
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

	handleInput(_data: string): void {}

	invalidate(): void {
		this.previewBlock.invalidate();
		this.optionListView.invalidate();
	}

		render(width: number): string[] {
		if (this.question.multiSelect === true) {
			this.lastRenderedScroll = 0;
			this.renderedScrollForIndex = -1;
			this.lastTotalHidden = 0;
			return this.optionListView.render(width);
		}
		// Spec: hide the preview pane entirely when no option carries a `preview`.
		if (!this.previewBlock.hasAnyPreview()) {
			this.lastRenderedScroll = 0;
			this.renderedScrollForIndex = -1;
			this.lastTotalHidden = 0;
			return this.optionListView.render(width);
		}
		// `inputMode` (typing on the "other" custom-answer row): the preview is irrelevant —
		// the row sits at index `options.length`, out of bounds for any option's preview — so
		// render the option list at the full pane width instead of the cramped left column.
		// Side-by-side + preview block resume verbatim on nav-away (inputMode clears).
		if (this.props.inputMode) {
			this.lastRenderedScroll = 0;
			this.renderedScrollForIndex = -1;
			this.lastTotalHidden = 0;
			return this.optionListView.render(width);
		}

		const mode = decideLayout(this.getTerminalWidth(), width);
		if (mode === "side-by-side") {
			const out = this.renderSideBySide(width, mode);
			this.lastRenderedScroll = this.previewBlock.lastClampedScroll;
			this.lastTotalHidden = this.previewBlock.lastTotalHidden;
			this.renderedScrollForIndex = this.props.selectedIndex;
			return out;
		}

		// Stacked: options + blank gap + preview block.
		const out = [
			...this.optionListView.render(width),
			...Array(STACKED_GAP_ROWS).fill(""),
			...this.previewBlock.renderBlock(
				width,
				this.props.selectedIndex,
				mode,
				this.props.focused,
				this.props.notesVisible,
				this.props.previewScroll ?? 0,
			),
		];
		this.lastRenderedScroll = this.previewBlock.lastClampedScroll;
		this.renderedScrollForIndex = this.props.selectedIndex;
		return out;
	}

	focusedItemRowRange(width: number): [number, number] {
		if (this.question.multiSelect === true) return this.optionListView.focusedItemRowRange(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.focusedItemRowRange(width);
		// `inputMode`: compute the focused row range against the FULL pane width (not the
		// side-by-side leftWidth), mirroring `render`'s full-width option list.
		if (this.props.inputMode) return this.optionListView.focusedItemRowRange(width);
		const mode = decideLayout(this.getTerminalWidth(), width);
		if (mode === "stacked") return this.optionListView.focusedItemRowRange(width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth } = columnWidths(width, adaptiveLeft);
		return this.optionListView.focusedItemRowRange(leftWidth);
	}

	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		// `inputMode`: height is the full-width option list only (no preview block) — preserves
		// the `naturalHeight === render.length` parity invariant.
		if (this.props.inputMode) return this.optionListView.render(width).length;
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
		if (mode === "side-by-side") return Math.max(optionsHeight, maxPreviewBlock);
		return optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
	}

	private renderSideBySide(width: number, mode: PreviewLayoutMode): string[] {
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth, rightWidth, gap } = columnWidths(width, adaptiveLeft);
		const leftLines = this.optionListView.render(leftWidth);
		const rightLines = this.renderPaddedPreviewLines(rightWidth, mode, this.props.previewScroll ?? 0);
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

	private renderPaddedPreviewLines(colWidth: number, mode: PreviewLayoutMode, scrollOffset: number): string[] {
		const inner = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.previewBlock.renderBlock(
			inner,
			this.props.selectedIndex,
			mode,
			this.props.focused,
			this.props.notesVisible,
			scrollOffset,
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
