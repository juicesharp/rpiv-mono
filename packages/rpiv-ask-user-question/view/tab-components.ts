import type { MultiSelectViewProps } from "./components/multi-select-view.js";
import type { OptionListViewProps } from "./components/option-list-view.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { StatefulView } from "./stateful-view.js";

/**
 * Per-question view components, exposed to the adapter and dialog as
 * `StatefulView<XProps>` views (interface-only consumption). The same
 * runtime instances that satisfy these tightened types also satisfy their
 * concrete classes; `buildQuestionnaire` keeps separate concrete-typed local
 * arrays for the height callbacks (`naturalHeight` / `maxNaturalHeight` are
 * not on `StatefulView<P>`).
 */
export interface TabComponents {
	optionList: StatefulView<OptionListViewProps>;
	preview: StatefulView<PreviewPaneProps>;
	multiSelect?: StatefulView<MultiSelectViewProps>;
}
