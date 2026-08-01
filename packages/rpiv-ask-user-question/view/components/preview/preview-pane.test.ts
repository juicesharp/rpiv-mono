import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

let markdownConstructed = 0;
let lastMarkdownText = "";
vi.mock("@earendil-works/pi-tui", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	class FakeMarkdown {
		constructor(public text: string) {
			markdownConstructed++;
			lastMarkdownText = text;
		}
		render(width: number): string[] {
			return [`MD[${width}]:${this.text.slice(0, Math.max(0, width - 4))}`];
		}
		invalidate(): void {}
		setText(t: string): void {
			this.text = t;
		}
	}
	return { ...actual, Markdown: FakeMarkdown };
});

import { applyLocale, registerStrings } from "@juicesharp/rpiv-i18n";
import { I18N_NAMESPACE } from "../../../state/i18n-bridge.js";
import type { QuestionData } from "../../../tool/types.js";
import { OptionListView } from "../option-list-view.js";
import type { WrappingSelectItem } from "../wrapping-select.js";
import {
	adaptiveLeftWidth,
	crossTabLeftWidthWithDonation,
	MAX_LEFT_RATIO,
	MIN_LEFT,
	MIN_PREVIEW_WIDTH,
	PREVIEW_COLUMN_GAP,
} from "./preview-layout-decider.js";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_TEXT,
	PREVIEW_MIN_WIDTH,
	PreviewBlockRenderer,
	PreviewPane,
	renderBorderedBox,
} from "./preview-pane.js";

const theme = makeTheme() as unknown as Theme;
const selectTheme = {
	selectedText: (t: string) => theme.fg("accent", theme.bold(t)),
	description: (t: string) => theme.fg("muted", t),
	scrollInfo: (t: string) => theme.fg("dim", t),
};
const markdownTheme = {
	heading: (t: string) => t,
	link: (t: string) => t,
	linkUrl: (t: string) => t,
	code: (t: string) => t,
	codeBlock: (t: string) => t,
	codeBlockBorder: (t: string) => t,
	quote: (t: string) => t,
	quoteBorder: (t: string) => t,
	hr: (t: string) => t,
	listBullet: (t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
	underline: (t: string) => t,
} as never;

function makePane(question: QuestionData, getWidth: () => number = () => 120) {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option" as const,
		label: o.label,
		description: o.description,
	}));
	const optionListView = new OptionListView({ items, theme: selectTheme });
	const previewBlock = new PreviewBlockRenderer({ question, theme, markdownTheme });
	const pane = new PreviewPane({
		question,
		getTerminalWidth: getWidth,
		optionListView,
		previewBlock,
	});
	// Auto-inject adaptive left width — mirrors buildQuestionnaire.injectGlobalLeftWidth so
	// test panes that bypass the builder still pass the throwing-sentinel guard. The throw-test
	// constructs PreviewPane inline to opt out of this injection.
	const totalForNumbering = question.multiSelect === true ? items.length : items.length + 1;
	pane.setGlobalLeftWidth((paneWidth) => adaptiveLeftWidth(items, totalForNumbering, paneWidth));
	return { pane, optionListView, previewBlock, items };
}

beforeEach(() => {
	markdownConstructed = 0;
	lastMarkdownText = "";
});

