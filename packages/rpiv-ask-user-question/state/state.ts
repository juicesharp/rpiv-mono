import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer (`buildDialog`, MultiSelectView.setProps,
 * SubmitPicker.setProps) read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	chatFocused: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/**
	 * Pre-answer notes side-band, keyed by tab index. OPTIONAL on the canonical type to
	 * preserve existing test-factory shapes; the reducer treats `undefined` as an empty map.
	 * Decoupled from `answers` so adding notes does NOT make `answers.has(currentTab)` true
	 * (otherwise Submit-tab missing-check + `allAnswered()` would falsely report the question
	 * as answered). Merged into the answer at confirm time.
	 */
	notesByTab?: ReadonlyMap<number, string>;
	/**
	 * True iff the currently-focused option carries a non-empty `preview` string. Computed via
	 * `computeFocusedOptionHasPreview`. Stored on state because it gates the `notes_enter`
	 * action and the "n to add notes" hint chip.
	 */
	focusedOptionHasPreview: boolean;
	/**
	 * Focused row in the Submit-tab picker (0 = Submit answers, 1 = Cancel). Default 0;
	 * reset on every tab switch.
	 */
	submitChoiceIndex: number;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state. Lives separately
 * from `QuestionnaireState` because these fields don't belong on the view-side state
 * (the view's setProps consumers must not see `keybindings` or `inputBuffer`).
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
}
