import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CANCEL_LABEL, SUBMIT_LABEL, SubmitPicker, type SubmitPickerProps } from "./submit-picker.js";

const theme = {
	bold: (t: string) => `<b>${t}</b>`,
	fg: (color: string, t: string) => `<${color}>${t}</${color}>`,
	bg: (_color: string, t: string) => t,
	strikethrough: (t: string) => t,
} as unknown as Theme;

function props(active0 = false, active1 = false): SubmitPickerProps {
	return { rows: [{ active: active0 }, { active: active1 }] };
}

function makePicker(initial: SubmitPickerProps): SubmitPicker {
	const picker = new SubmitPicker(theme);
	picker.setProps(initial);
	return picker;
}

describe("SubmitPicker", () => {
	it("naturalHeight is 2 regardless of width and props", () => {
		const p = makePicker(props());
		expect(p.naturalHeight(80)).toBe(2);
		expect(p.naturalHeight(40)).toBe(2);
	});

	it("renders both rows with numbers", () => {
		const p = makePicker(props());
		const lines = p.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("1");
		expect(lines[0]).toContain(SUBMIT_LABEL);
		expect(lines[1]).toContain("2");
		expect(lines[1]).toContain(CANCEL_LABEL);
	});

	it("active pointer follows props.rows[i].active", () => {
		const p = makePicker(props(true, false));
		const f0 = p.render(80);
		expect(f0[0]).toContain("❯");
		expect(f0[1]).not.toContain("❯");
		p.setProps(props(false, true));
		const f1 = p.render(80);
		expect(f1[0]).not.toContain("❯");
		expect(f1[1]).toContain("❯");
	});

	it("no active pointer when both rows are inactive", () => {
		const p = makePicker(props(false, false));
		const lines = p.render(80);
		expect(lines[0]).not.toContain("❯");
		expect(lines[1]).not.toContain("❯");
	});

	it("active row is bold-accent", () => {
		const p = makePicker(props(false, true));
		const lines = p.render(80);
		expect(lines[1]).toContain("<accent>");
		expect(lines[1]).toContain("<b>");
	});

	it("renders the same regardless of completeness — dim styling removed (D1 revised)", () => {
		const p = makePicker(props(true, false));
		const lines = p.render(80);
		expect(lines[0]).not.toContain("<dim>");
		expect(lines[0]).toContain("<accent>");
	});
});
