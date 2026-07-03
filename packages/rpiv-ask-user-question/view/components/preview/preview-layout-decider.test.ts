import { describe, expect, it } from "vitest";
import type { QuestionData } from "../../../tool/types.js";
import type { WrappingSelectItem } from "../wrapping-select.js";
import {
	adaptiveLeftWidth,
	crossTabLeftWidthWithDonation,
	crossTabMaxLeftWidth,
	crossTabPreviewBudget,
	MAX_LEFT_RATIO,
	MIN_LEFT,
	MIN_PREVIEW_WIDTH,
	PREVIEW_COLUMN_GAP,
	previewSourceWidth,
} from "./preview-layout-decider.js";

const opt = (label: string): WrappingSelectItem => ({ kind: "option", label });

const question = (options: Array<{ label: string; preview?: string }>, multiSelect?: boolean): QuestionData => ({
	question: "Test?",
	header: "Test",
	options: options.map((o) => ({ label: o.label, description: "", preview: o.preview })),
	...(multiSelect !== undefined ? { multiSelect } : {}),
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

describe("previewSourceWidth", () => {
	it("returns 0 when no option has a preview", () => {
		expect(previewSourceWidth(question([{ label: "A" }, { label: "B" }]))).toBe(0);
	});

	it("returns max source-line width for single-line preview", () => {
		const q = question([
			{ label: "A", preview: "short" },
			{ label: "B", preview: "a longer line here" },
		]);
		expect(previewSourceWidth(q)).toBe("a longer line here".length);
	});

	it("returns max across multiple lines in a single preview", () => {
		const q = question([{ label: "A", preview: "short\na much longer line here" }]);
		expect(previewSourceWidth(q)).toBe("a much longer line here".length);
	});

	it("returns max across all options' previews", () => {
		const q = question([
			{ label: "A", preview: "tiny" },
			{ label: "B", preview: "small\na very wide preview line" },
		]);
		expect(previewSourceWidth(q)).toBe("a very wide preview line".length);
	});

	it("skips options without preview", () => {
		const q = question([{ label: "A" }, { label: "B", preview: "wide content" }]);
		expect(previewSourceWidth(q)).toBe("wide content".length);
	});
});

describe("crossTabPreviewBudget", () => {
	const OVERHEAD = 5; // BORDER_HORIZONTAL_OVERHEAD(2) + 2*BORDER_INNER_PADDING_HORIZONTAL(2) + PREVIEW_PADDING_LEFT(1)

	it("floors at MIN_PREVIEW_WIDTH when no question has previews", () => {
		const qs = [question([{ label: "A" }]), question([{ label: "B" }])];
		expect(crossTabPreviewBudget(qs, 120)).toBe(MIN_PREVIEW_WIDTH);
	});

	it("returns preview content width + overhead when previews are present", () => {
		const qs = [question([{ label: "A", preview: "x".repeat(50) }])];
		expect(crossTabPreviewBudget(qs, 200)).toBe(50 + OVERHEAD);
	});

	it("takes the max across all questions", () => {
		const qs = [question([{ label: "A", preview: "short" }]), question([{ label: "B", preview: "x".repeat(80) }])];
		expect(crossTabPreviewBudget(qs, 200)).toBe(80 + OVERHEAD);
	});

	it("ceilings at paneWidth - GAP - MIN_LEFT", () => {
		const qs = [question([{ label: "A", preview: "x".repeat(200) }])];
		const maxContent = 120 - PREVIEW_COLUMN_GAP - MIN_LEFT;
		expect(crossTabPreviewBudget(qs, 120)).toBe(maxContent + OVERHEAD);
	});

	it("is permutation-invariant", () => {
		const a = question([{ label: "A", preview: "x".repeat(30) }]);
		const b = question([{ label: "B", preview: "x".repeat(70) }]);
		expect(crossTabPreviewBudget([a, b], 120)).toBe(crossTabPreviewBudget([b, a], 120));
	});
});

describe("crossTabLeftWidthWithDonation", () => {
	// 26-char label → labelDriven = 26 + 5 (prefix) + 2 (confirmed) = 33 > MIN_LEFT(30).
	// Required to escape the compact-content guard so the donation path is exercised.
	const LONG_LABEL = "Verbose Descriptive Option";

	it("short labels (labelDriven ≤ MIN_LEFT) suppress donation — compact-content guard", () => {
		// npm/yarn-style: short labels signal compact UI. Even with very narrow previews,
		// donation would inject dead space between options and the box. Skip it.
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("npm"), opt("yarn")]];
		const qs = [
			question([
				{ label: "npm", preview: "npm install" },
				{ label: "yarn", preview: "yarn install" },
			]),
		];
		const result = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 200);
		expect(result).toBe(MIN_LEFT);
	});

	it("no previews + long labels → donation hits ceiling (MIN_PREVIEW_WIDTH floor binds the budget)", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		const qs = [question([{ label: LONG_LABEL }, { label: "B" }])];
		const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, 120);
		expect(labelDriven).toBeGreaterThan(MIN_LEFT);
		const result = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120);
		// MIN_PREVIEW_WIDTH is the budget floor, so donation still engages —
		// result is the ceiling (paneWidth − GAP − MIN_PREVIEW_WIDTH).
		expect(result).toBeGreaterThanOrEqual(labelDriven);
		const ceiling = 120 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
		expect(result).toBe(ceiling);
	});

	it("long labels + narrow previews → slack donation engaged", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		const qs = [question([{ label: LONG_LABEL, preview: "tiny" }, { label: "B" }])];
		const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, 120);
		const donated = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120);
		expect(donated).toBeGreaterThan(labelDriven);
	});

	it("long labels + any wide preview → reverts to label-driven (donation suppressed)", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		const qs = [question([{ label: LONG_LABEL, preview: "x".repeat(100) }])];
		const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, 120);
		expect(crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120)).toBe(labelDriven);
	});

	it("any wide preview anywhere suppresses donation across all tabs", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL)], [opt("B")]];
		const qs = [
			question([{ label: LONG_LABEL, preview: "tiny" }]),
			question([{ label: "B", preview: "x".repeat(100) }]),
		];
		const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, 120);
		expect(crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120)).toBe(labelDriven);
	});

	it("respects MIN_PREVIEW_WIDTH ceiling — right column never below MIN_PREVIEW_WIDTH when donating", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL), opt("B")]];
		const qs = [question([{ label: LONG_LABEL, preview: "tiny" }])];
		const result = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120);
		const rightWidth = 120 - result - PREVIEW_COLUMN_GAP;
		expect(rightWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
	});

	it("is permutation-invariant across tab order", () => {
		const tabs = [{ multiSelect: false }, { multiSelect: false }];
		const a = [opt(LONG_LABEL)];
		const b = [opt("B")];
		const qs = [
			question([{ label: LONG_LABEL, preview: "tiny" }]),
			question([{ label: "B", preview: "x".repeat(60) }]),
		];
		expect(crossTabLeftWidthWithDonation(tabs, [a, b], qs, 120)).toBe(
			crossTabLeftWidthWithDonation(tabs, [b, a], qs, 120),
		);
	});

	it("floors at MIN_LEFT even with donation", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt(LONG_LABEL)]];
		const qs = [question([{ label: LONG_LABEL, preview: "tiny" }])];
		expect(crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 200)).toBeGreaterThanOrEqual(MIN_LEFT);
	});

	it("is deterministic — same args always produce same result", () => {
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [[opt("A"), opt("B")]];
		const qs = [question([{ label: "A", preview: "medium content" }])];
		const first = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120);
		const second = crossTabLeftWidthWithDonation(tabs, itemsByTab, qs, 120);
		expect(first).toBe(second);
	});
});
