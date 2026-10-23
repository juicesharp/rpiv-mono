import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetState,
	applyLocale,
	detectLocaleFromConfigAndEnv,
	getActiveLocale,
	I18N_STATE_KEY,
	type I18nState,
	loadLocaleConfig,
	registerStrings,
	saveLocaleConfig,
	scope,
	tr,
} from "./i18n.ts";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-i18n", "locale.json");

function readRegistry(): I18nState | undefined {
	return (globalThis as unknown as { [k: symbol]: I18nState | undefined })[I18N_STATE_KEY];
}

describe("loadLocaleConfig", () => {
	it("returns {} when file is absent", () => {
		expect(loadLocaleConfig()).toEqual({});
	});

	it("returns {} on invalid JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "{not json", "utf-8");
		expect(loadLocaleConfig()).toEqual({});
	});

	it("loads well-formed JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"locale":"uk"}', "utf-8");
		expect(loadLocaleConfig()).toEqual({ locale: "uk" });
	});
});

describe("saveLocaleConfig", () => {
	it("creates parent dir recursively", () => {
		saveLocaleConfig("uk");
		expect(existsSync(CONFIG_PATH)).toBe(true);
	});

	it("omits undefined locale", () => {
		saveLocaleConfig(undefined);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(parsed).toEqual({});
	});

	it("writes JSON with trailing newline", () => {
		saveLocaleConfig("uk");
		expect(readFileSync(CONFIG_PATH, "utf-8").endsWith("\n")).toBe(true);
	});

	it.skipIf(process.platform === "win32")("chmods the file to 0600", () => {
		saveLocaleConfig("uk");
		const mode = statSync(CONFIG_PATH).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("round-trips through loadLocaleConfig", () => {
		saveLocaleConfig("es");
		expect(loadLocaleConfig()).toEqual({ locale: "es" });
	});

	it("returns true on successful write (boolean wired through saveJsonConfig)", () => {
		// Save contract: boolean return is load-bearing for the /languages handler.
		// The false-path is covered in rpiv-config's own test suite, where
		// saveJsonConfig can be exercised against an unwritable path without
		// disturbing the module-level LOCALE_CONFIG_PATH captured here.
		expect(saveLocaleConfig("uk")).toBe(true);
	});
});

describe("detectLocaleFromConfigAndEnv", () => {
	const originalLang = process.env.LANG;
	const originalLcAll = process.env.LC_ALL;

	afterEach(() => {
		// Restore — never blanket-delete (test-env hygiene)
		if (originalLang === undefined) delete process.env.LANG;
		else process.env.LANG = originalLang;
		if (originalLcAll === undefined) delete process.env.LC_ALL;
		else process.env.LC_ALL = originalLcAll;
	});

	it("prefers config over env", () => {
		saveLocaleConfig("uk");
		process.env.LANG = "es_ES.UTF-8";
		expect(detectLocaleFromConfigAndEnv()).toBe("uk");
	});

	it("falls back to LANG when config is absent", () => {
		delete process.env.LC_ALL;
		process.env.LANG = "uk_UA.UTF-8";
		expect(detectLocaleFromConfigAndEnv()).toBe("uk");
	});

	it("falls back to LC_ALL when LANG is unset", () => {
		delete process.env.LANG;
		process.env.LC_ALL = "es_ES.UTF-8";
		expect(detectLocaleFromConfigAndEnv()).toBe("es");
	});

	it("rejects C locale", () => {
		delete process.env.LC_ALL;
		process.env.LANG = "C";
		expect(detectLocaleFromConfigAndEnv()).toBeUndefined();
	});

	it("rejects POSIX locale", () => {
		delete process.env.LC_ALL;
		process.env.LANG = "POSIX";
		expect(detectLocaleFromConfigAndEnv()).toBeUndefined();
	});

	it("returns undefined when neither config nor env is set", () => {
		delete process.env.LANG;
		delete process.env.LC_ALL;
		expect(detectLocaleFromConfigAndEnv()).toBeUndefined();
	});
});

describe("registerStrings + tr", () => {
	it("returns the English string when active locale is undefined", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" } });
		expect(tr("@example/pkg", "greeting", "fallback")).toBe("Hello");
	});

	it("returns the localized string when matching locale is active", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" }, uk: { greeting: "Привіт" } });
		applyLocale("uk");
		expect(tr("@example/pkg", "greeting", "fallback")).toBe("Привіт");
	});

	it("falls back to English for missing keys in non-English locale", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello", farewell: "Bye" }, uk: { greeting: "Привіт" } });
		applyLocale("uk");
		expect(tr("@example/pkg", "farewell", "fb")).toBe("Bye");
	});

	it("falls back to literal when namespace is unknown", () => {
		expect(tr("@unknown/pkg", "anything", "literal")).toBe("literal");
	});

	it("falls back to literal when key is unknown in registered namespace", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" } });
		expect(tr("@example/pkg", "missing", "literal")).toBe("literal");
	});

	it("falls back to literal when value is empty string", () => {
		registerStrings("@example/pkg", { en: { greeting: "" } });
		expect(tr("@example/pkg", "greeting", "literal")).toBe("literal");
	});

	it("re-registering replaces the prior namespace registration", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" } });
		registerStrings("@example/pkg", { en: { greeting: "Hi" } });
		expect(tr("@example/pkg", "greeting", "fb")).toBe("Hi");
	});

	it("isolates namespaces", () => {
		registerStrings("@a/pkg", { en: { key: "A" } });
		registerStrings("@b/pkg", { en: { key: "B" } });
		expect(tr("@a/pkg", "key", "fb")).toBe("A");
		expect(tr("@b/pkg", "key", "fb")).toBe("B");
	});

	it("missing-locale registration falls through to en when locale changes", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" } });
		applyLocale("xx");
		expect(tr("@example/pkg", "greeting", "fb")).toBe("Hello");
	});
});

