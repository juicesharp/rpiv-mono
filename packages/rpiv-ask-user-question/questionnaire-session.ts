import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { getKeybindings, Input } from "@mariozechner/pi-tui";
import { type ApplyContext, applyAction, type Effect } from "./apply-action.js";
import { buildDialog, type DialogComponent } from "./dialog-builder.js";
import { handleQuestionnaireInput, type QuestionnaireAction } from "./dispatch.js";
import { MultiSelectOptions } from "./multi-select-options.js";
import { OptionListView } from "./option-list-view.js";
import { PreviewBlockRenderer } from "./preview-block-renderer.js";
import { PreviewPane } from "./preview-pane.js";
import {
	computeFocusedOptionHasPreview,
	type QuestionnaireDispatchSnapshot,
	type QuestionnaireState,
} from "./questionnaire-state.js";
import { SubmitPicker } from "./submit-picker.js";
import { TabBar } from "./tab-bar.js";
import { type QuestionData, type QuestionnaireResult, type QuestionParams, SENTINEL_LABELS } from "./types.js";
import { QuestionnaireViewAdapter } from "./view-adapter.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

const BACKSPACE_CHARS = new Set(["\x7f", "\b"]);
const ESC_SEQUENCE_PREFIX = "\x1b";

export interface QuestionnaireSessionConfig {
	tui: { terminal: { columns: number }; requestRender(): void };
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
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
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
	};
}

