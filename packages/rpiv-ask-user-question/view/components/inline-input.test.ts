import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderInlineInputRow } from "./inline-input.js";

const cursorOn = (ch: string) => `${CURSOR_MARKER}\x1b[7m${ch}\x1b[27m`;
const NBSP = "\xa0";
const id = (t: string) => t;

describe("renderInlineInputRow — multiline:false (single line)", () => {
	const opts = (buffer: string, cursorOffset: number | undefined, contentWidth: number) => ({
		buffer,
		cursorOffset,
		rowPrefix: "",
		continuationPrefix: "",
		contentWidth,
		selectedText: id,
		multiline: false as const,
	});

	it("renders the full buffer + cursor when it fits", () => {
		const lines = renderInlineInputRow(opts("hello", 2, 40));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`he${cursorOn("l")}lo`);
	});

	it("cursor at end-of-buffer uses the NBSP fallback cell", () => {
		const lines = renderInlineInputRow(opts("hello", undefined, 40));
		expect(lines[0]).toContain(`hello${cursorOn(NBSP)}`);
	});

	it("truncates a long buffer to ONE line at contentWidth with an ellipsis", () => {
		const lines = renderInlineInputRow(opts("x".repeat(200), 200, 20));
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(20);
		expect(lines[0]).toContain("…");
	});

	it("never emits more than one line regardless of buffer length", () => {
		for (const w of [5, 10, 20]) {
			const lines = renderInlineInputRow(opts("y".repeat(500), 500, w));
			expect(lines).toHaveLength(1);
		}
	});
});

describe("renderInlineInputRow — multiline:true (wrap, regression parity)", () => {
	const opts = (buffer: string, cursorOffset: number | undefined, contentWidth: number) => ({
		buffer,
		cursorOffset,
		rowPrefix: "❯ 1. ",
		continuationPrefix: "     ",
		contentWidth,
		selectedText: id,
		multiline: true as const,
	});

	it("wraps a long buffer across multiple lines", () => {
		const lines = renderInlineInputRow(opts("a".repeat(60), 60, 15));
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0].startsWith("❯ 1. ")).toBe(true);
	});

	it("cursor grapheme core shared with multi-select: emoji not split", () => {
		const lines = renderInlineInputRow(opts("hi😀bye", 2, 40));
		expect(lines[0]).toContain(`hi${cursorOn("😀")}bye`);
	});
});
