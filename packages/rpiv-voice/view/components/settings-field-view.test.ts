import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { SettingsFieldView } from "./settings-field-view.ts";

const plain = makeTheme() as unknown as Theme;
const tagged = makeTheme({
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `*${text}*`,
}) as unknown as Theme;
const WIDTH = 80;

describe("SettingsFieldView", () => {
	describe("readonly field", () => {
		it("renders label + value for an inactive readonly field", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Microphone",
				active: false,
				field: { kind: "readonly", value: "System default" },
			});
			const lines = view.render(WIDTH);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("Microphone");
			expect(lines[0]).toContain("System default");
		});

		it("shows placeholder when readonly value is empty", () => {
			const view = new SettingsFieldView(tagged);
			view.setProps({
				label: "Language",
				active: false,
				field: { kind: "readonly", value: "" },
			});
			const lines = view.render(WIDTH);
			expect(lines[0]).toContain("<unset>");
		});

		it("renders hint on the next line when active", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Language",
				active: true,
				field: { kind: "readonly", value: "English" },
				hint: "Run /languages to change.",
			});
			const lines = view.render(WIDTH);
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("Run /languages to change.");
		});

		it("renders hint even when inactive for readonly fields", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Language",
				active: false,
				field: { kind: "readonly", value: "English" },
				hint: "Run /languages to change.",
			});
			const lines = view.render(WIDTH);
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("Run /languages to change.");
		});
	});

	describe("toggle field", () => {
		it("renders [ on ] when toggle is enabled", () => {
			const view = new SettingsFieldView(tagged);
			view.setProps({
				label: "Filter noise",
				active: true,
				field: { kind: "toggle", enabled: true },
			});
			const lines = view.render(WIDTH);
			expect(lines[0]).toContain("[ on ]");
		});

		it("renders [ off ] when toggle is disabled", () => {
			const view = new SettingsFieldView(tagged);
			view.setProps({
				label: "Filter noise",
				active: true,
				field: { kind: "toggle", enabled: false },
			});
			const lines = view.render(WIDTH);
			expect(lines[0]).toContain("[ off ]");
		});

		it("renders hint unconditionally for toggle fields (height stays stable across focus)", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Filter noise",
				active: false,
				field: { kind: "toggle", enabled: true },
				hint: "Some hint",
			});
			const lines = view.render(WIDTH);
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("Some hint");
		});

		it("shows hint when active for toggle fields", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Filter noise",
				active: true,
				field: { kind: "toggle", enabled: true },
				hint: "Drops silence-segment artifacts.",
			});
			const lines = view.render(WIDTH);
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("Drops silence-segment artifacts.");
		});
	});

	describe("active vs inactive styling", () => {
		it("applies accent color and bold to label when active", () => {
			const view = new SettingsFieldView(tagged);
			view.setProps({
				label: "Filter noise",
				active: true,
				field: { kind: "toggle", enabled: true },
			});
			expect(view.render(WIDTH)[0]).toContain("<accent>*Filter noise*</accent>");
		});

		it("does not apply accent/bold to label when inactive", () => {
			const view = new SettingsFieldView(tagged);
			view.setProps({
				label: "Microphone",
				active: false,
				field: { kind: "readonly", value: "Default" },
			});
			const line = view.render(WIDTH)[0];
			expect(line).not.toContain("<accent>");
		});
	});

	describe("no hint", () => {
		it("renders only one line when no hint is provided", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({
				label: "Mic",
				active: false,
				field: { kind: "readonly", value: "Default" },
			});
			expect(view.render(WIDTH)).toHaveLength(1);
		});
	});

	describe("setProps / handleInput / invalidate", () => {
		it("setProps updates the rendered output", () => {
			const view = new SettingsFieldView(plain);
			view.setProps({ label: "A", active: false, field: { kind: "readonly", value: "1" } });
			expect(view.render(WIDTH)[0]).toContain("A");

			view.setProps({ label: "B", active: false, field: { kind: "readonly", value: "2" } });
			expect(view.render(WIDTH)[0]).toContain("B");
		});

		it("handleInput and invalidate are no-ops (no throw)", () => {
			const view = new SettingsFieldView(plain);
			view.handleInput("x");
			view.invalidate();
		});
	});
});
