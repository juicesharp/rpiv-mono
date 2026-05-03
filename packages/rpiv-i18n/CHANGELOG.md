# Changelog

All notable changes to `@juicesharp/rpiv-i18n` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

### Added
- i18n SDK for Pi extensions: `registerStrings(namespace, byLocale)`, `scope(namespace)`, `tr(namespace, key, fallback)`, `getActiveLocale()`, `applyLocale(code)`
- `/languages` slash command for interactive locale selection (built-in picker chrome lists the locale's endonym)
- `--locale` CLI flag (priority: flag → config → LANG/LC_ALL → English)
- Locale detection from `~/.config/rpiv-i18n/locale.json`, `process.env.LANG`, `process.env.LC_ALL` (rejects `C` / `POSIX`)
- Config persistence at `~/.config/rpiv-i18n/locale.json` (chmod 0o600); `saveLocaleConfig` returns `false` on disk failure so the `/languages` handler can notify the user instead of silently reverting on next restart
- English fallback per missing key in non-English locales
- `SUPPORTED_LOCALES` ships Deutsch / English / Español / Français / Português / Português (Brasil) / Русский / Українська out of the box (alphabetical by code); consumers register their own translation maps for each
- Read-only globalThis snapshot at `Symbol.for("rpiv-i18n")` as `{ locale, namespaces }` for zero-import consumers
- Runtime state anchored on `globalThis[Symbol.for("rpiv-i18n.runtime")]` so live `/languages` changes propagate across multiple module instances (Pi extension load + node_modules import resolve to different cache keys)
- Sibling regex word-boundary anchored (`/rpiv-i18n(?![-\w])/i`) so future `rpiv-i18n-*` packages don't collide
