/**
 * Public re-export barrel. Internal modules import directly from
 * `state/state.ts` and `state/selectors/{focus,projections,derivations}.ts`.
 * This barrel exists to (a) preserve the public `chatNumberingFor` re-export
 * at `ask-user-question.ts:19` for downstream consumers, and (b) keep the
 * file path stable for any external imports that landed pre-Phase-11.
 */

export {
	chatNumberingFor,
	computeFocusedOptionHasPreview,
	selectActivePreviewPaneIndex,
	selectActiveTabItems,
	selectConfirmedIndicator,
} from "./selectors/derivations.js";
export { selectActiveView } from "./selectors/focus.js";
export {
	selectChatRowProps,
	selectMultiSelectProps,
	selectOptionListProps,
	selectPreviewPaneProps,
	selectSubmitPickerProps,
	selectTabBarProps,
} from "./selectors/projections.js";
export type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
