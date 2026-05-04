# rpiv-ask-user-question

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover" width="50%">
    </picture>
  </a>
</div>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Let the model ask you structured clarifying questions instead of guessing. `rpiv-ask-user-question` adds the `ask_user_question` tool to [Pi Agent](https://github.com/badlogic/pi-mono) - a tabbed dialog with single- and multi-select questions, side-by-side previews, per-option notes, and a Submit tab that reviews answers before they go back to the model.

![Side-by-side code preview](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/code-preview.jpg)

## Features

- **Multi-question dialogs** - ask several questions in one turn with a tab bar (`Tab` to switch).
- **Preview pane** - render an ASCII diagram, code snippet, or markdown next to each option, side-by-side or stacked depending on terminal width.
- **Per-option notes** - press `n` on a previewed option to attach a free-text note that travels back with the answer.
- **Multi-select questions** - checkboxes with `Space` to toggle, Enter-as-toggle on rows, a `Next` sentinel to advance, and toggles persisted across tab switches.
- **Submit tab** - review every answer before submitting; warns about unanswered questions and offers a Submit picker.
- **Chat row on every tab** - redirect the conversation without leaving the dialog.
- **"Other" free-text fallback** - type a custom answer when no option fits.
- **Localized UI** - sentinel rows, hints, submit/cancel labels, review pane, and notes affordance display in the user's chosen language via `@juicesharp/rpiv-i18n`. Ships Deutsch / English / Español / Français / Português (PT) / Português (BR) / Русский / Українська; switch with `/languages` or `pi --locale <code>`. LLM-facing copy (tool description, schemas, errors) stays English by design.

## Screens

| | |
|---|---|
| ![Single-question dialog](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg) | ![Multi-tab + ASCII preview](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/multi-tab-preview.jpg) |
| ![Multi-select with checkboxes](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/multi-select.jpg) | ![Submit tab review](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg) |
| ![Localized UI - German](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/localized-german-ui.jpg) | |

## Install

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

Then restart your Pi session.

### Optional: localization

`rpiv-ask-user-question` works standalone - install only this package and you get the full English UI. Install `@juicesharp/rpiv-i18n` alongside it to flip sentinel labels, dialog hints, review-tab heading, and chat-summary lines to your active locale:

```bash
pi install npm:@juicesharp/rpiv-i18n
```

With the SDK present, locale resolves from `--locale <code>` → `~/.config/rpiv-i18n/locale.json` → `LANG` / `LC_ALL` → English. The `/languages` interactive picker and `pi --locale <code>` startup flag are also enabled. Without the SDK, the dialog stays online and renders English at every call site - no warning, no crash. Users who installed via `pi install npm:@juicesharp/rpiv-pi` + `/rpiv-setup` get the SDK automatically.

## Tool

- **`ask_user_question`** - present one or more structured questions, each with 2+ options, optional `multiSelect`, optional per-option `preview`, and an optional free-text "Other" fallback. Returns the user's selection(s) plus any notes. See the tool's `promptGuidelines` for usage policy.

### Schema

```ts
ask_user_question({
  questions: [
    {
      question: string,            // full question text, ends with "?"
      header: string,              // chip label, max 12 chars
      options: [
        {
          label: string,           // 1-5 words, max 60 chars
          description: string,     // explains the choice / its trade-off
          preview?: string,        // optional markdown shown next to options
        },
        // … 2-4 options total
      ],
      multiSelect?: boolean,       // default false
    },
    // … 1-4 questions total
  ]
})
```

Reserved option labels (rejected at validation): `"Other"`, plus the runtime sentinels (`"Type something."`, `"Chat about this"`, `"Next →"`).

Returns:

```ts
{
  content: [{ type: "text", text: string }], // human-readable envelope or DECLINE_MESSAGE
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "chat" | "multi",
      answer: string | null,
      selected?: string[],         // present for multi-select
      notes?: string,              // free-text note, when typed
      preview?: string,            // echoed back when option carried a preview
    }>,
    cancelled: boolean,
    error?: "no_ui" | "no_questions" | "empty_options" | "too_many_questions"
          | "duplicate_question" | "duplicate_option_label" | "reserved_label",
  }
}
```

## License

MIT
