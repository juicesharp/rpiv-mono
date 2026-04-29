import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Input } from "@mariozechner/pi-tui";
import { type QuestionData, SENTINEL_LABELS } from "../tool/types.js";
import {
	type BoundGlobalBinding,
	type BoundPerTabBinding,
	globalBinding,
	perTabBinding,
} from "../view/component-binding.js";
import { ChatRowView } from "../view/components/chat-row-view.js";
import { MultiSelectView } from "../view/components/multi-select-view.js";
import { OptionListView } from "../view/components/option-list-view.js";
import { PreviewBlockRenderer } from "../view/components/preview/preview-block-renderer.js";
import { PreviewPane } from "../view/components/preview/preview-pane.js";
import { SubmitPicker } from "../view/components/submit-picker.js";
import { TabBar } from "../view/components/tab-bar.js";
import type { WrappingSelectItem, WrappingSelectTheme } from "../view/components/wrapping-select.js";
import { DialogView } from "../view/dialog-builder.js";
import { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import type { TabComponents } from "../view/tab-components.js";
import type { InputBuffer } from "./input-buffer.js";
import type { PerTabSelector } from "./selectors/contract.js";
import { selectActivePreviewPaneIndex } from "./selectors/derivations.js";
import {
	selectChatRowProps,
	selectDialogProps,
	selectMultiSelectProps,
	selectOptionListProps,
	selectPreviewPaneProps,
	selectSubmitPickerProps,
	selectTabBarProps,
} from "./selectors/projections.js";
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
 * lifecycle handle. Session-state dependencies arrive via `getCurrentTab` and
 * the `inputBuffer` cell. Initial paint is delegated to
 * `adapter.apply(initialState)` (called by the session at construction-end);
 * no selector is invoked here.
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
	});
	const notesInput = new Input();

	const markdownTheme = getMarkdownTheme();
	const getTerminalWidth = () => tui.terminal.columns;

	// Concrete-typed locals retained for the height callbacks
	// (`naturalHeight` / `maxNaturalHeight` are not on `StatefulView<P>`).
	const previewPanesByTab: PreviewPane[] = [];
	const multiSelectViewsByTab: (MultiSelectView | undefined)[] = [];

	const tabsByIndex: ReadonlyArray<TabComponents> = questions.map((q, i) => {
		const optionList = new OptionListView({ items: itemsByTab[i] ?? [], theme: selectTheme });
		const previewBlock = new PreviewBlockRenderer({ question: q, theme, markdownTheme });
		const preview = new PreviewPane({
			question: q,
			getTerminalWidth,
			optionListView: optionList,
			previewBlock,
		});
		const multiSelect = q.multiSelect ? new MultiSelectView(theme, q) : undefined;

		previewPanesByTab.push(preview);
		multiSelectViewsByTab.push(multiSelect);

		return { optionList, preview, multiSelect };
	});

	const submitPicker = isMulti ? new SubmitPicker(theme) : undefined;
	const tabBar = isMulti ? new TabBar(theme) : undefined;

	const computeGlobalContentHeight = (width: number): number => {
		let max = 0;
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i];
			const h = q?.multiSelect
				? (multiSelectViewsByTab[i]?.naturalHeight(width) ?? 0)
				: (previewPanesByTab[i]?.maxNaturalHeight(width) ?? 0);
			if (h > max) max = h;
		}
		return Math.max(1, max);
	};
	const computeCurrentContentHeight = (width: number): number => {
		const idx = Math.min(getCurrentTab(), questions.length - 1);
		const q = questions[idx];
		if (!q) return 0;
		const h = q.multiSelect
			? (multiSelectViewsByTab[idx]?.naturalHeight(width) ?? 0)
			: (previewPanesByTab[idx]?.naturalHeight(width) ?? 0);
		return Math.max(0, h);
	};

	const initialActivePreviewPane =
		previewPanesByTab[selectActivePreviewPaneIndex(initialState.currentTab, totalQuestions)] ?? previewPanesByTab[0]!;

	const dialog = new DialogView(
		{
			theme,
			questions,
			tabBar,
			notesInput,
			chatRow,
			isMulti,
			tabsByIndex,
			submitPicker,
			getBodyHeight: computeGlobalContentHeight,
			getCurrentBodyHeight: computeCurrentContentHeight,
		},
		{ state: initialState, activePreviewPane: initialActivePreviewPane },
	);

	const globalBindings: ReadonlyArray<BoundGlobalBinding> = [
		globalBinding({ component: dialog, select: selectDialogProps }),
		globalBinding({ component: chatRow, select: selectChatRowProps }),
		...(submitPicker ? [globalBinding({ component: submitPicker, select: selectSubmitPickerProps })] : []),
		...(tabBar ? [globalBinding({ component: tabBar, select: selectTabBarProps })] : []),
	];

	const isActiveTab: PerTabSelector<boolean> = (s, ctx) => {
		const paneIdx = ctx.totalQuestions <= 0 ? 0 : Math.min(s.currentTab, ctx.totalQuestions - 1);
		return ctx.i === paneIdx;
	};

	const perTabBindings: ReadonlyArray<BoundPerTabBinding> = [
		perTabBinding({
			resolve: (tab) => tab.optionList,
			predicate: isActiveTab,
			select: selectOptionListProps,
		}),
		perTabBinding({
			resolve: (tab) => tab.preview,
			predicate: isActiveTab,
			select: selectPreviewPaneProps,
		}),
		perTabBinding({
			resolve: (tab) => tab.multiSelect,
			select: selectMultiSelectProps,
		}),
	];

	const adapter = new QuestionnairePropsAdapter({
		tui,
		questions,
		itemsByTab,
		tabsByIndex,
		inputBuffer,
		globalBindings,
		perTabBindings,
		extraInvalidatables: [notesInput],
	});

	return {
		adapter,
		notesInput,
		render: (w) => dialog.render(w),
		invalidate: () => adapter.invalidate(),
	};
}
