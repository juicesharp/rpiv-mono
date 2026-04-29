import type { InputBuffer } from "../state/input-buffer.js";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.js";
import { selectActiveView } from "../state/selectors/focus.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { BindingContext, ComponentBinding, PerTabBinding, PerTabBindingContext } from "./component-binding.js";
import type { WrappingSelectItem } from "./components/wrapping-select.js";
import type { TabComponents } from "./tab-components.js";

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	inputBuffer: InputBuffer;
	globalBindings: ReadonlyArray<ComponentBinding<unknown>>;
	perTabBindings: ReadonlyArray<PerTabBinding<unknown>>;
}

/**
 * View fan-out: drives every component setter from the canonical state via
 * two binding registries. `globalBindings` covers the cross-tab components
 * (chatRow, dialog, submitPicker?, tabBar?); `perTabBindings` covers the
 * per-tab kinds (optionList, preview, multiSelect?). The hand-coded fan-out
 * collapses to one global loop + one nested per-tab loop. The `inputBuffer`
 * cell is read per tick into ctx so `selectOptionListProps` sees the live
 * value.
 */
export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly tabsByIndex: ReadonlyArray<TabComponents>;
	private readonly inputBuffer: InputBuffer;
	private readonly globalBindings: ReadonlyArray<ComponentBinding<unknown>>;
	private readonly perTabBindings: ReadonlyArray<PerTabBinding<unknown>>;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.tabsByIndex = config.tabsByIndex;
		this.inputBuffer = config.inputBuffer;
		this.globalBindings = config.globalBindings;
		this.perTabBindings = config.perTabBindings;
	}

	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const activeView = selectActiveView(state, totalQuestions);
		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
		const activePreviewPane = this.tabsByIndex[paneIndex]?.preview ?? this.tabsByIndex[0]!.preview;

		const ctx: BindingContext = {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			totalQuestions,
			activeView,
			inputBuffer: this.inputBuffer.get(),
			activePreviewPane,
		};

		for (const binding of this.globalBindings) {
			binding.component.setProps(binding.select(state, ctx));
		}

		for (let i = 0; i < this.tabsByIndex.length; i++) {
			const tab = this.tabsByIndex[i]!;
			const tabCtx: PerTabBindingContext = { ...ctx, tab, i };
			for (const binding of this.perTabBindings) {
				if (binding.predicate && !binding.predicate(state, tabCtx)) continue;
				const component = binding.resolve(tab);
				component?.setProps(binding.select(state, tabCtx));
			}
		}

		this.tui.requestRender();
	}
}
