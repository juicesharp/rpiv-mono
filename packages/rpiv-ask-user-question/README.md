# rpiv-ask-user-question

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Let the model ask you structured clarifying questions instead of guessing. `rpiv-ask-user-question` adds the `ask_user_question` tool to [Pi Agent](https://github.com/badlogic/pi-mono) — a tabbed dialog with single- and multi-select questions, side-by-side previews, per-option notes, and a Submit tab that reviews answers before they go back to the model.

![Side-by-side code preview](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/code-preview.jpg)

## Features

- **Multi-question dialogs** — ask several questions in one turn with a tab bar (`Tab` to switch).
- **Preview pane** — render an ASCII diagram, code snippet, or markdown next to each option, side-by-side or stacked depending on terminal width.
- **Per-option notes** — press `n` on a previewed option to attach a free-text note that travels back with the answer.
- **Multi-select questions** — checkboxes with `Space` to toggle, Enter-as-toggle on rows, a `Next` sentinel to advance, and toggles persisted across tab switches.
- **Submit tab** — review every answer before submitting; warns about unanswered questions and offers a Submit picker.
- **Chat row on every tab** — redirect the conversation without leaving the dialog.
- **"Other" free-text fallback** — type a custom answer when no option fits.

## Screens

| | |
|---|---|
| ![Single-question dialog](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg) | ![Multi-tab + ASCII preview](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/multi-tab-preview.jpg) |
| ![Multi-select with checkboxes](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/multi-select.jpg) | ![Submit tab review](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg) |

## Install

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

Then restart your Pi session.

## Tool

- **`ask_user_question`** — present one or more structured questions, each with 2+ options, optional `multiSelect`, optional per-option `preview`, and an optional free-text "Other" fallback. Returns the user's selection(s) plus any notes. See the tool's `promptGuidelines` for usage policy.

## License

MIT