describe("PreviewPane.render — layout switching", () => {
	const question: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "A", description: "", preview: "## A\n\nbody A content" },
			{ label: "B", description: "", preview: "## B\n\nbody B content" },
			{ label: "C", description: "" },
		],
	};

	it("side-by-side at width 120 (>= PREVIEW_MIN_WIDTH)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(120);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
	});

	it("stacked at width 80 (< PREVIEW_MIN_WIDTH)", () => {
		const { pane, optionListView } = makePane(question, () => 80);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(80);
		const mdLineIndex = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(mdLineIndex).toBeGreaterThan(0);
		// Bordered box no longer pads the content area to `MAX_PREVIEW_HEIGHT_STACKED - 4`. From
		// the first MD row down we get: actual content rows + bottom border + blank + affordance.
		// FakeMarkdown emits exactly 1 row, so the slice is 1 + 3 = 4 rows. The cap is now an
		// UPPER BOUND only — short previews hug their content.
		const trailing = lines.slice(mdLineIndex).length;
		expect(trailing).toBeGreaterThanOrEqual(4);
		expect(trailing).toBeLessThanOrEqual(MAX_PREVIEW_HEIGHT_STACKED);
	});

	it("a resize from width 99 to 100 switches from stacked to right-aligned side-by-side", () => {
		let terminalWidth = 99;
		const view = makePane(question, () => terminalWidth);
		view.pane.setGlobalLeftWidth((w) =>
			crossTabLeftWidthWithDonation([{ multiSelect: false }], [view.items], [question], w),
		);
		view.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const narrowLines = view.pane.render(99);
		expect(narrowLines.findIndex((l) => /MD\[\d+\]:/.test(l))).toBeGreaterThan(0);

		terminalWidth = PREVIEW_MIN_WIDTH;
		const wideLines = view.pane.render(PREVIEW_MIN_WIDTH);
		expect(wideLines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
		const previewTop = wideLines.find((line) => line.includes("┌"));
		expect(visibleWidth(previewTop!)).toBe(PREVIEW_MIN_WIDTH);
	});
});

describe("PreviewPane — cache + invalidate", () => {
	const question: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "A", description: "", preview: "alpha preview" },
			{ label: "B", description: "", preview: "beta preview" },
		],
	};

	it("creates one Markdown per option lazily; revisit hits cache", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: false, inputMode: false });
		pane.render(120);
		expect(markdownConstructed).toBe(1);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: false, inputMode: false });
		pane.render(120);
		expect(markdownConstructed).toBe(2);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: false, inputMode: false });
		pane.render(120);
		expect(markdownConstructed).toBe(2);
	});

	it("invalidate() does NOT delete instances; subsequent renders still re-use cache", () => {
		const { pane, optionListView, previewBlock } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.render(120);
		expect(markdownConstructed).toBe(1);
		previewBlock.invalidate();
		pane.render(120);
		expect(markdownConstructed).toBe(1);
	});
});

describe("PreviewPane — empty preview placeholder (per-question hide-when-no-previews)", () => {
	// Spec: when NO option in the question carries a `preview`, the preview pane is hidden
	// entirely (no "No preview available" placeholder, no extra MAX_PREVIEW_HEIGHT padding).
	it("hides the preview block entirely when no option provides a preview", () => {
		const question: QuestionData = {
			question: "pick",
			header: "pick",
			options: [{ label: "only", description: "" }],
		};
		const { pane, optionListView } = makePane(question, () => 80);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(80);
		expect(lines.some((l) => l.includes(NO_PREVIEW_TEXT))).toBe(false);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
	});

	it("still shows 'No preview available' for an item lacking a preview when SOME option in the question has one", () => {
		// Question has previews for option 0 but not for option 1; selecting option 1 must yield
		// the placeholder, not hide the pane (the pane is per-question, not per-option).
		const question: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "with", description: "", preview: "alpha" },
				{ label: "without", description: "" },
			],
		};
		const { pane, optionListView } = makePane(question, () => 80);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: false, inputMode: false });
		const lines = pane.render(80);
		const mdIndex = lines.findIndex((l) => l.includes(NO_PREVIEW_TEXT));
		expect(mdIndex).toBeGreaterThan(-1);
		// Stacked layout: optionsHeight + 1 gap row + MAX_PREVIEW_HEIGHT_STACKED preview lines.
		expect(lines.slice(mdIndex).length).toBeLessThanOrEqual(MAX_PREVIEW_HEIGHT_STACKED);
	});
});

describe("PreviewPane — multiSelect suppresses preview", () => {
	it("renders ONLY the options list when question.multiSelect === true", () => {
		const question: QuestionData = {
			question: "areas",
			header: "areas",
			multiSelect: true,
			options: [
				{ label: "FE", description: "", preview: "would not show" },
				{ label: "BE", description: "" },
			],
		};
		const { pane } = makePane(question, () => 120);
		const lines = pane.render(120);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
		expect(lines.some((l) => l.includes(NO_PREVIEW_TEXT))).toBe(false);
	});
});

