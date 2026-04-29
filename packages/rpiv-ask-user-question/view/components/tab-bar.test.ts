import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TabBar, type TabBarProps } from "./tab-bar.js";

const theme = makeTheme() as unknown as Theme;

interface PropsOver {
	questions?: ReadonlyArray<{ header?: string; question: string }>;
	answeredIndices?: ReadonlyArray<number>;
	activeTabIndex?: number;
	totalTabs?: number;
}

function makeBar(initial: TabBarProps): TabBar {
	const bar = new TabBar(theme);
	bar.setProps(initial);
	return bar;
}

function buildProps(over: PropsOver = {}): TabBarProps {
	const questions = over.questions ?? [
		{ header: "Scope", question: "Which scope?" },
		{ header: "Priority", question: "How urgent?" },
		{ header: "Tests", question: "Include tests?" },
	];
	const answeredSet = new Set(over.answeredIndices ?? []);
	const totalTabs = over.totalTabs ?? questions.length + 1;
	const activeTabIndex = over.activeTabIndex ?? 0;
	const submitIndex = totalTabs - 1;
	const tabs = questions.map((q, i) => ({
		label: q.header && q.header.length > 0 ? q.header : `Q${i + 1}`,
		answered: answeredSet.has(i),
		active: i === activeTabIndex,
	}));
	return {
		tabs,
		submit: {
			active: activeTabIndex === submitIndex,
			allAnswered: answeredSet.size === questions.length && questions.length > 0,
		},
	};
}

describe("TabBar.render", () => {
	it("emits exactly 2 lines (tab bar + blank spacer)", () => {
		const tb = makeBar(buildProps());
		const lines = tb.render(80);
		expect(lines.length).toBe(2);
		expect(lines[1]).toBe("");
	});

	it("renders one indicator per question + a Submit tab", () => {
		const tb = makeBar(buildProps());
		const line = tb.render(80)[0];
		const empties = (line.match(/□/g) ?? []).length;
		expect(empties).toBe(3);
		expect(line).toContain("Submit");
		expect(line).toContain("←");
		expect(line).toContain("→");
	});

	it("flips □ → ■ for answered questions", () => {
		const tb = makeBar(buildProps({ answeredIndices: [1] }));
		const line = tb.render(80)[0];
		expect(line.match(/■/g)?.length).toBe(1);
		expect(line.match(/□/g)?.length).toBe(2);
	});

	it("applies selectedBg styling to the active tab via theme.bg", () => {
		const spy = vi.spyOn(theme, "bg");
		const tb = makeBar(buildProps({ activeTabIndex: 1 }));
		tb.render(80);
		expect(spy).toHaveBeenCalledWith("selectedBg", expect.stringContaining("Priority"));
		spy.mockRestore();
	});

	it("Submit shows success color when all answered, dim otherwise", () => {
		const spy = vi.spyOn(theme, "fg");
		const tbAll = makeBar(buildProps({ answeredIndices: [0, 1, 2], activeTabIndex: 0 }));
		tbAll.render(80);
		expect(spy).toHaveBeenCalledWith("success", expect.stringContaining("Submit"));

		spy.mockClear();
		const tbPartial = makeBar(buildProps({ answeredIndices: [], activeTabIndex: 0 }));
		tbPartial.render(80);
		expect(spy).toHaveBeenCalledWith("dim", expect.stringContaining("Submit"));
		spy.mockRestore();
	});

	it("falls back to Q{n+1} when header is absent", () => {
		const tb = makeBar(
			buildProps({
				questions: [{ question: "first" }, { question: "second" }],
				totalTabs: 3,
			}),
		);
		const line = tb.render(80)[0];
		expect(line).toContain("Q1");
		expect(line).toContain("Q2");
	});

	it("truncates rather than overflowing when 4 long headers exceed width", () => {
		const tb = makeBar(
			buildProps({
				questions: [
					{ header: "VeryLongHeaderOne", question: "" },
					{ header: "VeryLongHeaderTwo", question: "" },
					{ header: "VeryLongHeaderThree", question: "" },
					{ header: "VeryLongHeaderFour", question: "" },
				],
				totalTabs: 5,
			}),
		);
		for (const w of [40, 60, 80, 120]) {
			const lines = tb.render(w);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(w);
		}
	});

	it("setProps replaces props between renders", () => {
		const tb = makeBar(buildProps({ activeTabIndex: 0 }));
		const before = tb.render(80)[0];
		tb.setProps(buildProps({ activeTabIndex: 1, answeredIndices: [0] }));
		const after = tb.render(80)[0];
		expect(before).not.toBe(after);
		expect(after.match(/■/g)?.length).toBe(1);
	});
});
