# Lanes

Every `/wf` stage runs in a detached child session. The lane dock and lane browser are
how you watch those runs, answer their questions, and stop them.

## The dock

Once a run is in flight, a lane dock renders directly below your editor. It stays there
for the life of the run — you keep typing in the main session while stages execute. Each
lane shows one run; a fanout stage adds a sub-row per parallel unit.

From an **empty** prompt (no text typed, no autocomplete open, at least one lane):

| Key | Effect |
| --- | --- |
| `↓` | Step into the lane browser |
| `esc` | Clear the dock — only once every lane has finished; a single running lane makes it a no-op |

## Opening the browser

| Trigger | Notes |
| --- | --- |
| `/lanes` | Always available |
| `ctrl+q` | Global hotkey; requires a UI, at least one lane, and that you are not already focused into a run |
| `↓` on an empty prompt | See above |

With no runs in flight, `/lanes` notifies `No in-flight runs.`; `ctrl+q` silently does
nothing.

## Inside the browser

The browser replays the selected lane's transcript, tool calls included.

| Key | Effect |
| --- | --- |
| `↑` / `↓` | Move along the lane spine. `↑` on the top row backs out |
| `⏎` | Arm the parked question on a flagged lane, inline |
| `PgUp` / `PgDn` | Scroll the transcript. Scrolling away from the tail switches the footer from `following` to `paused` |
| `t` | Expand or collapse tool output |
| `x` | Stop the selected run |
| `esc` / `←` | Back out to the prompt |

The footer states the live contract:

```
↑/↓ lanes · ⏎ answer · following · PgUp/PgDn scroll · t expand · x stop · ↑/←/esc back
```

## Parked questions

When a detached stage needs an answer, it does not steal your session. The question
parks on that lane, the row is flagged, and the browser's footer grows `⏎ answer`.
Press `⏎` on the flagged lane to arm the question in place and answer it there; the
browser stays open across answers, so you can work through several lanes in a row.

While a question has focus, `esc` hands the keys back to the lane spine and leaves the
question deferred — it stays parked until you come back to it. The footer in that state
reads `esc → lanes · answer in the question above`.

Install [`@juicesharp/rpiv-warp`](https://www.npmjs.com/package/@juicesharp/rpiv-warp)
if you want parked questions to also raise a "Blocked" badge in Warp. It is entirely
opt-in; without it nothing changes.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `RPIV_LANES_HOTKEY` | `ctrl+q` | Rebind the browser hotkey to any Pi key id. Set it to `off`, `none`, `false`, `disabled`, or empty to register no hotkey at all — `/lanes` still works. An unrecognized key id registers but never fires |
| `RPIV_BASH_TIMEOUT_MS` | `180000` (3 min) | Per-command watchdog on bash calls inside detached child sessions. Clamped to 5 000–1 800 000 ms; a non-numeric or non-positive value falls back to the default. Read once at load, so export it before starting Pi |

When a bash call exceeds the watchdog the child session aborts that command and the
reason is routed into the run's soft-halt gate rather than wedging the lane:

```
bash command exceeded the 180s per-command timeout and was aborted: `<command>`
```

## Why lanes are launcher-only

The dock, the dock editor, the execution host, and the progress bridge are installed
only in a root interactive session. A detached child that re-loads the extension skips
all of them, so a running stage can never clobber the launcher's dock.
