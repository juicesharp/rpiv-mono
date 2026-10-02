import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { MultiSelectView } from "./components/multi-select-view.js";
import { WrappingSelect, type WrappingSelectItem } from "./components/wrapping-select.js";
import { optionPointerRows, pointerTargetAt } from "./pointer-target.js";

const theme = {
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
};

describe("pointer targets", () => {
	it("maps only defined option rows and respects cell boundaries", () => {
		const rows = optionPointerRows([0, undefined, 1], 20);
		expect(pointerTargetAt(rows, 0, 0)).toEqual({ kind: "option", index: 0 });
		expect(pointerTargetAt(rows, 19, 2)).toEqual({ kind: "option", index: 1 });
		for (const [x, y] of [
			[-1, 0],
			[20, 0],
			[0, 1],
			[0, -1],
			[0, 3],
		]) {
			expect(pointerTargetAt(rows, x!, y!)).toBeUndefined();
		}
	});

	it.each([12, 30, 120])("single-select row maps share wrapped ANSI/CJK layout at width %i", (width) => {
		const items: WrappingSelectItem[] = [
			{
				kind: "option",
				label: "\x1b[1m日本語の選択肢\x1b[22m",
				description: "long description with emoji 🧪 and continuation text",
			},
			{ kind: "option", label: "Beta" },
			{ kind: "other", label: "Type something." },
		];
		const select = new WrappingSelect(items, 10, theme);
		const lines = select.render(width);
		const rows = select.itemRowMap(width);
		expect(rows).toHaveLength(lines.length);
		const beta = lines.findIndex((line) => line.includes("Beta"));
		expect(rows[beta]).toBe(1);
		expect(rows.slice(0, beta).every((index) => index === 0)).toBe(true);
		select.setSelectedIndex(2);
		select.setInputBuffer("first line\nsecond line with many words");
		expect(select.itemRowMap(width)).toHaveLength(select.render(width).length);
		expect(
			select
				.itemRowMap(width)
				.slice(beta + 1)
				.every((index) => index === 2),
		).toBe(true);
	});

	it("hover does not recenter the visible window or alter the focused row range", () => {
		const items: WrappingSelectItem[] = Array.from({ length: 15 }, (_, i) => ({ kind: "option", label: `row-${i}` }));
		const select = new WrappingSelect(items, 5, theme);
		select.setSelectedIndex(7);
		const before = select.itemRowMap(40);
		const range = select.focusedItemRowRange(40);
		select.setHoveredIndex(9);
		expect(select.itemRowMap(40)).toEqual(before);
		expect(select.focusedItemRowRange(40)).toEqual(range);
		expect(before).toEqual([5, 6, 7, 8, 9, undefined]);
	});

	it("empty single-select lists have no targets", () => {
		expect(new WrappingSelect([], 5, theme).itemRowMap(40)).toEqual([]);
	});

	it.each([18, 80])("multi-select shares its cached row layout at width %i", (width) => {
		const view = new MultiSelectView(makeTheme() as unknown as Theme, {
			question: "Which?",
			header: "Pick",
			multiSelect: true,
			options: [
				{ label: "Alpha", description: "long description ending uniquely" },
				{ label: "Beta", description: "second description" },
			],
		});
		view.setProps({
			rows: [
				{ checked: false, active: false },
				{ checked: true, active: false },
			],
			other: { active: true, inputMode: true, inputBuffer: "first line\nsecond line", inputCursorOffset: undefined },
			nextActive: false,
			nextLabel: "Next",
		});
		const lines = view.render(width);
		const rows = view.pointerRows(width);
		expect(rows).toHaveLength(lines.length);
		expect(rows[lines.findIndex((line) => line.includes("uniquely"))]?.target).toEqual({ kind: "option", index: 0 });
		expect(rows[lines.findIndex((line) => line.includes("Beta"))]?.target).toEqual({ kind: "option", index: 1 });
		expect(rows.at(-1)?.target).toEqual({ kind: "option", index: 3 });
		const [start, end] = view.focusedItemRowRange(width);
		expect(rows.slice(start, end).every((row) => row?.target.index === 2)).toBe(true);
	});
});
