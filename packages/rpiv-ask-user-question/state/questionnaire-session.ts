import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Input, type OverlayHandle } from "@earendil-works/pi-tui";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { COLLAPSED_HINT } from "../view/dialog-builder.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire } from "./build-questionnaire.js";
import { t } from "./i18n-bridge.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import { computeFocusedOptionHasPreview } from "./selectors/derivations.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";

// Module-level constant; reused for cursor-end mutations after setValue rehydration.
// Ctrl-E → tui.editor.cursorLineEnd (public path; pi-tui keybindings.js:25-28).
const CURSOR_END = "\x05";

export interface QuestionnaireSessionConfig {
	tui: { terminal: { columns: number; rows: number }; requestRender(): void };
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	/** Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
	collapseKey: string;
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

/**
 * Slim runtime: owns the canonical state cell, the input-buffer cell, the
 * two-pass `notesVisible` dispatch loop, and the effect runner. State
 * transitions go through the pure `reduce` reducer; UI fan-out goes through
 * the `QuestionnairePropsAdapter` produced by `buildQuestionnaire`.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Input;
	private readonly inlineInput: Input;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly collapseKey: string;

	/**
	 * Overlay handle captured by `ctx.ui.custom`'s `onHandle` callback. Lets the session
	 * call `setHidden(true/false)` so pi-tui's overlay stack reflects the collapsed state
	 * and overlay-aware consumers (e.g. `pi-station`) can resume normal behaviour.
	 */
	private overlayHandle: OverlayHandle | undefined;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.collapseKey = config.collapseKey;
		// Seed from the focused option at start; the reducer keeps it in sync via withFocusedOptionHasPreview.
		this.state = { ...this.state, focusedOptionHasPreview: computeFocusedOptionHasPreview(this.questions, 0, 0) };

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		const theme = config.theme;
		// Collapsed render: a single dim row at the bottom of the overlay. pi-tui sizes
		// the overlay to `min(lines.length, maxHeight)`, so returning one line shrinks
		// the bottom-anchored overlay from full-height to one row and the transcript
		// behind it becomes readable (#47). The overlay stays focused and in the
		// stack, so Ctrl+] still routes here to expand.
		const collapsedRender = (_width: number): string[] => [
			theme.fg("dim", ` ${t("hint.expand_line", COLLAPSED_HINT)} `),
		];

		this.component = {
			render: (width) => (this.state.collapsed ? collapsedRender(width) : built.render(width)),
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
		};

		this.viewAdapter.apply(this.state);
	}

	dispatch(data: string): void {
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		const draft = this.notesInput.getValue();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setValue(effect.value);
				this.inlineInput.handleInput(CURSOR_END);
				return;
			case "clear_input_buffer":
				this.inlineInput.setValue("");
				return;
			case "set_notes_value":
				this.notesInput.setValue(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "set_overlay_hidden":
				// No-op until `setOverlayHandle` has been called (the handle arrives via
				// `ctx.ui.custom`'s `onHandle` right after the overlay is shown).
				this.overlayHandle?.setHidden(effect.hidden);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/**
	 * Per-keystroke `ignore` fast path: delegates to the headless `inlineInput`
	 * Input so bracketed-paste accumulator (`input.js:33-63`) and Kitty CSI-u
	 * decode (`input.js:155-163`) take effect. Cursor is NOT force-reset here —
	 * doing so would corrupt split-chunk pastes (a `\x05` byte mid-paste lands
	 * verbatim in `pasteBuffer` and survives `handlePaste`'s narrow strip).
	 * Cursor advances naturally via `insertCharacter` on typing/paste; cursor-
	 * movement keys (Left/Right/Home/End/word-jumps) are now functional, with
	 * the always-end visual cursor marker drawn independently by
	 * `WrappingSelect.renderInlineInputRow`. `viewAdapter.apply` is called
	 * directly without a reducer round-trip — preserves the D3 fast-path
	 * latency profile from Phase 11.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		return {
			keybindings: getKeybindings(),
			inputBuffer: this.inlineInput.getValue(),
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
			collapseKey: this.collapseKey,
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}

	/**
	 * Setter for the overlay handle, called by `ctx.ui.custom`'s `onHandle` callback once
	 * the TUI has created the overlay. Until this is called, `set_overlay_hidden` effects
	 * are no-ops — the session still tracks `state.collapsed` for the view layer.
	 */
	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	/**
	 * Public toggle used by the raw terminal input listener registered in `execute()`.
	 * pi-tui does not route input to a hidden overlay's `component.handleInput`, so the
	 * raw listener (which fires for terminal data regardless of overlay visibility)
	 * reaches the session through this method instead of the dispatch path. Routed
	 * through `commit` so the transition stays in the reducer and the overlay hide
	 * happens via the `set_overlay_hidden` effect like every other side effect.
	 */
	toggleCollapsedExternal(): void {
		this.commit({ kind: "toggle_collapsed" });
	}
}
