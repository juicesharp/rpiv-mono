/**
 * i18n/localization SDK for Pi extensions.
 *
 * Public surface for consumers (rpiv-* family or third-party Pi extensions):
 *   - `registerStrings(namespace, byLocale)` — register a package's translation maps
 *   - `tr(namespace, key, fallback)` / `scope(namespace)` — render-time lookup
 *   - `getActiveLocale()` — current locale code (undefined = English default)
 *   - `applyLocale(code)` — change locale; rebuilds active strings across all namespaces
 *
 * Locale detection priority (resolved in index.ts):
 *   1. --locale CLI flag
 *   2. ~/.config/rpiv-i18n/locale.json
 *   3. process.env.LANG / LC_ALL (Unix convention)
 *   4. English default (locale === undefined)
 *
 * A flattened, read-only snapshot is also published at
 * `globalThis[Symbol.for("rpiv-i18n")]` as `{ locale, namespaces }` for
 * introspection and zero-import escape hatches.
 *
 * Config persists at ~/.config/rpiv-i18n/locale.json (chmod 0o600, best-effort writes).
 */

import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranslationMap = Readonly<Record<string, string>>;
export type LocaleStrings = Readonly<Record<string, TranslationMap>>;

export interface I18nState {
	readonly locale: string | undefined;
	readonly namespaces: Readonly<Record<string, TranslationMap>>;
}