describe("PreviewPane — width safety (Pi crash guard)", () => {
	const question: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "A", description: "", preview: "x".repeat(500) },
			{ label: "B", description: "" },
		],
	};

	it("every emitted line satisfies visibleWidth(line) <= width", () => {
		for (const w of [60, 80, 100, 120]) {
			const { pane, optionListView } = makePane(question, () => w);
			optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
			const lines = pane.render(w);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
		}
	});
});

describe("PreviewPane.naturalHeight", () => {
	const fewOptionsNoDesc: QuestionData = {
		question: "q",
		header: "q",
		options: [
			{ label: "A", description: "" },
			{ label: "B", description: "" },
		],
	};
	const manyOptionsWithDesc: QuestionData = {
		question: "q",
		header: "q",
		options: [
			{ label: "A", description: "desc-a" },
			{ label: "B", description: "desc-b" },
			{ label: "C", description: "desc-c" },
			{ label: "D", description: "" },
		],
	};
	const singleOption: QuestionData = {
		question: "q",
		header: "q",
		options: [{ label: "only", description: "" }],
	};

	const fixtures: Array<[string, QuestionData]> = [
		["few-options-no-desc", fewOptionsNoDesc],
		["many-options-with-desc", manyOptionsWithDesc],
		["single-option", singleOption],
	];

	it("naturalHeight(w) === render(w).length parametric across modes and fixtures", () => {
		for (const [_label, q] of fixtures) {
			// multiSelect mode
			const multiQ: QuestionData = { ...q, multiSelect: true };
			const multi = makePane(multiQ, () => 120);
			for (const w of [60, 80, 100, 120, 160]) {
				expect(multi.pane.naturalHeight(w)).toBe(multi.pane.render(w).length);
			}
			// side-by-side (terminal >= PREVIEW_MIN_WIDTH AND width >= PREVIEW_MIN_WIDTH)
			const wide = makePane(q, () => 120);
			for (const w of [100, 120, 160]) {
				expect(wide.pane.naturalHeight(w)).toBe(wide.pane.render(w).length);
			}
			// stacked (either side < PREVIEW_MIN_WIDTH)
			const narrow = makePane(q, () => 80);
			for (const w of [60, 80]) {
				expect(narrow.pane.naturalHeight(w)).toBe(narrow.pane.render(w).length);
			}
		}
	});
});

describe("PreviewPane.maxNaturalHeight", () => {
	const mixedQuestion: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "short", description: "", preview: "tiny" },
			{ label: "long", description: "", preview: "x".repeat(800) },
			{ label: "no-preview", description: "" },
		],
	};

	it("multiSelect returns options height (no preview branch)", () => {
		const multiQ: QuestionData = { ...mixedQuestion, multiSelect: true };
		const { pane } = makePane(multiQ, () => 120);
		const w = 120;
		expect(pane.maxNaturalHeight(w)).toBe(pane.render(w).length);
	});

	it("no-preview question returns options height (early-return parity with naturalHeight)", () => {
		const q: QuestionData = {
			question: "q",
			header: "q",
			options: [
				{ label: "A", description: "" },
				{ label: "B", description: "" },
			],
		};
		const { pane } = makePane(q, () => 120);
		expect(pane.maxNaturalHeight(120)).toBe(pane.render(120).length);
		expect(pane.maxNaturalHeight(80)).toBe(pane.render(80).length);
	});

	it("side-by-side: maxNaturalHeight >= naturalHeight for any selectedIndex", () => {
		const { pane, optionListView } = makePane(mixedQuestion, () => 120);
		const w = 120;
		const max = pane.maxNaturalHeight(w);
		for (let i = 0; i < mixedQuestion.options.length; i++) {
			optionListView.setProps({ selectedIndex: i, focused: true, inputBuffer: "" });
			pane.setProps({ notesVisible: false, selectedIndex: i, focused: true, inputMode: false });
			expect(pane.naturalHeight(w)).toBeLessThanOrEqual(max);
		}
	});

	it("stacked: maxNaturalHeight >= naturalHeight for any selectedIndex", () => {
		const { pane, optionListView } = makePane(mixedQuestion, () => 80);
		const w = 80;
		const max = pane.maxNaturalHeight(w);
		for (let i = 0; i < mixedQuestion.options.length; i++) {
			optionListView.setProps({ selectedIndex: i, focused: true, inputBuffer: "" });
			pane.setProps({ notesVisible: false, selectedIndex: i, focused: true, inputMode: false });
			expect(pane.naturalHeight(w)).toBeLessThanOrEqual(max);
		}
	});

	it("maxNaturalHeight is index-independent (does not depend on the current props.selectedIndex)", () => {
		const { pane: paneA, optionListView: olA } = makePane(mixedQuestion, () => 120);
		olA.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		paneA.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		const maxA = paneA.maxNaturalHeight(120);

		const { pane: paneB, optionListView: olB } = makePane(mixedQuestion, () => 120);
		olB.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		paneB.setProps({ notesVisible: false, selectedIndex: 1, focused: true, inputMode: false });
		const maxB = paneB.maxNaturalHeight(120);

		expect(maxA).toBe(maxB);
	});
});

