# rpiv-advisor

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/cover.png" alt="rpiv-advisor cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-advisor.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-advisor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Let the model ask a stronger model for a second opinion before it acts. `rpiv-advisor` adds the `advisor` tool and `/advisor` slash command to [Pi Agent](https://github.com/badlogic/pi-mono) — the working model can hand the full conversation to a reviewer (e.g. Opus) and resume with its plan, correction, or stop signal.

![Advisor model selector](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/advisor.jpg)

## Features

- **Reviewer model selector** — `/advisor` opens a picker over any model in Pi's registry, plus a reasoning-effort picker for reasoning-capable models.
- **Persisted across sessions** — selection saved at `~/.config/rpiv-advisor/advisor.json` (chmod 0600).
- **Off by default** — the `advisor` tool is excluded until you pick a model; choose "No advisor" to disable.
- **Zero-parameter handoff** — calling `advisor` forwards the full serialized conversation branch; no manual prompt needed.

## Install

```bash
pi install npm:@juicesharp/rpiv-advisor
```

Then restart your Pi session.

## Usage

Configure an advisor model with `/advisor` — the command opens a selector for
any model registered with Pi's model registry, plus a reasoning-effort picker
for reasoning-capable models. Selection persists across sessions at
`~/.config/rpiv-advisor/advisor.json` (chmod 0600).

The `advisor` tool is registered at load but excluded from active tools by
default; selecting a model via `/advisor` enables it. Choose "No advisor" to
disable.

`advisor` takes zero parameters — calling it forwards the full serialized
conversation branch to the advisor model, which returns guidance (plan,
correction, or stop signal) that the executor consumes.

## License

MIT
