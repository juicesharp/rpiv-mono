# Configuration reference

Every option
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
reads, where the file lives, and exactly what happens when a value is wrong.

## Where the file lives

The config file is optional. It is resolved in this order:

1. `$XDG_CONFIG_HOME/rpiv-todo/config.json` — used when `XDG_CONFIG_HOME` is set
   to an absolute path. A bare `~` or a leading `~/` is expanded first; a `~user`
   form is not expanded and therefore falls through.
2. `~/.config/rpiv-todo/config.json` — used when `XDG_CONFIG_HOME` is unset,
   empty, whitespace-only, or relative.
3. If the XDG file does not exist, the legacy `~/.config/rpiv-todo/config.json`
   is read anyway, so a pre-XDG file is still found after you set
   `XDG_CONFIG_HOME`. This fallback is one-way: if the XDG file exists but is
   malformed, you get a warning and defaults — it does **not** quietly read the
   legacy file instead.

Both files missing means every default applies. Malformed JSON prints a
`rpiv-config: invalid JSON at …` warning and is treated as `{}`. A JSON array or
a non-object value (`null`, a string, a number, a boolean) is silently treated as
`{}` — no warning.

`rpiv-todo` never writes this file — you create and edit it yourself, and the
extension only reads it.

## Example

```json
{
  "collapseKey": "alt+t",
  "completedTaskVisibility": "session",
  "completedTaskPresentation": "priority",
  "guidance": {
    "promptSnippet": "Use the `todo` tool to track multi-step work before starting it.",
    "promptGuidelines": [
      "Create one task per discrete step.",
      "Mark a task in_progress while working on it; completed when done."
    ]
  }
}
```

## `maxWidgetLines`

**Default `12`.** The content-row budget for the default `"turn"` overlay. The
heading and, on overflow, the `+N more` summary row both count against it. Only
the trailing blank spacer sits outside the budget, so `12` renders up to 13
terminal rows.

- Floor of `3`. A number below `3` falls back to the default.
- A non-number falls back to the default.
- No ceiling.
- Read fresh on every render, so a change takes effect on the next repaint —
  no `/reload`.
- Session `"priority"` normally derives its three-to-five task budget from the
  active terminal height. This option is its fallback only when that height is
  unavailable. Chronological session mode does not apply the row budget.
## `completedTaskVisibility`

**Default `"turn"`.** Controls whether completed rows remain available after the
next agent turn starts.

- `"turn"` keeps the compact-overlay default: a completed row stays visible for
  the remainder of the current turn, then drops from later overlay renders.
- `"session"` retains every task in canonical session state until the session
  ends, the todo list is cleared, or the task is deleted. Presentation controls
  only what the overlay projects, never the underlying task state.
- If a user changes from `"session"` to `"turn"`, the next agent turn hides the
  retained completed rows. The reverse change restores rows that the turn policy
  previously hid.
- A missing, non-string, or unrecognized value falls back to `"turn"`.
- The policy is read at every agent turn, so a change takes effect on the next
  turn without `/reload`.

## `completedTaskPresentation`

**Default `"priority"`.** Controls the overlay projection while completed-task
visibility is `"session"`. A missing, non-string, or unrecognized value falls
back to `"priority"`. The choice is read at every render.

- `"priority"` follows Claude-like terminal behavior: temporarily recent
  completion, then in-progress work, unblocked pending work, blocked pending
  work, and older completion. Items beyond the terminal budget become one
  `… +N` status-counted summary row. It does not register a completed-row
  shortcut.
- `"chronological"` keeps original task order. It shows every pending and
  in-progress row, then folds only an old contiguous completed prefix at the
  top of the list.

## `maxVisibleCompleted`

**Default `5`.** In `"chronological"` session mode, the number of newest rows
kept expanded within the contiguous completed prefix at the top of the todo
list. When that prefix is longer, the older rows become one expandable
`▶ N completed` row in the same list position. A completed task after an
unfinished task never moves or joins that folded prefix.

- `0` folds the whole completed prefix.
- A negative number, fractional number, non-number, or unsafe integer falls back
  to the default.
- The value is read on every render, so a change takes effect on the next repaint
  without `/reload`.
- This setting applies only when visibility is `"session"` and presentation is
  `"chronological"`.

## `completedCollapseKey`

**Default `"ctrl+shift+c"`.** The shortcut that expands and folds the older
completed prefix in `"chronological"` session mode. The collapsed row shows the
currently configured key as its expansion hint.

- The value uses the same strict Pi keybinding grammar as `collapseKey`. Missing,
  blank, non-string, and invalid values fall back to the default.
- `"off"` disables completed-row folding and leaves every completed row expanded.
- It must not equal `collapseKey`. A collision registers only the whole-panel
  shortcut, writes a warning, and leaves every completed row expanded.
- The binding is resolved once at extension load. Run `/reload` after editing it
  or after switching presentation to `"chronological"`; priority mode never
  registers this shortcut.

## `collapseKey`
**Default `"ctrl+shift+t"`.** The shortcut that collapses and expands the
overlay.

The value is trimmed and lowercased, then matched against Pi's keybinding
grammar: zero or more distinct modifiers joined by `+`, then a base key.

| Part | Accepted |
| --- | --- |
| Modifiers | `ctrl`, `shift`, `alt`, `super` — each at most once |
| Base key | one printable character (`a`, `7`, `]`, `/`, …) |
| Base key | a named key: `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `f1`–`f12` |

Examples: `alt+o`, `ctrl+shift+t`, `super+alt+f5`.

- A missing, empty, blank, non-string, or ungrammatical value falls back to the
  default. The grammar is checked strictly on purpose: Pi takes the last `+`-part
  as the base key and ignores unknown parts, so a typo like `ctr+]` would
  otherwise capture every bare `]` keypress globally.
- `"off"` disables the feature — no shortcut is registered at all.
- The binding is resolved **once at extension load**. After editing this value,
  run `/reload` to rebind; until you do, the old key stays active even though the
  collapsed panel's hint text (which is resolved per render) already shows the
  new one.

## Guidance

`guidance.promptSnippet` (string) and `guidance.promptGuidelines` (array of
strings) replace the prompt copy the `todo` tool advertises to the model. Both
are absent by default, in which case the built-in snippet and the eight built-in
guideline bullets are used.

- `promptSnippet` must be a non-empty string; an empty string or a wrong type
  falls back to the default.
- `promptGuidelines` must be a non-empty array of non-empty strings. A non-array,
  or an array containing an empty string, falls back to the default — the array
  is all-or-nothing, not merged item by item.
- Both are read at extension load, so `/reload` after editing them.

## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Relocates the config directory, as described above. |
| `HOME` | Anchors `~/.config` when `XDG_CONFIG_HOME` does not apply. |

`rpiv-todo` reads no environment variables of its own. If you have
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
installed, that package has its own locale configuration and its own env-var
chain — see its README.