describe("PreviewPane — right-aligned preview with a bounded options column", () => {
	const question: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "A", description: "", preview: "short body" },
			{ label: "B", description: "" },
		],
	};

	function extractPreviewColumnLines(joined: string[]): string[] {
		return joined.filter((l) => /MD\[\d+\]:/.test(l));
	}

	it("content-sized preview boxes share the right edge while retaining their natural widths", () => {
		const short = makePane(question, () => 120);
		short.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const shortLines = short.pane.render(120);
		const shortMD = extractPreviewColumnLines(shortLines)[0].indexOf("MD[");

		const longQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "A", description: "", preview: "x".repeat(500) },
				{ label: "B", description: "" },
			],
		};
		const long = makePane(longQ, () => 120);
		long.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const longLines = long.pane.render(120);
		const longMD = extractPreviewColumnLines(longLines)[0].indexOf("MD[");

		expect(visibleWidth(shortLines.find((line) => line.includes("┌"))!)).toBe(120);
		expect(visibleWidth(longLines.find((line) => line.includes("┌"))!)).toBe(120);
		expect(shortMD).toBeGreaterThan(longMD);
	});

	it("side-by-side: adaptive left width adjusts options column based on label content", () => {
		const longQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "A", description: "", preview: "x".repeat(500) },
				{ label: "B", description: "" },
			],
		};
		const items: WrappingSelectItem[] = [
			{ kind: "option", label: "A" },
			{ kind: "option", label: "B" },
		];
		const { pane, optionListView } = makePane(longQ, () => 200);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(200);
		const preview = extractPreviewColumnLines(lines);
		expect(preview.length).toBeGreaterThan(0);
		// Short labels → leftWidth = MIN_LEFT (30). MD column starts at
		// leftWidth + gap(2) + leftPad(1) + leftBorderBar(1) + innerLeftPad(1).
		const expectedLeft = adaptiveLeftWidth(items, 3, 200);
		const expectedMdIdx = expectedLeft + PREVIEW_COLUMN_GAP + 1 + 2;
		const mdIdx = preview[0].indexOf("MD[");
		expect(mdIdx).toBe(expectedMdIdx);
	});

	it("side-by-side: first MD row is preceded by the top border row (no top padding)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(120);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(0);
		const above = lines[firstMD - 1] ?? "";
		expect(above).toMatch(/┌─+┐/);
	});

	it("stacked mode: an empty gap row separates the options block from the bordered preview block", () => {
		const { pane, optionListView } = makePane(question, () => 80);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(80);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(1);
		// firstMD - 1 is the top border row; firstMD - 2 is the empty gap row between options and preview.
		expect(lines[firstMD - 1]).toMatch(/┌─+┐/);
		expect(lines[firstMD - 2]).toBe("");
	});

	it("multiSelect mode unchanged (options-only, no preview, no padding logic)", () => {
		const multiQ: QuestionData = { ...question, multiSelect: true };
		const { pane } = makePane(multiQ, () => 120);
		const lines = pane.render(120);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
	});

	it("width safety: visibleWidth(line) <= width across boundary widths", () => {
		for (const w of [100, 120, 160]) {
			const { pane, optionListView } = makePane(question, () => w);
			optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
			const lines = pane.render(w);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
		}
	});
});

