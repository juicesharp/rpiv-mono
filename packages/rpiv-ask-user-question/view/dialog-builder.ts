import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer } from "@earendil-works/pi-tui";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import { computeScrollStart, decorateOverflow } from "./scroll-window.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";

export {
	COLLAPSED_HINT_TEMPLATE,
	HINT_MULTI,
	HINT_PART_CANCEL,
	HINT_PART_CLEAR,
	HINT_PART_COLLAPSE,
	HINT_PART_COLLAPSE_TEMPLATE,
	HINT_PART_ENTER,
	HINT_PART_EXPAND_TEMPLATE,
	HINT_PART_NAV,
	HINT_PART_NEW_LINE,
	HINT_PART_NOTES,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	HINT_SINGLE,
	INCOMPLETE_WARNING_PREFIX,
	KEY_PLACEHOLDER,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-copy.js";

/**
 * Rows the scroll window must keep for the body before the heading (header badge +
 * question) is pinned above it. Below this the heading scrolls with the body, so a
 * tiny terminal still reaches its options.
 */
const MIN_SCROLL_ROWS_WITH_PINNED_HEADING = 3;

/** No-overflow path: append the residual spacer rows after the footer. */
function renderFitsTerminal(natural: string[], spacerRows: number): string[] {
	return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
}

/** Terminal too small for any middle content — show just chrome, hard-clamped to termRows. */
function renderChromeOnly(natural: string[], topFixed: number, bottomFixed: number, termRows: number): string[] {
	const chromeOnly = [...natural.slice(0, topFixed), ...natural.slice(natural.length - bottomFixed)];
	return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
}

export type DialogState = QuestionnaireState;

/** Per-tick projection of dialog state. Written by the adapter; read by the strategy thunk. */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** Construction-time config for `DialogView`. Frozen after construction. */
export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Editor;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	/** Optional so single-question mode and non-submit tests can omit it; SubmitTabStrategy falls back to Spacer rows. */
	submitPicker?: Component;
	/** Worst-case body height across all tabs/options. Determines the stable overall dialog footprint. */
	getBodyHeight: (width: number) => number;
	/** Body height of the CURRENTLY active tab/option. The chrome subtracts this from `getBodyHeight` to absorb the residual OUTSIDE the bordered region. */
	getCurrentBodyHeight: (width: number) => number;
	/**
	 * Row budget getter, read at render time: `tui.terminal.rows` passed through the
	 * presentation's row budget (identity for the overlay, capped for inline).
	 */
	getTerminalRows: () => number;
	/**
	 * Resolved collapse/expand key spec (`resolveCollapseKey` output: `"ctrl+]"`,
	 * `"alt+o"`, or `"off"`). Construction-time config, NOT canonical state —
	 * `QuestionnaireRuntime.collapseKey` must never reach view setProps consumers.
	 * The footer hint interpolates it, and drops the collapse part when `"off"`.
	 */
	collapseKey: string;
}

/**
 * The 7th renderable, promoted from a structural literal to a named class so
 * all view-layer components share one explicit `implements StatefulView<P>`
 * contract. `setProps(DialogProps)` writes the live cell read by the
 * strategy thunk during `render()`. `liveProps.activePreviewPane` is a
 * resolved pane reference threaded by the adapter per tick — the dialog
 * itself does not derive it.
 */
