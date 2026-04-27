import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { DialogState } from "./dialog-builder.js";
import { CANCEL_LABEL, SUBMIT_LABEL, SubmitPicker } from "./submit-picker.js";

const theme = {
	bold: (t: string) => `<b>${t}</b>`,
	fg: (color: string, t: string) => `<${color}>${t}</${color}>`,
	bg: (_color: string, t: string) => t,
	strikethrough: (t: string) => t,
} as unknown as Theme;

function state(over: Partial<DialogState> = {}): DialogState {
	return {
		currentTab: 2,
		optionIndex: 0,
		notesVisible: false,
		inputMode: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: over.submitChoiceIndex ?? 0,
		...over,
	} as DialogState;
}

describe("SubmitPicker", () => {
	it("naturalHeight is 2 regardless of width and state", () => {
		const p = new SubmitPicker(theme, state());
		expect(p.naturalHeight(80)).toBe(2);
		expect(p.naturalHeight(40)).toBe(2);
	});

	it("renders both rows with numbers", () => {
		const p = new SubmitPicker(theme, state());
		const lines = p.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("1");
		expect(lines[0]).toContain(SUBMIT_LABEL);
		expect(lines[1]).toContain("2");
		expect(lines[1]).toContain(CANCEL_LABEL);
	});

	it("active pointer follows submitChoiceIndex when focused", () => {
		const p = new SubmitPicker(theme, state({ submitChoiceIndex: 0 }));
		p.setFocused(true);
		const f0 = p.render(80);
		expect(f0[0]).toContain("❯");
		expect(f0[1]).not.toContain("❯");
		p.setState(state({ submitChoiceIndex: 1 }));
		const f1 = p.render(80);
		expect(f1[0]).not.toContain("❯");
		expect(f1[1]).toContain("❯");
	});

	it("no active pointer when unfocused", () => {
		const p = new SubmitPicker(theme, state({ submitChoiceIndex: 0 }));
		p.setFocused(false);
		const lines = p.render(80);
		expect(lines[0]).not.toContain("❯");
		expect(lines[1]).not.toContain("❯");
	});

	it("active row is bold-accent when focused", () => {
		const p = new SubmitPicker(theme, state({ submitChoiceIndex: 1 }));
		p.setFocused(true);
		const lines = p.render(80);
		expect(lines[1]).toContain("<accent>");
		expect(lines[1]).toContain("<b>");
	});

	it("renders the same regardless of completeness — dim styling removed (D1 revised)", () => {
		const p = new SubmitPicker(theme, state({ submitChoiceIndex: 0 }));
		p.setFocused(true);
		const lines = p.render(80);
		expect(lines[0]).not.toContain("<dim>");
		expect(lines[0]).toContain("<accent>");
	});
});