describe("PreviewPane — slack donation to left column", () => {
	// 26-char label → labelDriven > MIN_LEFT, used where the label-driven path
	// itself must exceed the floor.
	const LONG_LABEL = "Verbose Descriptive Option";

	it("short labels donate slack and move the preview to the right", () => {
		const compactQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "A", description: "", preview: "tiny" },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(compactQ, () => 200);
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [items];
		const questions = [compactQ];
		pane.setGlobalLeftWidth((w) => crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, w));
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });

		const donatedLeft = crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, 200);
		expect(donatedLeft).toBe(Math.floor(200 * MAX_LEFT_RATIO));

		const lines = pane.render(200);
		const previewTop = lines.find((line) => line.includes("┌"));
		expect(visibleWidth(previewTop!)).toBe(200);
	});

	it("long labels + narrow previews → donation engaged, MD at wider offset", () => {
		const narrowQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: LONG_LABEL, description: "", preview: "tiny" },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(narrowQ, () => 120);
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [items];
		const questions = [narrowQ];
		pane.setGlobalLeftWidth((w) => crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, w));
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });

		const labelDriven = adaptiveLeftWidth(items, 3, 120);
		expect(labelDriven).toBeGreaterThan(MIN_LEFT);

		const lines = pane.render(120);
		const mdLine = lines.find((l) => /MD\[\d+\]:/.test(l));
		expect(mdLine).toBeDefined();
		// Donation wants 73 columns, but the 50% ratio caps the options column at 60.
		// The narrow preview is then right-aligned inside the remaining column.
		const donatedLeft = crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, 120);
		expect(donatedLeft).toBe(Math.floor(120 * MAX_LEFT_RATIO));
		const previewTop = lines.find((line) => line.includes("┌"));
		expect(visibleWidth(previewTop!)).toBe(120);
	});

	it("long labels + wide previews → donation suppressed, MD at label-driven offset", () => {
		const wideQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: LONG_LABEL, description: "", preview: "x".repeat(500) },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(wideQ, () => 120);
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [items];
		const questions = [wideQ];
		pane.setGlobalLeftWidth((w) => crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, w));
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(120);
		const mdLine = lines.find((l) => /MD\[\d+\]:/.test(l));
		expect(mdLine).toBeDefined();
		// Wide preview → donation suppressed → left column = labelDriven (33 for the 26-char label).
		const labelDriven = adaptiveLeftWidth(items, 3, 120);
		expect(mdLine!.indexOf("MD[")).toBe(labelDriven + PREVIEW_COLUMN_GAP + 1 + 2);
	});

	it("right column never below MIN_PREVIEW_WIDTH when donation engages", () => {
		const narrowQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: LONG_LABEL, description: "", preview: "tiny" },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(narrowQ, () => 100);
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [items];
		const questions = [narrowQ];
		pane.setGlobalLeftWidth((w) => crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, w));
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const left = crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, 100);
		expect(100 - left - PREVIEW_COLUMN_GAP).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
		const lines = pane.render(100);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	it("naturalHeight(w) === render(w).length holds with donation active", () => {
		const narrowQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: LONG_LABEL, description: "", preview: "tiny" },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(narrowQ, () => 120);
		const tabs = [{ multiSelect: false }];
		const itemsByTab = [items];
		const questions = [narrowQ];
		pane.setGlobalLeftWidth((w) => crossTabLeftWidthWithDonation(tabs, itemsByTab, questions, w));
		for (const w of [100, 120, 160]) {
			optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
			expect(pane.naturalHeight(w)).toBe(pane.render(w).length);
		}
	});
});

