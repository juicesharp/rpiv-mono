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
- **`@juicesharp/rpiv-config`** (dependency): `loadJsonConfigWithLegacyFallback`/`validateGuidanceFields` — XDG-path load with one-way legacy fallback; `config.ts` holds prompt overrides plus the overlay settings `maxWidgetLines`/`collapseKey` (`todo.ts:16`)
- **`typebox`** (dependency — moved from peers so installers that don't materialise peer deps still resolve it): tool parameter schema

## Consumers
- **Pi extension host** (loads via `pi.extensions: ["./index.ts"]`) and **`rpiv-pi`** (lists in `peerDependencies` and `siblings.ts`)

## Module Structure
```
.                — Composer + tool/command registrars + overlay widget class. Each capability
                   gets a single file at the package root; the composer (index.ts) is pure wiring.
state/           — Reducer + store cell + replay (compaction-survival) + task-graph + invariants
                   + selectors + i18n-bridge. No Pi imports below the bridge — testable in isolation.
                   Detailed shape: `.rpiv/guidance/packages/rpiv-todo/state/architecture.md`.
tool/            — Pi tool surface: TypeBox params, response-envelope shape consumed by replay.
                   Detailed: `.rpiv/guidance/packages/rpiv-todo/tool/architecture.md`
view/            — Presentation helpers (line formatting) shared by /todos command + overlay.
locales/         — JSON maps registered by index.ts (registerLocalesFromDir); i18n-bridge resolves lookups.
```

## Reducer / Store / Replay Split
```typescript
// state/state.ts — canonical shape, single source of truth.
export interface TaskState { tasks: Task[]; nextId: number; }

// state/state-reducer.ts — pure: (state, action, params) → { state, op }.
// `op` is a closed tagged union (create | update | list | get | delete | clear | error).
export function applyTaskMutation(state, action, params): ApplyResult { /* ... */ }

// state/store.ts — per-session slots (Map<sid, TaskState>) + a ctx-less render pointer.
// Every accessor/seam is keyed by session id so a detached/child session (distinct sid)
// can never read or clobber another session's tasks.
export function sid(ctx): string;                // sessionManager.getSessionId() ?? ""
export function getState(sessionId): TaskState;  // get-or-fresh slot; the four slot writers
// (commitState post-reducer / replaceState replay seam / evictSession / __resetState) — see Architectural Boundaries.
// Foreground render pointer — which slot the ctx-less readers (overlay, renderCall) show:
// getRenderState() = slotFor(activeRenderSession); setActiveRenderSession(id) claimed once at
// overlay creation; getActiveRenderSession() read by the index.ts sid-gate; clearActiveRenderSession() on teardown.

// state/replay.ts — pure: walk branch, return fresh TaskState (last-writer-wins).
export function replayFromBranch(ctx): TaskState;
```

## Persistent Widget Mount (Lazy, Idempotent, Auto-hide)
```typescript
// Lazy: the FIRST hasUI session_start constructs it and claims the foreground render pointer (creator-ownership); a child (distinct sid) is sid-gated out of rebinding/disposing it.
let todoOverlay: TodoOverlay | undefined;
pi.on("session_start", async (_e, ctx) => {
    const id = sid(ctx); replaceState(id, replayFromBranch(ctx));   // each session → its OWN slot
    if (!ctx.hasUI) return;
    if (todoOverlay === undefined) { todoOverlay = new TodoOverlay(); setActiveRenderSession(id); }
    if (id !== getActiveRenderSession()) return;   // child: skip rebind
    todoOverlay.setUICtx(ctx.ui); todoOverlay.update();
});

// Register-once factory: setWidget(WIDGET_KEY, (tui, theme) => ({ render, invalidate }),
// { placement: "aboveEditor" }) — the factory captures `tui`; invalidate() clears
// widgetRegistered + tui so the next update re-registers; later updates just tui.requestRender().
```

## Architectural Boundaries
- **Status transitions are a single declarative table** — `Record<TaskStatus, ReadonlySet<TaskStatus>>` in `state/invariants.ts`, never an `if/switch` ladder; adding a status is a one-line edit and mistakes surface as data
- **NO replay from `tool_execution_end`** — `message_end` runs after, so the branch is stale; the widget reads live state via `getRenderState()` (the ctx-less foreground slot — `import { getRenderState } from "./state/store.js"`) instead
- **`TOOL_NAME` and `WIDGET_KEY` are preserved verbatim** — renaming breaks session-history replay and persisted UI state
- **Delete is a tombstone** (`status: "deleted"`, terminal) — preserves ids so historic `blockedBy` references still resolve
- **NO disk persistence** — state derives entirely from the session branch via the `details` envelope
- **Mutation goes through `store.ts`** — reducer is pure; only `commitState` / `replaceState` / `evictSession` / `__resetState` write the session-slot Map (all keyed by sid); `setActiveRenderSession` / `clearActiveRenderSession` move the foreground pointer (a distinct concept, not a 4th task-state writer)
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
- **Line cap**: config field `maxWidgetLines` (default 12, floor of 3), read fresh via `getMaxWidgetLines()` on every render — no `/reload`; overflow math adapts automatically
- **Collapse key**: config field `collapseKey` (default `ctrl+shift+t`, `"off"` disables) — resolved once at factory scope by `resolveCollapseKey()`, so a change needs `/reload` to re-bind; validated strictly against pi-tui's KeyId grammar so a typo like `ctr+]` cannot silently consume bare keypresses; `toggleCollapse()` forces `requestRender(true)` on the height step, and the collapsed view renders a dim expand hint (static label when the key is `"off"` mid-session)
- **Glyphs / heading**: the status-glyph palette is the only glyph coupling site; the heading-color/icon/text triple lives in `renderWidget`
- Theme always via `theme.fg(...)` — never raw ANSI; use `truncateToWidth` for every line
</important>
