# Contributing translations

How to add or improve a translation for any Pi extension that uses
`@juicesharp/rpiv-i18n`. The contract is small and uniform across packages, so
what you learn here applies to every one of them.

## What to translate

Translate every key listed in the package's `locales/en.json`. Those are the
TUI-facing strings — labels, hints, prompts, headings — that a human reads on
screen.

Do **not** translate:

- Tool descriptions, TypeBox `description` fields, prompt guidelines and
  snippets. They go to the LLM and stay English so the model parses them
  deterministically across sessions and providers.
- Validation errors that flow through `tool result` envelopes (for example
  `"Error: UI not available …"`) — same reason.
- Reserved labels and any string checked by exact-match validation. Translating
  those lets a localized equivalent slip past duplicate-detection guards.

If a key is not in the package's `locales/en.json`, it is intentionally
English-only. Do not invent new keys; open an issue first if you think a string
should be made localizable.

## File location and naming

- One JSON file per locale, named `<code>.json` — `es.json`, `fr.json`,
  `pt-BR.json` — inside the consumer package's `locales/` directory.
- Locale codes follow BCP-47-ish convention: language only (`es`, `fr`, `de`) or
  `language-Region` for variants (`pt-BR`). Hyphenated, never underscored.
- Mirror the exact key set from `en.json`. Missing keys fall back to English
  silently — acceptable, but note the gap in `_meta.notes`.

## Key naming

Keys are flat and dotted, lowercase: `sentinel.next`, `submit.cancel`,
`preview.no_preview`. Prefer `snake_case` for multi-word leaves. Whatever the
shape, the binding rule is that your file mirrors `en.json` key for key — you do
not choose key names, you copy them.

## File shape

```json
{
  "_meta.notes": "Optional contributor note — auto-translated, native review welcome, key gaps, etc.",

  "<dotted.key.from.en.json>": "Localized string"
}
```

`_meta.*` keys are never requested by a lookup, so they are inert at runtime.
Use them for provenance, change notes, or "WIP — N keys missing".

Values matter: an **empty string resolves to the English fallback**, not to
blank. Leave a key out entirely rather than shipping `""` as a placeholder.

## Universal CLI conventions — leave untranslated

- Symbols: `↑/↓`, `⚠`, `✓`. They render the same in every locale.
- Keyboard names: `Enter`, `Esc`, `Tab`, `Space` — the labels printed on
  physical keyboards worldwide. Some locales (French, for instance) write
  `Entrée` / `Échap`; that is acceptable when it matches the desktop convention
  you are targeting, but be consistent across the whole file.
- Single-key shortcut letters (`n` to add notes): keep the letter unchanged. It
  maps to a literal keystroke handler, not to a label.

## Wiring a new locale

Dropping the file in `locales/` is all a consumer package needs **when the code
is already listed in `SUPPORTED_LOCALES`** — its `registerLocalesFromDir(...)`
call iterates that list and picks up every matching file automatically.

For a *new* locale code, the `SUPPORTED_LOCALES` entry in
`packages/rpiv-i18n/i18n.ts` is required. Without it the loader never reads your
file, so the strings are never registered — the locale does nothing even when a
user selects it with `--locale` or `LANG`, and it never appears in the
`/languages` picker:

```ts
{ code: "fr", label: "Français" },
```

The `label` is the endonym — the language's name in itself — not its English
name. The list is kept alphabetical by code.

## Submitting a PR

Include:

1. The new `locales/<code>.json` file.
2. The `SUPPORTED_LOCALES` entry in `packages/rpiv-i18n/i18n.ts`, if the locale
   is not already listed.
3. A passing `npm run check && npm test` from the monorepo root.

A native-speaker reviewer will land it. Auto-translated drafts are accepted —
mark them in `_meta.notes`. English fallbacks make any gap or error invisible to
users until a fix arrives, so a partial translation is never a regression.