describe("renderBorderedBox helper", () => {
	it("wraps lines in 4-sided border with `┌─┐│└┘` corners", () => {
		const out = renderBorderedBox(["hello"], 20, (s) => s);
		expect(out[0].startsWith("┌")).toBe(true);
		expect(out[0].endsWith("┐")).toBe(true);
		expect(out[1].startsWith("│")).toBe(true);
		expect(out[1].endsWith("│")).toBe(true);
		expect(out[out.length - 1].startsWith("└")).toBe(true);
		expect(out[out.length - 1].endsWith("┘")).toBe(true);
	});

	it("right-pads content lines so the right `│` lands at fixed column", () => {
		const out = renderBorderedBox(["hi"], 20, (s) => s);
		expect(visibleWidth(out[1])).toBe(20);
	});

	it("emits truncation indicator on bottom row when hidden > 0", () => {
		const out = renderBorderedBox(["a", "b"], 30, (s) => s, 5);
		const bottom = out[out.length - 1];
		expect(bottom).toContain("✂");
		expect(bottom).toContain("5 lines hidden");
		expect(bottom.startsWith("└")).toBe(true);
		expect(bottom.endsWith("┘")).toBe(true);
	});
});

describe("PreviewPane — oneLine() removal (multi-line markdown rendering)", () => {
	it("passes raw multi-line markdown to Markdown (oneLine collapse removed)", () => {
		const question: QuestionData = {
			question: "q",
			header: "q",
			options: [
				{ label: "A", description: "", preview: "## Heading\n\n- item 1\n- item 2" },
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.render(120);
		expect(lastMarkdownText).toBe("## Heading\n\n- item 1\n- item 2");
		expect(lastMarkdownText).toContain("\n");
	});
});

describe("PreviewPane — notes affordance row (Slice 4 height-stable affordance)", () => {
	const question: QuestionData = {
		question: "q",
		header: "q",
		options: [
			{ label: "A", description: "", preview: "alpha body" },
			{ label: "B", description: "" },
		],
	};

	it("renders 'Notes: press n to add notes' below preview when focused on preview-bearing option", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
	});

	it("hides notes affordance text when option lacks preview (height contract preserved)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		const linesA = pane.render(120);
		expect(linesA.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: true, inputMode: false });
		const linesB = pane.render(120);
		expect(linesB.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		expect(linesA.length).toBe(linesB.length);
	});

	it("hides notes affordance when notesVisible (notes mode active)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: true, selectedIndex: 0, focused: true, inputMode: false });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
	});

	it("does not render the affordance text when MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE is reached but option lacks preview", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: true, inputMode: false });
		const lines = pane.render(120);
		// Side-by-side path: preview pane still renders (option A has preview), but affordance hidden.
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		// Sanity: cap value is referenced so the import isn't tree-shaken in CI.
		expect(MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE).toBe(20);
	});

	it("an affordance wider than the preview box slides left instead of clipping (long-locale headroom)", () => {
		// 65 visible cols — wider than the 44-col box floor (BOX_MIN_CONTENT_WIDTH + 4).
		// The real FR string sits at exactly 44, so growth past the box must not clip.
		const LONG_AFFORDANCE = "Notes : appuyez longuement sur la touche n pour ajouter des notes";
		registerStrings(I18N_NAMESPACE, { fr: { "preview.notes_affordance": LONG_AFFORDANCE } });
		applyLocale("fr");
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		const lines = pane.render(120);
		const affordanceLine = lines.find((l) => l.includes("Notes :"));
		expect(affordanceLine).toBeDefined();
		expect(affordanceLine).toContain(LONG_AFFORDANCE);
		expect(visibleWidth(affordanceLine!)).toBeLessThanOrEqual(120);
	});
});

