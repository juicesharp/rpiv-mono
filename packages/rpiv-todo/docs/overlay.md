# Overlay and `/todos` display

How
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | Only while at least one overlay-visible task exists. The widget unregisters itself when the list empties, and re-registers when a task reappears. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last `todo` tool result's snapshot, which replaces the whole list
(last-write-wins).

## Anatomy of a row

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Heading** — `● Todos (done/total)` in the accent color while any task is
  `pending` or `in_progress`; `○ Todos (done/total)` dimmed once everything is
  completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `✗` deleted.
  Completed and deleted subjects render dim and struck through.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Dependencies** — appended as `⛓ #1,#2` when the task has a `blockedBy` set.
- **`#id` prefix** — shown on every row only when at least one visible task
  carries a `blockedBy`. Without a `⛓ #N` anywhere, the per-row ids have nothing
  to point at, so they are omitted.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. Before the window is laid out, every `in_progress` task is hoisted
into an **active strip** rendered directly under the heading — parallel work
always stays visible instead of hiding behind the `… N later` marker. The
strip spends its own rows out of the same budget, so the window over the
remaining tasks gets `budget - strip height` rows. When the strip itself is
taller than the budget, only the first `budget - 2` active rows render, the
last row reports `… N more active`, and no other tasks are shown.

When the remaining tasks still overflow what is left of the budget, the
overlay renders a focused window over them instead of the whole list:

1. the window anchors at the first unfinished task in display order;
2. if fewer tasks remain after that anchor than fit, the window backfills from
   earlier tasks so it stays full;
3. each hidden side spends one budget row on a marker — `… N earlier` above,
   `… N later` below;
4. when every task is completed, the final window is shown.

At the minimum budget of `3` there is no room for two marker rows, so both
hidden sides fold into a single bottom `+N more` summary — and no active
strip is hoisted there either, since a strip plus a fold marker would not
leave a single task row.

Use Pi's tool-output expansion shortcut (`ctrl+o` by default) to expand the
widget and show every task. Collapsing Pi's tool output reapplies the configured
row budget and its focused window. See
[configuration.md](./configuration.md#maxwidgetlines) for the budget's floor and
reload semantics.

## Completed tasks fading out

A completed task stays on screen until it has been displaced by 3 newer
completions — the overlay keeps only the 3 most recently finished rows (by a
monotonic `completedSeq` stamped when the task is completed, persisted inside
the task snapshot so recency survives reload and compaction replay). Fading is
immediate and deterministic: no agent-turn boundary is involved, and the
heading's `(done/total)` counts exclude faded rows. Tasks completed before
this feature existed carry no stamp and rank oldest, ordered among themselves
by id.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to two lines — the heading plus a dim
`└─ ctrl+shift+t to expand` hint — and again to expand it. The hint always shows
the currently configured key.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). If the shortcut is set to
`"off"` while the panel is collapsed, the hint becomes a static `collapsed`
label rather than advertising an unbindable key.

## `/todos`

`/todos` prints the whole list grouped by status, independent of the overlay's
row budget and auto-hiding:

```
2/7 completed · 1 in progress · 4 pending
── Pending ──
  ○ #4 Register DI bindings
  ○ #5 Add integration tests    ⛓ #4
  ○ #6 Wire up the HTTP endpoint
  ○ #7 Update the API docs
── In Progress ──
  ◐ #3 Create DemoTodoRepository (creating the repository)
── Completed ──
  ✓ #1 Create DemoTodo domain entity
  ✓ #2 Create IDemoTodoRepository interface
```

The header omits any count that is zero. Sections appear only when they have
tasks. Tombstoned tasks are never listed.

- With no tasks: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

## Localization

The overlay heading, the `… N earlier` / `… N later` overflow markers, the
collapse hint, the `/todos`
section headers, and the status words all localize through
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
when that package is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`,
`pt-BR`, `ru`, `uk`, `zh`.

LLM-facing output — the tool response envelope, reducer error messages, and the
schema descriptions — stays English by design.

The SDK is a soft optional peer, loaded through a dynamic import at module init.
When it is absent, every call site returns its inline English literal and the
extension stays online: no warning, no crash. Install it at any time with
`pi install npm:@juicesharp/rpiv-i18n` and restart the session. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.
