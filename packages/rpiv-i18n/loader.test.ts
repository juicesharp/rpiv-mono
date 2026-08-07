import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, scope } from "./i18n.js";
import { registerLocalesFromDir } from "./loader.js";

let pkgDir: string;
let pkgUrl: string;

beforeEach(() => {
	pkgDir = mkdtempSync(join(tmpdir(), "rpiv-loader-"));
	mkdirSync(join(pkgDir, "locales"), { recursive: true });
	// Anchor is a synthetic index.ts inside the temp package — fileURLToPath +
	// `new URL("./locales/<code>.json", pkgUrl)` then resolves to pkgDir/locales/.
	pkgUrl = pathToFileURL(join(pkgDir, "index.ts")).href;
	__resetState();
});

afterEach(() => {
	rmSync(pkgDir, { recursive: true, force: true });
});

describe("registerLocalesFromDir", () => {
	it("reads each available locale from the caller's locales/ directory and registers it", () => {
		writeFileSync(join(pkgDir, "locales", "en.json"), JSON.stringify({ greeting: "Hello" }));
		writeFileSync(join(pkgDir, "locales", "uk.json"), JSON.stringify({ greeting: "Привіт" }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		registerLocalesFromDir("@test/ns", pkgUrl);

		const t = scope("@test/ns");
		// Default locale is English (no applyLocale called), so we read the en map.
		expect(t("greeting", "fallback")).toBe("Hello");
		warn.mockRestore();
	});

	it("records an empty map and warns when a locale file is missing — extension stays online", () => {
		// Only en.json present; the other 11 SUPPORTED_LOCALES files are missing.
		writeFileSync(join(pkgDir, "locales", "en.json"), JSON.stringify({ greeting: "Hi" }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		registerLocalesFromDir("@test/ns", pkgUrl);

		// 11 warns for the 11 missing files; en still resolves.
		expect(warn).toHaveBeenCalled();
		const t = scope("@test/ns");
		expect(t("greeting", "fallback")).toBe("Hi");
		warn.mockRestore();
	});

	it("warns and records an empty map on malformed JSON — never throws", () => {
		writeFileSync(join(pkgDir, "locales", "en.json"), "{ not json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(() => registerLocalesFromDir("@test/ns", pkgUrl)).not.toThrow();

		const t = scope("@test/ns");
		// English map was overwritten with {} → fallback returned for every key.
		expect(t("anything", "fallback-literal")).toBe("fallback-literal");
		warn.mockRestore();
	});

	it("prefixes warn messages with the supplied label", () => {
		// No locale files exist at all — every SUPPORTED_LOCALES entry triggers a warn.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		registerLocalesFromDir("@test/ns", pkgUrl, { label: "rpiv-test" });

		const messages = warn.mock.calls.map((c) => String(c[0]));
		expect(messages.length).toBeGreaterThan(0);
		expect(messages.every((m) => m.startsWith("rpiv-test:"))).toBe(true);
		warn.mockRestore();
	});

	it("defaults the warn label to the namespace when no label option is supplied", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		registerLocalesFromDir("@juicesharp/example", pkgUrl);

		const messages = warn.mock.calls.map((c) => String(c[0]));
		expect(messages.every((m) => m.startsWith("@juicesharp/example:"))).toBe(true);
		warn.mockRestore();
	});
});
