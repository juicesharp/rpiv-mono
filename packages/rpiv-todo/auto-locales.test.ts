import { readFileSync } from "node:fs";
import { applyLocale, tr } from "@juicesharp/rpiv-i18n";
import { registerLocalesFromDir } from "@juicesharp/rpiv-i18n/loader";
import { afterEach, describe, expect, it } from "vitest";

const locales = ["de", "en", "es", "fr", "pt", "pt-BR", "ru", "uk", "zh"];
const keys = ["description", "on", "off", "title", "usage", "saved", "saveError", "readError"];

afterEach(() => applyLocale(undefined));

describe("auto-collapse localization", () => {
	it("provides every string and placeholder in all supported locales", () => {
		for (const locale of locales) {
			const strings = JSON.parse(readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), "utf8"));
			for (const key of keys) expect(strings[`auto.${key}`], `${locale}: ${key}`).toBeTruthy();
			for (const key of ["title", "saved"]) expect(strings[`auto.${key}`]).toContain("{state}");
			for (const key of ["saveError", "readError"]) expect(strings[`auto.${key}`]).toContain("{error}");
		}
	});

	it("uses the existing SDK to switch the new strings", () => {
		registerLocalesFromDir("@juicesharp/rpiv-todo", import.meta.url);
		applyLocale("zh");
		expect(tr("@juicesharp/rpiv-todo", "auto.on", "On")).toBe("开启");
		applyLocale("en");
		expect(tr("@juicesharp/rpiv-todo", "auto.on", "fallback")).toBe("On");
	});
});