describe("PreviewPane composes OptionListView state into render output", () => {
	const noPreviewQuestion: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "Alpha", description: "" },
			{ label: "Beta", description: "" },
			{ label: "Gamma", description: "" },
		],
	};

	it("setConfirmedIndex(1) renders ` ✔` on row 2 even when cursor is on row 0", () => {
		const { pane, optionListView } = makePane(noPreviewQuestion, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes("Beta ✔"))).toBe(true);
		expect(lines.some((l) => l.includes("Alpha ✔"))).toBe(false);
	});

	it("setConfirmedIndex(undefined) clears the marker", () => {
		const { pane, optionListView } = makePane(noPreviewQuestion, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", confirmed: { index: 1 } });
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(120);
		expect(lines.join("\n")).not.toContain("✔");
	});

	it("OptionListView.setProps({inputBuffer:'Hello'}) flows to the inline-input row render", () => {
		const otherQuestion: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "Alpha", description: "" },
				{ label: "Beta", description: "" },
			],
		};
		const items: WrappingSelectItem[] = [
			...otherQuestion.options.map((o) => ({
				kind: "option" as const,
				label: o.label,
				description: o.description,
			})),
			{ kind: "other", label: "Type something." },
		];
		const optionListView = new OptionListView({ items, theme: selectTheme });
		const previewBlock = new PreviewBlockRenderer({ question: otherQuestion, theme, markdownTheme });
		const pane = new PreviewPane({
			question: otherQuestion,
			getTerminalWidth: () => 120,
			optionListView,
			previewBlock,
		});
		pane.setGlobalLeftWidth((w) => adaptiveLeftWidth(items, items.length, w));
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true, inputMode: false });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "Hello" });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes("Hello"))).toBe(true);
		expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true);
	});
});

describe("PreviewPane — adaptive left column width", () => {
	const question: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "Short", description: "", preview: "body" },
			{ label: "Another", description: "" },
		],
	};

	it("short labels floor at MIN_LEFT (30)", () => {
		const { pane, optionListView, items } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const leftW = adaptiveLeftWidth(items, 3, 120);
		expect(leftW).toBe(MIN_LEFT);
		const lines = pane.render(120);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("long labels produce wider left column up to MAX_LEFT_RATIO", () => {
		const longLabelQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{
					label: "A very long option label that tests the ratio cap",
					description: "",
					preview: "body",
				},
				{ label: "B", description: "" },
			],
		};
		const { pane, optionListView, items } = makePane(longLabelQ, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const leftW = adaptiveLeftWidth(items, 3, 120);
		expect(leftW).toBeGreaterThan(MIN_LEFT);
		expect(leftW).toBeLessThanOrEqual(Math.floor(120 * MAX_LEFT_RATIO));
		const lines = pane.render(120);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("MIN_PREVIEW_WIDTH safety net prevents right-side collapse", () => {
		// At width 100: ratio cap = 50, available = 100 - 2 - 45 = 53.
		// With long labels (60-char label), desired exceeds both — cap is min(50, 53) = 50.
		// At width 82: ratio cap = 41, available = 35 — leftWidth <= 35.
		const items: WrappingSelectItem[] = [
			{ kind: "option", label: "x".repeat(60) },
			{ kind: "option", label: "y" },
		];
		const leftW = adaptiveLeftWidth(items, 3, 82);
		expect(leftW).toBeLessThanOrEqual(82 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH);
	});

	it("render() throws if setGlobalLeftWidth was not injected — render is illegal pre-injection", () => {
		// Construct PreviewPane inline to opt out of makePane's auto-injection.
		// buildQuestionnaire.injectGlobalLeftWidth always injects in production; tests that
		// bypass the builder MUST inject explicitly. Missing injection is a hard fail rather
		// than a silent fallback to a magic constant.
		const items: WrappingSelectItem[] = question.options.map((o) => ({
			kind: "option" as const,
			label: o.label,
			description: o.description,
		}));
		const optionListView = new OptionListView({ items, theme: selectTheme });
		const previewBlock = new PreviewBlockRenderer({ question, theme, markdownTheme });
		const pane = new PreviewPane({
			question,
			getTerminalWidth: () => 120,
			optionListView,
			previewBlock,
		});
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		expect(() => pane.render(120)).toThrow(/setGlobalLeftWidth/);
	});

	it("cross-tab max keeps width stable — same getter produces same leftWidth for different items", () => {
		const shortItems: WrappingSelectItem[] = [{ kind: "option", label: "A" }];
		const longItems: WrappingSelectItem[] = [{ kind: "option", label: "A very long label indeed" }];
		const shortW = adaptiveLeftWidth(shortItems, 2, 120);
		const longW = adaptiveLeftWidth(longItems, 2, 120);
		const globalMax = Math.max(shortW, longW);
		expect(globalMax).toBe(longW);
		const getter = (w: number) => Math.max(adaptiveLeftWidth(shortItems, 2, w), adaptiveLeftWidth(longItems, 2, w));
		expect(getter(120)).toBe(globalMax);
	});

	it("naturalHeight(w) === render(w).length still holds with adaptive width", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		for (const w of [100, 120, 160]) {
			optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
			expect(pane.naturalHeight(w)).toBe(pane.render(w).length);
		}
	});
});

