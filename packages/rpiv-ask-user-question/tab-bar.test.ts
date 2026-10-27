import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { TabBar } from "./view/components/tab-bar.ts";

const theme = {
	bg: (_role: string, text: string) => text,
	fg: (_role: string, text: string) => text,
} as unknown as Theme;

function bar(labels: readonly string[], active: number, answered: readonly number[] = []): TabBar {
	const tabBar = new TabBar(theme);
	tabBar.setProps({
		tabs: labels.map((label, index) => ({
			label,
			answered: answered.includes(index),
			active: index === active,
		})),
		submit: { active: false, allAnswered: false },
	});
	return tabBar;
}

function longLabels(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `Header${index + 1}`.padEnd(16, "x"));
}

describe("TabBar", () => {
	it("renders every tab when the strip fits", () => {
		const line = bar(["One", "Two", "Three"], 1, [0]).render(120)[0] ?? "";
		for (const label of ["One", "Two", "Three"]) expect(line).toContain(label);
		expect(line).toContain("■");
		expect(line).toContain("Submit");
		expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("keeps the active tab and Submit visible when the strip overflows", () => {
		const line = bar(longLabels(8), 6).render(100)[0] ?? "";
		expect(line).toContain("Header7");
		expect(line).toContain("…");
		expect(line).toContain("Submit");
		expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	it("keeps Submit visible with four full-length headers on an 80-column terminal", () => {
		const line = bar(longLabels(4), 2).render(80)[0] ?? "";
		expect(line).toContain("Submit");
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("falls back to the compact indicator on narrow terminals", () => {
		const line = bar(longLabels(8), 7).render(30)[0] ?? "";
		expect(line).toContain("8/8");
		expect(line).toContain("Submit");
		expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("never exceeds the terminal width", () => {
		for (const width of [16, 24, 40, 80, 140]) {
			const line = bar(longLabels(12), 9).render(width)[0] ?? "";
			expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
		}
	});
});
