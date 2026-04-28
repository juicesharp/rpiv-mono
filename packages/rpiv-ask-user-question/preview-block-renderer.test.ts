import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { MarkdownTheme } from "@mariozechner/pi-tui";
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

import { NOTES_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.js";
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
} as unknown as MarkdownTheme;

const previewQuestion: QuestionData = {
	question: "pick",
	header: "pick",
	options: [
		{ label: "A", description: "", preview: "## A\n\nbody A" },
		{ label: "B", description: "", preview: "## B\n\nbody B" },
		{ label: "C", description: "" },
	],
};

const noPreviewQuestion: QuestionData = {
	question: "pick",
	header: "pick",
	options: [
		{ label: "A", description: "" },
		{ label: "B", description: "" },
	],
};

beforeEach(() => {
	markdownConstructed = 0;
});

describe("PreviewBlockRenderer — preview gating", () => {
	it("hasAnyPreview returns true when at least one option carries preview", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		expect(r.hasAnyPreview()).toBe(true);
	});

	it("hasAnyPreview returns false when no option carries preview", () => {
		const r = new PreviewBlockRenderer({ question: noPreviewQuestion, theme, markdownTheme });
		expect(r.hasAnyPreview()).toBe(false);
	});

	it("has(i) is true for preview-bearing option, false for option without preview", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		expect(r.has(0)).toBe(true);
		expect(r.has(2)).toBe(false);
	});
});

describe("PreviewBlockRenderer.renderBlock", () => {
	it("emits bordered box + blank + affordance when focused on preview-bearing option", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		const lines = r.renderBlock(60, 0, "side-by-side", true, false);
		expect(lines.some((l) => l.startsWith("┌"))).toBe(true);
		expect(lines.some((l) => l.startsWith("└"))).toBe(true);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
	});

	it("hides affordance when notesVisible=true (notes mode active)", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		const lines = r.renderBlock(60, 0, "side-by-side", true, true);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
	});

	it("hides affordance when focused=false (cursor on chat row)", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		const lines = r.renderBlock(60, 0, "side-by-side", false, false);
		expect(lines.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
	});

	it("hides affordance when focused option lacks a preview (height contract preserved)", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		const linesA = r.renderBlock(60, 0, "side-by-side", true, false);
		const linesB = r.renderBlock(60, 2, "side-by-side", true, false);
		expect(linesA.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(true);
		expect(linesB.some((l) => l.includes(NOTES_AFFORDANCE_TEXT))).toBe(false);
		expect(linesA.length).toBe(linesB.length);
	});
});

describe("PreviewBlockRenderer.blockHeight", () => {
	it("matches renderBlock(...).length under all gating combinations", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		for (const idx of [0, 1, 2]) {
			for (const mode of ["side-by-side", "stacked"] as const) {
				expect(r.blockHeight(60, idx, mode)).toBe(r.renderBlock(60, idx, mode, true, false).length);
			}
		}
	});
});

describe("PreviewBlockRenderer — cache lifecycle", () => {
	it("creates one Markdown per option lazily; revisit hits cache", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		r.renderBlock(60, 0, "side-by-side", true, false);
		expect(markdownConstructed).toBe(1);
		r.renderBlock(60, 1, "side-by-side", true, false);
		expect(markdownConstructed).toBe(2);
		r.renderBlock(60, 0, "side-by-side", true, false);
		expect(markdownConstructed).toBe(2);
	});

	it("invalidate() does NOT delete instances; subsequent renders re-use cache", () => {
		const r = new PreviewBlockRenderer({ question: previewQuestion, theme, markdownTheme });
		r.renderBlock(60, 0, "side-by-side", true, false);
		expect(markdownConstructed).toBe(1);
		r.invalidate();
		r.renderBlock(60, 0, "side-by-side", true, false);
		expect(markdownConstructed).toBe(1);
	});
});
