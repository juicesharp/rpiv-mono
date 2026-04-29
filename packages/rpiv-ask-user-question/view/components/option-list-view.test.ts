import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_OPTIONS, OptionListView, type OptionListViewProps } from "./option-list-view.js";
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

function props(over: Partial<OptionListViewProps> = {}): OptionListViewProps {
	return {
		selectedIndex: over.selectedIndex ?? 0,
		focused: over.focused ?? true,
		inputBuffer: over.inputBuffer ?? "",
		...(over.confirmed ? { confirmed: over.confirmed } : {}),
	};
}

const sampleItems: WrappingSelectItem[] = [
	{ kind: "option", label: "Alpha" },
	{ kind: "option", label: "Beta" },
	{ kind: "option", label: "Gamma" },
];

describe("OptionListView — selectedIndex projection", () => {
	it("setProps({selectedIndex}) value is reflected in render() row activation (cursor on row 3)", () => {
		const v = makeView(sampleItems);
		v.setProps(props({ selectedIndex: 2, focused: true }));
		const lines = v.render(40);
		const activeRow = lines.find((l) => l.includes("Gamma"));
		expect(activeRow).toBeDefined();
		expect(activeRow!.includes("❯")).toBe(true);
	});
});

describe("OptionListView — focused projection", () => {
	it("setProps({focused: false}) hides the active pointer", () => {
		const v = makeView(sampleItems);
		v.setProps(props({ selectedIndex: 0, focused: false }));
		const lines = v.render(40);
		expect(lines.every((l) => !l.startsWith("❯"))).toBe(true);
	});

	it("setProps({focused: true}) shows the active pointer at row 0", () => {
		const v = makeView(sampleItems);
		v.setProps(props({ selectedIndex: 0, focused: true }));
		const lines = v.render(40);
		expect(lines[0]?.includes("❯")).toBe(true);
	});
});

describe("OptionListView — inputBuffer prop", () => {
	const otherItems: WrappingSelectItem[] = [
		{ kind: "option", label: "Alpha" },
		{ kind: "other", label: "Type something." },
	];

	it("setProps({inputBuffer}) reflects buffer text in inline-input row render", () => {
		const v = makeView(otherItems);
		v.setProps(props({ selectedIndex: 1, focused: true, inputBuffer: "typed" }));
		const lines = v.render(40);
		expect(lines.some((l) => l.includes("typed"))).toBe(true);
		expect(lines.some((l) => l.includes("▌"))).toBe(true);
	});
});

describe("OptionListView — confirmed-index passthrough", () => {
	it("setProps({confirmed: { index: 1 }}) renders ' ✔' on row 2", () => {
		const v = makeView(sampleItems);
		v.setProps(props({ selectedIndex: 0, focused: true, confirmed: { index: 1 } }));
		const lines = v.render(40);
		expect(lines.some((l) => l.includes("Beta ✔"))).toBe(true);
	});

	it("omitting confirmed in setProps clears the marker", () => {
		const v = makeView(sampleItems);
		v.setProps(props({ confirmed: { index: 1 } }));
		v.setProps(props());
		const lines = v.render(40);
		expect(lines.join("\n").includes("✔")).toBe(false);
	});
});

describe("OptionListView — visible-window cap", () => {
	it("MAX_VISIBLE_OPTIONS is 10", () => {
		expect(MAX_VISIBLE_OPTIONS).toBe(10);
	});
});
