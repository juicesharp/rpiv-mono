import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { QuestionData } from "../../../tool/types.js";
import { OptionListView } from "../option-list-view.js";
import type { WrappingSelectItem } from "../wrapping-select.js";
import { adaptiveLeftWidth } from "./preview-layout-decider.js";
import { NOTES_AFFORDANCE_TEXT, PreviewBlockRenderer, PreviewPane } from "./preview-pane.js";

// #210: under a row allowance the preview body fits itself — the box shrinks but always
// closes and counts the hidden lines; the options scroll around the focused option.
// Real Markdown here (preview-pane.test.ts stubs it to one line).

const theme = makeTheme() as unknown as Theme;
const selectTheme = {
	selectedPrefix: (t: string) => t,
	selectedText: (t: string) => t,
	description: (t: string) => t,
	scrollInfo: (t: string) => t,
};
const identity = (t: string) => t;
const markdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
} as never;
const strip = (l: string) => l.replace(/\x1b\[[0-9;:]*m/g, "");

const code = (n: number, tag: string) =>
	`\`\`\`\n${Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n")}\n\`\`\``;

function question(optionCount: number, previewLines: number, described = false): QuestionData {
	return {
		question: "Which layout?",
		header: "Layout",
		options: Array.from({ length: optionCount }, (_, i) => ({
			label: `Layout ${i + 1}`,
			description: described ? `Trade-off summary for layout ${i + 1}, one sentence long.` : "",
			preview: code(previewLines, `P${i + 1}_`),
		})),
	};
}

function makePane(q: QuestionData, terminalWidth: number, selectedIndex = 0) {
	const items: WrappingSelectItem[] = q.options.map((o) => ({
		kind: "option" as const,
		label: o.label,
		description: o.description,
	}));
	items.push({ kind: "other", label: "Type something." });
	const optionListView = new OptionListView({ items, theme: selectTheme });
	optionListView.setProps({ selectedIndex, focused: true, inputBuffer: "" });
	const previewBlock = new PreviewBlockRenderer({ question: q, theme, markdownTheme });
	const pane = new PreviewPane({
		question: q,
		theme,
		getTerminalWidth: () => terminalWidth,
		optionListView,
		previewBlock,
	});
	pane.setGlobalLeftWidth((paneWidth) => adaptiveLeftWidth(items, items.length, paneWidth));
	pane.setProps({ notesVisible: false, hasNote: false, selectedIndex, focused: true, inputMode: false });
	return { pane, previewBlock };
}

describe("PreviewBlockRenderer — fitting a row allowance", () => {
	const q = question(1, 40);
	const block = new PreviewBlockRenderer({ question: q, theme, markdownTheme });

	it("is unchanged when the allowance fits the full block", () => {
		const full = block.renderBlock(60, 0, "side-by-side", "add");
		expect(block.renderBlock(60, 0, "side-by-side", "add", 100)).toEqual(full);
		expect(block.blockHeight(60, 0, "side-by-side", 100)).toBe(full.length);
	});

	it("drops the notes affordance, then shrinks content, and still closes the box with the hidden count", () => {
		const lines = block.renderBlock(60, 0, "side-by-side", "add", 8).map(strip);
		expect(lines).toHaveLength(8);
		expect(block.blockHeight(60, 0, "side-by-side", 8)).toBe(8);
		expect(lines[0]).toMatch(/^┌/);
		expect(lines.at(-1)).toMatch(/^└.*34 lines hidden.*┘$/); // 6 content rows of 40
		expect(lines.join("\n")).not.toContain(NOTES_AFFORDANCE_TEXT);
	});

	it("renders nothing when not even one content line fits inside the border", () => {
		expect(block.renderBlock(60, 0, "side-by-side", "add", 2)).toEqual([]);
		expect(block.blockHeight(60, 0, "side-by-side", 2)).toBe(0);
	});
});

describe("PreviewPane — fitting a row allowance", () => {
	it("stacked: keeps the focused option and its preview in view instead of the whole option list", () => {
		const { pane } = makePane(question(4, 15, true), 90, 3);
		pane.setRowAllowance(12);
		const lines = pane.render(86).map(strip);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(pane.naturalHeight(86)).toBe(lines.length);
		expect(lines.some((l) => l.includes("Layout 4"))).toBe(true);
		expect(lines.some((l) => l.includes("P4_1"))).toBe(true);
		expect(lines.some((l) => /^└.*lines hidden/.test(l.trim()))).toBe(true);
		const [from, to] = pane.focusedItemRowRange(86);
		expect(lines.slice(from, to).join(" ")).toContain("Layout 4");
	});

	it("side-by-side: scrolls a tall options column and keeps the preview box closed", () => {
		const { pane } = makePane(question(4, 40, true), 120, 3);
		pane.setRowAllowance(7);
		const lines = pane.render(116).map(strip);
		expect(lines.length).toBeLessThanOrEqual(7);
		expect(pane.naturalHeight(116)).toBe(lines.length);
		expect(pane.maxNaturalHeight(116)).toBeLessThanOrEqual(7);
		expect(lines.some((l) => l.includes("Layout 4"))).toBe(true);
		expect(lines.some((l) => l.includes("┌"))).toBe(true);
		expect(lines.some((l) => l.includes("└") && l.includes("lines hidden"))).toBe(true);
	});

	it("renders exactly as before when no allowance is set", () => {
		const q = question(4, 40, true);
		const constrained = makePane(q, 120, 1);
		const free = makePane(q, 120, 1);
		constrained.pane.setRowAllowance(7);
		constrained.pane.setRowAllowance(undefined);
		expect(constrained.pane.render(116)).toEqual(free.pane.render(116));
		expect(constrained.pane.focusedItemRowRange(116)).toEqual(free.pane.focusedItemRowRange(116));
	});
});
