# rpiv-todo / tool

## Responsibility
The LLM-facing tool contract surface: declares tool identity strings, the TypeBox parameter schema (whose `description` fields double as prompt copy), and builds the dual-channel response envelope — human-readable `content` text plus the machine-readable `details` snapshot consumed by post-compaction replay.

## Dependencies
- **`typebox`** (regular dependency, not peer): `Type`, `Static` for `TodoParamsSchema` — moved from peers so tool registration survives installers that do not materialise peer deps
- **`@earendil-works/pi-ai`** (peer): `StringEnum` for `action` and `status` literal unions
- **Internal**: `../state/state.js` (`TaskState`), `../state/state-reducer.js` (`Op`), `../state/task-graph.js` (`deriveBlocks`)

## Inbound / Outbound
- **Imported by** `../todo.ts`: registers the `todo` tool using `TOOL_NAME`, `TodoParamsSchema`, and `buildToolResult`
- **No outbound** to Pi runtime — pure schema + formatter layer

## Module Structure
```
types.ts                — Identity constants (TOOL_NAME, TOOL_LABEL, COMMAND_NAME), error strings,
                           public domain types (Task, TaskStatus, TaskAction, TaskDetails, TaskMutationParams),
                           and TodoParamsSchema TypeBox shape
response-envelope.ts    — Pure formatters (formatListLine, formatGetLines, formatContent) closed-switching over
                           the Op tagged union, plus buildToolResult envelope constructor
response-envelope.test.ts — Snapshot coverage of every Op branch and the envelope shape
```

## Response Envelope (dual-channel)
```ts
export function buildToolResult(action: TaskAction, params: TaskMutationParams, state: TaskState, op: Op) {
    const text = formatContent(op, state);          // LLM-visible text channel
    const details: TaskDetails = {
        action,
        params: params as Record<string, unknown>,
        tasks: state.tasks,                          // FULL post-commit snapshot
        nextId: state.nextId,
        ...(op.kind === "error" ? { error: op.message } : {}),
    };
    return { content: [{ type: "text", text }], details };
}
```
**No-op updates are surfaced, not silently echoed**: `formatContent`'s `update` branch checks `op.changed` and returns `No change: #N already matches the requested values (status: ...)` instead of `Updated #N` — the content channel telling the model an update had no effect stops it re-issuing the same no-op in a loop.

## `details` Payload Carries Full State (replay-survival)
```ts
export interface TaskDetails {
    action: TaskAction;
    params: Record<string, unknown>;
    tasks: Task[];        // full task list AFTER the mutation — not a delta
    nextId: number;       // ID counter snapshot
    error?: string;
}
```
**Critical**: every envelope carries the *entire* post-commit `TaskState`. Post-compaction reconstruct is a single last-writer-wins lookup over the branch — **never a reducer replay**.

## Types Surface
- `TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear"`
- `TaskStatus = "pending" | "in_progress" | "completed" | "deleted"`
- `TodoParamsSchema` enumerates the action via `StringEnum`, plus optional `subject/description/activeForm/status/blockedBy/addBlockedBy/removeBlockedBy/owner/metadata/id/includeDeleted` — every field's `description` is LLM-facing prompt copy

## Symmetry with `rpiv-ask-user-question/tool/`
Both packages share the `{ content: [{ type:"text", text }], details }` envelope contract and the TypeBox-params + types split. **Divergence**: todo is leaner (only schema + envelope) because state lives in `../state/`; AUQ's tool layer adds `format-answer.ts` and `validate-questionnaire.ts` because its surface is richer.

## Reconstruct Flow Connection
`details` is consumed by `replayFromBranch` in `../state/replay.ts`: walks the session branch filtering `toolResult.toolName === "todo"` and applies last-writer-wins on the `tasks`/`nextId` fields. The result is fed to the per-session `replaceState(sessionId, next)` in `../state/store.ts` from `../index.ts` — the `session_start` handler plus the shared `replayAndRefresh` handler for `session_compact` / `session_tree` — so every session replays into its own store slot keyed by `sid(ctx)`; `../todo.ts` no longer participates in replay.

## Architectural Boundaries
- **`TOOL_NAME` is preserved verbatim** — renaming breaks session-history replay (replay filters on `toolResult.toolName`)
- **`details.tasks` is a SNAPSHOT**, not a diff — replay does last-writer-wins, no reducer re-execution
- **Replay-survival is scoped per session** — each session reconstructs into its own store slot, so a detached or child session never reads or overwrites another session's tasks
- **Errors are values** — `op.kind === "error"` puts the message in `details.error`; never throws across the tool boundary
