import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Input } from "@mariozechner/pi-tui";
import { type QuestionData, SENTINEL_LABELS } from "../tool/types.js";
import { ChatRowView } from "../view/components/chat-row-view.js";
import { MultiSelectView } from "../view/components/multi-select-view.js";
import { OptionListView } from "../view/components/option-list-view.js";
import { PreviewBlockRenderer } from "../view/components/preview/preview-block-renderer.js";
import { PreviewPane } from "../view/components/preview/preview-pane.js";
import { SubmitPicker } from "../view/components/submit-picker.js";
import { TabBar } from "../view/components/tab-bar.js";
import type { WrappingSelectItem, WrappingSelectTheme } from "../view/components/wrapping-select.js";
import { buildDialog } from "../view/dialog-builder.js";
import { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import type { InputBuffer } from "./input-buffer.js";
import { chatNumberingFor, selectActivePreviewPaneIndex } from "./selectors/derivations.js";
import { selectActiveView } from "./selectors/focus.js";
import { selectMultiSelectProps, selectSubmitPickerProps, selectTabBarProps } from "./selectors/projections.js";
import type { QuestionnaireState } from "./state.js";

export interface QuestionnaireBuildConfig {
	tui: { terminal: { columns: number }; requestRender(): void };
	theme: Theme;
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	isMulti: boolean;
	initialState: QuestionnaireState;
	inputBuffer: InputBuffer;
	getCurrentTab: () => number;
}

export interface QuestionnaireBuilt {
	adapter: QuestionnairePropsAdapter;
	notesInput: Input;
	render: (width: number) => string[];
	invalidate: () => void;
}

/**
 * Pure factory: assembles every TUI component, the props adapter, and a
 * lifecycle handle. Holds no `this` reference — every dependency on session
 * state arrives via config callbacks (`getCurrentTab`) or constructor-passed
 * cells (`inputBuffer`).
 *
 * Returns the four narrow handles the action loop needs (`adapter`,
 * `notesInput`, `render`, `invalidate`). The internal components stay
 * encapsulated in the factory closure.
 */
export function buildQuestionnaire(config: QuestionnaireBuildConfig): QuestionnaireBuilt {
	const { tui, theme, questions, itemsByTab, isMulti, initialState, inputBuffer, getCurrentTab } = config;
	const totalQuestions = questions.length;

	const selectTheme: WrappingSelectTheme = {
		selectedText: (t) => theme.fg("accent", theme.bold(t)),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
	};

	const chatRow = new ChatRowView({
		item: { kind: "chat", label: SENTINEL_LABELS.chat },
		theme: selectTheme,
		initialProps: {
			focused: false,
			numbering: chatNumberingFor(itemsByTab[0] ?? []),
		},
	});
	const notesInput = new Input();

	const optionListViewsByTab = itemsByTab.map((items) => new OptionListView({ items, theme: selectTheme }));

	const markdownTheme = getMarkdownTheme();
	const getTerminalWidth = () => tui.terminal.columns;

	const previewPanes = questions.map((q, i) => {
		const previewBlock = new PreviewBlockRenderer({ question: q, theme, markdownTheme });
		return new PreviewPane({
			question: q,
			getTerminalWidth,
			optionListView: optionListViewsByTab[i]!,
			previewBlock,
			initialProps: { notesVisible: false, selectedIndex: 0, focused: false },
		});
	});

	const initialActiveView = selectActiveView(initialState, totalQuestions);
	const multiSelectOptionsByTab: ReadonlyArray<MultiSelectView | undefined> = questions.map((q) =>
		q.multiSelect
			? new MultiSelectView(theme, q, selectMultiSelectProps(initialState, q, initialActiveView))
			: undefined,
	);
	const submitPicker = isMulti
		? new SubmitPicker(theme, selectSubmitPickerProps(initialState, totalQuestions, initialActiveView))
		: undefined;
	const tabBar = isMulti ? new TabBar(selectTabBarProps(initialState, questions), theme) : undefined;

	const computeGlobalContentHeight = (width: number): number => {
		let max = 0;
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i];
			const h = q?.multiSelect
				? (multiSelectOptionsByTab[i]?.naturalHeight(width) ?? 0)
				: (previewPanes[i]?.maxNaturalHeight(width) ?? 0);
			if (h > max) max = h;
		}
		return Math.max(1, max);
	};
	const computeCurrentContentHeight = (width: number): number => {
		const idx = Math.min(getCurrentTab(), questions.length - 1);
		const q = questions[idx];
		if (!q) return 0;
		const h = q.multiSelect
			? (multiSelectOptionsByTab[idx]?.naturalHeight(width) ?? 0)
			: (previewPanes[idx]?.naturalHeight(width) ?? 0);
		return Math.max(0, h);
	};

	const dialog = buildDialog({
		theme,
		questions,
		initialProps: {
			state: initialState,
			activePreviewPane:
				previewPanes[selectActivePreviewPaneIndex(initialState.currentTab, totalQuestions)] ?? previewPanes[0]!,
		},
		tabBar,
		notesInput,
		chatRow,
		isMulti,
		multiSelectOptionsByTab,
		submitPicker,
		getBodyHeight: computeGlobalContentHeight,
		getCurrentBodyHeight: computeCurrentContentHeight,
	});

	const adapter = new QuestionnairePropsAdapter({
		tui,
		questions,
		itemsByTab,
		optionListViewsByTab,
		previewPanes,
		chatRow,
		multiSelectOptionsByTab,
		submitPicker,
		tabBar,
		dialog,
		inputBuffer,
	});

	return {
		adapter,
		notesInput,
		render: (w) => dialog.render(w),
		invalidate: () => dialog.invalidate(),
	};
}