export interface LocaleConfig {
	locale?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const I18N_STATE_KEY = Symbol.for("rpiv-i18n");
const I18N_RUNTIME_KEY = Symbol.for("rpiv-i18n.runtime");

const LOCALE_CONFIG_PATH = configPath("rpiv-i18n", "locale.json");
const DEFAULT_FALLBACK_LOCALE = "en";

// Supported locales — alphabetical by code (so the /languages picker stays
// in deterministic order regardless of how entries are appended). Labels
// are endonyms (the language's name in itself), not English names.
// Third-party extensions opt in to additional locales by calling
// registerStrings with the matching code keys; this list drives only the
// /languages picker UI.
export const SUPPORTED_LOCALES: readonly { code: string; label: string }[] = [
	{ code: "de", label: "Deutsch" },
	{ code: DEFAULT_FALLBACK_LOCALE, label: "English" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "lzh", label: "文言（華夏）" },
	{ code: "pt", label: "Português" },
	{ code: "pt-BR", label: "Português (Brasil)" },
	{ code: "ru", label: "Русский" },
	{ code: "uk", label: "Українська" },
	{ code: "zh", label: "中文" },
	{ code: "zh-Hant", label: "繁體中文" },
];

// ---------------------------------------------------------------------------
// Translation registry — Map<namespace, Map<locale, strings>>.
//
// All SDK state is anchored on globalThis under `Symbol.for("rpiv-i18n.runtime")`
// so live locale changes via `/languages` propagate even when this module is
// loaded as multiple instances (e.g. once via Pi's extension entry, once via
// a consumer's `node_modules/@juicesharp/rpiv-i18n` import — Pi's TS loader
// caches them under different paths and each `import { tr }` would otherwise
// see its own private copy of `activeStrings`).
//
// The public read-only snapshot under `Symbol.for("rpiv-i18n")` is kept as a
// frozen plain-data view for zero-import consumers.
// ---------------------------------------------------------------------------

interface I18nRuntime {
	registry: Map<string, Map<string, TranslationMap>>;
	activeLocale: string | undefined;
	activeStrings: Map<string, TranslationMap>;
}

function getRuntime(): I18nRuntime {
	const g = globalThis as unknown as { [k: symbol]: I18nRuntime | undefined };
	let rt = g[I18N_RUNTIME_KEY];
	if (!rt) {
		rt = { registry: new Map(), activeLocale: undefined, activeStrings: new Map() };
		g[I18N_RUNTIME_KEY] = rt;
	}
	return rt;
}

function pickStringsForLocale(byLocale: Map<string, TranslationMap>, locale: string | undefined): TranslationMap {
	if (locale && locale !== DEFAULT_FALLBACK_LOCALE) {
		const overlay = byLocale.get(locale);
		const base = byLocale.get(DEFAULT_FALLBACK_LOCALE) ?? {};
		if (overlay) return Object.freeze({ ...base, ...overlay });
		return base;
	}
	return byLocale.get(DEFAULT_FALLBACK_LOCALE) ?? {};
}

function rebuildActive(): void {
	const rt = getRuntime();
	rt.activeStrings.clear();
	for (const [namespace, byLocale] of rt.registry) {
		rt.activeStrings.set(namespace, pickStringsForLocale(byLocale, rt.activeLocale));
	}
	writeRegistry();
}

function snapshotForGlobal(): Readonly<Record<string, TranslationMap>> {
	const snapshot: Record<string, TranslationMap> = {};
	for (const [namespace, strings] of getRuntime().activeStrings) {
		snapshot[namespace] = strings;
	}
	return Object.freeze(snapshot);
}

function writeRegistry(): void {
	const state: I18nState = Object.freeze({
		locale: getRuntime().activeLocale,
		namespaces: snapshotForGlobal(),
	});
	(globalThis as unknown as { [k: symbol]: I18nState })[I18N_STATE_KEY] = state;
}

// ---------------------------------------------------------------------------
// Public registration + lookup API
// ---------------------------------------------------------------------------

/**
 * Register translation strings for a Pi extension. Consumers call this once
 * at extension load (typically inside their default-exported wiring function).
 * The namespace SHOULD be the npm package name to avoid collisions.
 *
 * Re-calling with the same namespace replaces the prior registration.
 */
export function registerStrings(namespace: string, byLocale: LocaleStrings): void {
	const map = new Map<string, TranslationMap>();
	for (const [code, strings] of Object.entries(byLocale)) {
		map.set(code, Object.freeze({ ...strings }));
	}
	getRuntime().registry.set(namespace, map);
	rebuildActive();
}

/** Render-time translation lookup. Returns `fallback` when no entry exists. */
export function tr(namespace: string, key: string, fallback: string): string {
	const strings = getRuntime().activeStrings.get(namespace);
	if (!strings) return fallback;
	const value = strings[key];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Bind a namespace once; returns a `(key, fallback) => string` closure. */
export function scope(namespace: string): (key: string, fallback: string) => string {
	return (key, fallback) => tr(namespace, key, fallback);
}

// ---------------------------------------------------------------------------
// Locale state
// ---------------------------------------------------------------------------

export function applyLocale(locale: string | undefined): void {
	getRuntime().activeLocale = locale;
	rebuildActive();
}

export function getActiveLocale(): string | undefined {
	return getRuntime().activeLocale;
}

// ---------------------------------------------------------------------------
// Config persistence — mirrors advisor.ts:99-123
// ---------------------------------------------------------------------------

export function loadLocaleConfig(): LocaleConfig {
	return loadJsonConfigWithLegacyFallback<LocaleConfig>("rpiv-i18n", "locale.json");
}

/**
 * Persist the locale preference. Returns `true` on success, `false` if the
 * write failed (disk full, EACCES, EROFS, etc.) — caller MUST react. The
 * `/languages` handler relies on this boolean to honor the documented
 * save-then-apply invariant: applying in-memory state after a failed write
 * would silently revert at next start with zero diagnostic surface.
 *
 * The chmod step inside `saveJsonConfig` is best-effort and never affects
 * the return value.
 */
export function saveLocaleConfig(locale: string | undefined): boolean {
	const config: LocaleConfig = {};
	if (locale) config.locale = locale;
	return saveJsonConfig(LOCALE_CONFIG_PATH, config);
}

// ---------------------------------------------------------------------------
// Locale detection (no flag — flag is read in index.ts which has pi access)
// ---------------------------------------------------------------------------

function parseLangEnv(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const lang = value.split("_")[0]?.split(".")[0];
	if (!lang || lang === "C" || lang === "POSIX") return undefined;
	return lang;
}

export function detectLocaleFromConfigAndEnv(): string | undefined {
	const config = loadLocaleConfig();
	if (config.locale) return config.locale;
	return parseLangEnv(process.env.LANG) ?? parseLangEnv(process.env.LC_ALL);
}

// ---------------------------------------------------------------------------
// Module init — globalThis registry exists from first import. Subsequent
// loads of this module (e.g. via different node_modules resolution paths)
// share the same runtime via the globalThis singleton, so re-running this
// init on the second load is a no-op data-wise (the locale value is the
// same, registrations are preserved).
// ---------------------------------------------------------------------------

applyLocale(detectLocaleFromConfigAndEnv());

// ---------------------------------------------------------------------------
// Test reset — wired into test/setup.ts beforeEach
// ---------------------------------------------------------------------------

export function __resetState(): void {
	const rt = getRuntime();
	rt.registry.clear();
	rt.activeStrings.clear();
	rt.activeLocale = undefined;
	writeRegistry();
}
