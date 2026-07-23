# rpiv-advisor configuration

Complete reference for `advisor.json` — where it lives, every key it accepts, and how the per-executor blocklist is evaluated.

## Where the file lives

`advisor.json` resolves under the XDG config directory:

| `XDG_CONFIG_HOME` | Resolved path |
| --- | --- |
| unset, empty, or whitespace-only | `~/.config/rpiv-advisor/advisor.json` |
| absolute path | `$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` |
| `~` or `~/…` | tilde expanded, then used as the config dir |
| relative path | ignored → `~/.config/rpiv-advisor/advisor.json` |
| `~user/…` | not expanded → `~/.config/rpiv-advisor/advisor.json` |

`XDG_CONFIG_HOME` is the only environment variable this package reads.

**Legacy read fallback.** If nothing exists at the XDG-resolved path, reads fall
back once to `~/.config/rpiv-advisor/advisor.json` (always `~/.config`, ignoring
`XDG_CONFIG_HOME`). If the XDG path *does* exist, it wins — even when it is
malformed. **Writes always go to the XDG-resolved path only**; there is no
migration or copy of the legacy file.

A missing or malformed file is treated as `{}` — malformed JSON logs a warning
and never crashes the extension.

## File permissions

`/advisor` writes the file with `JSON.stringify(config, null, 2)` plus a
trailing newline, creating parent directories as needed, then chmods it to
`0600` on a best-effort basis. A failed chmod does not fail the save; on Windows
the chmod is a no-op.

Saving happens **before** any in-memory state changes. If the write fails you
get `Failed to save advisor selection — selection not persisted` and both the
previous selection and the active tool list are left untouched.

## Keys

| Key | Type | Default | Written by |
| --- | --- | --- | --- |
| `modelKey` | `string` — `"provider/modelId"` | absent (advisor off) | `/advisor` |
| `effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | absent (no `reasoning` sent) | `/advisor` effort picker |
| `disabledForModels` | `(string \| { model, minEffort? })[]` | `[]` | hand-edited |
| `guidance.promptSnippet` | `string` | built-in snippet | hand-edited |
| `guidance.promptGuidelines` | `string[]` | six built-in guidelines | hand-edited |

`/advisor` only ever writes `modelKey` and `effort`; `guidance` and
`disabledForModels` are preserved across saves, so hand-edits survive.

### `modelKey`

The canonical persisted form is slash-separated — `anthropic/claude-opus-4-5`.
Reads also accept the legacy colon form (`anthropic:claude-opus-4-5`); when both
forms are present the slash form wins. A colon-form key is rewritten to slash
form the next time you save through `/advisor`.

### `effort`

Offered only for models whose registry entry reports reasoning support. The
picker lists `off`, `minimal`, `low`, `medium`, `high`, and adds `xhigh` when
the picked model supports it. `high` is marked `(recommended)`. Choosing `off`
deletes the key, and no `reasoning` parameter is sent with the advisor call.

`EFFORT_ORDINAL`, lowest to highest, is `minimal`, `low`, `medium`, `high`,
`xhigh`. This ordering is what `minEffort` compares against.

### `disabledForModels`

A list of **executor** models for which the advisor tool should be stripped —
useful when you are already driving a top-tier model and do not want to pay for
a second opinion. Two entry forms:

```json
{
  "modelKey": "anthropic/claude-opus-4-5",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

- **String entry** — blocks at any reasoning effort.
- **Object entry without `minEffort`** — blocks at any reasoning effort.
- **Object entry with `minEffort`** — blocks when the executor's current effort
  is at or above the threshold in `EFFORT_ORDINAL`. Ties block.
- An executor effort of `off` or unset never matches a `minEffort` entry.

Entry keys are canonicalised to slash form before comparison, so a legacy
`"anthropic:claude-opus-4-5"` entry still blocks without a re-save.

**Validation.** A non-array value becomes `[]`. Empty strings are dropped.
Object entries need a non-empty string `model`; an unrecognised `minEffort`
drops the entry. `null`, numbers, booleans and `undefined` are dropped. The
order of surviving entries is preserved.

**Live re-evaluation.** The blocklist is re-applied on `session_start`, on every
turn, whenever you switch executor model, and whenever you change reasoning
effort — so the tool strips and re-adds mid-session as you move around. You see
`Advisor disabled for <provider/model>` when it strips and
`Advisor restored: <label>[, <effort>]` when it comes back.

### `guidance`

Overrides what the executor model is told about *when* to escalate, without
forking the package.

- `guidance.promptSnippet` — a non-empty string replacing the one-line snippet
  that appears in the system prompt.
- `guidance.promptGuidelines` — a non-empty array of non-empty strings replacing
  the six built-in guidelines.

Either field falls back to its built-in default when absent, empty, or the wrong
type. Both are read once at extension load, so restart your Pi session after
editing them.

The built-in guidelines tell the model to call `advisor` before substantive
work, again when it believes the task is complete (after making the deliverable
durable), and when it is stuck or considering a change of approach; to weight
the advice seriously unless empirically contradicted; and to reconcile
conflicting evidence with one more `advisor` call rather than silently switching.

## Notifications

| String | When |
| --- | --- |
| `Advisor: <label>[, <effort>]` | you selected a model with `/advisor` |
| `Advisor: <label>[, <effort>] (inactive for current executor)` | selected, but blocked by `disabledForModels` |
| `Advisor restored: <label>[, <effort>]` | re-applied at session start, or unblocked mid-session |
| `Advisor restored: <label>[, <effort>] (inactive for current executor)` | restored while blocked |
| `Advisor disabled` | you chose **No advisor** |
| `Advisor disabled for <provider/model>` | you switched to a blocklisted executor model or effort |
| `Advisor selection not found: <choice>` | the model you picked was no longer in the available-model list when `/advisor` resolved the choice |
| `Previously configured advisor model <key> is no longer available` | the saved model left Pi's registry |
| `Failed to save advisor selection — selection not persisted` | the write to `advisor.json` failed |
| `/advisor requires interactive mode` | `/advisor` ran without a TTY |

The `Advisor restored: …` announcement fires at most once per process, so
programmatic session spawns (workflow stages, subagents) do not repeat it.
