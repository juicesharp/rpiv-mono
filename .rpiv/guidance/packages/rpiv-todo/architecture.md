# rpiv-todo

## Monorepo Context
Sibling Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family — never bump independently. Listed in `siblings.ts`; peer-pinned by `rpiv-pi` as `"*"`.

## Responsibility
Claude-Code-parity task management for Pi. Registers a single multiplexed `todo` tool (action-discriminated: create/update/list/get/delete/clear), the `/todos` slash command, a persistent overlay widget mounted above the editor, and a global collapse/expand shortcut for it (`pi.registerShortcut`, default `ctrl+shift+t`; `collapseKey: "off"` skips registration entirely). State is reconstructed by replaying the session branch — no disk persistence.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, `ExtensionUIContext`, theme/render primitives
- **`@earendil-works/pi-ai`** (peer): `StringEnum` for action/status enums
- **`@earendil-works/pi-tui`** (peer): width-safe text helpers, render primitives
- **`@juicesharp/rpiv-i18n`** (peer, `"*"`, optional): locale lookups via `state/i18n-bridge.ts`
- **`@juicesharp/rpiv-config`** (dependency): `loadJsonConfigWithLegacyFallback`/`validateGuidanceFields` — XDG-path load with one-way legacy fallback; `config.ts` owns `TodoConfig` (prompt overrides + overlay settings `maxWidgetLines`/`collapseKey`, `config.ts:4-15`) and the collapse-key grammar validator
- **`typebox`** (dependency — moved from peers so installers that don't materialise peer deps still resolve it): tool parameter schema

## Consumers
- **Pi extension host** (loads via `pi.extensions: ["./index.ts"]`) and **`rpiv-pi`** (lists in `peerDependencies` and `siblings.ts`)

## Module Structure
```
.                — Composer (index.ts) + tool/command registrars (todo.ts) + overlay widget class
                   (todo-overlay.ts) + config.ts. Each capability gets a single file at the package
                   root; the composer is pure wiring; todo.ts re-exports the reducer/store/graph/types
                   surface so existing consumers keep importing from "./todo.js".
state/           — Reducer + store cell + replay (compaction-survival) + task-graph + invariants
                   + selectors + i18n-bridge. No Pi imports below the bridge — testable in isolation.
                   Detailed shape: `.rpiv/guidance/packages/rpiv-todo/state/architecture.md`.
tool/            — Pi tool surface: TypeBox params, response-envelope shape consumed by replay,
                   terminal-text sanitizer (sanitize.ts, shared with view/).
                   Detailed: `.rpiv/guidance/packages/rpiv-todo/tool/architecture.md`
view/            — Presentation layer: format.ts (line formatting + render hooks renderTodoCall/
                   renderTodoResult + the glyph/color tables) shared by /todos command + overlay.
locales/         — JSON maps registered by index.ts (registerLocalesFromDir); i18n-bridge resolves lookups.
```

## Reducer / Store / Replay Split
```typescript
// state/state.ts — canonical shape, single source of truth.
export interface TaskState { tasks: Task[]; nextId: number; }

// state/state-reducer.ts — pure: (state, action, params) → { state, op }.
// `op` is a closed tagged union (create | update | list | get | delete | clear | error).
// `update` merges metadata keys; a null value deletes the key; an empty record drops metadata.
export function applyTaskMutation(state, action, params): ApplyResult { /* ... */ }

// state/store.ts — per-session slots (Map<sid, TaskState>) + a ctx-less render pointer.
// Every accessor/seam is keyed by session id so a detached/child session (distinct sid)
// can never read or clobber another session's tasks.
export function sid(ctx): string;                // sessionManager.getSessionId() ?? ""
export function getState(sessionId), getTodos(sessionId), getNextId(sessionId);   // read-only accessors
// The four slot writers (commitState post-reducer / replaceState replay seam / evictSession /
// __resetState) — see Architectural Boundaries.
// Foreground render pointer — which slot the ctx-less readers (overlay, renderCall) show:
// getRenderState() = slotFor(activeRenderSession); setActiveRenderSession(id) claimed once by
// first UI start; getActiveRenderSession() read by the index.ts sid-gate; clearActiveRenderSession() on teardown.

// state/replay.ts — pure: walk branch, return fresh TaskState (last-writer-wins).
export function replayFromBranch(ctx): TaskState;
```

## Persistent Widget Mount (Lazy, Idempotent, Auto-hide)
```typescript
// Lazy: the FIRST hasUI session_start claims the foreground render pointer (creator-ownership); a child
// (distinct sid) is sid-gated out of rebinding/disposing it. The overlay module itself loads through a
// memoized loader (makeTodoOverlayLoader) that clears rejected promises, latches poisoned-namespace
// errors (isStaleOverlayModuleError → STALE_OVERLAY_MESSAGE remedy), and pre-warms after a short delay;
// a lifecycleGeneration counter invalidates stale loads across /reload.
pi.on("session_start", async (_e, ctx) => {
    const id = sid(ctx); replaceState(id, replayFromBranch(ctx));   // each session → its OWN slot
    if (!ctx.hasUI) return;
    if (getActiveRenderSession() === "") setActiveRenderSession(id);   // no eager ctor
    if (id !== getActiveRenderSession()) return;   // child: skip rebind
    uiCtx = ctx.ui; await updateTodoOverlay(true);   // lazy import + task-gated ctor inside
});

// Register-once factory: setWidget(WIDGET_KEY, (tui, theme) => ({ render, invalidate }),
// { placement: "aboveEditor" }) — the factory captures `tui`; invalidate() is a
// no-op (no cached strings); setUICtx change re-registers; later updates just tui.requestRender().
```

## Overlay Data Flow
- **Overflow layout is a selector** — `selectOverlayLayout(state, budget)` anchors a focus window at the first unfinished task and backfills from earlier tasks to keep the window full, reserving one marker row (`… N earlier` / `… N later`) per hidden side inside the budget; a degenerate two-row body budget folds both sides into one legacy `+N more` summary (`state/selectors.ts`)
- **Active strip hoist** — `selectActivePartition(tasks)` splits overlay-eligible tasks into `in_progress` (all rendered under the heading) and the rest (fed to `selectOverlayLayout` with the remaining budget); a strip taller than the budget caps at `B-2` rows + `… N more active` marker, and the degenerate `B=2` budget skips hoisting entirely; Pi's tool-expansion mode bypasses the strip and renders natural order (`todo-overlay.ts`)
- **Completed-task fading is a recency rule** — the reducer stamps a monotonic `completedSeq` on transition into `completed` (persisted inside the task snapshot, so replay preserves it); `selectOverlayTasks(state, KEEP_RECENT_COMPLETED=3)` keeps only the newest stamped completions and drops stale ones immediately — no `agent_start` bookkeeping, no per-turn hide sets
- **`renderCall` reads the foreground slot** — `ToolRenderContext` carries no session id, so render hooks render `getRenderState()`; child-session calls degrade to a `#id` suffix
- **Trailing spacer row** — the rendered widget is one line taller than `maxWidgetLines` by design (`withTrailingSpacer`)

## Architectural Boundaries
- **Status transitions are a single declarative table** — `Record<TaskStatus, ReadonlySet<TaskStatus>>` in `state/invariants.ts`, never an `if/switch` ladder; adding a status is a one-line edit and mistakes surface as data
- **NO replay from `tool_execution_end`** — `message_end` runs after, so the branch is stale; the widget reads live state via `getRenderState()` (the ctx-less foreground slot — `import { getRenderState } from "./state/store.js"`) instead
- **`TOOL_NAME` and `WIDGET_KEY` are preserved verbatim** — renaming breaks session-history replay and persisted UI state
- **Delete is a tombstone** (`status: "deleted"`, terminal) — preserves ids so historic `blockedBy` references still resolve
- **NO disk persistence** — state derives entirely from the session branch via the `details` envelope
- **Mutation goes through `store.ts`** — reducer is pure; only `commitState` / `replaceState` / `evictSession` / `__resetState` write the session-slot Map (all keyed by sid); `setActiveRenderSession` / `clearActiveRenderSession` move the foreground pointer (a distinct concept, not a task-state writer)
- **`session_compact`/`session_tree` share one extracted `replayAndRefresh` handler** (`index.ts`) — swallows ONLY the known stale-ctx error (`isStaleCtxError`: auto-compaction races session disposal); other errors are real replay bugs and propagate; the overlay refresh is sid-gated to the foreground
- **Overlay teardown is try/finally** — `session_shutdown` always evicts the slot; the foreground's own shutdown (or an unknown/stale sid `""`, treated as foreground) then runs `todoOverlay?.dispose()` with `todoOverlay = undefined` + `clearActiveRenderSession()` in `finally` — `dispose()` can throw on a stale ui proxy, and a surviving pointer would target the already-evicted slot (overlay silently renders empty)

<important if="you are adding a new todo action">
## Adding an Action
1. Add the literal to the `TaskAction` union (`tool/types.ts`) and to the action `StringEnum` in the tool params schema (`tool/`)
2. Add the reducer branch in `state/state-reducer.ts` — extend the `Op` union and return `errorResult` on failures (errors are values, never throws)
3. Extend the response-envelope's `formatContent` switch (`tool/response-envelope.ts`) — compiler-enforced exhaustive over `Op`; it owns content/details formatting
4. Hook renderers (action glyph, status glyph, status color) in the view layer; if status-changing, extend the `VALID_TRANSITIONS` table in `state/invariants.ts` + the overlay's status-glyph and line formatter
5. Update the `/todos` command if a new section is needed
6. Add a prompt-guideline bullet so the agent knows *when* to call it
</important>

<important if="you are customizing the overlay">
## Customizing the Overlay
- **Placement**: change `{ placement: "aboveEditor" }` to `"belowEditor"` in `setWidget`
- **Line cap**: config field `maxWidgetLines` (default 12, floor of 3), read fresh via `getMaxWidgetLines()` at render time — no `/reload`; overflow math adapts automatically (see `selectOverlayLayout`). Exception: when Pi's tool-output expansion mode is on (`uiCtx.getToolsExpanded?.() === true`, optional-chained for hosts predating it), the render bypasses the cap and budgets all visible tasks so Pi's expand shortcut also expands this widget
- **Collapse key**: config field `collapseKey` (default `ctrl+shift+t`, `"off"` disables) — validated strictly against pi-tui's KeyId grammar (config.ts's `isValidCollapseKeySpec`) so a typo cannot silently consume bare keypresses; resolved once at factory scope, so a change needs `/reload` to re-bind; `toggleCollapse()` forces `requestRender(true)` on the height step, and the collapsed view renders a dim expand hint (static label when the key is `"off"` mid-session)
- **Glyphs / heading**: the status-glyph palette is the only glyph coupling site; the heading-color/icon/text triple lives in `renderWidget`
- Theme always via `theme.fg(...)` — never raw ANSI; use `truncateToWidth` for every line
</important>
