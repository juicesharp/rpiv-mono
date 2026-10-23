import { applyLocale, registerStrings } from "@juicesharp/rpiv-i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { formatStatusLabel, I18N_NAMESPACE, t } from "./i18n-bridge.ts";

describe("i18n-bridge", () => {
	beforeEach(() => {
		// `i18n.__resetState()` is invoked by the global test/setup.ts hook;
		// re-register the namespace fresh per test to exercise registration.
		registerStrings(I18N_NAMESPACE, {
			en: {
				"status.pending": "pending",
				"status.in_progress": "in progress",
				"status.completed": "completed",
				"status.deleted": "deleted",
			},
			de: {
				"status.in_progress": "in Bearbeitung",
				"status.completed": "erledigt",
			},
		});
	});

	it("returns English when no locale is active", () => {
		expect(formatStatusLabel("in_progress")).toBe("in progress");
		expect(formatStatusLabel("completed")).toBe("completed");
	});

	it("returns localized value when locale is set", () => {
		applyLocale("de");
		expect(formatStatusLabel("in_progress")).toBe("in Bearbeitung");
		expect(formatStatusLabel("completed")).toBe("erledigt");
	});

	it("falls back to English literal when key missing in active locale", () => {
		applyLocale("de"); // de doesn't define status.pending in this test
		expect(formatStatusLabel("pending")).toBe("pending");
	});

	it("`t` falls back to the inline English literal for unknown keys", () => {
		expect(t("nonexistent.key", "fallback literal")).toBe("fallback literal");
	});

	it("namespace constant is the canonical package name", () => {
		expect(I18N_NAMESPACE).toBe("@juicesharp/rpiv-todo");
	});
});