describe("scope", () => {
	it("binds namespace once and resolves keys", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello", farewell: "Bye" } });
		const t = scope("@example/pkg");
		expect(t("greeting", "fb")).toBe("Hello");
		expect(t("farewell", "fb")).toBe("Bye");
	});

	it("scoped lookups follow live locale changes", () => {
		registerStrings("@example/pkg", { en: { greeting: "Hello" }, uk: { greeting: "Привіт" } });
		const t = scope("@example/pkg");
		expect(t("greeting", "fb")).toBe("Hello");
		applyLocale("uk");
		expect(t("greeting", "fb")).toBe("Привіт");
	});
});

describe("applyLocale + globalThis registry", () => {
	it("publishes a plain-data registry — no functions", () => {
		registerStrings("@example/pkg", { en: { k: "v" } });
		applyLocale("en");
		const reg = readRegistry();
		expect(reg).toBeDefined();
		expect(typeof reg!.locale === "string" || reg!.locale === undefined).toBe(true);
		for (const [, strings] of Object.entries(reg!.namespaces)) {
			for (const v of Object.values(strings)) {
				expect(typeof v).toBe("string");
			}
		}
	});

	it("globalThis namespaces reflect the active locale", () => {
		registerStrings("@example/pkg", { en: { k: "Hello" }, uk: { k: "Привіт" } });
		applyLocale("uk");
		const reg = readRegistry();
		expect(reg!.locale).toBe("uk");
		expect(reg!.namespaces["@example/pkg"]?.k).toBe("Привіт");
	});

	it("getActiveLocale reflects the registry", () => {
		applyLocale("uk");
		expect(getActiveLocale()).toBe("uk");
		applyLocale(undefined);
		expect(getActiveLocale()).toBeUndefined();
	});
});

describe("__resetState", () => {
	it("clears registrations and locale", () => {
		registerStrings("@example/pkg", { en: { k: "Hello" } });
		applyLocale("uk");
		__resetState();
		expect(getActiveLocale()).toBeUndefined();
		expect(tr("@example/pkg", "k", "fb")).toBe("fb");
		const reg = readRegistry();
		expect(reg).toBeDefined();
		expect(Object.keys(reg!.namespaces)).toHaveLength(0);
	});
});
