import { describe, expect, it } from "vitest";
import type { QuestionData } from "../../../tool/types.ts";
import type { WrappingSelectItem } from "../wrapping-select.ts";
import {
	adaptiveLeftWidth,
	crossTabLeftWidth,
	crossTabMaxLeftWidth,
	MAX_LEFT_RATIO,
	MIN_LEFT,
	MIN_PREVIEW_WIDTH,
	PREVIEW_COLUMN_GAP,
	previewRigidWidth,
} from "./preview-layout-decider.ts";

const opt = (label: string): WrappingSelectItem => ({ kind: "option", label });

const optWithDesc = (label: string, description: string): WrappingSelectItem => ({
	kind: "option",
	label,
	description,
});

const question = (options: Array<{ label: string; preview?: string }>): QuestionData => ({
	question: "Test?",
	header: "Test",
	options: options.map((o) => ({ label: o.label, description: "", preview: o.preview })),
});

describe("adaptiveLeftWidth", () => {
	// prefixW for totalForNumbering=2 is 1 digit + 4 ("❯ " + ". ") = 5; confirmedOverhead = 2.
	const OVERHEAD = 7;

	it("label-only items keep the label-driven width", () => {
		expect(adaptiveLeftWidth([opt("x".repeat(40)), opt("y")], 2, 200)).toBe(40 + OVERHEAD);
		// An empty description is ignored, same as a missing one.
		expect(adaptiveLeftWidth([optWithDesc("x".repeat(40), ""), opt("y")], 2, 200)).toBe(40 + OVERHEAD);
	});

	it("longest description drives the width so it wraps to at most two lines", () => {
		// 60-col description → target content width 30 → column 30 + 7 = 37.
		expect(adaptiveLeftWidth([optWithDesc("A", "d".repeat(60))], 2, 200)).toBe(30 + OVERHEAD);
	});

	it("label wins when it is wider than half the longest description", () => {
		expect(adaptiveLeftWidth([optWithDesc("x".repeat(80), "d".repeat(60))], 2, 200)).toBe(80 + OVERHEAD);
	});

	it("respects MAX_LEFT_RATIO ceiling even with long descriptions", () => {
		expect(adaptiveLeftWidth([optWithDesc("A", "d".repeat(300))], 2, 120)).toBe(Math.floor(120 * MAX_LEFT_RATIO));
	});

	it("floors at MIN_LEFT when descriptions are short", () => {
		expect(adaptiveLeftWidth([optWithDesc("A", "short")], 2, 200)).toBe(MIN_LEFT);
	});

	it("description width is measured in display columns (CJK counts double)", () => {
		// 26 Han chars → 52 display columns → half-target 26 → column 26 + 7 = 33.
		expect(adaptiveLeftWidth([optWithDesc("选项", "汉".repeat(26))], 2, 200)).toBe(26 + OVERHEAD);
	});
});

describe("crossTabMaxLeftWidth", () => {
	it("returns MIN_LEFT for empty input", () => {
		expect(crossTabMaxLeftWidth([], [], 120)).toBe(MIN_LEFT);
	});

	it("floors at MIN_LEFT when every tab has short labels", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		const itemsByTab = [[opt("A"), opt("B")], [opt("C")]];
		expect(crossTabMaxLeftWidth(tabs, itemsByTab, 120)).toBe(MIN_LEFT);
	});

	it("returns the widest tab — single long label dominates short tabs", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		const longLabel = "A very long option label that exceeds MIN_LEFT comfortably";
		const itemsByTab = [
			[opt("A"), opt("B")],
			[opt(longLabel), opt("y")],
		];
		const longSingleTab = adaptiveLeftWidth([opt(longLabel), opt("y")], 3, 120);
		expect(crossTabMaxLeftWidth(tabs, itemsByTab, 120)).toBe(longSingleTab);
		expect(longSingleTab).toBeGreaterThan(MIN_LEFT);
	});

	it("respects MAX_LEFT_RATIO ceiling — never exceeds floor(paneWidth * 0.5)", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("x".repeat(120)), opt("y")]];
		const result = crossTabMaxLeftWidth(tabs, itemsByTab, 120);
		expect(result).toBeLessThanOrEqual(Math.floor(120 * MAX_LEFT_RATIO));
	});

	it("respects MIN_PREVIEW_WIDTH safety net on narrow panes", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("x".repeat(60)), opt("y")]];
		// At width 82: available = 82 - GAP(2) - MIN_PREVIEW_WIDTH(45) = 35
		const result = crossTabMaxLeftWidth(tabs, itemsByTab, 82);
		expect(result).toBeLessThanOrEqual(82 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH);
	});

	it("single- and multi-select tabs use items.length for numbering (no chat row slot)", () => {
		const longLabel = "x".repeat(30);
		const items = Array.from({ length: 9 }, () => opt(longLabel));
		const multi = crossTabMaxLeftWidth([{ multiSelect: true }], [items], 200);
		const single = crossTabMaxLeftWidth([{ multiSelect: false }], [items], 200);
		expect(single).toBe(multi);
	});

	it("idempotent across tab order — max is permutation-invariant", () => {
		const a: WrappingSelectItem[] = [opt("short")];
		const b: WrappingSelectItem[] = [opt("a much longer option label here")];
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		expect(crossTabMaxLeftWidth(tabs, [a, b], 120)).toBe(crossTabMaxLeftWidth(tabs, [b, a], 120));
	});

	it("missing itemsByTab[i] is treated as an empty tab, not a crash", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		// Only one entry in itemsByTab — second tab missing
		const itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]> = [[opt("a")]];
		expect(() => crossTabMaxLeftWidth(tabs, itemsByTab, 120)).not.toThrow();
		expect(crossTabMaxLeftWidth(tabs, itemsByTab, 120)).toBe(MIN_LEFT);
	});
});

