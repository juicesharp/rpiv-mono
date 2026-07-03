import type { StatefulView } from "../stateful-view.js";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.js";

/**
 * Maximum number of option rows visible in the WrappingSelect window. Lifted here from
 * `preview-pane.ts` so the cap travels with the option-list owner.
 */
export const MAX_VISIBLE_OPTIONS = 10;

export interface OptionListViewConfig {
	items: readonly WrappingSelectItem[];
	theme: WrappingSelectTheme;
}

/**
 * Per-tick projection of OptionListView state. After Phase 11b, `inputBuffer`
 * is part of the props bag — the session-owned `inlineInput` (a headless
 * `pi-tui` Input instance) supplies its current `getValue()` here per tick.
 * `OptionListView` is purely props-driven; the imperative buffer surface and
 * read-back getters are gone.
 */
export interface OptionListViewProps {
	selectedIndex: number;
	focused: boolean;
	inputBuffer: string;
	inputCursorOffset?: number;
	/** Optional previously-confirmed indicator. Omit when no marker should be drawn. */
	confirmed?: { index: number; labelOverride?: string };
}

/**
 * Sole owner of the option list's interactive state. Wraps a single
 * `WrappingSelect`. Implements `StatefulView<OptionListViewProps>`:
 * `setProps` is the only mutator; render output reflects the last props
 * received.
 */
export class OptionListView implements StatefulView<OptionListViewProps> {
	private readonly select: WrappingSelect;

	constructor(config: OptionListViewConfig) {
		this.select = new WrappingSelect(config.items, Math.min(config.items.length, MAX_VISIBLE_OPTIONS), config.theme, {
			numberStartOffset: 0,
			totalItemsForNumbering: config.items.length,
		});
	}

	setProps(props: OptionListViewProps): void {
		this.select.setSelectedIndex(props.selectedIndex);
		this.select.setFocused(props.focused);
		this.select.setConfirmedIndex(props.confirmed?.index, props.confirmed?.labelOverride);
		this.select.setInputBuffer(props.inputBuffer);
		this.select.setInputCursorOffset(props.inputCursorOffset);
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.select.invalidate();
	}

	render(width: number): string[] {
		return this.select.render(width);
	}

	focusedItemRowRange(width: number): [number, number] {
		return this.select.focusedItemRowRange(width);
	}
}
