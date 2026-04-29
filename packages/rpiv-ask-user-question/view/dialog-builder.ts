import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, type Input, Spacer } from "@mariozechner/pi-tui";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import { BodyResidualSpacer } from "./body-residual-spacer.js";
import type { ChatRowView } from "./components/chat-row-view.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";

// Hint phrases — single source of truth for both production (`buildHintText`) and the
// substring assertions in `dialog-container.test.ts`.
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

export type DialogState = QuestionnaireState;

/**
 * Per-tick projection of dialog state. Replaces the prior split between
 * `setState(state)` (mutated `liveConfig.state`) and `setPreviewPane(pane)`
 * (mutated `liveConfig.previewPane`). The adapter writes both fields in one
 * `setProps` call per `apply()` tick; the chrome's strategy thunk
 * (`getPreviewPane: () => liveProps.activePreviewPane`) reads through.
 */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: PreviewPane;
}

/**
 * Construction-time config for `buildDialog`. Frozen after construction;
 * per-tick state lives on `DialogProps` and is written via `setProps`.
 */
export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	initialProps: DialogProps;
	tabBar: TabBar | undefined;
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
	multiSelectOptionsByTab: ReadonlyArray<MultiSelectView | undefined>;
	/**
	 * Submit-tab Submit/Cancel picker. Optional so the type stays
	 * compatible with single-question mode (no Submit Tab) and with tests that
	 * exercise non-submit code paths. SubmitTabStrategy falls back to Spacer
	 * rows when undefined.
	 */
	submitPicker?: Component;
	/**
	 * Worst-case body height across all tabs and (for preview tabs) all options.
	 * Determines the stable overall dialog footprint.
	 */
	getBodyHeight: (width: number) => number;
	/**
	 * Body height of the CURRENTLY active tab/option. The chrome wrapper subtracts
	 * this from `getBodyHeight` to absorb the height residual OUTSIDE the bordered
	 * region — the body itself renders at its natural height with no internal padding.
	 */
	getCurrentBodyHeight: (width: number) => number;
}

export function buildDialog(config: DialogConfig): StatefulView<DialogProps> {
	let liveProps: DialogProps = config.initialProps;

	const questionStrategy: TabContentStrategy = new QuestionTabStrategy({
		theme: config.theme,
		questions: config.questions,
		// Live getter — reads liveProps.activePreviewPane on every call so
		// dialog.setProps updates flow through to the strategy without
		// re-construction. Replaces the prior `liveConfig.previewPane` read.
		getPreviewPane: () => liveProps.activePreviewPane,
		multiSelectOptionsByTab: config.multiSelectOptionsByTab,
		notesInput: config.notesInput,
		chatRow: config.chatRow,
		isMulti: config.isMulti,
		getCurrentBodyHeight: config.getCurrentBodyHeight,
	});

	const submitStrategy: TabContentStrategy | undefined = config.isMulti
		? new SubmitTabStrategy({
				theme: config.theme,
				questions: config.questions,
				submitPicker: config.submitPicker,
			})
		: undefined;

	const maxFooterRowCount = Math.max(questionStrategy.footerRowCount, submitStrategy?.footerRowCount ?? 0);

	const component: StatefulView<DialogProps> = {
		setProps(props: DialogProps) {
			liveProps = props;
		},
		handleInput() {},
		invalidate() {
			liveProps.activePreviewPane.invalidate();
			config.tabBar?.invalidate();
			config.notesInput.invalidate();
			config.chatRow.invalidate();
		},
		render(width: number): string[] {
			const onSubmit = config.isMulti && liveProps.state.currentTab === config.questions.length;
			const strategy = onSubmit && submitStrategy ? submitStrategy : questionStrategy;
			return buildContainerFromStrategy(strategy, config, liveProps, maxFooterRowCount).render(width);
		},
	};
	return component;
}

/**
 * Chrome wrapper. `config` carries construction-time fields (theme, isMulti,
 * tabBar, getBodyHeight); `props` carries per-tick state (state,
 * activePreviewPane). Both threaded for height-equality math.
 */
function buildContainerFromStrategy(
	strategy: TabContentStrategy,
	config: DialogConfig,
	props: DialogProps,
	maxFooterRowCount: number,
): Container {
	const { theme, isMulti, tabBar } = config;
	const state = props.state;
	const container = new Container();
	const border = () => new DynamicBorder((s) => theme.fg("accent", s));

	// Top chrome — common to every tab.
	container.addChild(border());
	if (isMulti && tabBar) container.addChild(tabBar);
	container.addChild(new Spacer(1));

	// Strategy-supplied content.
	for (const c of strategy.headingRows(state)) container.addChild(c);
	container.addChild(strategy.bodyComponent(state));
	container.addChild(new Spacer(1));
	for (const c of strategy.midRows(state)) container.addChild(c);

	// Bottom chrome — common.
	container.addChild(border());
	for (const c of strategy.footerRows(state)) container.addChild(c);

	// Residual: equalize total height across strategies. Replaces both the
	// per-tab residual asymmetry and the prior +1 magic.
	container.addChild(
		new BodyResidualSpacer(
			(w) => config.getBodyHeight(w) + maxFooterRowCount,
			(w) => strategy.bodyHeight(w, state) + strategy.footerRowCount,
		),
	);
	return container;
}