describe("previewRigidWidth", () => {
	it("returns 0 when no option has a preview", () => {
		expect(previewRigidWidth(question([{ label: "A" }, { label: "B" }]))).toBe(0);
	});

	it("returns 0 for prose-only previews — markdown wraps prose to any width", () => {
		const q = question([{ label: "A", preview: "a plain sentence\nanother prose line" }]);
		expect(previewRigidWidth(q)).toBe(0);
	});

	it("measures the widest line inside fenced code blocks", () => {
		const q = question([{ label: "A", preview: "```\nshort\n" + "x".repeat(80) + "\nshorter\n```" }]);
		expect(previewRigidWidth(q)).toBe(80);
	});

	it("measures table rows outside fences", () => {
		const q = question([{ label: "A", preview: "intro prose\n| col | col |" }]);
		expect(previewRigidWidth(q)).toBe("| col | col |".length);
	});

	it("takes the max across all options", () => {
		const q = question([
			{ label: "A", preview: "```\n" + "y".repeat(30) + "\n```" },
			{ label: "B", preview: "```\n" + "z".repeat(60) + "\n```" },
		]);
		expect(previewRigidWidth(q)).toBe(60);
	});

	it("ignores trailing spaces on rigid lines", () => {
		const q = question([{ label: "A", preview: "```\ncode   \n```" }]);
		expect(previewRigidWidth(q)).toBe(4);
	});

	it("measures indented fenced lines at their full visible width", () => {
		const q = question([{ label: "A", preview: "```\n    " + "x".repeat(10) + "\n```" }]);
		expect(previewRigidWidth(q)).toBe(14);
	});
});

describe("crossTabLeftWidth", () => {
	// 26-char label → labelDriven = 26 + 5 (prefix) + 2 (confirmed) = 33 > MIN_LEFT(30).
	const LONG_LABEL = "Verbose Descriptive Option";

	it("short labels keep the column at MIN_LEFT on a wide pane — no slack donation", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("npm"), opt("yarn")]];
		expect(crossTabLeftWidth(tabs, itemsByTab, 200)).toBe(MIN_LEFT);
	});

	it("returns the cross-tab label-driven width — previews no longer participate", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		expect(crossTabLeftWidth(tabs, itemsByTab, 200)).toBe(crossTabMaxLeftWidth(tabs, itemsByTab, 200));
	});

	it("respects MAX_LEFT_RATIO ceiling — never exceeds floor(paneWidth * 0.5)", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("x".repeat(120)), opt("y")]];
		expect(crossTabLeftWidth(tabs, itemsByTab, 120)).toBe(Math.floor(120 * MAX_LEFT_RATIO));
	});

	it("re-clamps the MIN_LEFT floor to the preview-safety ceiling on narrow panes", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("x".repeat(60)), opt("y")]];
		// At width 70: adaptiveLeftWidth's own floor keeps 30, but the side-by-side
		// safety net only allows 70 - GAP(2) - MIN_PREVIEW_WIDTH(45) = 23.
		expect(crossTabLeftWidth(tabs, itemsByTab, 70)).toBe(70 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH);
	});

	it("respects MIN_PREVIEW_WIDTH ceiling — right column never below MIN_PREVIEW_WIDTH", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		const result = crossTabLeftWidth(tabs, itemsByTab, 120);
		const rightWidth = 120 - result - PREVIEW_COLUMN_GAP;
		expect(rightWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
	});

	it("is permutation-invariant across tab order", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		const a = [opt(LONG_LABEL)];
		const b = [opt("B")];
		expect(crossTabLeftWidth(tabs, [a, b], 120)).toBe(crossTabLeftWidth(tabs, [b, a], 120));
	});

	it("floors at MIN_LEFT", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL)]];
		expect(crossTabLeftWidth(tabs, itemsByTab, 200)).toBeGreaterThanOrEqual(MIN_LEFT);
	});

	it("is deterministic — same args always produce same result", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("A"), opt("B")]];
		expect(crossTabLeftWidth(tabs, itemsByTab, 120)).toBe(crossTabLeftWidth(tabs, itemsByTab, 120));
	});
});
