# @juicesharp/rpiv-advisor

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-advisor.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-advisor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/cover.png" alt="rpiv-advisor cover: an executor model calling advisor() and a stronger reviewer answering with a plan, a correction, or a stop signal" width="50%">
    </picture>
  </a>
</div>

Let the model you're working with hand its whole conversation to a second, stronger model and get back a plan, a correction, or a stop signal — then keep going. `rpiv-advisor` adds the zero-parameter `advisor` tool and the `/advisor` picker to [Pi Agent](https://github.com/badlogic/pi-mono), so you can drive a session with a fast model and keep a stronger reviewer one call away.

## Install

```sh
pi install npm:@juicesharp/rpiv-advisor
```

Restart your Pi session.

## Quick start

Nothing happens until you pick a reviewer. Run:

```
/advisor
```

You get a picker over every model Pi already has credentials for — start typing
to filter it by model name, provider, or `provider/id`. Pick one, and if it
supports reasoning you get a second picker for its effort level (`high` is
recommended). Pi confirms with `Advisor: <model>, <effort>`, and the `advisor`
tool goes live for this and every future session.

If the model you want isn't in the list, its provider isn't authenticated yet —
run Pi's `/login` for that provider, then re-run `/advisor`.

![The /advisor picker: a bordered panel titled "Advisor Tool" above a scrollable list of the models Pi has credentials for, with the current selection highlighted](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/advisor.jpg)

From there the executor model calls `advisor()` on its own when it needs stronger
judgment. To turn it back off, run `/advisor` and choose **No advisor**.

## What you get

- **A second opinion without leaving the session** — the executor calls
  `advisor()` mid-turn, reads the reviewer's answer as the tool result, and
  resumes. Nothing is injected into your transcript.
- **Nothing to type or paste** — the tool takes zero parameters. The whole
  conversation branch is serialised and forwarded automatically: the task, every
  tool call made, every result seen. That whole branch is billed against the
  reviewer model on every call, so escalations are not free.
- **The reviewer sees what survived compaction** — the branch is built from Pi's
  resolved LLM context, so compaction and branch summaries are forwarded instead
  of a stale raw replay.
- **Any model can be the reviewer** — every model you're authenticated for is in
  the `/advisor` picker, found by fuzzy-typing. No provider is privileged.
- **Pick once, it stays picked** — model and effort persist to `advisor.json`
  and are re-applied at every session start.
- **Skip it when you're already on a strong model** — list executor models in
  `disabledForModels` to strip the tool for them, optionally only at or above a
  reasoning-effort threshold. It strips and re-adds live as you switch model or
  effort mid-session.
- **Off costs nothing** — with no model selected the tool is stripped from the
  active set, so its prompt text never enters the system prompt at all.

## Configuration

Settings live in `~/.config/rpiv-advisor/advisor.json` (or
`$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` when that variable is set to an
absolute path). `/advisor` creates the file and chmods it to `0600`; a failed
write leaves your previous selection untouched and tells you so.

| Key | What it does | Default |
| --- | --- | --- |
| `modelKey` | The reviewer model, as `"provider/modelId"`. Written by `/advisor`. | absent — advisor off |
| `effort` | Reasoning effort for the reviewer: `minimal`, `low`, `medium`, `high`, `xhigh`. Written by `/advisor`. | absent — no reasoning sent |
| `disabledForModels` | Executor models the advisor is stripped for. Plain strings block at any effort; `{ "model": "…", "minEffort": "…" }` blocks only at or above that effort. | `[]` |

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

`/advisor` only rewrites `modelKey` and `effort`, so hand-edited keys —
`disabledForModels` and the `guidance` overrides — survive every save.

## Reference

- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/docs/configuration.md) — config file resolution, every key, blocklist matching rules, guidance overrides, and the full notification catalogue.
- [`advisor` tool reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/docs/tool-reference.md) — schema, result envelope, failure paths, what gets sent to the reviewer, lifecycle hooks, and picker keys.

## Requirements

- A [Pi Agent](https://github.com/badlogic/pi-mono) host — the extension loads
  through Pi's extension manifest. No native dependencies.
- An authenticated provider for the **reviewer** model, resolved through Pi's
  model registry.
- An interactive terminal for `/advisor`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The `/advisor` picker offers only **No advisor** | No provider is authenticated in Pi | Run Pi's `/login` for a provider, then re-run `/advisor` |
| `Advisor (<model>) has no API key available.` comes back as the tool result | Credentials for the reviewer's provider no longer resolve | Re-authenticate that provider with `/login` |
| `/advisor requires interactive mode` | Running under `pi --print …` or RPC | Run Pi interactively |

## Related

- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) —
  the umbrella package; its `code-review` skill calls `advisor()` when this
  package is installed.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-advisor/LICENSE).
