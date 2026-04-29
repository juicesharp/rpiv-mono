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

import type { QuestionData } from "../../../tool/types.js";
import { OptionListView } from "../option-list-view.js";
import type { WrappingSelectItem } from "../wrapping-select.js";
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
	return { pane, optionListView, previewBlock };
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

	it("width 99 → stacked, width 100 → side-by-side (threshold boundary)", () => {
		const narrow = makePane(question, () => 99);
		narrow.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const narrowLines = narrow.pane.render(99);
		expect(narrowLines.findIndex((l) => /MD\[\d+\]:/.test(l))).toBeGreaterThan(0);

		const wide = makePane(question, () => PREVIEW_MIN_WIDTH);
		wide.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const wideLines = wide.pane.render(PREVIEW_MIN_WIDTH);
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
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: false });
		pane.render(120);
		expect(markdownConstructed).toBe(1);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: false });
		pane.render(120);
		expect(markdownConstructed).toBe(2);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: false });
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
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: false });
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
		const short = makePane(question, () => 120);
		short.optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const shortMD = extractPreviewColumnLines(short.pane.render(120))[0].indexOf("MD[");

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
		const longMD = extractPreviewColumnLines(long.pane.render(120))[0].indexOf("MD[");

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
		const { pane, optionListView } = makePane(longQ, () => 200);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		const lines = pane.render(200);
		const preview = extractPreviewColumnLines(lines);
		expect(preview.length).toBeGreaterThan(0);
		// MD column starts at leftWidth(40) + gap(2) + leftPad(1) + leftBorderBar(1) + innerLeftPad(1) = 45.
		const mdIdx = preview[0].indexOf("MD[");
		expect(mdIdx).toBe(45);
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
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
	});

	it("hides notes affordance text when option lacks preview (height contract preserved)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 0, focused: true });
		const linesA = pane.render(120);
		expect(linesA.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: true });
		const linesB = pane.render(120);
		expect(linesB.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		expect(linesA.length).toBe(linesB.length);
	});

	it("hides notes affordance when notesVisible (notes mode active)", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 0, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: true, selectedIndex: 0, focused: true });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
	});

	it("does not render the affordance text when MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE is reached but option lacks preview", () => {
		const { pane, optionListView } = makePane(question, () => 120);
		optionListView.setProps({ selectedIndex: 1, focused: true, inputBuffer: "" });
		pane.setProps({ notesVisible: false, selectedIndex: 1, focused: true });
		const lines = pane.render(120);
		// Side-by-side path: preview pane still renders (option A has preview), but affordance hidden.
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		// Sanity: cap value is referenced so the import isn't tree-shaken in CI.
		expect(MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE).toBe(20);
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
		pane.setProps({ notesVisible: false, selectedIndex: 2, focused: true });
		optionListView.setProps({ selectedIndex: 2, focused: true, inputBuffer: "Hello" });
		const lines = pane.render(120);
		expect(lines.some((l) => l.includes("Hello"))).toBe(true);
		expect(lines.some((l) => l.includes("▌"))).toBe(true);
	});
});
