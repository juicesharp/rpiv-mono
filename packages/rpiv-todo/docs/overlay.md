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

In the default `"turn"` policy, the content-row budget is `maxWidgetLines`
(default `12`), and the heading counts against it. When there are more tasks
than fit:

1. one row is reserved for the summary line;
2. completed tasks are dropped first, newest first — the oldest completed rows
   are the last completed rows to go;
3. if the unfinished tasks alone still overflow, the tail of that list is
   truncated;
4. the last row becomes `+N more (X completed, Y pending)`.

In `"session"` completed-task visibility, the panel does not apply that height
budget: pending and in-progress tasks always stay as individual rows. When the
contiguous completed prefix at the top exceeds `maxVisibleCompleted` (default
`5`), only its older rows fold into a single expandable row. The expanded view
may grow the widget to show every folded row.

See [configuration.md](./configuration.md#maxwidgetlines) for the turn-mode
budget and [completed-task visibility](./configuration.md#completedtaskvisibility)
for the session-mode rules.

## Completed tasks

With the default `completedTaskVisibility: "turn"`, a completed task stays on
screen for the remainder of the turn in which it completed. At the start of the
next agent turn, every completed row that has been displayed is hidden from
later renders. Reloading or compacting resets that tracking, so a fresh session
shows the full list again.

With `completedTaskVisibility: "session"`, completed rows stay in the same
chronological list until the session ends, the list is cleared, or the task is
deleted. If the list begins with more completed rows than `maxVisibleCompleted`,
the oldest ones fold in place:

```text
● Todos (6/7)
├─ ▶ 1 completed · ctrl+shift+c to expand
├─ ✓ Most recent completed task
├─ ◐ Current task
└─ ○ Next task
```

Press `completedCollapseKey` (default `ctrl+shift+c`) to expand every folded row
in place, then press it again to fold them. A completed task behind any pending
or in-progress task retains its original position and is never moved into that
fold.
## Collapsing

Press `ctrl+shift+t` to collapse the whole panel to two lines — the heading plus
a dim `└─ ctrl+shift+t to expand` hint — and again to expand it. The hint always
shows the currently configured `collapseKey`.

The separate `completedCollapseKey` only expands or folds the older completed
prefix in session mode; it does not collapse the whole panel. Rebind or disable
either key through configuration. If both keys resolve to the same value, the
whole-panel key wins and completed rows stay expanded.
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

The overlay heading, the `+N more` summary, the collapse hint, the `/todos`
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