export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
			collapseKey: config.collapseKey,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
					notesInput: config.notesInput,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	handleInput(_data: string): void {}

	// Invalidation is driven by `QuestionnairePropsAdapter.invalidate()`, which
	// owns the full set of renderables (binding registries + extras like
	// `notesInput`). DialogView has no cached layout of its own.
	invalidate(): void {}

	render(width: number): string[] {
		const state = this.liveProps.state;
		const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;

		// Cache heading rows (avoid double construction in render and container build).
		const headingRowCache = strategy.headingRows(state);
		// Rendered rows, not components: a long question wraps.
		const headingHeight = headingRowCache.reduce((rows, c) => rows + c.render(width).length, 0);

		// Fixed region sizes (deterministic from structure).
		// TabBar.render() returns [tabLine, ""] — always 2 rows.
		const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
		const bottomFixed = 1 + strategy.footerRowCount;
		const termRows = this.config.getTerminalRows();

		this.allotBodyRows(
			onSubmit,
			termRows - topFixed - headingHeight - bottomFixed - this.rowsAroundBody(strategy, width),
		);

		// Build container WITHOUT residual spacer — spacer handled below based on overflow.
		const natural = this.buildContainerFromStrategy(strategy, headingRowCache).render(width);

		// Residual spacer: equalizes total height across tabs (only needed when no overflow).
		// Resting mid rows (a question's saved-note row, #197) come out of the spacer's slack,
		// so a tab with a note keeps the shared height when the body leaves room. The open
		// notes editor deliberately grows the dialog instead, so it is not absorbed.
		const restingMidRows = state.notesVisible ? 0 : this.rowsAroundBody(strategy, width) - 1;
		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount -
				restingMidRows,
		);

		// The spacer is padding for a stable cross-tab footprint, not content: when only the
		// padding overflows, clamp it rather than entering the scroll partition, which assumes
		// the middle region itself is longer than the window (#260).
		if (natural.length <= termRows) {
			return renderFitsTerminal(natural, Math.min(spacerRows, termRows - natural.length));
		}

		// OVERFLOW — apply 3-region partition with scroll-to-focus. The heading joins the
		// fixed top whenever the body keeps a usable window, so the question being answered
		// never scrolls out of view; heading height is measured in rendered rows, since a
		// long question wraps.
		const pinHeading = termRows - topFixed - headingHeight - bottomFixed >= MIN_SCROLL_ROWS_WITH_PINNED_HEADING;
		const top = pinHeading ? topFixed + headingHeight : topFixed;
		const middleRows = natural.length - top - bottomFixed;
		const availableMiddle = Math.max(0, termRows - top - bottomFixed);
		if (availableMiddle === 0) {
			return renderChromeOnly(natural, top, bottomFixed, termRows);
		}

		// Never slice past the middle region into the bottom-fixed rows, which are appended
		// below — that would draw the bottom border and hint twice (#260).
		const windowRows = Math.min(availableMiddle, middleRows);
		const rowsBeforeBody = pinHeading ? 0 : headingHeight;
		const focusedRange = strategy.focusedItemRowRange(width, state);
		const scrollStart = computeScrollStart(focusedRange, rowsBeforeBody, windowRows, middleRows);
		const scrollableMiddle = natural.slice(top + scrollStart, top + scrollStart + windowRows);
		const focusedInWindow: [number, number] | undefined = focusedRange && [
			rowsBeforeBody + focusedRange[0] - scrollStart,
			rowsBeforeBody + focusedRange[1] - scrollStart,
		];
		decorateOverflow(
			scrollableMiddle,
			scrollStart > 0,
			scrollStart + windowRows < middleRows,
			this.config.theme,
			focusedInWindow,
		);

		const result = [...natural.slice(0, top), ...scrollableMiddle, ...natural.slice(natural.length - bottomFixed)];
		// Safety: never exceed terminal rows (covers the availableMiddle === 0 case
		// where topFixed + bottomFixed > termRows).
		return result.length > termRows ? result.slice(0, termRows) : result;
	}

	/** Rows between the body and the bottom border: the body's trailing Spacer(1) plus any mid rows (e.g. the notes editor). */
	private rowsAroundBody(strategy: TabContentStrategy, width: number): number {
		return 1 + strategy.midRows(this.liveProps.state).reduce((rows, c) => rows + c.render(width).length, 0);
	}

	/**
	 * Hand the active question's preview pane the rows its body may use this frame, so a body
	 * taller than the space fits itself — options scroll in their column, the preview box
	 * shrinks but closes — instead of the scroll window below slicing through it (#210).
	 * Other tabs' panes are cleared so a stale allowance never skews the cross-tab height.
	 * Below `MIN_SCROLL_ROWS_WITH_PINNED_HEADING` the dialog's own scroll window takes over.
	 */
	private allotBodyRows(onSubmit: boolean, bodyRows: number): void {
		const active =
			onSubmit || bodyRows < MIN_SCROLL_ROWS_WITH_PINNED_HEADING ? undefined : this.liveProps.activePreviewPane;
		for (const tab of this.config.tabsByIndex) {
			tab.preview?.setRowAllowance?.(tab.preview === active ? bodyRows : undefined);
		}
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy, headingRowCache: Component[]): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		for (const c of headingRowCache) container.addChild(c);
		container.addChild(strategy.bodyComponent(state));
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		// BodyResidualSpacer moved out of Container — handled in render().
		return container;
	}
}
