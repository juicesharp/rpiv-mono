import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export interface WrappingSelectItem {
	label: string;
	description?: string;
	/** Sentinel: the inline free-text input row. */
	isOther?: boolean;
	/** Sentinel: the "chat about this question" row. */
	isChat?: boolean;
}

export interface WrappingSelectTheme {
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
}

export interface WrappingSelectOptions {
	/** Start numbering at this offset + 1 (default 0 → rows labeled 1, 2, 3 …). */
	numberStartOffset?: number;
	/** Override the total used to pad the number column (useful when items span multiple lists). */
	totalItemsForNumbering?: number;
}

export class WrappingSelect implements Component {
	private static readonly ACTIVE_POINTER = "❯ ";
	private static readonly INACTIVE_POINTER = "  ";
	private static readonly NUMBER_SEPARATOR = ". ";
	private static readonly INPUT_CURSOR = "▌";
	private static readonly MIN_CONTENT_WIDTH = 1;

	private readonly items: readonly WrappingSelectItem[];
	private readonly maxVisible: number;
	private readonly theme: WrappingSelectTheme;
	private readonly numberStartOffset: number;
	private readonly totalItemsForNumbering: number;

	private selectedIndex = 0;
	private focused = true;
	private inputBuffer = "";

	constructor(
		items: readonly WrappingSelectItem[],
		maxVisible: number,
		theme: WrappingSelectTheme,
		options: WrappingSelectOptions = {},
	) {
		this.items = items;
		this.maxVisible = Math.max(1, maxVisible);
		this.theme = theme;
		this.numberStartOffset = options.numberStartOffset ?? 0;
		this.totalItemsForNumbering = options.totalItemsForNumbering ?? items.length;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	getInputBuffer(): string {
		return this.inputBuffer;
	}

	appendInput(text: string): void {
		const printable = this.stripControlChars(text);
		if (printable) this.inputBuffer += printable;
	}

	backspaceInput(): void {
		if (this.inputBuffer.length === 0) return;
		this.inputBuffer = Array.from(this.inputBuffer).slice(0, -1).join("");
	}

	clearInputBuffer(): void {
		this.inputBuffer = "";
	}

	/** Intentionally empty — input is routed at the container level. */
	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(this.totalItemsForNumbering).length;
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.selectedIndex && this.focused;
			lines.push(...this.renderItem(item, i, isActive, width, numberWidth));
		}

		if (this.hasItemsOutsideWindow(startIndex, endIndex)) {
			lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.items.length})`));
		}
		return lines;
	}

	private computeVisibleWindow(): { startIndex: number; endIndex: number } {
		const half = Math.floor(this.maxVisible / 2);
		const startIndex = Math.max(0, Math.min(this.selectedIndex - half, this.items.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
		return { startIndex, endIndex };
	}

	private hasItemsOutsideWindow(startIndex: number, endIndex: number): boolean {
		return startIndex > 0 || endIndex < this.items.length;
	}

	private renderItem(
		item: WrappingSelectItem,
		index: number,
		isActive: boolean,
		width: number,
		numberWidth: number,
	): string[] {
		const rowPrefix = this.buildRowPrefix(index, isActive, numberWidth);
		const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
		const contentWidth = Math.max(WrappingSelect.MIN_CONTENT_WIDTH, width - visibleWidth(rowPrefix));

		if (this.shouldRenderAsInlineInput(item, isActive)) {
			return [this.renderInlineInputRow(rowPrefix, width)];
		}

		return [
			...this.renderLabelBlock(item.label, rowPrefix, continuationPrefix, contentWidth, isActive),
			...this.renderDescriptionBlock(item.description, continuationPrefix, contentWidth),
		];
	}

	private buildRowPrefix(index: number, isActive: boolean, numberWidth: number): string {
		const pointer = isActive ? WrappingSelect.ACTIVE_POINTER : WrappingSelect.INACTIVE_POINTER;
		const displayNumber = this.numberStartOffset + index + 1;
		const paddedNumber = String(displayNumber).padStart(numberWidth, " ");
		return `${pointer}${paddedNumber}${WrappingSelect.NUMBER_SEPARATOR}`;
	}

	private shouldRenderAsInlineInput(item: WrappingSelectItem, isActive: boolean): boolean {
		return !!item.isOther && isActive;
	}

	private renderInlineInputRow(rowPrefix: string, width: number): string {
		const raw = `${rowPrefix}${this.inputBuffer}${WrappingSelect.INPUT_CURSOR}`;
		return truncateToWidth(this.theme.selectedText(raw), width, "");
	}

	private renderLabelBlock(
		label: string,
		rowPrefix: string,
		continuationPrefix: string,
		contentWidth: number,
		isActive: boolean,
	): string[] {
		const wrapped = wrapTextWithAnsi(label, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			const line = `${prefix}${segment}`;
			return isActive ? this.theme.selectedText(line) : line;
		});
	}

	private renderDescriptionBlock(
		description: string | undefined,
		continuationPrefix: string,
		contentWidth: number,
	): string[] {
		if (!description) return [];
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		return wrapped.map((segment) => `${continuationPrefix}${this.theme.description(segment)}`);
	}

	private stripControlChars(text: string): string {
		return Array.from(text)
			.filter((c) => c >= " ")
			.join("");
	}
}
