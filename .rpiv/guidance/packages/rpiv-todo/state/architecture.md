# rpiv-todo/state/

## Responsibility
Pure state layer for the `todo` tool — owns the canonical shape, the reducer, the live store cell, branch replay, and graph/transition invariants. No Pi imports below the i18n bridge — fully testable in isolation. All Pi-aware callers (`../index.ts`, `../todo.ts`, `../todo-overlay.ts`) live one level up — see Consumers.

## Dependencies
- **`../tool/types.ts`** — `Task`, `TaskAction`, `TaskMutationParams`, `TaskStatus`, `TaskDetails` (the canonical schema travels with the tool surface, not the state layer)
- **`@juicesharp/rpiv-i18n`** — only via `i18n-bridge.ts`; the rest of `state/` is locale-agnostic
- **NO `@earendil-works/pi-*`** below the bridge — reducers and selectors are testable without Pi

## Consumers
- **`../index.ts`** (composer): wires `replayFromBranch` into `session_start`/`session_compact`/`session_tree`, committing each replay snapshot via `replaceState`; `evictSession` + render-pointer teardown on `session_shutdown`
- **`../todo.ts`** (tool registrar): `execute()` runs the reducer and `commitState`s the result
- **`../todo-overlay.ts`** (widget): reads live state via `getRenderState()` (the ctx-less foreground slot — `./state/store.js`) between renders
- **`test/setup.ts`**: imports `__resetState` for the global `beforeEach`

## Module Structure
```
state.ts          — Canonical `TaskState { tasks, nextId }` + `EMPTY_STATE`. Single source of truth.
state-reducer.ts  — Pure: (state, action, params) → { state, op }. `Op` is a closed tagged union.
store.ts          — Live state cell + read-only accessors + commit/replace/reset seams.
replay.ts         — Pure: walk session branch, return fresh `TaskState` (last-writer-wins).
invariants.ts     — `VALID_TRANSITIONS` table + `isTransitionValid` predicate.
task-graph.ts     — `detectCycle` (cycle check before a `blockedBy` mutation lands) + `deriveBlocks`.
selectors.ts      — Pure derivations of `TaskState` (visible/grouped/counted).
i18n-bridge.ts    — Locale-aware string lookup (only file in this folder that imports rpiv-i18n).
```

## Reducer Output (`Op` closed union)
`applyTaskMutation(state, action, params) → { state, op }` where `op` is a **closed tagged union** spanning one variant per `TaskAction` plus a terminal `error` kind. The response envelope's `formatContent` is compiler-enforced exhaustive over `Op` — adding an action without extending the envelope fails the build. **Errors are values, never throws**: every failure path returns `{ kind: "error", message }`, never raises.

The `update` variant carries `changed: boolean`, computed by the pure `taskChanged(before, after)` comparator (order-sensitive on `blockedBy`, JSON-equality on `metadata`) — a no-effect update lets the envelope report `No change` instead of `Updated #N`, so a model does not re-issue the same no-op update in a loop.

## Store Mutation Seams (single writer)
`store.ts` is the **only** module that mutates state. State lives as a `Map<sid, TaskState>` (per-session slots — a detached/child session keyed by a distinct sid cannot read or clobber another's tasks). The write surface is three sid-keyed seams — `commitState` (post-reducer), `replaceState` (replay), `evictSession` (drop a slot on `session_shutdown`) — plus the global `__resetState` (test isolation: takes no sid, clears the whole Map and the render pointer; signature kept stable so `test/setup.ts` needed no edit) and read-only accessors. A separate `activeRenderSession` pointer (`setActiveRenderSession`/`clearActiveRenderSession`) selects which slot the ctx-less readers render; it is NOT a task-state writer. Any other module that wants to change state must go through these seams.

## Branch Replay + Cycle Guard (pure, last-writer-wins)
Replay walks the session branch, picks the latest `todo` toolResult whose `details` survive the runtime type guard, and returns a **fresh** `TaskState` (the composer commits via `replaceState`). Stale-schema entries from older sessions are silently skipped — never coerced via defaults, which would drift.

Cycle detection runs **before** a `blockedBy` mutation lands — the reducer never accepts a graph edit and rolls back. Status transitions go through a `Record<TaskStatus, ReadonlySet<TaskStatus>>` table in `invariants.ts`; the mapped type makes the table exhaustive over `TaskStatus` and `deleted` is the only terminal status (tombstone, preserves ids).

## Architectural Boundaries
- **Reducer is pure** — `(state, action, params) → { state, op }`; no module-state reads, no IO, no throws
- **`store.ts` is the only mutation seam** — `commitState`/`replaceState`/`evictSession` (sid-keyed) plus the global `__resetState` are the entire task-state write surface; the `activeRenderSession` pointer is separate
- **Replay returns a fresh `TaskState`** — never mutates module state directly; the composer commits via `replaceState`
- **`detectCycle` runs BEFORE the mutation lands** — never accept a graph edit and roll back
- **Errors are `Op` values, not throws** — `errorResult` wraps every failure path so the response envelope can format uniformly
- **Schema-guard every replay entry** — `isTaskDetails` rejects entries from older or corrupt sessions silently
- **`i18n-bridge.ts` is the ONLY rpiv-i18n consumer in this folder** — every other file works in pure English

<important if="you are adding a new field to TaskState or TaskDetails">
## Schema Evolution
1. Add the field to both `TaskState` AND the persisted `TaskDetails` shape (in `tool/types.ts`)
2. Update `isTaskDetails` (`state/replay.ts`) to recognize the new field — old session entries lacking the field stay rejected, NOT silently filled with defaults (drift trap)
3. Decide replay default: either widen the type guard to accept missing+new (filling on read) OR bump a `version` discriminator and skip pre-version entries
4. Update the response-envelope `formatContent` if the field is user-facing
5. Add a regression test that replays a synthetic branch containing both old-shape and new-shape entries
</important>