describe("PreviewPane — inputMode (custom-answer full-width while typing)", () => {
	// Single-select question WITH previews — without inputMode the pane renders side-by-side.
	// With inputMode: true (focus on the "other" custom-answer row), the pane collapses to a
	// single full-width option-list column: no side-by-side split, no preview block.
	const previewQuestion: QuestionData = {
		question: "pick",
		header: "pick",
		options: [
			{ label: "A", description: "", preview: "alpha body" },
			{ label: "B", description: "", preview: "beta body" },
		],
	};

	function makePreviewPaneWithOther(getWidth: () => number = () => 120) {
		const items: WrappingSelectItem[] = [
			...previewQuestion.options.map((o) => ({
				kind: "option" as const,
				label: o.label,
				description: o.description,
			})),
			{ kind: "other", label: "Type something." },
		];
		const optionListView = new OptionListView({ items, theme: selectTheme });
		const previewBlock = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		const pane = new PreviewPane({
			question: previewQuestion,
			getTerminalWidth: getWidth,
			optionListView,
			previewBlock,
		});
		pane.setGlobalLeftWidth((w) => adaptiveLeftWidth(items, items.length, w));
		return { pane, optionListView, items };
	}

	it("inputMode: true → render is a single full-width option list (no side-by-side split, no preview border)", () => {
		const { pane, optionListView } = makePreviewPaneWithOther();
		// Focus on the "other" row (index 2 = options.length) with a typed buffer.
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true, inputMode: true });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "custom text" });
		const lines = pane.render(120);
		// No preview markdown lines, no bordered-box top border.
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
		expect(lines.some((l) => /┌─+┐/.test(l))).toBe(false);
		// Byte-identical to the option list rendered at full width.
		expect(lines).toEqual(optionListView.render(120));
	});

	it("inputMode: false → side-by-side layout renders as before (MD + border present; inputMode branch skipped)", () => {
		const { pane, optionListView } = makePreviewPaneWithOther();
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(120);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
		expect(lines.some((l) => /┌─+┐/.test(l))).toBe(true);
	});

	it("inputMode: true → naturalHeight(w) === render(w).length and maxNaturalHeight(w) === render(w).length", () => {
		const { pane, optionListView } = makePreviewPaneWithOther();
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true, inputMode: true });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "x".repeat(200) });
		for (const w of [100, 120, 160]) {
			expect(pane.naturalHeight(w)).toBe(pane.render(w).length);
			expect(pane.maxNaturalHeight(w)).toBe(pane.render(w).length);
			// Full-width option-list height, not a side-by-side max-of-column.
			expect(pane.maxNaturalHeight(w)).toBe(optionListView.render(w).length);
		}
	});

	it("inputMode: true → focusedItemRowRange computed at FULL width (matches the full-width option list)", () => {
		const { pane, optionListView } = makePreviewPaneWithOther();
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true, inputMode: true });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "" });
		const width = 120;
		expect(pane.focusedItemRowRange(width)).toEqual(optionListView.focusedItemRowRange(width));
	});

	it("preview layout restored on nav-away (inputMode clears → side-by-side returns)", () => {
		const { pane, optionListView } = makePreviewPaneWithOther();
		// Typing on "other": full-width option list, no preview.
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true, inputMode: true });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "half-typed" });
		const typingLines = pane.render(120);
		expect(typingLines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
		// Navigate back to an option row: inputMode clears, side-by-side preview returns.
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true, inputMode: false });
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const restoredLines = pane.render(120);
		expect(restoredLines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
		expect(restoredLines.some((l) => /┌─+┐/.test(l))).toBe(true);
	});
});
