import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/**
	 * Pre-answer notes side-band, keyed by tab index. Decoupled from `answers` so adding
	 * notes does NOT mark a question answered (the Submit-tab missing-check would falsely
	 * pass otherwise). Merged into the answer at confirm time.
	 */
	notesByTab: ReadonlyMap<number, string>;
	/** True iff the focused option carries a non-empty `preview` string. Gates `notes_enter` and the "n to add notes" hint chip. */
	focusedOptionHasPreview: boolean;
	/** Focused row in the Submit-tab picker (0 = Submit, 1 = Cancel). Reset on tab switch. */
	submitChoiceIndex: number;
	/** Canonical mirror of the in-flight notes editor; runtime mirrors after `forward_notes_keystroke`. */
	notesDraft: string;
	/**
	 * Collapsed mode: the questionnaire shrinks to a single hint row so the agent transcript
	 * behind the bottom-anchored overlay becomes readable. Toggled by `Ctrl+]` from any state;
	 * while true, every keystroke except cancel is swallowed (see `routeKey`). The overlay
	 * stays focused so the expand key never falls through to an underlying overlay (e.g.
	 * `/btw`) — that focus-restore property is the entire reason we render a collapsed row
	 * instead of calling `OverlayHandle.setHidden(true)`.
	 */
	collapsed: boolean;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state. Held separately
 * because `keybindings` / `inputBuffer` must never reach view setProps consumers.
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
	/**
	 * Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. Resolved
	 * from `AskUserQuestionConfig.collapseKey` (or the package default). When `"off"`,
	 * the collapse shortcut is disabled.
	 */
	collapseKey: string;
}
