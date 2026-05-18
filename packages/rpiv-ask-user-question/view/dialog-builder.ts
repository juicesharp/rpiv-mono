import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Input, Spacer } from "@earendil-works/pi-tui";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_TAB, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTISELECT_SUFFIX = ` · ${HINT_PART_TOGGLE}`;
export const HINT_NOTES_SUFFIX = ` · ${HINT_PART_NOTES}`;
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";

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
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	/** Optional so single-question mode and non-submit tests can omit it; SubmitTabStrategy falls back to Spacer rows. */
	submitPicker?: Component;
	/** Worst-case body height across all tabs/options. Determines the stable overall dialog footprint. */
	getBodyHeight: (width: number) => number;
	/** Body height of the CURRENTLY active tab/option. The chrome subtracts this from `getBodyHeight` to absorb the residual OUTSIDE the bordered region. */
	getCurrentBodyHeight: (width: number) => number;
	/** Terminal height getter. Mirrors `getTerminalWidth` — reads `tui.terminal.rows` at render time. */
	getTerminalRows: () => number;
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
			chatRow: config.chatRow,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
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
		const headingCount = headingRowCache.length;

		// Build container WITHOUT residual spacer — spacer handled below based on overflow.
		const natural = this.buildContainerFromStrategy(strategy, headingRowCache).render(width);

		// Fixed region sizes (deterministic from structure).
		// TabBar.render() returns [tabLine, ""] — always 2 rows.
		const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
		const bottomFixed = 1 + strategy.footerRowCount;
		const middleRows = natural.length - topFixed - bottomFixed;

		// Residual spacer: equalizes total height across tabs (only needed when no overflow).
		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount,
		);

		const termRows = this.config.getTerminalRows();

		if (natural.length + spacerRows <= termRows) {
			// No overflow — add residual spacer rows after footer.
			return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
		}

		// OVERFLOW — apply 3-region partition with scroll-to-focus.
		const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
		if (availableMiddle === 0) {
			// Terminal too small for any middle content — show just chrome.
			const chromeOnly = [...natural.slice(0, topFixed), ...natural.slice(natural.length - bottomFixed)];
			return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
		}

		const bodyRange = strategy.focusedItemRowRange(width, state);

		// Compute scroll window centered on the focused option.
		let scrollStart: number;
		if (bodyRange) {
			const focusedRowInMiddle = headingCount + bodyRange[0];
			const focusedHeight = bodyRange[1] - bodyRange[0];
			// Center the focused item vertically in the available middle space.
			const idealStart = focusedRowInMiddle - Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
			scrollStart = Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
		} else {
			// No interactive focus (submit tab) — top-anchor the middle.
			scrollStart = 0;
		}

		const scrollableMiddle = natural.slice(topFixed + scrollStart, topFixed + scrollStart + availableMiddle);

		if (scrollStart > 0 && scrollableMiddle.length > 0) {
			scrollableMiddle[0] = this.config.theme.fg("dim", OVERFLOW_UP);
		}
		if (scrollStart + availableMiddle < middleRows && scrollableMiddle.length > 0) {
			scrollableMiddle[scrollableMiddle.length - 1] = this.config.theme.fg("dim", OVERFLOW_DOWN);
		}

		const result = [
			...natural.slice(0, topFixed),
			...scrollableMiddle,
			...natural.slice(natural.length - bottomFixed),
		];
		// Safety: never exceed terminal rows (covers the availableMiddle === 0 case
		// where topFixed + bottomFixed > termRows).
		return result.length > termRows ? result.slice(0, termRows) : result;
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
