import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { TranscriptView } from "./transcript-view.ts";

const plain = makeTheme() as unknown as Theme;
const tagged = makeTheme({
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
}) as unknown as Theme;
const WIDTH = 80;

describe("TranscriptView", () => {
	it("renders placeholder when both text and partial are empty", () => {
		const view = new TranscriptView(tagged);
		view.setProps({ text: "", partial: "", placeholder: "Listening..." });
		const lines = view.render(WIDTH);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Listening...");
		expect(lines[0]).toContain("<muted>");
	});

	it("renders committed text only when partial is absent", () => {
		const view = new TranscriptView(plain);
		view.setProps({ text: "hello world", placeholder: "Listening..." });
		const lines = view.render(WIDTH);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.some((l) => l.includes("hello world"))).toBe(true);
	});

	it("renders partial text in dim style", () => {
		const view = new TranscriptView(tagged);
		view.setProps({ text: "", partial: "going to", placeholder: "Listening..." });
		const lines = view.render(WIDTH);
		expect(lines.some((l) => l.includes("<dim>going to</dim>"))).toBe(true);
	});

	it("renders committed + partial with a separating space", () => {
		const view = new TranscriptView(tagged);
		view.setProps({ text: "I am", partial: "going home", placeholder: "Listening..." });
		const lines = view.render(WIDTH);
		// Should contain both pieces
		const merged = lines.join("\n");
		expect(merged).toContain("I am");
		expect(merged).toContain("<dim>going home</dim>");
	});

	it("uses the placeholder from setProps", () => {
		const view = new TranscriptView(plain);
		view.setProps({ text: "", placeholder: "Speak now..." });
		const lines = view.render(WIDTH);
		expect(lines[0]).toContain("Speak now...");
	});

	it("setProps updates the rendered output", () => {
		const view = new TranscriptView(plain);
		view.setProps({ text: "first", placeholder: "..." });
		expect(view.render(WIDTH).some((l) => l.includes("first"))).toBe(true);

		view.setProps({ text: "second", placeholder: "..." });
		expect(view.render(WIDTH).some((l) => l.includes("second"))).toBe(true);
	});

	it("handleInput and invalidate are no-ops (no throw)", () => {
		const view = new TranscriptView(plain);
		view.handleInput("x");
		view.invalidate();
	});
});
