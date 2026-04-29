import type { InputBuffer } from "../state/input-buffer.js";
import {
	type QuestionnaireState,
	selectActivePreviewPaneIndex,
	selectActiveView,
	selectChatRowProps,
	selectMultiSelectProps,
	selectOptionListProps,
	selectPreviewPaneProps,
	selectSubmitPickerProps,
	selectTabBarProps,
} from "../state/questionnaire-state.js";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import type { SubmitPicker } from "./components/submit-picker.js";
import type { TabBar } from "./components/tab-bar.js";
import type { WrappingSelectItem } from "./components/wrapping-select.js";
import type { DialogProps } from "./dialog-builder.js";
import type { StatefulView } from "./stateful-view.js";

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	optionListViewsByTab: ReadonlyArray<OptionListView>;
	previewPanes: readonly PreviewPane[];
	chatRow: ChatRowView;
	multiSelectOptionsByTab: ReadonlyArray<MultiSelectView | undefined>;
	submitPicker: SubmitPicker | undefined;
	tabBar: TabBar | undefined;
	dialog: StatefulView<DialogProps>;
	inputBuffer: InputBuffer;
}

/**
 * View fan-out: drives every component setter from the canonical state via named selectors.
 *
 * Holds a constructor-injected reference to the session-owned `InputBuffer` cell so
 * `selectOptionListProps` receives the live buffer value per tick without coupling
 * the adapter to mutable session state.
 */
export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly optionListViewsByTab: ReadonlyArray<OptionListView>;
	private readonly previewPanes: readonly PreviewPane[];
	private readonly chatRow: ChatRowView;
	private readonly multiSelectOptionsByTab: ReadonlyArray<MultiSelectView | undefined>;
	private readonly submitPicker: SubmitPicker | undefined;
	private readonly tabBar: TabBar | undefined;
	private readonly dialog: StatefulView<DialogProps>;
	private readonly inputBuffer: InputBuffer;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.optionListViewsByTab = config.optionListViewsByTab;
		this.previewPanes = config.previewPanes;
		this.chatRow = config.chatRow;
		this.multiSelectOptionsByTab = config.multiSelectOptionsByTab;
		this.submitPicker = config.submitPicker;
		this.tabBar = config.tabBar;
		this.dialog = config.dialog;
		this.inputBuffer = config.inputBuffer;
	}

	/**
	 * Project canonical state through selectors → component setters and request a render.
	 * Idempotent — calling twice with the same state produces the same setter sequence.
	 */
	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const activeView = selectActiveView(state, totalQuestions);

		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
		const activePreviewPane = this.previewPanes[paneIndex] ?? this.previewPanes[0]!;

		this.dialog.setProps({ state, activePreviewPane });

		const view = this.optionListViewsByTab[paneIndex] ?? this.optionListViewsByTab[0];
		if (view) {
			view.setProps(
				selectOptionListProps(
					state,
					this.itemsByTab[paneIndex] ?? [],
					this.questions,
					activeView,
					this.inputBuffer.get(),
				),
			);
		}

		activePreviewPane.setProps(selectPreviewPaneProps(state, activeView));

		this.chatRow.setProps(selectChatRowProps(state, this.itemsByTab, totalQuestions, activeView));

		for (let i = 0; i < this.multiSelectOptionsByTab.length; i++) {
			const mso = this.multiSelectOptionsByTab[i];
			if (!mso) continue;
			const q = this.questions[i];
			if (!q) continue;
			mso.setProps(selectMultiSelectProps(state, q, activeView));
		}
		if (this.submitPicker) {
			this.submitPicker.setProps(selectSubmitPickerProps(state, totalQuestions, activeView));
		}

		if (this.tabBar) {
			this.tabBar.setProps(selectTabBarProps(state, this.questions));
		}

		this.tui.requestRender();
	}
}
