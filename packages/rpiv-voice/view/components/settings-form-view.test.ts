import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { SettingsFieldView } from "./settings-field-view.ts";
import { SettingsFormView } from "./settings-form-view.ts";

const plain = makeTheme() as unknown as Theme;
const WIDTH = 80;

function makeField(label: string, value: string): SettingsFieldView {
	const field = new SettingsFieldView(plain);
	field.setProps({ label, active: false, field: { kind: "readonly", value } });
	return field;
}

describe("SettingsFormView", () => {
	it("renders all fields concatenated", () => {
		const f1 = makeField("Microphone", "Default");
		const f2 = makeField("Language", "English");
		const form = new SettingsFormView({ fields: [f1, f2] });

		const lines = form.render(WIDTH);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Microphone");
		expect(lines[1]).toContain("Language");
	});

	it("renders empty when no fields are provided", () => {
		const form = new SettingsFormView({ fields: [] });
		expect(form.render(WIDTH)).toEqual([]);
	});

	it("renders multiple lines per field when hints are present", () => {
		const field = new SettingsFieldView(plain);
		field.setProps({
			label: "Language",
			active: true,
			field: { kind: "readonly", value: "English" },
			hint: "Run /languages to change.",
		});
		const form = new SettingsFormView({ fields: [field] });

		const lines = form.render(WIDTH);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Language");
		expect(lines[1]).toContain("Run /languages to change.");
	});

	it("setProps is a no-op (no throw)", () => {
		const form = new SettingsFormView({ fields: [] });
		form.setProps({});
	});

	it("handleInput and invalidate are no-ops (no throw)", () => {
		const form = new SettingsFormView({ fields: [] });
		form.handleInput("x");
		form.invalidate();
	});
});
