import { describe, expect, it } from "vitest";
import { renderBanner } from "./banner.ts";

describe("renderBanner", () => {
	it("renders title, body, spacer, and CTA inside a rounded box", () => {
		const out = renderBanner("title", ["• item", "", "Run /cmd to act."]);
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/^╭─ title ─+╮$/);
		expect(lines[1]).toMatch(/^│ {2}• item +│$/);
		expect(lines[2]).toMatch(/^│ +│$/); // spacer
		expect(lines[3]).toContain("Run /cmd to act.");
		expect(lines[4]).toMatch(/^╰─+╯$/);
	});

	it("every line has the same display width (frame is rectangular)", () => {
		const out = renderBanner("a longer banner title here", ["x", "a body line that is even longer than the title"]);
		const widths = new Set(out.split("\n").map((l) => [...l].length));
		expect(widths.size).toBe(1);
	});

	it("width hugs the title when the title is the longest line", () => {
		const out = renderBanner("a very long title that dominates", ["x"]);
		const lines = out.split("\n");
		expect(lines[0]).toContain("a very long title that dominates");
		expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
	});
});