/**
 * Slim runtime: owns the canonical state cell, the two-pass `notesVisible` dispatch loop,
 * and the effect runner. State transitions delegate to the pure `applyAction` reducer
 * (`apply-action.ts`); UI fan-out delegates to `QuestionnaireViewAdapter` (`view-adapter.ts`).
 *
 * Mirrors the rpiv-todo "thin controller around a pure reducer" pattern.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];
	private readonly optionListViewsByTab: OptionListView[];
	private readonly previewPanes: PreviewPane[];
	private readonly multiSelectOptionsByTab: ReadonlyArray<MultiSelectOptions | undefined>;
	private readonly submitPicker: SubmitPicker | undefined;
	private readonly tabBar: TabBar | undefined;
	private readonly chatList: WrappingSelect;
	private readonly notesInput: Input;
	private readonly dialog: DialogComponent;
	private readonly viewAdapter: QuestionnaireViewAdapter;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];

	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		// Seed from the focused option at start (cursor at tab 0, option 0). The reducer keeps
		// this in sync via `withFocusedOptionHasPreview` on subsequent transitions.
		this.state = { ...this.state, focusedOptionHasPreview: computeFocusedOptionHasPreview(this.questions, 0, 0) };

		const selectTheme: WrappingSelectTheme = {
			selectedText: (t) => config.theme.fg("accent", config.theme.bold(t)),
			description: (t) => config.theme.fg("muted", t),
			scrollInfo: (t) => config.theme.fg("dim", t),
		};
		this.chatList = new WrappingSelect([{ kind: "chat", label: SENTINEL_LABELS.chat }], 1, selectTheme);
		this.notesInput = new Input();

		this.optionListViewsByTab = this.itemsByTab.map((items) => new OptionListView({ items, theme: selectTheme }));

		const markdownTheme = getMarkdownTheme();
		const getTerminalWidth = () => this.tui.terminal.columns;

		this.previewPanes = this.questions.map((q, i) => {
			const previewBlock = new PreviewBlockRenderer({
				question: q,
				theme: config.theme,
				markdownTheme,
			});
			return new PreviewPane({
				question: q,
				getTerminalWidth,
				optionListView: this.optionListViewsByTab[i]!,
				previewBlock,
			});
		});

		const initialSnap = this.snapshot();
		this.multiSelectOptionsByTab = this.questions.map((q) =>
			q.multiSelect ? new MultiSelectOptions(config.theme, q, initialSnap) : undefined,
		);
		this.submitPicker = this.isMulti ? new SubmitPicker(config.theme, initialSnap) : undefined;
		this.tabBar = this.isMulti
			? new TabBar(
					{
						questions: this.questions,
						answers: new Map(),
						activeTabIndex: 0,
						totalTabs: this.questions.length + 1,
					},
					config.theme,
				)
			: undefined;

		this.dialog = buildDialog({
			theme: config.theme,
			questions: this.questions,
			state: initialSnap,
			previewPane: this.previewPanes[0]!,
			tabBar: this.tabBar,
			notesInput: this.notesInput,
			chatList: this.chatList,
			isMulti: this.isMulti,
			multiSelectOptionsByTab: this.multiSelectOptionsByTab,
			submitPicker: this.submitPicker,
			getBodyHeight: (w) => this.computeGlobalContentHeight(w),
			getCurrentBodyHeight: (w) => this.computeCurrentContentHeight(w),
		});

		this.viewAdapter = new QuestionnaireViewAdapter({
			tui: this.tui,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			optionListViewsByTab: this.optionListViewsByTab,
			previewPanes: this.previewPanes,
			chatList: this.chatList,
			multiSelectOptionsByTab: this.multiSelectOptionsByTab,
			submitPicker: this.submitPicker,
			tabBar: this.tabBar,
			dialog: this.dialog,
		});

		this.component = {
			render: (w) => this.dialog.render(w),
			invalidate: () => this.dialog.invalidate(),
			handleInput: (data) => this.dispatch(data),
		};

		this.viewAdapter.apply(this.state);
	}

	/**
	 * Single dispatch entry point. Two-pass when `notesVisible` is active — once to probe
	 * for `notes_exit`, then forward to the Input on every other key. The head-guard pattern
	 * is load-bearing (any non-Esc/Enter key must reach `Input.handleInput`).
	 */
	dispatch(data: string): void {
		if (this.state.notesVisible) {
			const preAction = handleQuestionnaireInput(data, this.snapshot());
			if (preAction.kind === "notes_exit") {
				this.commit(preAction);
				return;
			}
			this.notesInput.handleInput(data);
			this.tui.requestRender();
			return;
		}

		const action = handleQuestionnaireInput(data, this.snapshot());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = applyAction(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.viewAdapter.apply(this.state);
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.optionListViewsByTab[this.state.currentTab]?.setInputBuffer(effect.value);
				return;
			case "clear_input_buffer":
				this.optionListViewsByTab[this.state.currentTab]?.clearInputBuffer();
				return;
			case "set_notes_value":
				this.notesInput.setValue(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "set_active_preview_pane":
				this.viewAdapter.setActivePreviewPane(effect.paneIndex);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/**
	 * Inline `ignore` handler — preserves per-keystroke buffer mutation when in inputMode.
	 * Routes directly to OptionListView (no PreviewPane proxy). Bypasses the reducer because no
	 * canonical state changes; bypasses the view-adapter because only the OptionListView's own
	 * buffer needs to update before the next render.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		const view = this.optionListViewsByTab[this.state.currentTab];
		if (!view) return;
		if (BACKSPACE_CHARS.has(data)) {
			view.backspaceInput();
			this.tui.requestRender();
		} else if (data && !data.startsWith(ESC_SEQUENCE_PREFIX)) {
			view.appendInput(data);
			this.tui.requestRender();
		}
	}

	private snapshot(): QuestionnaireDispatchSnapshot {
		return {
			...this.state,
			keybindings: getKeybindings(),
			inputBuffer: this.optionListViewsByTab[this.state.currentTab]?.getInputBuffer() ?? "",
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			pendingNotesValue: this.notesInput.getValue().trim(),
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		if (this.state.chatFocused) return { kind: "chat", label: SENTINEL_LABELS.chat };
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		if (this.state.optionIndex < arr.length) return arr[this.state.optionIndex];
		return { kind: "chat", label: SENTINEL_LABELS.chat };
	}

	private computeGlobalContentHeight(width: number): number {
		let max = 0;
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const h = q?.multiSelect
				? (this.multiSelectOptionsByTab[i]?.naturalHeight(width) ?? 0)
				: (this.previewPanes[i]?.maxNaturalHeight(width) ?? 0);
			if (h > max) max = h;
		}
		return Math.max(1, max);
	}

	private computeCurrentContentHeight(width: number): number {
		const idx = Math.min(this.state.currentTab, this.questions.length - 1);
		const q = this.questions[idx];
		if (!q) return 0;
		const h = q.multiSelect
			? (this.multiSelectOptionsByTab[idx]?.naturalHeight(width) ?? 0)
			: (this.previewPanes[idx]?.naturalHeight(width) ?? 0);
		return Math.max(0, h);
	}
}
