# rpiv-btw

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-btw">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-btw/docs/cover.png" alt="rpiv-btw cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-btw.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-btw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ask a side question without polluting the main conversation. `rpiv-btw` adds `/btw <question>` to [Pi Agent](https://github.com/badlogic/pi-mono) — a lightweight side agent picks up a **read-only clone** of your current conversation and answers in a panel at the bottom of the terminal. The side agent remembers its own `/btw` thread for follow-ups, while your main chat keeps going — its transcript is never polluted.

![The /btw side-question panel at the bottom of the Pi terminal](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-btw/docs/overlay.jpg)

## Install

```bash
pi install npm:@juicesharp/rpiv-btw
```

Restart your Pi Agent session, then type `/btw` followed by your question:

```
/btw why did we switch from sockets to SSE last week?
```

## Usage

### What you see

A panel opens at the bottom of the terminal with:

- your question on a banner,
- a `…` while the model is thinking,
- the answer when it arrives.

Prior `/btw` questions from the same session appear above the banner, so follow-ups have context.

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll the panel (when its content overflows) |
| `x` | Clear this session's `/btw` history (hidden until you have a prior entry) |
| `Esc` | Close the panel; cancel the request if it's still running |

### What the model sees

The side agent is a fresh, tool-less instance of the same primary model, handed a read-only clone of your current conversation. When you press enter, `/btw` sends it:

1. A snapshot of your main conversation so far — so it knows what you've been working on. The side agent only reads the clone, so nothing it does pollutes your main transcript.
2. Your previous `/btw` questions and answers in this session — so follow-ups make sense.
3. The question you just typed.

### What it does *not* do

- Your main conversation is never polluted. The side answer lives only in the panel and in memory — it's not written to the agent's transcript or to disk.
- `/btw` has no tools. The model answers in plain text.
- History is lost when you exit Pi Agent. Your main session is unaffected.

## Commands

| Command | Description |
|---|---|
| `/btw <question>` | Ask a side question without polluting the main conversation |

## Architecture

```
rpiv-btw/
├── index.ts        — extension entry; registers command + hooks
├── btw.ts          — state, message threading, model call
├── btw-ui.ts       — bottom panel renderer
└── prompts/
    └── btw-system.txt — system prompt for the side call
```

Pi Agent discovers the extension via `"pi": { "extensions": ["./index.ts"] }` in `package.json`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/btw requires interactive mode` | Running in `pi --print …` or RPC mode | `/btw` needs a terminal — run Pi interactively |
| `/btw requires an active model` | No primary model configured | Set one with `/login` or edit `~/.pi/agent/models.json` |
| Panel opens but answer never arrives | Model call failed or network dropped | Press `Esc` to cancel; check your provider credentials |
| History missing after restart | Expected — no disk persistence | `/btw` history is per-Pi-process by design |

## License

MIT
