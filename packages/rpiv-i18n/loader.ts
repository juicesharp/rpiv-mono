/**
 * Locale-file loader for sibling Pi extensions.
 *
 * Consumers ship a `locales/<code>.json` directory mirroring `SUPPORTED_LOCALES`.
 * Instead of hand-rolling the readFileSync + per-locale try/catch + 8-key
 * `registerStrings` literal in every extension, they import this subpath and
 * call `registerLocalesFromDir(namespace, import.meta.url, { label })`.
 *
 * Lives under the `@juicesharp/rpiv-i18n/loader` subpath (separate from the
 * SDK entry) so a consumer doing `await import("@juicesharp/rpiv-i18n/loader")`
 * does not pull `i18n-ui.ts` and the pi-tui dependency into its load graph
 * just to register strings.
 *
 * Soft-peer contract preserved: when `@juicesharp/rpiv-i18n` is not installed
 * at all, the consumer's outer `try { await import(...) }` rejects before this
 * module is even loaded, so nothing here runs. When it IS installed but at a
 * version that predates this file, the consumer's `sdk.registerLocalesFromDir`
 * resolves to `undefined` and the consumer's outer catch swallows the TypeError —
 * extension stays online, all strings fall back to inline English.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerStrings, SUPPORTED_LOCALES, type TranslationMap } from "./i18n.ts";

export interface RegisterLocalesFromDirOptions {
	/**
	 * Prefix used in the `console.warn` message when a locale file fails to
	 * load. Defaults to the namespace. Set this when the namespace differs
	 * from the npm package name (most extensions pass their package name as
	 * the namespace, so the default is usually right).
	 */
	label?: string;
}

/**
 * Read `locales/<code>.json` for every code in `SUPPORTED_LOCALES` from the
 * caller's package and call `registerStrings(namespace, byLocale)` once.
 *
 * Per-file failures (missing file, malformed JSON, EACCES) emit a `console.warn`
 * and record an empty map for that locale — `tr()` falls back to English. The
 * extension never crashes at module init from a locale-file mistake.
 *
 * @param namespace Translation namespace (typically the npm package name).
 * @param packageUrl Pass `import.meta.url` from the caller — used as the
 *   anchor for resolving `./locales/<code>.json`. Files are read from the
 *   caller's package, not from rpiv-i18n.
 */
export function registerLocalesFromDir(
	namespace: string,
	packageUrl: string,
	options?: RegisterLocalesFromDirOptions,
): void {
	const label = options?.label ?? namespace;
	const byLocale: Record<string, TranslationMap> = {};
	for (const { code } of SUPPORTED_LOCALES) {
		byLocale[code] = loadOneLocale(packageUrl, code, label);
	}
	registerStrings(namespace, byLocale);
}

function loadOneLocale(packageUrl: string, code: string, label: string): TranslationMap {
	try {
		const filePath = fileURLToPath(new URL(`./locales/${code}.json`, packageUrl));
		return JSON.parse(readFileSync(filePath, "utf-8")) as TranslationMap;
	} catch (err) {
		console.warn(
			`${label}: failed to load locales/${code}.json — falling back to English (${(err as Error).message})`,
		);
		return {};
	}
}
