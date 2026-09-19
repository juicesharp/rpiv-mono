# @juicesharp/rpiv-ask-user-question

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover: a tabbed terminal questionnaire asking Which real development task are we planning right now?, with numbered options — Bug fix, New feature, Refactor — each under a one-line description, and a footer of key hints" width="50%">
  </a>
</div>

Let the model ask you instead of guessing. This extension gives [Pi Agent](https://github.com/badlogic/pi-mono) one tool — `ask_user_question` — that opens a terminal dialog of up to four questions with written-out options, and hands your choices back as structured data. Install it if you would rather spend fifteen seconds picking than an hour undoing a wrong assumption.

## Install

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart your Pi session.

## Quick start

Nothing to set up — the tool is live as soon as Pi restarts. Hand the model a task with a real decision buried in it:

> Add caching to the API client.

Rather than picking a strategy on your behalf, the model calls `ask_user_question` and a dialog takes over the bottom of your terminal. Move with `↑`/`↓`, choose with `Enter`, press `n` to attach a note to a question — or a global note to the whole questionnaire from the Submit tab — or land on the `Type something.` row to answer in your own words. While typing, `Shift+Enter` adds a line, `Ctrl+G` opens Pi's configured external editor, and `Ctrl+U` clears the draft; browsing another option and returning keeps what you wrote. `Esc` abandons the questionnaire entirely.

When the questionnaire begins waiting in an interactive TTY, it emits one standard terminal BEL (`\x07`). Your terminal configuration determines whether that appears as an audible alert, a visual alert, or nothing; redirected and non-TTY output is untouched.

![Single question in the dialog: the tab strip reads Feature Type, Design Tab, Testing, Release, Submit; the question Which real development task are we planning right now? sits above four numbered options — Bug fix (Recommended), New feature, Refactor, Perf tuning — each with a one-line description, followed by the appended Type something. row](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg)

When the model asks several things at once, `Tab` moves between them and a Submit tab reviews everything before it goes back:

![Submit tab of a four-question dialog: a Review your answers list showing Feature Type set to Bug fix and Testing set to Unit tests plus Integration tests, a warning naming Design Tab and Release as still unanswered, a picker offering Submit answers or Cancel, and a dim bottom key-hint row including n to add a note](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg)

## What you get

- **Typed options instead of a wall of prose** — each question carries 2-4 authored choices, and every choice comes with a description of what it means or what it costs you.
- **You can always answer in your own words** — a `Type something.` row is appended to every question, single- or multi-select, widens to the full pane while you type, keeps its multiline draft visible in that row while you browse, and supports Pi's `Shift+Enter` newline and `Ctrl+G` external-editor flows.
- **Compare real artifacts, not just labels** — an option can carry a markdown `preview` (ASCII mockup, code, diagram, config) that renders in a bordered box beside the option list.
- **One interruption, not five** — up to four questions arrive in a single tabbed dialog, and the Submit tab lists your answers and names anything still blank before you commit.
- **Notes on any answer — or on all of them** — `n` opens a multiline note editor on any question tab, and on the Submit tab it opens one global note for the whole questionnaire. Per-question notes reach the model as `user notes: <text>`, the global note as `global note: <text>`; neither marks a question answered.
- **Read the transcript behind the dialog** — `Ctrl+]` collapses the overlay so you can scroll the conversation, then brings it back with your answers intact.
- **Works outside the terminal too** — in RPC and ACP hosts such as the VS Code pendant or Zed the questionnaire walks through the host's native dialogs (notes are terminal-only and do not carry over). In non-interactive runs the tool is normally removed; it remains available only when you explicitly enable Jev auto-answer.

## Configuration

Optional. Settings live in `~/.config/rpiv-ask-user-question/config.json`. The package reads this file and writes it only when `/ask-user-auto-answer on|off` persists your opt-in choice.

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog. Accepts Pi keybinding ids such as `alt+o`; `"off"` disables the shortcut. | `"ctrl+]"` |
| `guidance.description` | Full replacement for the tool description the model sees. A non-empty string replaces the built-in text entirely — no merging. | built-in description |
| `guidance.promptSnippet` | One-line description of the tool in the system prompt — tune how eagerly the model asks. | built-in snippet |
| `guidance.promptGuidelines` | Usage guidelines given to the model, as a list of strings. | 5 built-in guidelines |
| `jev.autoAnswer` | Opt in to TypeSafe Jev answering instead of showing the questionnaire when every answer is confident enough. | `false` |
| `jev.model` | TypeSafe model id or alias. | `"jev-latest"` |
| `jev.minConfidence` | Inclusive `0..1` confidence/certainty floor; an answer below it falls back to the human UI. | `0.5` |

```json
{
  "collapseKey": "alt+o",
  "jev": { "autoAnswer": false, "model": "jev-latest", "minConfidence": 0.5 }
}
```

Use `/ask-user-auto-answer on`, `off`, or `status` to persist or inspect the opt-in. When enabled, the model must supply a top-level `state` string containing only the bounded facts needed for the questions. The extension sends that string plus the question and option text to TypeSafe; it never copies the conversation automatically, and option previews are not sent. Single-select questions use Choice. Every option of a multi-select question uses an independent Noul in the same request; `noul >= 0.5` selects it, while `jev.minConfidence` applies to `abs(noul - 0.5) * 2`.

A missing API key, unavailable SDK/service, malformed response, missing state, or low-confidence answer falls back to the normal human UI. Without UI, the call instead returns an explicit error saying that the user never saw the questions. Automated result text says that **Jev**, not the user, answered.

Malformed JSON falls back to the defaults with a warning; an individual unusable value is silently dropped back to its default. Never an error.

## Reference

- [Tool schema](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/tool-schema.md) — parameters, limits, reserved labels, validation errors, the result envelope, and the `rpiv:ask-user:prompt` event.
- [Keyboard and layout](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/keyboard.md) — every key, the rows the dialog appends, notes, collapse mode, and how previews and overflow adapt to terminal size.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/configuration.md) — file lookup and `XDG_CONFIG_HOME`, the `collapseKey` grammar, the `guidance.*` prompt overrides, and how invalid values are handled.
- [Hosts and runtime behavior](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/hosts.md) — terminal vs RPC vs non-interactive, what degrades in each, and the load-failure envelopes.
- [Localization](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/localization.md) — the nine shipped languages, how the locale is chosen, and how to add one.

## Requirements

- Node.js 22 or newer.
- Pi Agent. An interactive terminal or RPC/ACP host is required for the default human flow; non-interactive runs see the tool only while Jev auto-answer is enabled.
- `TYPESAFE_API_KEY` when Jev auto-answer is enabled. TypeSafe's optional `TYPESAFE_BASE_URL` and `TYPESAFE_LOG_LEVEL` remain supported by its SDK; `jev.model` explicitly selects the model for these requests.
- A terminal at least 100 columns wide for side-by-side previews; narrower terminals stack the preview under the options.

The default, disabled mode makes no external model request.

## Troubleshooting

**The model says the questionnaire UI failed to load and asks its questions as chat text.** The dialog's modules were replaced on disk while Pi was running, usually by a package-manager install touching the store. Repair the install if it is broken, then restart Pi; the failure is not recoverable inside the running process.

**`Ctrl+]` does nothing.** On keyboard layouts where `]` sits on the shifted layer (Latin American among them) the default is unreachable. Set `collapseKey` to something you can type, for example `"alt+o"`.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — optional; installing it renders the dialog chrome in your language and adds `/languages`.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — the umbrella package whose workflow skills use `ask_user_question` as their developer checkpoint. `/rpiv-setup` offers to install this extension.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/LICENSE).
