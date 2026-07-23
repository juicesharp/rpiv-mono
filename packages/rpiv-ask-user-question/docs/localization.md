# Localization

How the dialog picks its language, which languages ship, and how to add one.

## Enabling it

The extension works standalone: install only this package and you get the full dialog in
English. Localization needs one more install:

```sh
pi install npm:@juicesharp/rpiv-i18n
```

Restart your Pi session. If you installed through
[`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) and ran
`/rpiv-setup`, you already have it.

The dependency is a genuinely optional peer. This package loads the SDK inside a
`try`/`catch` at startup; when it is absent, every string falls back to its inline English
literal at the call site. There is no warning and no crash — the dialog simply renders in
English.

## Picking a language

With the SDK installed, the locale resolves in this order, first hit wins:

1. `pi --locale <code>` on the command line
2. `~/.config/rpiv-i18n/locale.json`
3. `LANG` / `LC_ALL` from the environment
4. English

`/languages` opens an interactive picker and flips the strings live — the dialog reads its
strings at render time, so an open questionnaire follows the change. Both `/languages` and
`--locale` are registered by `@juicesharp/rpiv-i18n`, not by this package.

## Shipped languages

Nine locale files ship in `locales/`:

| Code | Language |
| --- | --- |
| `de` | Deutsch |
| `en` | English |
| `es` | Español |
| `fr` | Français |
| `pt` | Português |
| `pt-BR` | Português (Brasil) |
| `ru` | Русский |
| `uk` | Українська |
| `zh` | 中文 |

## What is translated, and what is not

Translation covers the chrome you read: the `Type something.` and `Next` sentinel rows,
the footer hint segments (including the collapsed-state line), the Submit picker labels,
the review-tab heading with its submit-readiness prompt and incomplete-answers warning, the
preview pane's empty and notes-affordance lines, the notes header, and the two RPC dialog
prompts. Twenty keys in total, all under the namespace
`@juicesharp/rpiv-ask-user-question`.

Everything the *model* reads stays English by design: the tool description, the parameter
schema descriptions, error messages, and the reserved-label list. Those are prompt inputs,
not UI, and translating them would change model behavior rather than your reading
experience. It also means reserved-label validation compares against fixed English
strings, so `Type something.` is rejected as an authored option label in every locale.

## Adding a language

No code change is required.

1. Copy `locales/en.json` to `locales/<code>.json`, where `<code>` is a locale the SDK
   supports.
2. Translate the values. Keep every key, and keep the placeholders and leading symbols
   (`↑/↓`, `⚠`) intact.
3. Restart Pi and select the language with `/languages`.

The loader iterates the SDK's supported-locale list over this directory at startup, so a
new file is picked up automatically. See the
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) README,
section "Contributing translations", for the full convention.

Keys are looked up individually with an English fallback, so a partially translated file
is safe — untranslated keys render in English rather than blank.
