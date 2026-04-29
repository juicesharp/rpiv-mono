import { describe, expect, it } from "vitest";
import { SENTINEL_LABELS } from "../../tool/types.js";
import { ChatRowView } from "./chat-row-view.js";
import type { WrappingSelectTheme } from "./wrapping-select.js";

const PASSTHROUGH: WrappingSelectTheme = {
	selectedText: (t) => `[A]${t}[/A]`,
	description: (t) => t,
	scrollInfo: (t) => t,
};

function makeChatRow(initial = { focused: false, numbering: { offset: 0, total: 1 } }) {
	const row = new ChatRowView({
		item: { kind: "chat", label: SENTINEL_LABELS.chat },
		theme: PASSTHROUGH,
	});
	row.setProps(initial);
	return row;
}

describe("ChatRowView", () => {
	it("renders without active pointer when focused=false", () => {
		const row = makeChatRow({ focused: false, numbering: { offset: 0, total: 1 } });
		const lines = row.render(40);
		expect(lines.join("\n")).not.toContain("❯");
		expect(lines.join("\n")).toContain(SENTINEL_LABELS.chat);
	});

	it("renders with active pointer when focused=true", () => {
		const row = makeChatRow({ focused: true, numbering: { offset: 0, total: 1 } });
		const lines = row.render(40);
		expect(lines.join("\n")).toContain("❯");
		expect(lines.join("\n")).toContain(SENTINEL_LABELS.chat);
	});

	it("setProps swaps focused state without rebuilding", () => {
		const row = makeChatRow({ focused: false, numbering: { offset: 0, total: 1 } });
		expect(row.render(40).join("\n")).not.toContain("❯");
		row.setProps({ focused: true, numbering: { offset: 0, total: 1 } });
		expect(row.render(40).join("\n")).toContain("❯");
		row.setProps({ focused: false, numbering: { offset: 0, total: 1 } });
		expect(row.render(40).join("\n")).not.toContain("❯");
	});

	it("setProps updates numbering offset", () => {
		const row = makeChatRow({ focused: false, numbering: { offset: 0, total: 1 } });
		const before = row.render(40).join("\n");
		expect(before).toMatch(/\b1\.\s/);
		row.setProps({ focused: false, numbering: { offset: 4, total: 5 } });
		const after = row.render(40).join("\n");
		expect(after).toMatch(/\b5\.\s/);
	});
});
