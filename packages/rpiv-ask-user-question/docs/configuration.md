# Configuration

Every setting the package reads, where the file lives, and what happens when a value is
wrong.

## The config file

```
~/.config/rpiv-ask-user-question/config.json
```

The file is optional — with no config at all, every setting takes its default. The
package reads it at startup and before Jev calls. `/ask-user-auto-answer on|off` writes
only the `jev.autoAnswer` value while preserving the other fields; the shared config
writer creates the file when needed and applies owner-only permissions when the
filesystem supports them.

A complete example:

```json
{
  "collapseKey": "alt+o",
  "jev": {
    "autoAnswer": false,
    "model": "jev-latest",
    "minConfidence": 0.5
  },
  "guidance": {
    "description": "Ask the user structured questions whenever requirements are ambiguous.",
    "promptSnippet": "Ask me before guessing on anything ambiguous",
    "promptGuidelines": [
      "Batch every clarifying question into one ask_user_question call.",
      "Put your recommended option first and suffix it with (Recommended)."
    ]
  }
}
```

### Where the file is looked up

1. `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`, if `XDG_CONFIG_HOME` is set,
   non-empty and absolute. A leading `~` is expanded first; a relative value is ignored.
   Unset or ignored, the directory falls back to `~/.config`.
2. If that file does not exist, the legacy path `~/.config/rpiv-ask-user-question/config.json`
   is read. This path deliberately ignores `XDG_CONFIG_HOME`, so an existing config keeps
   working after you set the variable.
3. Neither present: all defaults.

If the XDG-path file exists, its result wins even when it is malformed — there is no
second chance at the legacy path.

### When the file is invalid

Malformed JSON is not fatal. The loader warns on stderr and continues with defaults:

```
rpiv-config: invalid JSON at <path>, using default ({}) — <parser message>
```

Valid JSON that is not an object (a string, number, `null`, or an array) is rejected too,
falling back to defaults — but silently, with no warning. Individual keys with the wrong
type are likewise dropped back to their default without a warning.

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog overlay. | `"ctrl+]"` |
| `guidance.description` | Full text of the tool description the model sees. Replaces the built-in default entirely — no merging. | built-in description |
| `guidance.promptSnippet` | One-line snippet describing the tool in the system prompt. | built-in snippet |
| `guidance.promptGuidelines` | List of usage guidelines given to the model. | 5 built-in guidelines |
| `jev.autoAnswer` | Persisted, user-owned opt-in for TypeSafe Jev auto-answer. Only the boolean `true` enables it. | `false` |
| `jev.model` | TypeSafe model id or alias used for System One requests. | `"jev-latest"` |
| `jev.minConfidence` | Inclusive confidence/certainty floor from `0` to `1`. | `0.5` |

### `collapseKey`

The value uses Pi's keybinding id format: zero or more distinct modifiers from `ctrl`,
`shift`, `alt`, `super`, joined by `+`, followed by a base key. Values are trimmed and
lowercased before matching.

The base key is either a single printable character from
`a-z 0-9 _ - ! @ # $ % ^ & * ( ) | ~ \` ' " : ; , . / < > ? [ ] { } = \`, or one of the
named keys `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`,
`insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`,
`f1`–`f12`.

Examples that work: `"ctrl+]"`, `"alt+o"`, `"ctrl+shift+h"`, `"f9"`, `"ctrl+}"`.

Set `"off"` (any casing) to disable the collapse shortcut entirely — no raw terminal
listener is registered in that case.

A spec that does not match the grammar is rejected and the default is used. This is
strict on purpose: Pi's parser takes the last `+`-separated part as the key and ignores
unknown parts, so a typo like `"ctr+]"` would otherwise silently capture every bare `]`
keypress at the terminal level.

The footer hint inside the dialog names whatever key you configure (`Alt+O to collapse`
for `"alt+o"`), as do the collapsed one-line footer and the one-shot notification shown
when the dialog is first hidden. With `"off"` the collapse hint is dropped from the
footer entirely, since no shortcut can fire.

### `guidance.description`, `guidance.promptSnippet` and `guidance.promptGuidelines`

`guidance.description` replaces the entire built-in description Pi registers for the
`ask_user_question` tool — the text the model reads when deciding how to use it. There is
no merging: a valid value wins wholesale. It is used only when it is a non-empty string;
anything else falls back to the built-in default. Like the other guidance fields it is read
once, when the extension registers the tool, so changes take effect on the next Pi restart.

These replace the text Pi puts in the system prompt about when to reach for
`ask_user_question`. Use them to make the model ask more or less often, or to enforce a
house style for options.

`promptSnippet` is used only when it is a non-empty string. `promptGuidelines` is used
only when it is a non-empty array whose entries are all non-empty strings. Anything else
falls back to the built-in defaults. Both are read once, when the extension registers the
tool, so changes take effect on the next Pi restart.

### `jev.*` and `/ask-user-auto-answer`

Jev auto-answer is disabled unless `jev.autoAnswer` is exactly `true`. You can edit the
file or use the registered slash command:

- `/ask-user-auto-answer on` persists the opt-in and updates the current session.
- `/ask-user-auto-answer off` persists the opt-out and restores the normal host behavior.
- `/ask-user-auto-answer status` reports the current session value without writing.

When enabled, `ask_user_question` evaluates the call's explicit top-level `state` string.
The caller is instructed to include only the bounded facts needed to answer that batch;
the extension never reads or copies conversation history into the request. TypeSafe also
receives question text plus option labels and descriptions. Preview markdown is not sent.
Do not put secrets in `state`, questions, labels, or descriptions unless they may be sent
to the configured TypeSafe endpoint.

Every single-select question becomes one Choice. Every option of a multi-select question
becomes one Noul, and all Choice and Noul questions are sent in one System One request.
A Noul probability of at least `0.5` selects its option. Since Noul has no separate
confidence field, its certainty is `abs(probability - 0.5) * 2`; the least-certain option
must meet `jev.minConfidence`. Each Choice confidence must meet the same inclusive floor.
Blank models and non-finite or out-of-range confidence values use the defaults.

Missing/blank state, SDK or service errors, malformed responses, and sub-threshold results
all fall back to the unchanged human questionnaire when UI exists. Without UI, the call
returns an explicit structured error and says the user never saw the questions. Successful
automated results are labeled as Jev answers and include model, probability/confidence,
and token-usage metadata; they are never attributed to the user.

## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Relocates the config directory, as described above. Must be absolute. |
| `TYPESAFE_API_KEY` | Required by the dynamically loaded TypeSafe SDK when auto-answer is enabled. |
| `TYPESAFE_BASE_URL` | Optional TypeSafe API root override. |
| `TYPESAFE_LOG_LEVEL` | Optional TypeSafe SDK logging level. Request bodies can contain the explicit state; avoid debug logging when it is sensitive. |

`LANG` and `LC_ALL` influence the dialog language, but they are read by
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) rather than
by this package — see [localization.md](./localization.md). The TypeSafe variables are read
by `@typesafe-ai/sdk`, which is dynamically loaded only after the user has enabled
auto-answer and a tool call reaches that path.
