/**
 * models-picker — filterable select panel for /rpiv-models cascade pickers.
 *
 * Clone of the advisor's showFilterablePicker (advisor-ui.ts:65-115) at
 * Phase-1 zero-cross-imports contract enforcement. Promotion to a shared TUI
 * package (e.g. packages/rpiv-tui/) is queued as a follow-up.
 */

import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

const MAX_VISIBLE_ROWS = 10;
const navHint = (escAction: string) => `type to filter • ↑↓ navigate • enter select • esc ${escAction}`;

interface FilterablePickerOptions {
	title: string;
	proseLines: string[];
	items: SelectItem[];
	/** Value to preselect while query is empty (e.g. current setting). */
	preferredValue?: string;
	/**
	 * Word describing what ESC does, shown in the nav hint. Defaults to "cancel"
	 * (top-level picker closes); inner cascade levels pass "back" since ESC there
	 * steps one level up rather than closing the whole flow.
	 */
	escHint?: string;
}

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function buildPanel(
	theme: Theme,
	title: string,
	prose: string[],
	query: string,
	list: SelectList,
	escHint: string,
): Container {
	const c = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
	c.addChild(border());
	c.addChild(new Spacer(1));
	c.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	c.addChild(new Spacer(1));
	for (const line of prose) {
		c.addChild(new Text(line, 1, 0));
		c.addChild(new Spacer(1));
	}
	const filterText = query.length > 0 ? `Filter: ${query}` : "Type to filter…";
	c.addChild(new Text(theme.fg(query.length > 0 ? "accent" : "dim", filterText), 1, 0));
	c.addChild(new Spacer(1));
	c.addChild(list);
	c.addChild(new Spacer(1));
	c.addChild(new Text(theme.fg("dim", navHint(escHint)), 1, 0));
	c.addChild(new Spacer(1));
	c.addChild(border());
	return c;
}

function filterItems(items: SelectItem[], query: string): SelectItem[] {
	if (!query) return items;
	const q = query.toLowerCase();
	return items.filter((it) => it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q));
}

function isPrintable(s: string): boolean {
	return s.length === 1 && s.charCodeAt(0) >= 0x20 && s.charCodeAt(0) < 0x7f;
}

function isBackspace(s: string): boolean {
	return s === "\u0008" || s === "\u007f";
}

export function showFilterablePicker(ctx: ExtensionContext, opts: FilterablePickerOptions): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let list: SelectList;
		let panel: Container;

		const rebuild = () => {
			const filtered = filterItems(opts.items, query);
			const rows = Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_ROWS);
			list = new SelectList(filtered, rows, selectListTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			if (query.length === 0 && opts.preferredValue) {
				const idx = filtered.findIndex((it) => it.value === opts.preferredValue);
				if (idx >= 0) list.setSelectedIndex(idx);
			}
			panel = buildPanel(theme, opts.title, opts.proseLines, query, list, opts.escHint ?? "cancel");
		};
		rebuild();

		return {
			render: (w) => panel.render(w),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => {
				if (isBackspace(data)) {
					if (query.length > 0) {
						query = query.slice(0, -1);
						rebuild();
					}
				} else if (isPrintable(data)) {
					query += data;
					rebuild();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}
