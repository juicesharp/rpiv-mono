# Changelog

All notable changes to `@juicesharp/rpiv-i18n` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.4] - 2026-05-03

### Changed
- README integration guide now teaches the dynamic-import shim + `peerDependenciesMeta.optional: true` as the recommended posture for new integrators (steps 0/2/3). Replaces the prior static `import { scope }` example, which fails module load if a user installs the consumer extension standalone without rpiv-i18n. Adds a "why dynamic instead of static" explainer.
- README integration guide lists `@juicesharp/rpiv-todo` alongside `@juicesharp/rpiv-ask-user-question` as a worked exemplar so prospective integrators have two reference implementations to study.

## [1.1.3] - 2026-05-03

### Changed
- README integration guide expanded for third-party extension authors: peerDependencies snippet, file-tree layout, normalized `ExtensionAPI` typing, "Verify it works locally before publishing" section (npm pack → pi install → /languages smoke test), and rewritten `globalThis` escape-hatch example showing the per-call re-read pattern (snapshots are replaced, not mutated, on every locale change).

## [1.1.2] - 2026-05-03

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
