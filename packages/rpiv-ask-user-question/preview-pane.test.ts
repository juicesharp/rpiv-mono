import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

let markdownConstructed = 0;
let lastMarkdownText = "";
vi.mock("@mariozechner/pi-tui", async (orig) => {
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

import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_TEXT,
	PREVIEW_MIN_WIDTH,
	PreviewPane,
	renderBorderedBox,
} from "./preview-pane.js";
import type { QuestionData } from "./types.js";

const theme = makeTheme() as unknown as Theme;
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
	const items = question.options.map((o) => ({ label: o.label, description: o.description }));
	return new PreviewPane({
		items,
		question,
		theme,
		markdownTheme,
		getTerminalWidth: getWidth,
	});
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
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		const lines = pane.render(120);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
	});

	it("stacked at width 80 (< PREVIEW_MIN_WIDTH)", () => {
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(0);
		const lines = pane.render(80);
		const mdLineIndex = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(mdLineIndex).toBeGreaterThan(0);
		// From the first content row: remaining contentBudget rows + bottom border + blank + affordance.
		// = (cap - 4 content rows) - 1 + 3 trailing rows = cap - 2; plus the MD row itself = cap - 1.
		expect(lines.slice(mdLineIndex).length).toBe(MAX_PREVIEW_HEIGHT_STACKED - 1);
	});

	it("width 99 → stacked, width 100 → side-by-side (threshold boundary)", () => {
		const paneNarrow = makePane(question, () => 99);
		paneNarrow.setSelectedIndex(0);
		const narrowLines = paneNarrow.render(99);
		expect(narrowLines.findIndex((l) => /MD\[\d+\]:/.test(l))).toBeGreaterThan(0);

		const paneWide = makePane(question, () => PREVIEW_MIN_WIDTH);
		paneWide.setSelectedIndex(0);
		const wideLines = paneWide.render(PREVIEW_MIN_WIDTH);
		expect(wideLines.some((l) => /MD\[\d+\]:/.test(l))).toBe(true);
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
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		pane.render(120);
		expect(markdownConstructed).toBe(1);
		pane.setSelectedIndex(1);
		pane.render(120);
		expect(markdownConstructed).toBe(2);
		pane.setSelectedIndex(0);
		pane.render(120);
		expect(markdownConstructed).toBe(2);
	});

	it("invalidateCache() does NOT delete instances; subsequent renders still re-use cache", () => {
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		pane.render(120);
		expect(markdownConstructed).toBe(1);
		pane.invalidateCache();
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
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(0);
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
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(1);
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
		const pane = makePane(question, () => 120);
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
			const pane = makePane(question, () => w);
			pane.setSelectedIndex(0);
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
				expect(multi.naturalHeight(w)).toBe(multi.render(w).length);
			}
			// side-by-side (terminal >= PREVIEW_MIN_WIDTH AND width >= PREVIEW_MIN_WIDTH)
			const wide = makePane(q, () => 120);
			for (const w of [100, 120, 160]) {
				expect(wide.naturalHeight(w)).toBe(wide.render(w).length);
			}
			// stacked (either side < PREVIEW_MIN_WIDTH)
			const narrow = makePane(q, () => 80);
			for (const w of [60, 80]) {
				expect(narrow.naturalHeight(w)).toBe(narrow.render(w).length);
			}
		}
	});
});

describe("PreviewPane — left-aligned preview with top/left padding (side-by-side only)", () => {
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

	// Spec: preview content is NO LONGER horizontally centered. The MD marker should land at
	// the same X-column whether the body is short or long — because both leftMargin slabs are
	// fixed (options column max-width + gap + PREVIEW_PADDING_LEFT).
	it("side-by-side preview lines have a fixed left-padding offset, NOT a content-dependent center margin", () => {
		const shortPane = makePane(question, () => 120);
		shortPane.setSelectedIndex(0);
		const shortMD = extractPreviewColumnLines(shortPane.render(120))[0].indexOf("MD[");

		const longQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "A", description: "", preview: "x".repeat(500) },
				{ label: "B", description: "" },
			],
		};
		const longPane = makePane(longQ, () => 120);
		longPane.setSelectedIndex(0);
		const longMD = extractPreviewColumnLines(longPane.render(120))[0].indexOf("MD[");

		expect(shortMD).toBe(longMD);
	});

	it("side-by-side: options column is capped at PREVIEW_LEFT_COLUMN_MAX_WIDTH (40) regardless of total width", () => {
		const longQ: QuestionData = {
			question: "pick",
			header: "pick",
			options: [
				{ label: "A", description: "", preview: "x".repeat(500) },
				{ label: "B", description: "" },
			],
		};
		const pane = makePane(longQ, () => 200);
		pane.setSelectedIndex(0);
		const lines = pane.render(200);
		const preview = extractPreviewColumnLines(lines);
		expect(preview.length).toBeGreaterThan(0);
		// MD column starts at leftWidth(40) + gap(2) + leftPad(1) + leftBorderBar(1) = 44.
		const mdIdx = preview[0].indexOf("MD[");
		expect(mdIdx).toBe(44);
	});

	it("side-by-side: first MD row is preceded by the top border row (no top padding)", () => {
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		const lines = pane.render(120);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(0);
		const above = lines[firstMD - 1] ?? "";
		expect(above).toMatch(/┌─+┐/);
	});

	it("stacked mode: an empty gap row separates the options block from the bordered preview block", () => {
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(0);
		const lines = pane.render(80);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(1);
		// firstMD - 1 is the top border row; firstMD - 2 is the empty gap row between options and preview.
		expect(lines[firstMD - 1]).toMatch(/┌─+┐/);
		expect(lines[firstMD - 2]).toBe("");
	});

	it("multiSelect mode unchanged (options-only, no preview, no padding logic)", () => {
		const multiQ: QuestionData = { ...question, multiSelect: true };
		const pane = makePane(multiQ, () => 120);
		const lines = pane.render(120);
		expect(lines.some((l) => /MD\[\d+\]:/.test(l))).toBe(false);
	});

	it("width safety: visibleWidth(line) <= width across boundary widths", () => {
		for (const w of [100, 120, 160]) {
			const pane = makePane(question, () => w);
			pane.setSelectedIndex(0);
			const lines = pane.render(w);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
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
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
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
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		pane.setFocused(true);
		pane.setNotesVisible(false);
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
	});

	it("hides notes affordance text when option lacks preview (height contract preserved)", () => {
		const pane = makePane(question, () => 120);
		pane.setFocused(true);
		pane.setSelectedIndex(0);
		const linesA = pane.render(120);
		expect(linesA.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
		pane.setSelectedIndex(1);
		const linesB = pane.render(120);
		expect(linesB.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		expect(linesA.length).toBe(linesB.length);
	});

	it("hides notes affordance when notesVisible (notes mode active)", () => {
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		pane.setFocused(true);
		pane.setNotesVisible(true);
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
	});

	it("does not render the affordance text when MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE is reached but option lacks preview", () => {
		const pane = makePane(question, () => 120);
		pane.setFocused(true);
		pane.setSelectedIndex(1);
		const lines = pane.render(120);
		// Side-by-side path: preview pane still renders (option A has preview), but affordance hidden.
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		// Sanity: cap value is referenced so the import isn't tree-shaken in CI.
		expect(MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE).toBe(20);
	});
});
