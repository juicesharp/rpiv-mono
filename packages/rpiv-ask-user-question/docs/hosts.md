# Hosts and runtime behavior

Where the questionnaire renders, what it degrades to, and what happens when it cannot
render at all.

## Three environments

| Environment | What the model sees | What you see |
| --- | --- | --- |
| Interactive terminal | `ask_user_question` in its tool list | The full tabbed TUI overlay |
| RPC / ACP host (VS Code pendant, Zed, Paseo) | `ask_user_question` in its tool list | A sequence of the host's own native select and input dialogs |
| Non-interactive run (no UI) | Nothing — the tool is removed | Nothing |

### Non-interactive runs

A `before_agent_start` hook reconciles the active tool set against `ctx.hasUI` before every
turn. When there is no UI, `ask_user_question` is stripped from the list so the model never
sees a tool it cannot use — better than offering it and auto-declining every call. When UI
comes back, the tool is restored. The reconciler is idempotent and leaves sibling tools
untouched.

A second guard lives inside the tool handler as a one-turn backstop: if a call somehow
arrives without UI, it returns `error: "no_ui"` and the text
`Error: UI not available (running in non-interactive mode)`.

### RPC and ACP hosts

RPC hosts report `hasUI: true` because Pi's dialog sub-protocol works there, but custom
terminal UI does not render. The package detects this two ways: hosts that advertise
`ctx.mode === "rpc"` route straight to the dialog walker, skipping the TUI import
entirely, and older RPC builds are caught by a backstop when custom UI resolves without
rendering anything. Either path requires the host to expose both `select` and `input`.

The walker asks one question per dialog and returns exactly the same result envelope the
TUI produces. Trade-offs inherent to the native primitives:

- No side-by-side preview pane. Previews are folded into the dialog title instead,
  truncated at 600 characters each.
- No tab bar and no Submit review tab — one dialog per question, in order.
- Multi-select is a free-text input: type the option numbers, comma-separated
  (`1,3`). Any token that is not a valid option index is treated as a typed custom answer,
  which is how the `Type something.` escape survives. An empty input commits an empty
  selection, matching `Next` with nothing toggled.
- Dismissing any dialog cancels the whole questionnaire, mirroring `Esc` in the TUI.

If the host can render neither custom UI nor dialogs, the call returns
`error: "no_custom_ui"` with text telling the model the user never saw the questions and
that it should ask them as plain chat text instead — explicitly not a decline.

## Conditional surfaces

Some parts of the dialog exist only under the right conditions:

| Surface | Appears when |
| --- | --- |
| Tab bar and Submit tab | The call carries more than one question |
| `Next` row | The question is multi-select |
| `Type something.` row | Always |
| Side-by-side preview | An option carries a `preview`, and terminal and pane are both ≥ 100 columns |
| Preview pane at all | Single-select questions only |
| Collapse shortcut | `collapseKey` is not `"off"` and the host exposes raw terminal input |
| Localized chrome | `@juicesharp/rpiv-i18n` is installed |

## Loading and startup cost

The dialog's render graph costs roughly 560 ms to import, so it is loaded lazily — on the
first tool call, not when the extension registers. To keep that first call fast and safe,
the graph is also pre-warmed in the background two seconds after startup. The pre-warm
timer is unref'd, so it never holds a process open, and a failed pre-warm is swallowed:
the first real call re-imports and reports properly.

The pre-warm exists for a specific failure. Pi's module loader registers a module in its
graph cache *before* evaluating it and does not evict it if evaluation throws. If your
package manager replaces the dependency store while Pi is running, one failed import can
poison the cache for the rest of the process. Evaluating the graph early, while the paths
Pi resolved at boot still exist, keeps it in memory for the process lifetime and makes
that unreachable.

When it does happen, you get a structured envelope rather than a raw `TypeError`:

| `error` | Meaning | Fix |
| --- | --- | --- |
| `session_load_failed` | The dialog module could not be imported. | Repair the install if needed, then restart Pi. |
| `stale_module_cache` | The module cache went stale after an earlier failed import. | Restart Pi — this is unrecoverable in the running process. |

Both messages tell the model the questions were never shown and to ask them as plain chat
text instead of treating the failure as a decline.
