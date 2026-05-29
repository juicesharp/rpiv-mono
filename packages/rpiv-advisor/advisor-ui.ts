/**
 * advisor-ui — bordered select-panel builders for the /advisor command.
 *
 * Two public functions (showAdvisorPicker, showEffortPicker) share a private
 * showFilterablePicker helper that owns the bordered-container layout, the
 * SelectList theme wiring, and a type-to-filter fuzzy search over the items.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { filterItems, isBackspace, isPrintable } from "./fuzzy.js";

const MAX_VISIBLE_ROWS = 10;
const NAV_HINT = "type to filter • ↑↓ navigate • enter select • esc cancel";

const ADVISOR_HEADER_TITLE = "Advisor Tool";
const ADVISOR_HEADER_PROSE_1 =
	"When the active model needs stronger judgment — a complex decision, an ambiguous " +
	"failure, a problem it's circling without progress — it escalates to the " +
	"advisor model for guidance, then resumes. The advisor runs server-side " +
	"and uses additional tokens.";
const ADVISOR_HEADER_PROSE_2 =
	"For certain workloads, pairing a faster model as the main model with a " +
	"more capable one as the advisor gives near-top-tier performance with " +
	"reduced token usage.";

const EFFORT_HEADER_TITLE = "Reasoning Level";
const EFFORT_HEADER_PROSE =
	"Choose the reasoning effort level for the advisor. " +
	"Higher levels produce stronger judgment but use more tokens.";

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function buildSelectPanel(
	theme: Theme,
	title: string,
	proseLines: string[],
	query: string,
	selectList: SelectList,
): Container {
	const container = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));

	container.addChild(border());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
	for (const line of proseLines) {
		container.addChild(new Text(line, 1, 0));
		container.addChild(new Spacer(1));
	}
	const filterText = query.length > 0 ? `Filter: ${query}` : "Type to filter…";
	container.addChild(new Text(theme.fg(query.length > 0 ? "accent" : "dim", filterText), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(selectList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(border());
	return container;
}

interface FilterablePickerOptions {
	title: string;
	proseLines: string[];
	items: SelectItem[];
	/** Value to preselect while the query is empty (e.g. the current effort). */
	preferredValue?: string;
}

function showFilterablePicker(ctx: ExtensionContext, opts: FilterablePickerOptions): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let query = "";
		let selectList: SelectList;
		let container: Container;

		const rebuild = () => {
			const filtered = filterItems(opts.items, query);
			const visibleRows = Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_ROWS);
			selectList = new SelectList(filtered, visibleRows, selectListTheme(theme));
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			if (query.length === 0 && opts.preferredValue) {
				const idx = filtered.findIndex((item) => item.value === opts.preferredValue);
				if (idx >= 0) selectList.setSelectedIndex(idx);
			}
			container = buildSelectPanel(theme, opts.title, opts.proseLines, query, selectList);
		};

		rebuild();

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
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
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

export async function showAdvisorPicker(ctx: ExtensionContext, items: SelectItem[]): Promise<string | null> {
	return showFilterablePicker(ctx, {
		title: ADVISOR_HEADER_TITLE,
		proseLines: [ADVISOR_HEADER_PROSE_1, ADVISOR_HEADER_PROSE_2],
		items,
	});
}

export async function showEffortPicker(
	ctx: ExtensionContext,
	items: SelectItem[],
	currentEffort: ThinkingLevel | undefined,
	defaultEffort: ThinkingLevel,
): Promise<string | null> {
	const preferredValue = items.some((item) => item.value === currentEffort) ? currentEffort : defaultEffort;
	return showFilterablePicker(ctx, {
		title: EFFORT_HEADER_TITLE,
		proseLines: [EFFORT_HEADER_PROSE],
		items,
		preferredValue,
	});
}
