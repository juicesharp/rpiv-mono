# rpiv-warp

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-warp">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-warp/docs/cover.png" alt="rpiv-warp cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-warp.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-warp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Native [Warp terminal](https://www.warp.dev/) toasts for [Pi Agent](https://github.com/badlogic/pi-mono) lifecycle events. When Pi finishes a long task, asks for your input, or completes a turn, `rpiv-warp` emits Warp's `OSC 777` escape sequence and Warp surfaces a native OS notification. Outside Warp it does nothing — install it everywhere, it only fires where it's useful.

## Install

```bash
pi install npm:@juicesharp/rpiv-warp
```

`rpiv-warp` is **opt-in** — it is NOT auto-installed by `/rpiv-setup`. Install it explicitly only if you use Warp.

## What you get

| Pi event | Warp toast |
|---|---|
| `session_start` (startup only) | "Pi Agent active — notifications enabled." |
| `agent_end` | last user prompt → last assistant reply (truncated 200 chars) |
| `tool_call` (when Pi calls `ask_user_question`) | "Input needed" |
| `turn_end` | last tool name of the turn |

`session_start` is filtered to `reason === "startup"` only — `/new`, `/resume`, `/fork`, `/reload` do NOT emit (you're already looking at the terminal in those cases).

## Detection

`rpiv-warp` reads three environment variables Warp sets automatically:

- `TERM_PROGRAM === "WarpTerminal"` — required. Outside Warp the extension is a no-op.
- `WARP_CLI_AGENT_PROTOCOL_VERSION` — required for structured emission. If unset, `rpiv-warp` does nothing rather than falling back to a less-rich legacy format.
- `WARP_CLIENT_VERSION` — used for broken-version gating. A short list of known-broken Warp builds (per release channel) suppresses emission until Warp ships a fix.

## Edge cases

| Case | Behavior |
|---|---|
| Not in Warp (`TERM_PROGRAM !== "WarpTerminal"`) | Silent no-op — extension loads, every handler short-circuits |
| Pi in print mode (`pi -p "..."`) | **Toasts still fire** — print mode emits all four events at the agent layer |
| `/dev/tty` unreachable (cron, no-tty SSH) | Silent no-op — `try/catch` around `openSync` |
| Windows | Silent no-op — `/dev/tty` doesn't exist; ConPTY support is future work |
| Known-broken Warp build | Silent no-op — broken-version table gates emission per channel |

## Why standalone (not a sibling)

`rpiv-warp` is intentionally NOT registered in `rpiv-pi`'s sibling list. Not every Pi user uses Warp — auto-installing it everywhere would impose Warp-specific code on every install. If you don't use Warp, don't install it. If you do, install it explicitly. The package still joins the rpiv-mono lockstep version + shared release pipeline.

## License

MIT — see [LICENSE](./LICENSE).
