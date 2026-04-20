import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { buildDialogContainer } from "./ask-user-question.js";
import { WrappingSelect, type WrappingSelectTheme } from "./wrapping-select.js";

const selectTheme: WrappingSelectTheme = {
	selectedText: (t) => t,
	description: (t) => t,
	scrollInfo: (t) => t,
};

const theme = makeTheme() as unknown as Theme;

function lists() {
	const main = new WrappingSelect([{ label: "A" }, { label: "B" }], 2, selectTheme);
	const chat = new WrappingSelect([{ label: "Chat" }], 1, selectTheme);
	return { main, chat };
}

describe("buildDialogContainer", () => {
	it("returns a Container instance with a callable render function", () => {
		const { main, chat } = lists();
		const c = buildDialogContainer(theme, { question: "Q", options: [] }, main, chat);
		expect(c).toBeInstanceOf(Container);
		expect(typeof c.render).toBe("function");
	});

	it("renders without throwing at a reasonable width", () => {
		const { main, chat } = lists();
		const c = buildDialogContainer(theme, { question: "Q", options: [] }, main, chat);
		expect(() => c.render(60)).not.toThrow();
	});

	it("header-present output contains the header text", () => {
		const { main, chat } = lists();
		const c = buildDialogContainer(theme, { question: "Q", header: "HEADER-TEXT", options: [] }, main, chat);
		const rendered = c.render(60).join("\n");
		expect(rendered).toContain("HEADER-TEXT");
		expect(rendered).toContain("Q");
	});

	it("header-absent render still contains the question", () => {
		const { main, chat } = lists();
		const c = buildDialogContainer(theme, { question: "Q-ONLY", options: [] }, main, chat);
		const rendered = c.render(60).join("\n");
		expect(rendered).toContain("Q-ONLY");
	});

	it("header-present produces strictly more output lines than header-absent", () => {
		const { main: m1, chat: c1 } = lists();
		const { main: m2, chat: c2 } = lists();
		const withHeader = buildDialogContainer(theme, { question: "Q", header: "H", options: [] }, m1, c1).render(60);
		const noHeader = buildDialogContainer(theme, { question: "Q", options: [] }, m2, c2).render(60);
		expect(withHeader.length).toBeGreaterThan(noHeader.length);
	});
});
