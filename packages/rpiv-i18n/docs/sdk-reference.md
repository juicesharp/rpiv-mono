# SDK reference

The complete public surface of `@juicesharp/rpiv-i18n` — every exported function,
its behavior contract, the locale detection chain, and the `globalThis` escape
hatch. For a task-oriented walkthrough of adding localization to your own
extension, read [integration-guide.md](./integration-guide.md) first.

## Import surface

The package ships two entry points:

| Specifier | Module | Use it for |
| --- | --- | --- |
| `@juicesharp/rpiv-i18n` | `i18n.ts` | Lookup and locale state — `scope`, `tr`, `registerStrings`, `applyLocale` |
| `@juicesharp/rpiv-i18n/loader` | `loader.ts` | Registering a `locales/` directory — `registerLocalesFromDir` |

The `/loader` subpath exists so a consumer that only needs to register strings
does not pull `i18n-ui.ts` — and with it the `@earendil-works/pi-tui`
dependency — into its load graph.

## `@juicesharp/rpiv-i18n`

### Registration and lookup

| Export | Signature | Behavior |
| --- | --- | --- |
| `registerStrings` | `(namespace: string, byLocale: LocaleStrings) => void` | Registers a package's translation maps under `namespace` (use your npm package name). Each map is frozen on registration. Re-calling with the same namespace **replaces** the prior registration. |
| `tr` | `(namespace: string, key: string, fallback: string) => string` | One-shot render-time lookup. Never throws. |
| `scope` | `(namespace: string) => (key: string, fallback: string) => string` | Binds a namespace once and returns a closure. The closure reads live state on every call, so it follows locale changes. |

### Locale state

| Export | Signature | Behavior |
| --- | --- | --- |
| `applyLocale` | `(locale: string \| undefined) => void` | Sets the active locale and rebuilds the active string set across **all** registered namespaces. `undefined` means the English default. |
| `getActiveLocale` | `() => string \| undefined` | The active locale code, or `undefined` for the English default. |
| `detectLocaleFromConfigAndEnv` | `() => string \| undefined` | Resolves persisted config, then `LANG`, then `LC_ALL`. Does not read the `--locale` flag. |

### Config persistence

| Export | Signature | Behavior |
| --- | --- | --- |
| `loadLocaleConfig` | `() => LocaleConfig` | Reads the XDG config path; falls back to the legacy `~/.config` path only when the XDG path does not exist. Returns `{}` when both are absent. |
| `saveLocaleConfig` | `(locale: string \| undefined) => boolean` | Writes `{"locale":"<code>"}` to the XDG path. Passing `undefined` omits the key entirely. Returns `false` when the write fails — callers must react. |

### Constants and types

| Export | Value |
| --- | --- |
| `SUPPORTED_LOCALES` | `readonly { code: string; label: string }[]` — the nine picker entries, alphabetical by code, labelled with endonyms. |
| `I18N_STATE_KEY` | `Symbol.for("rpiv-i18n")` — the key of the public snapshot on `globalThis`. |
| `__resetState` | Test-only hook that clears the registry, active strings, and locale. |
| Types | `TranslationMap`, `LocaleStrings`, `I18nState`, `LocaleConfig` |

## `@juicesharp/rpiv-i18n/loader`

```ts
registerLocalesFromDir(
  namespace: string,
  packageUrl: string,           // pass import.meta.url from YOUR package
  options?: { label?: string }, // warn-message prefix; defaults to namespace
): void
```

Reads `./locales/<code>.json` relative to `packageUrl` for every code in
`SUPPORTED_LOCALES`, then calls `registerStrings(namespace, byLocale)` once.
Files are read from the *caller's* package, never from rpiv-i18n.

A per-file failure (missing file, malformed JSON, `EACCES`) emits

```
<label>: failed to load locales/<code>.json — falling back to English (<message>)
```

on `console.warn` and records an empty map for that locale. Module init never
crashes because of a locale-file mistake.

Also exported: the type `RegisterLocalesFromDirOptions`.

## Behavior contract

- **English fallback per key.** The active locale's map is spread over the `en`
  map and the result frozen. A key present in `en` but missing from the active
  locale resolves to the English string, not to blank.
- **Caller fallback as the last resort.** If the namespace is unregistered, the
  key is missing from both maps, **or the stored value is an empty string**,
  `tr` returns the `fallback` argument you passed at the call site.
- **Live locale changes.** After `/languages` writes a new locale, the next
  `tr(...)` call returns the new string. No restart.
- **Render-time only.** Call `tr(...)` inside the render function. A top-level
  `const HEADING = t("welcome.title", "Welcome")` is evaluated at module init
  and freezes English before the user's locale is ever applied.
- **Multi-instance safe.** All mutable state lives on
  `globalThis[Symbol.for("rpiv-i18n.runtime")]`, so a locale change propagates
  even when Pi's TypeScript loader resolves the module under two paths and each
  `import { tr }` would otherwise see a private copy.

## Locale detection chain

`applyLocale` runs at exactly three points: module init, the `session_start`
hook, and each `/languages` selection. The value it receives resolves in this
order:

1. `--locale <code>` — read from the flag, but **only** during `session_start`.
   Module-init resolution never sees it.
2. The persisted config file (XDG path, then the legacy path).
3. `process.env.LANG`, then `process.env.LC_ALL`. Parsed as the language
   segment of `<lang>_<REGION>.<charset>` — `uk_UA.UTF-8` yields `uk`. The
   values `C` and `POSIX` are rejected.
4. `undefined` — the silent English default.

`SUPPORTED_LOCALES` gates the `/languages` picker list *and* the set of files
`registerLocalesFromDir` reads — it iterates the list, so a `locales/<code>.json`
whose code is absent is never read or registered. A direct `registerStrings` call
bypasses that: it may register any locale code, and codes outside the list simply
do not appear in the picker.

The persisted config is read from the XDG path, falling back to the pre-2.0.0
`~/.config/rpiv-i18n/locale.json` only when the XDG path does not exist. Writes
always go to the XDG path.

## `globalThis` introspection escape hatch

For tools that prefer not to import this package, the active state is published
at `globalThis[Symbol.for("rpiv-i18n")]` as a frozen
`{ locale, namespaces }` plain-data snapshot:

```ts
const I18N = Symbol.for("rpiv-i18n");

function lookup(key: string, fallback: string): string {
  // Re-read the symbol on every call — the SDK *replaces* the snapshot on
  // every registerStrings/applyLocale, so a cached reference silently serves
  // stale strings after `/languages`.
  const state = (globalThis as { [k: symbol]: unknown })[I18N] as
    | { locale: string | undefined; namespaces: Record<string, Record<string, string>> }
    | undefined;
  return state?.namespaces["@my-org/cool-tool"]?.[key] ?? fallback;
}

lookup("welcome", "Welcome!");
```

Each locale change produces a **new** frozen object — read the symbol at call
time, never hoist it into a module-scope `const`. Registration must still go
through `registerStrings(...)`; writing into `globalThis[I18N]` directly is
unsupported.
