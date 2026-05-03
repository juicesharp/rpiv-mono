/**
 * rpiv-ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with a free-text "Other" fallback.
 *
 * Sentinel labels (and TUI chrome strings in subsequent phases) localize at
 * render time via the i18n bridge. Strings are registered with rpiv-i18n
 * here, once, at module init.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set), then add the load + entry to the `registerStrings` call below.
 * See `@juicesharp/rpiv-i18n` README → "Contributing translations" for the
 * full convention.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerStrings, type TranslationMap } from "@juicesharp/rpiv-i18n";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";

function loadLocale(code: string): TranslationMap {
	// A missing or malformed locale file degrades gracefully: registerStrings
	// records an empty map for the locale, so render-time `tr(key, fallback)`
	// returns the canonical English literal at the call site. Crashing here
	// would take the entire ask_user_question tool offline at module init —
	// publish-manifest miss would brick the extension.
	try {
		return JSON.parse(
			readFileSync(fileURLToPath(new URL(`./locales/${code}.json`, import.meta.url)), "utf-8"),
		) as TranslationMap;
	} catch (err) {
		console.warn(
			`rpiv-ask-user-question: failed to load locales/${code}.json — falling back to English (${(err as Error).message})`,
		);
		return {};
	}
}

registerStrings(I18N_NAMESPACE, {
	de: loadLocale("de"),
	en: loadLocale("en"),
	es: loadLocale("es"),
	fr: loadLocale("fr"),
	pt: loadLocale("pt"),
	"pt-BR": loadLocale("pt-BR"),
	ru: loadLocale("ru"),
	uk: loadLocale("uk"),
});

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
}
