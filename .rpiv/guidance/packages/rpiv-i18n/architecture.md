# rpiv-i18n

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`. Other rpiv-* packages declare it as an **optional** peer (`peerDependenciesMeta.optional: true`); `rpiv-todo`, `rpiv-ask-user-question`, and `rpiv-voice` already do. Carries an `exports` map (`{ ".": "./i18n.ts", "./loader": "./loader.ts" }`) — bare-name imports hit the public SDK; the `./loader` subpath exposes the locale-file loader without pulling `i18n-ui.ts`/pi-tui.

## Responsibility
Localization SDK + extension. Two concerns:
1. **SDK** (`i18n.ts`): namespace-keyed translation registry, `tr`/`scope` lookup, `applyLocale`, locale persistence via `@juicesharp/rpiv-config` at `$XDG_CONFIG_HOME/rpiv-i18n/locale.json` (default `~/.config`), chmod 0o600.
2. **Extension wiring** (`index.ts`): `--locale` CLI flag, `/languages` slash command (interactive picker), and a `session_start` hook that runs the detection chain (flag → config → `LANG`/`LC_ALL` → English default).

A frozen read-only snapshot is also published on a well-known `globalThis` Symbol so zero-import consumers can read locale state without depending on this package.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, `ExtensionContext`, `Theme`, `DynamicBorder`
- **`@earendil-works/pi-tui`** (peer): `Container`, `SelectList`, `Spacer`, `Text` for the picker UI
- **`@juicesharp/rpiv-config`** (`^1.20.0`, the only runtime dependency): `configPath`, `loadJsonConfigWithLegacyFallback`, `saveJsonConfig` for locale persistence
- Node built-ins: only `node:fs` + `node:url` in `loader.ts`; `i18n.ts` imports none

## Consumers
- **Pi extension host**: loads via `pi.extensions: ["./index.ts"]`
- **Sibling extensions**: call `registerLocalesFromDir(namespace, import.meta.url, { label })` from `@juicesharp/rpiv-i18n/loader` (dynamic import, soft-peer try/catch) at extension load — bulk dir-based registration that replaces hand-rolled `registerStrings`. Then use `tr` / `scope` from `@juicesharp/rpiv-i18n` at render sites. Today: `rpiv-todo`, `rpiv-ask-user-question`, `rpiv-voice` (all `optional: true` peers — UI works without it but English-only)

## Module Structure
```
.                 — Flat package. Four source files:
                    • i18n.ts       — SDK (registry, lookup, locale, config persistence, detection)
                    • loader.ts     — `registerLocalesFromDir` (./loader subpath; dir-based bulk registration)
                    • i18n-ui.ts    — bordered SelectList panel for /languages
                    • index.ts      — composer: flag, command, session_start hook
locales/          — None at this layer; sibling packages own their own `locales/` JSON maps.
```

## Dual-Symbol Singleton (multi-instance safe)
Pi's TS loader can resolve this module twice (once via `pi.extensions`, once via a consumer's `node_modules` import), so a privately-held `activeStrings` would split state. The runtime instead anchors **two `globalThis[Symbol.for(...)]` cells** under well-known keys: one **mutable** runtime store (namespace → locale → strings), and one **frozen snapshot** of the current `{ locale, namespaces }` view that zero-import consumers read. Live `/languages` updates write the mutable cell and republish the snapshot, so updates propagate across all module instances.

## Locale Detection Priority (single chain)
A single chain resolves the active locale: explicit flag (highest), then persisted config, then `LANG`/`LC_ALL`, then undefined (silent English). `applyLocale` runs at three well-defined points — `i18n.ts` module init (config/env only), the `session_start` hook (adds the flag on top), and each `/languages` selection — never inside render paths. The persisted-config step reads via `loadJsonConfigWithLegacyFallback`: the XDG path (`configPath("rpiv-i18n", "locale.json")`) wins whenever the file **exists** — a malformed XDG file does not fall back — and only an absent XDG file falls through, one-way, to legacy `~/.config/rpiv-i18n/locale.json`. Writes (`saveLocaleConfig`) always target the XDG path.

## Overlay-then-Base Translation Lookup
Lookups are **overlay-then-base**: the active locale's map is merged on top of the English base map, and the result is frozen. Missing keys in the overlay silently fall through to English. Missing keys in *both* return the consumer-provided fallback — translation lookup never throws.

## Architectural Boundaries
- **NO LLM-facing copy** — `tr()` powers TUI/UI strings only; system prompts and tool descriptions remain English (cache parity)
- **English is the silent fallback** — `locale === undefined` AND a missing key both fall back; never crash on missing translations
- **Save-then-apply** — `/languages` writes the config first; if disk write fails the in-memory locale is NOT applied (prevents silent revert at restart)
- **Best-effort chmod** — the 0o600 chmod happens inside rpiv-config's `saveJsonConfig` (not in this package) and swallows errors; persistence success is independent of mode
- **`SUPPORTED_LOCALES` drives only the picker** — third-party extensions opt into other locales by registering matching code keys; the picker list is not the registry

<important if="you are integrating rpiv-i18n into a sibling extension">
## Wiring an Extension as a Translation Consumer
1. Add `@juicesharp/rpiv-i18n` to `peerDependencies` (`"*"`) AND `peerDependenciesMeta: { "@juicesharp/rpiv-i18n": { "optional": true } }` so the extension still installs without it
2. Author `locales/<code>.json` JSON maps (mirror `rpiv-todo/locales/`); ship them in `package.json` `files`
3. At module top level (top-level `await`, before the default export — mirror `rpiv-todo/index.ts`), dynamic-`import("@juicesharp/rpiv-i18n/loader")` inside a try/catch (soft peer) and call `registerLocalesFromDir(<pkg-name>, import.meta.url, { label })` ONCE — it iterates `SUPPORTED_LOCALES` and calls `registerStrings` for you. (Low-level `registerStrings(<pkg-name>, byLocale)` remains for callers that build maps in-memory.)
4. Use `const t = scope("<pkg-name>")` then `t("key", "English fallback")` at every render-time string site — never inline literals where translations exist
5. If your extension owns module-level singleton i18n state (e.g. an `i18n-bridge.ts` cache), export a `__resetState` and wire it into `test/setup.ts` `beforeEach` — see existing rpiv-todo / rpiv-ask-user-question bridges
</important>

<important if="you are adding a new supported locale to the picker">
## Adding a Locale
1. Append `{ code, label }` (label is the endonym) to `SUPPORTED_LOCALES` in alphabetical order by code
2. Author `locales/<code>.json` in every consuming package; partial coverage is fine (English fills gaps)
3. No registration needed for the SDK itself — the picker reads `SUPPORTED_LOCALES` directly
4. Update CHANGELOG `[Unreleased]`
</important>
