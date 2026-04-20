import { describe, expect, it } from "vitest";
import { WrappingSelect, type WrappingSelectTheme } from "./wrapping-select.js";

const identityTheme: WrappingSelectTheme = {
	selectedText: (t) => t,
	description: (t) => t,
	scrollInfo: (t) => t,
};

describe("WrappingSelect.setSelectedIndex", () => {
	it("clamps negative to 0", () => {
		const s = new WrappingSelect([{ label: "a" }, { label: "b" }], 10, identityTheme);
		s.setSelectedIndex(-5);
		const lines = s.render(40);
		expect(lines[0]).toContain("❯ 1. a");
	});
	it("clamps above-max to last", () => {
		const s = new WrappingSelect([{ label: "a" }, { label: "b" }], 10, identityTheme);
		s.setSelectedIndex(99);
		const lines = s.render(40);
		expect(lines[1]).toContain("❯ 2. b");
	});
});

describe("WrappingSelect.appendInput + backspaceInput (unicode aware)", () => {
	it("strips control chars on append", () => {
		const s = new WrappingSelect([{ label: "a", isOther: true }], 10, identityTheme);
		s.setSelectedIndex(0);
		s.appendInput("abc\x07\x1bdef");
		expect(s.getInputBuffer()).toBe("abcdef");
	});
	it("backspace removes one visual char (Array.from for unicode)", () => {
		const s = new WrappingSelect([{ label: "a", isOther: true }], 10, identityTheme);
		s.setSelectedIndex(0);
		s.appendInput("a😀b");
		s.backspaceInput();
		expect(s.getInputBuffer()).toBe("a😀");
		s.backspaceInput();
		expect(s.getInputBuffer()).toBe("a");
	});
	it("backspace on empty buffer is a no-op", () => {
		const s = new WrappingSelect([{ label: "a", isOther: true }], 10, identityTheme);
		s.backspaceInput();
		expect(s.getInputBuffer()).toBe("");
	});
});

describe("WrappingSelect.render — visible window", () => {
	const items = Array.from({ length: 20 }, (_, i) => ({ label: `row-${i + 1}` }));

	it("renders all items when count <= maxVisible", () => {
		const s = new WrappingSelect(items.slice(0, 3), 10, identityTheme);
		const lines = s.render(40);
		expect(lines.filter((l) => l.includes("row-")).length).toBe(3);
	});

	it("shows scroll indicator when items exceed maxVisible", () => {
		const s = new WrappingSelect(items, 5, identityTheme);
		s.setSelectedIndex(10);
		const lines = s.render(40);
		expect(lines.some((l) => l.includes("(11/20)"))).toBe(true);
	});

	it("centers window around selectedIndex", () => {
		const s = new WrappingSelect(items, 5, identityTheme);
		s.setSelectedIndex(10);
		const lines = s.render(40);
		expect(lines.some((l) => /\brow-9\b/.test(l))).toBe(true);
		expect(lines.some((l) => /\brow-11\b/.test(l))).toBe(true);
		expect(lines.some((l) => /\brow-1\b/.test(l))).toBe(false);
	});

	it("returns empty array for zero items", () => {
		const s = new WrappingSelect([], 5, identityTheme);
		expect(s.render(40)).toEqual([]);
	});
});

describe("WrappingSelect.render — inline input when isOther + focused", () => {
	it("renders inline input row with cursor when isOther item focused", () => {
		const s = new WrappingSelect([{ label: "pick", isOther: true }], 1, identityTheme);
		s.setSelectedIndex(0);
		s.setFocused(true);
		s.appendInput("hi");
		const lines = s.render(40);
		expect(lines[0]).toContain("hi");
		expect(lines[0]).toContain("▌");
	});
	it("renders label (not input) when isOther but NOT focused", () => {
		const s = new WrappingSelect([{ label: "pick", isOther: true }], 1, identityTheme);
		s.setFocused(false);
		s.appendInput("buf");
		const lines = s.render(40);
		expect(lines[0]).toContain("pick");
		expect(lines[0]).not.toContain("▌");
	});
});

describe("WrappingSelect.render — number column padding", () => {
	it("pads numbers to width of total count", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ label: `r${i + 1}` }));
		const s = new WrappingSelect(items, 20, identityTheme);
		const lines = s.render(40);
		expect(lines[0]).toContain(" 1. ");
		expect(lines[9]).toContain("10. ");
	});
	it("uses numberStartOffset for numbering", () => {
		const s = new WrappingSelect([{ label: "chat" }], 1, identityTheme, {
			numberStartOffset: 5,
			totalItemsForNumbering: 10,
		});
		const lines = s.render(40);
		expect(lines[0]).toContain(" 6. chat");
	});
});

describe("WrappingSelect.render — description block", () => {
	it("renders description lines under label", () => {
		const s = new WrappingSelect([{ label: "L", description: "desc-line" }], 2, identityTheme);
		const lines = s.render(40);
		expect(lines.some((l) => l.includes("desc-line"))).toBe(true);
	});
	it("omits description block when absent", () => {
		const s = new WrappingSelect([{ label: "L" }], 1, identityTheme);
		expect(s.render(40).length).toBe(1);
	});
});
