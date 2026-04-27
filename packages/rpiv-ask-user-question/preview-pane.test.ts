import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

let markdownConstructed = 0;
vi.mock("@mariozechner/pi-tui", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	class FakeMarkdown {
		constructor(public text: string) {
			markdownConstructed++;
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

import { MAX_PREVIEW_HEIGHT, NO_PREVIEW_TEXT, PREVIEW_MIN_WIDTH, PreviewPane } from "./preview-pane.js";
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
});

describe("PreviewPane.render — layout switching", () => {
	const question: QuestionData = {
		question: "pick",
		options: [
			{ label: "A", preview: "## A\n\nbody A content" },
			{ label: "B", preview: "## B\n\nbody B content" },
			{ label: "C" },
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
		expect(lines.slice(mdLineIndex).length).toBe(MAX_PREVIEW_HEIGHT);
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
		options: [
			{ label: "A", preview: "alpha preview" },
			{ label: "B", preview: "beta preview" },
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
		const question: QuestionData = { question: "pick", options: [{ label: "only" }] };
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
			options: [{ label: "with", preview: "alpha" }, { label: "without" }],
		};
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(1);
		const lines = pane.render(80);
		const mdIndex = lines.findIndex((l) => l.includes(NO_PREVIEW_TEXT));
		expect(mdIndex).toBeGreaterThan(-1);
		// Stacked layout: optionsHeight + 1 gap row + MAX_PREVIEW_HEIGHT preview lines.
		expect(lines.slice(mdIndex).length).toBeLessThanOrEqual(MAX_PREVIEW_HEIGHT);
	});
});

describe("PreviewPane — multiSelect suppresses preview", () => {
	it("renders ONLY the options list when question.multiSelect === true", () => {
		const question: QuestionData = {
			question: "areas",
			multiSelect: true,
			options: [{ label: "FE", preview: "would not show" }, { label: "BE" }],
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
		options: [{ label: "A", preview: "x".repeat(500) }, { label: "B" }],
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
		options: [{ label: "A" }, { label: "B" }],
	};
	const manyOptionsWithDesc: QuestionData = {
		question: "q",
		options: [
			{ label: "A", description: "desc-a" },
			{ label: "B", description: "desc-b" },
			{ label: "C", description: "desc-c" },
			{ label: "D" },
		],
	};
	const singleOption: QuestionData = { question: "q", options: [{ label: "only" }] };

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
		options: [{ label: "A", preview: "short body" }, { label: "B" }],
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
			options: [{ label: "A", preview: "x".repeat(500) }, { label: "B" }],
		};
		const longPane = makePane(longQ, () => 120);
		longPane.setSelectedIndex(0);
		const longMD = extractPreviewColumnLines(longPane.render(120))[0].indexOf("MD[");

		expect(shortMD).toBe(longMD);
	});

	it("side-by-side: options column is capped at PREVIEW_LEFT_COLUMN_MAX_WIDTH (40) regardless of total width", () => {
		const longQ: QuestionData = {
			question: "pick",
			options: [{ label: "A", preview: "x".repeat(500) }, { label: "B" }],
		};
		const pane = makePane(longQ, () => 200);
		pane.setSelectedIndex(0);
		const lines = pane.render(200);
		const preview = extractPreviewColumnLines(lines);
		expect(preview.length).toBeGreaterThan(0);
		// MD column starts at leftWidth(40) + gap(2) + PREVIEW_PADDING_LEFT(1) = 43.
		const mdIdx = preview[0].indexOf("MD[");
		expect(mdIdx).toBe(43);
	});

	it("side-by-side: preview block has a top-padding row (first MD row is preceded by an empty preview row)", () => {
		const pane = makePane(question, () => 120);
		pane.setSelectedIndex(0);
		const lines = pane.render(120);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(0);
		// The line immediately above the first MD line on the right column must have no MD marker
		// AND its right-side region must be blank (top-padding row).
		const above = lines[firstMD - 1] ?? "";
		expect(/MD\[\d+\]:/.test(above)).toBe(false);
	});

	it("stacked mode: an empty gap row separates the options block from the preview block", () => {
		const pane = makePane(question, () => 80);
		pane.setSelectedIndex(0);
		const lines = pane.render(80);
		const firstMD = lines.findIndex((l) => /MD\[\d+\]:/.test(l));
		expect(firstMD).toBeGreaterThan(0);
		// The row directly above the first preview line must be empty (the spacer between options and preview).
		expect(lines[firstMD - 1]).toBe("");
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
