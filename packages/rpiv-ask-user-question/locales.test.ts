import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localesDir = fileURLToPath(new URL("./locales", import.meta.url));

/**
 * Translator contract (docs/localization.md): these values are templates —
 * `{key}` is replaced at render time with the user's configured `collapseKey`
 * display form. A locale value without the placeholder would silently no-op
 * the `.replace` and render the raw string verbatim.
 */
const TEMPLATED_KEYS = ["hint.collapse", "hint.expand_line"] as const;

describe("locales — {key} placeholder contract", () => {
	const files = readdirSync(localesDir).filter((f) => f.endsWith(".json"));

	it("en.json defines both templated hint keys (English is the fallback base for every locale)", () => {
		const en = JSON.parse(readFileSync(join(localesDir, "en.json"), "utf8")) as Record<string, string>;
		for (const key of TEMPLATED_KEYS) {
			expect(en[key], `en.json ${key}`).toContain("{key}");
		}
	});

	it.each(files)("%s keeps the literal {key} placeholder in templated hint values", (file) => {
		const map = JSON.parse(readFileSync(join(localesDir, file), "utf8")) as Record<string, string>;
		for (const key of TEMPLATED_KEYS) {
			const value = map[key];
			// Missing keys fall back to English and are fine; present keys must template.
			if (value !== undefined) {
				expect(value, `${file} ${key}`).toContain("{key}");
			}
		}
	});
});
