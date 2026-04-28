import type { Component } from "@mariozechner/pi-tui";
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
 * Sole owner of the option list's interactive state — `selectedIndex`, `focused`, input buffer,
 * confirmed-index marker. Wraps a single `WrappingSelect`.
 *
 * The session targets this directly for input-buffer effects + per-tick `snapshot` input-buffer
 * reads. The view-adapter targets this directly for `setSelectedIndex` / `setFocused` /
 * `setConfirmedIndex`. `PreviewPane` queries `getSelectedIndex()` and `isFocused()` at render
 * time — no mirrored state cells.
 *
 * NOT a `StatefulComponent<S>` — owns its mutable fields directly rather than projecting from a
 * canonical state object.
 */
export class OptionListView implements Component {
	private readonly select: WrappingSelect;
	private selectedIndex = 0;
	private focused = true;

	constructor(config: OptionListViewConfig) {
		// Reserve a slot for the chat row in the WrappingSelect's number-padding so the column
		// width is identical whether or not the user navigates into chat (chat row uses
		// items.length + 1).
		this.select = new WrappingSelect(config.items, Math.min(config.items.length, MAX_VISIBLE_OPTIONS), config.theme, {
			numberStartOffset: 0,
			totalItemsForNumbering: config.items.length + 1,
		});
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = index;
		this.select.setSelectedIndex(index);
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.select.setFocused(focused);
	}

	isFocused(): boolean {
		return this.focused;
	}

	setConfirmedIndex(index: number | undefined, labelOverride?: string): void {
		this.select.setConfirmedIndex(index, labelOverride);
	}

	setInputBuffer(text: string): void {
		this.select.setInputBuffer(text);
	}

	getInputBuffer(): string {
		return this.select.getInputBuffer();
	}

	appendInput(text: string): void {
		this.select.appendInput(text);
	}

	backspaceInput(): void {
		this.select.backspaceInput();
	}

	clearInputBuffer(): void {
		this.select.clearInputBuffer();
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.select.invalidate();
	}

	render(width: number): string[] {
		return this.select.render(width);
	}
}
