# Detection and edge cases

How `rpiv-warp` decides whether to emit anything at all, and exactly what it does
in every environment where it cannot.

## The gate

`rpiv-warp` checks the environment once, at registration. If the check fails it
returns immediately — **zero** handlers are subscribed, no timers are armed, and
nothing is ever written. There is no partial mode.

Both of these must hold:

1. `TERM_PROGRAM === "WarpTerminal"`
2. `WARP_CLI_AGENT_PROTOCOL_VERSION` is set to a non-empty string, **and**
   `WARP_CLIENT_VERSION` is not a known-broken build

Warp sets all three variables itself. You never set them by hand.

## Environment variables

| Variable | Read for | Behavior |
| --- | --- | --- |
| `TERM_PROGRAM` | terminal identification | Must equal exactly `"WarpTerminal"`. Anything else — iTerm2, Ghostty, VS Code, a bare SSH session — is a total no-op. |
| `WARP_CLI_AGENT_PROTOCOL_VERSION` | structured protocol support | Any non-empty value enables emission. Unset means the extension does nothing rather than falling back to a less-rich legacy format. |
| `WARP_CLIENT_VERSION` | broken-build gating | Parsed and compared against a per-channel threshold. An unparseable value is treated as fine and emission proceeds. |
| `XDG_CONFIG_HOME` | config file location | Relocates the config directory. See the [Configuration](../README.md#configuration) section. |

All three Warp variables are read fresh on every call — nothing is cached at
module level.

## Protocol negotiation

The version written into every payload's `v` field is
`min(WARP_CLI_AGENT_PROTOCOL_VERSION, 1)`, where `1` is the highest protocol this
extension speaks. Clamping client-side means an older Warp that only understands
`v: 1` keeps seeing `v: 1` even after the plugin's ceiling is raised. A missing,
empty or unparseable environment value falls back to `1`.

## Broken-build gating

Some Warp builds advertise structured-protocol support but render the
notifications behind a feature flag. Emission is suppressed for builds at or
below the last known-broken build on their channel:

| Channel | Last broken build |
| --- | --- |
| `stable` | `v0.2026.3.25.8.24.stable_5` |
| `preview` | `v0.2026.3.25.8.24.preview_5` |
| `dev` | never gated |

Version literals follow the grammar `v0.YYYY.M.D.H.M.(stable|preview|dev)_N`.
Comparison is element-wise and inclusive — a build equal to the threshold is
gated. Upgrading Warp clears the gate; there is nothing to configure.

## Edge cases

| Situation | Behavior |
| --- | --- |
| Not running in Warp | Silent no-op. No handlers registered, nothing written, no measurable cost. Install it everywhere. |
| Known-broken Warp build | Silent no-op, per the table above. |
| `WARP_CLI_AGENT_PROTOCOL_VERSION` unset | Silent no-op. No legacy fallback format. |
| `/dev/tty` unopenable (cron, no-TTY SSH) | Every write is silently swallowed. The `open`/`write`/`close` cycle is wrapped in a try/catch that never rethrows, so a failed notification cannot reach the agent loop. |
| Windows | Best-effort. There is no `/dev/tty`, so the same OSC bytes go to `process.stdout` and ConPTY forwards them to Warp. Skipped entirely when `process.stdout.isTTY` is false, so piped or redirected output is never polluted. This path is untested in the wild. |
| Detached workflow child sessions | The extension is not loaded at all. See below. |
| `blockingTools` configured empty | The `tool_call` and `tool_execution_end` handlers short-circuit; no Blocked badge, everything else unaffected. |
| `heartbeatMs` set to `0` | The heartbeat interval never starts. |
| Terminal without an xterm title stack | The CSI push/pop sequences are ignored silently; the spinner still animates. |

## Detached workflow child sessions

`rpiv-warp` declares `"pi": { "ambientObserver": true }` in its `package.json`.
That flag marks it as a launcher-only extension: it registers lifecycle handlers
and side effects — timers, terminal writes, a spinner — but exposes no tool or
command that a workflow stage could invoke.

`rpiv-pi`'s workflow host reads the flag before it constructs a child session's
extensions and filters `rpiv-warp` out. A detached child has no terminal of its
own, so loading it there would be pure cost, and the 300 ms idle timer armed at
`agent_end` would fire against an already-disposed context.

Workflow questions still reach Warp — they go through the run-keyed transport
described in [events.md](./events.md#workflow-question-transport), driven from the
launcher session where the terminal actually is.

## Terminal writes

Every emission opens `/dev/tty`, writes, and closes. There is no cached file
descriptor. On Unix the escape bytes are intercepted by the terminal emulator and
never enter stdout or stderr, so they cannot corrupt piped output or Pi's own
capture.

`rpiv-warp` writes no other files. It reads its config file and never creates,
modifies or chmods one.
