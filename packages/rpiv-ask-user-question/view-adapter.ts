import type { DialogComponent } from "./dialog-builder.js";
import type { MultiSelectOptions } from "./multi-select-options.js";
import type { OptionListView } from "./option-list-view.js";
import type { PreviewPane } from "./preview-pane.js";
import {
	chatNumberingFor,
	type QuestionnaireState,
	selectActivePreviewPaneIndex,
	selectActiveTabItems,
	selectConfirmedIndicator,
	selectOptionsFocused,
	selectSubmitPickerFocused,
} from "./questionnaire-state.js";
import type { SubmitPicker } from "./submit-picker.js";
import type { TabBar } from "./tab-bar.js";
import type { QuestionData } from "./types.js";
import type { WrappingSelect, WrappingSelectItem } from "./wrapping-select.js";

export interface QuestionnaireViewAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	optionListViewsByTab: ReadonlyArray<OptionListView>;
	previewPanes: readonly PreviewPane[];
	chatList: WrappingSelect;
	multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined>;
	submitPicker: SubmitPicker | undefined;
	tabBar: TabBar | undefined;
	dialog: DialogComponent;
}

/**
 * View fan-out: drives every component setter from the canonical state via named selectors.
 *
 * `OptionListView` receives the option-side setters directly (`setSelectedIndex`, `setFocused`,
 * `setConfirmedIndex`) — no mirrored cells on `PreviewPane`. `PreviewPane` only receives
 * `setNotesVisible` (its sole local state).
 *
 * The adapter owns the components but never owns mutable state — every projection is read fresh
 * from the input `state` argument, so there is no risk of stale view-side data.
 */
export class QuestionnaireViewAdapter {
	private readonly tui: QuestionnaireViewAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly optionListViewsByTab: ReadonlyArray<OptionListView>;
	private readonly previewPanes: readonly PreviewPane[];
	private readonly chatList: WrappingSelect;
	private readonly multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined>;
	private readonly submitPicker: SubmitPicker | undefined;
	private readonly tabBar: TabBar | undefined;
	private readonly dialog: DialogComponent;

	constructor(config: QuestionnaireViewAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.optionListViewsByTab = config.optionListViewsByTab;
		this.previewPanes = config.previewPanes;
		this.chatList = config.chatList;
		this.multiSelectOptionsByTab = config.multiSelectOptionsByTab;
		this.submitPicker = config.submitPicker;
		this.tabBar = config.tabBar;
		this.dialog = config.dialog;
	}

	/**
	 * Replace the dialog's active preview pane. Called by the runtime when it executes the
	 * `set_active_preview_pane` effect emitted by `applyAction`'s tab-switching paths. Must
	 * run before the next `apply()` so the dialog's strategy reads the new pane via its live
	 * getter.
	 */
	setActivePreviewPane(paneIndex: number): void {
		const pane = this.previewPanes[paneIndex] ?? this.previewPanes[0];
		if (pane) this.dialog.setPreviewPane(pane);
	}

	/**
	 * Project canonical state through selectors → component setters and request a render.
	 * Idempotent — calling twice with the same state produces the same setter sequence.
	 */
	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const optionsFocused = selectOptionsFocused(state);

		this.dialog.setState(state);

		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);

		const view = this.optionListViewsByTab[paneIndex] ?? this.optionListViewsByTab[0];
		if (view) {
			view.setSelectedIndex(state.optionIndex);
			view.setFocused(optionsFocused);
			const confirmed = selectConfirmedIndicator(
				this.questions,
				state.currentTab,
				state.answers,
				this.itemsByTab[paneIndex] ?? [],
			);
			view.setConfirmedIndex(confirmed?.index, confirmed?.labelOverride);
		}

		const pane = this.previewPanes[paneIndex] ?? this.previewPanes[0];
		pane?.setNotesVisible(state.notesVisible);

		this.chatList.setFocused(state.chatFocused);

		for (const mso of this.multiSelectOptionsByTab) {
			if (!mso) continue;
			mso.setState(state);
			mso.setFocused(optionsFocused);
		}
		if (this.submitPicker) {
			this.submitPicker.setState(state);
			this.submitPicker.setFocused(selectSubmitPickerFocused(state.currentTab, totalQuestions));
		}

		const activeItems = selectActiveTabItems(this.itemsByTab, state.currentTab, totalQuestions);
		const numbering = chatNumberingFor(activeItems);
		this.chatList.setNumbering(numbering.offset, numbering.total);

		if (this.tabBar) {
			this.tabBar.setConfig({
				questions: this.questions,
				answers: new Map(state.answers),
				activeTabIndex: state.currentTab,
				totalTabs: totalQuestions + 1,
			});
		}

		this.tui.requestRender();
	}
}
