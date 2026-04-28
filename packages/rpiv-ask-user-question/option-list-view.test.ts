import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_OPTIONS, OptionListView } from "./option-list-view.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

const baseTheme = makeTheme() as unknown as Theme;
const selectTheme = {
	selectedText: (t: string) => baseTheme.fg("accent", baseTheme.bold(t)),
	description: (t: string) => baseTheme.fg("muted", t),
	scrollInfo: (t: string) => baseTheme.fg("dim", t),
};

function makeView(items: WrappingSelectItem[]): OptionListView {
	return new OptionListView({ items, theme: selectTheme });
}

const sampleItems: WrappingSelectItem[] = [
	{ kind: "option", label: "Alpha" },
	{ kind: "option", label: "Beta" },
	{ kind: "option", label: "Gamma" },
];

describe("OptionListView — selectedIndex SOT", () => {
	it("getSelectedIndex defaults to 0", () => {
		const v = makeView(sampleItems);
		expect(v.getSelectedIndex()).toBe(0);
	});

	it("setSelectedIndex updates the value queryable via getSelectedIndex", () => {
		const v = makeView(sampleItems);
		v.setSelectedIndex(2);
		expect(v.getSelectedIndex()).toBe(2);
	});

	it("setSelectedIndex value is reflected in render() row activation (cursor on row 3)", () => {
		const v = makeView(sampleItems);
		v.setSelectedIndex(2);
		v.setFocused(true);
		const lines = v.render(40);
		const activeRow = lines.find((l) => l.includes("Gamma"));
		expect(activeRow).toBeDefined();
		expect(activeRow!.includes("❯")).toBe(true);
	});
});

describe("OptionListView — focused SOT", () => {
	it("isFocused defaults to true", () => {
		const v = makeView(sampleItems);
		expect(v.isFocused()).toBe(true);
	});

	it("setFocused(false) makes isFocused() return false; render no longer shows the active pointer", () => {
		const v = makeView(sampleItems);
		v.setSelectedIndex(0);
		v.setFocused(false);
		expect(v.isFocused()).toBe(false);
		const lines = v.render(40);
		expect(lines.every((l) => !l.startsWith("❯"))).toBe(true);
	});

	it("setFocused(true) restores the active pointer at row 0", () => {
		const v = makeView(sampleItems);
		v.setFocused(true);
		v.setSelectedIndex(0);
		const lines = v.render(40);
		expect(lines[0]?.includes("❯")).toBe(true);
	});
});

describe("OptionListView — input buffer proxies", () => {
	const otherItems: WrappingSelectItem[] = [
		{ kind: "option", label: "Alpha" },
		{ kind: "other", label: "Type something." },
	];

	it("getInputBuffer returns empty string by default", () => {
		const v = makeView(otherItems);
		expect(v.getInputBuffer()).toBe("");
	});

	it("setInputBuffer + getInputBuffer round-trip", () => {
		const v = makeView(otherItems);
		v.setInputBuffer("Hello");
		expect(v.getInputBuffer()).toBe("Hello");
	});

	it("appendInput grows the buffer; backspaceInput shrinks; clearInputBuffer empties", () => {
		const v = makeView(otherItems);
		v.appendInput("Hi");
		expect(v.getInputBuffer()).toBe("Hi");
		v.appendInput("!");
		expect(v.getInputBuffer()).toBe("Hi!");
		v.backspaceInput();
		expect(v.getInputBuffer()).toBe("Hi");
		v.clearInputBuffer();
		expect(v.getInputBuffer()).toBe("");
	});

	it("inline input render reflects input buffer when row is active", () => {
		const v = makeView(otherItems);
		v.setSelectedIndex(1);
		v.setFocused(true);
		v.setInputBuffer("typed");
		const lines = v.render(40);
		expect(lines.some((l) => l.includes("typed"))).toBe(true);
		expect(lines.some((l) => l.includes("▌"))).toBe(true);
	});
});

describe("OptionListView — confirmed-index passthrough", () => {
	it("setConfirmedIndex(1) renders ' ✔' on row 2", () => {
		const v = makeView(sampleItems);
		v.setSelectedIndex(0);
		v.setFocused(true);
		v.setConfirmedIndex(1);
		const lines = v.render(40);
		expect(lines.some((l) => l.includes("Beta ✔"))).toBe(true);
	});

	it("setConfirmedIndex(undefined) clears the marker", () => {
		const v = makeView(sampleItems);
		v.setConfirmedIndex(1);
		v.setConfirmedIndex(undefined);
		const lines = v.render(40);
		expect(lines.join("\n").includes("✔")).toBe(false);
	});
});

describe("OptionListView — visible-window cap", () => {
	it("MAX_VISIBLE_OPTIONS is 10", () => {
		expect(MAX_VISIBLE_OPTIONS).toBe(10);
	});
});
