# rpiv-todo

<a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo">
  <picture>
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/cover.png" alt="rpiv-todo cover" width="100%">
  </picture>
</a>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-todo.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Give the model a todo list it can keep across long sessions. `rpiv-todo` adds the `todo` tool, the `/todos` slash command, and a live overlay above the editor to [Pi Agent](https://github.com/badlogic/pi-mono) — tasks survive `/reload` and conversation compaction, so the model picks up where it left off.

![Todo overlay widget above the Pi editor](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg)

## Features

- **Live overlay above the editor** — see the model's plan at all times; auto-hides when empty.
- **Survives `/reload` and compaction** — tasks replay from the conversation branch, not disk.
- **Status states** — pending, in_progress, completed, plus a deleted tombstone for audit.
- **Dependency tracking** — `blockedBy` with cycle detection, so the model can sequence work.
- **Smart truncation** — 12-line collapse threshold; completed tasks drop first, pending tasks stay visible last.

## Install

```bash
pi install npm:@juicesharp/rpiv-todo
```

Then restart your Pi session.

## Tool

- **`todo`** — create / update / list / get / delete / clear tasks. 4-state
  machine (pending → in_progress → completed, plus deleted tombstone).
  Supports `blockedBy` dependency tracking with cycle detection. Tasks persist
  via branch replay — survive session compact and `/reload`.

## Commands

- **`/todos`** — print the current todo list grouped by status.

## Overlay

The aboveEditor widget auto-renders whenever any non-deleted tasks exist.
12-line collapse threshold; completed tasks drop first on overflow, pending
tasks truncate last. Auto-hides when the list is empty.

## License

MIT
