# sessions/

## Responsibility
Per-stage / per-loop-unit session orchestrator. Every stage and loop unit runs in its own detached child session opened through `ctx.spawnChild` (up to `ctx.maxConcurrency` in flight); the sole surviving policy divergence is the branch offset (`branchOffsetFor`). Two orthogonal concerns: (1) **child-session plumbing** — spawn/fork/reattach primitives + session-backed resume; (2) **fatal-extraction** — folding collector/parser/schema failures into the structured `OutputProduction` outcome the audit layer records. Public surface (barrel): `runStageSession`, `continueStageSession`, `reattachStageSession`, `locateSessionFile`, `pruneOrphanedChildSessions`.

## Dependencies
- **`../types`** (type-only; re-exports `../host`): `StageSession`, `WorkflowHostContext`, `WorkflowSessionContext` — abstract Pi's `ExtensionAPI` / `ExtensionCommandContext` structurally; `host.test.ts` carries a compile-time tripwire
- **`../validate-output`**: `runValidationRetryLoop` (the shared retry engine), `validateOutputData`, MIN/MAX clamps; **`../internal-utils`**: `withTimeout`, `WorkflowAbortError`, `assertNever`
- **`../output-spec`, `../outcomes`, `../output`**: `Outcome` (the v1.20 rename of `OutputSpec`), `sideEffectOutcome` fallback, `finalizeOutput`, `failedOutput` sentinel
- **`../audit`, `../audit-rows`, `../events`, `../messages`, `../transcript`**: row writers (`recordStopFailure` / `recordTerminalFailure` / `recordUnitHalt`, `persistStageSuccess`), `onStageEnd` / `onStageRetry` / `onUnitEnd` / `onUnitHalt` lifecycle fires, `MSG_*` / `ERR_*` / `FAIL_*` constants
- **No direct `@earendil-works/pi-coding-agent` imports anywhere under `sessions/`** — verified by grep

## Consumers
- `../runner/run-stage.ts` calls `runStageSession(ctx, s)` and consumes `continueStageSession` / `locateSessionFile` / `reattachStageSession` (plus deep-imports `forkChildSession` / `reattachChildSession` from `spawn.ts`); loop units run through `deps.runStageSession` (`../loop.ts`, `../loop-parallel.ts` — bounded-parallel fan-out); `../runner/runner.ts` sweeps `pruneOrphanedChildSessions` once at run end
- Entries return `Promise<void>`; outcomes drain through the row writers and the `onSuccess` / `onFailure` callbacks — the runner never inspects a return value

## Module Structure
```
index.ts           — Barrel: the five public symbols above
sessions.ts        — runStageSession / continueStageSession entries; postStage pipeline; outcome reader
spawn.ts           — openChild → spawnChildAndRun / reattachChildSession / forkChildSession; resendIntoChild; branchOffsetFor
extraction.ts      — produceAndValidateOutput: collector → parser → schema-validate → retry loop; emits OutputProduction
halt-routing.ts    — haltStageOrSoftHalt gate + per-arm halt helpers + auditFor
success-persist.ts — recordStageSuccess + unitEventOf (value-imported by halt-routing — the acyclic direction)
locate.ts          — locateSessionFile id→path fallback ladder + pruneOrphanedChildSessions orphan sweep (node:fs only)
reattach.ts        — session-backed resume: promotion → reattach arms reusing postStage / recordStageSuccess
```

## Detached execution — every stage in its own child

`openChild` (`spawn.ts`) is THE primitive: `ctx.spawnChild({ prompt, model, signal, unitIndex, ...mode, withSession })` opens an isolated child (the parent launcher ctx stays valid), waits for it to settle, then runs the body on the guaranteed-in-session `WorkflowSessionContext`. Three open modes:

- **FRESH** (`spawnChildAndRun`) — brand-new child; the host sends the prompt. The default stage / loop-unit entry (`runStageSession`); fan-out units run through the same entry, threading identity via `StageSession.unit`
- **REATTACH** (`reattachChildSession`) — open a persisted file IN PLACE for session-backed resume; the detached replacement for the deleted `ctx.switchSession` swap. Body is `reattachStageSession`: promote from the loaded branch, else nudge via `resendIntoChild`
- **FORK** (`forkChildSession`) — `sessionPolicy: "continue"`: copy the PREDECESSOR's persisted session (`SessionManager.forkFrom` — source file never mutated, the fork has its own resumable identity), located from `run.state.lastSession` via `locateSessionFile` and gated in `run-stage.ts` (no hit ⇒ fresh-dispatch fallback). Body is `continueStageSession`: re-derive the inherited-prefix offset from the forked branch, send the continuation turn, run `postStage` sliced past the prefix

`postStage` runs on a **two-ctx split**: `obsCtx` (the long-lived launcher/observer) carries recording, lifecycle fires, and the chain continuation (`onSuccess` spawns the NEXT stage's child off the launcher — the single spawner, no nested-child chain); `child` carries transcript reads and retry re-prompts, and is disposed when the stage ends. `StageSession.laneUnitIndex` flows through as `spawnChild`'s `unitIndex` so a lane-aware host publishes each fan-out unit under its own registry slot (observability-only hint).

## Fatal vs recoverable: tagged outcome + the soft-halt gate

`produceAndValidateOutput(ctx: WorkflowSessionContext, s, branch, branchOffset: number | undefined)` returns `OutputProduction` — `ok` | `fatal` (collector/parser fatal, `produces` with empty artifacts, schema throw/timeout) | `validation-exhausted`. The retry policy is the shared `runValidationRetryLoop` engine (`../validate-output.ts` — same engine as the script path); each retry fires `onStageRetry` and re-prompts via `resendIntoChild` (`askAgentToFix`), bounded by clamped `maxRetries` + per-attempt `validateTimeoutMs`.

Every halt routes through the single `haltStageOrSoftHalt` gate (`halt-routing.ts`) on a four-arm `HaltReason`:

```ts
type HaltReason =
  | { kind: "stop"; stop: Exclude<StopSignal, "stop"> }  // classifyStop ≠ clean stop
  | { kind: "extraction"; message: string }              // OutputProduction "fatal"
  | { kind: "validation"; failureSummary: string }       // retries spent
  | { kind: "timeout"; reason: string };                 // watchdog via child.toolTimeout()
```

A `collectAll` fanout unit soft-halts (`softHaltUnit`): a NON-terminal `collected:true` row + a `failedOutput` sentinel handed to `onSuccess` so the parallel fold places it by index and the run survives; `onUnitHalt` fires after the row lands (without it the unit emits no terminal lifecycle event and lane bridges mis-render it as success). Everything else fail-fast halts via the per-arm helpers. Aborts throw `WorkflowAbortError` BEFORE any row write (`postStage`) so resume re-dispatches the unit — except a watchdog tool-timeout (`child.toolTimeout()` on an `aborted` stop with the signal cold), which routes to the gate's `timeout` arm instead of re-running the runaway command on resume.

## Host port — `WorkflowHost` abstracts Pi away

```ts
// host.ts — Pi's ExtensionAPI / ExtensionCommandContext structurally satisfy WorkflowHost /
// WorkflowLauncherContext = Omit<WorkflowHostContext, "spawnChild" | "maxConcurrency">;
// host.test.ts asserts the fit so a Pi rename breaks `check`.
export interface WorkflowHost {
  registerCommand(name, { description?, handler }): void;  // handler gets WorkflowLauncherContext
  getCommands(): ReadonlyArray<{ name: string; source: string }>;
}
// WorkflowHostContext adds spawnChild<T> + readonly maxConcurrency (no sender, no newSession/switchSession).
// WorkflowSessionContext (the child ctx) adds the guaranteed sendUserMessage + optional toolTimeout?().
// Fields touched from sessions/: ctx.spawnChild, obsCtx.ui.notify (reattach.ts resume notices), child.{sendUserMessage, waitForIdle, toolTimeout?}.
```

## Architectural Boundaries
- **Tagged outcomes only across the runner boundary** — extraction returns values; only `WorkflowAbortError` is thrown from `postStage` (abort signal / aborted stop without a watchdog timeout), deliberately before any row write. **Pi-coupling structural only**: `sessions/` never imports `@earendil-works/pi-coding-agent`; the host port is the single seam
- **Cross-session state lives on `s.state`** — `output`, `primaryArtifact`, `stagesCompleted`, `termination.error`, `lastAllocatedStageNumber`, `lastSession` (rolled forward by `recordStageSuccess` for single stages so a downstream `continue` forks it)
- **"Output is set iff the JSONL row landed"** — `recordStageSuccess` (`success-persist.ts`) returns boolean and the caller gates `onSuccess` on it; persistence goes through the shared `persistStageSuccess` pipeline (`../audit-rows.ts`)
- **IDLE-BEFORE-REPROMPT** — re-prompts go through `resendIntoChild` (`sendUserMessage` QUEUES, safe mid-stream; the SDK throws "Agent is already processing" on a mid-stream `prompt()`); `openChild`'s await-idle-then-body sequence is load-bearing and lives in one place
- **Continue is gated on a `locateSessionFile` hit** — no predecessor session file ⇒ degrade to fresh dispatch (`MSG_CONTINUE_FALLBACK`); there is NO host-sender runtime guard anymore

<important if="you are adding a new session policy or open mode">
## Adding a Session Policy
1. Append the literal to `SESSION_POLICIES` in `../stage-def.ts` (re-exported via `../api.ts`; type and runtime guard update together)
2. Add an `OpenMode` arm + a named entry in `spawn.ts` reducing to `openChild`, and a `branchOffsetFor` arm if the policy changes offset semantics — document what the host does with the carried `prompt`
3. Extend `WorkflowHostContext.spawnChild`'s options in `../host.ts` and every host implementation — an open mode is a host-side open semantic
4. Update the load-time preflight (`../validate/stage-rules.ts`) if the policy rejects combos
5. Add a `sessions.test.ts` group: spawn routed with the right mode, offset threading, abort arm
</important>

<important if="you are adding a new fatal classifier">
## Adding a Fatal Classifier
1. Decide the boundary owner: collector-authoritative (return `{ kind: "fatal", message }` from `collect`), parser-authoritative (same from `parse`), or cross-cutting (add a guard inside `produceAndValidateOutput` returning `{ kind: "fatal", message }` BEFORE the retry loop — reuse the `validateOrFatal` shape)
2. Stabilise wording via a `MSG_*` / `ERR_*` constant in `../messages.ts` so audit-row assertions can pin substrings
3. Add a test asserting: `onFailure` called once, notification matches, `state.termination.error` matches, `status: "failed"` JSONL row landed
4. Do NOT add a `HaltReason` arm unless the reason originates outside `OutputProduction` (stop classification, watchdog timeout) — extraction-borne failures must flow through `OutputProduction`'s three arms into the existing `extraction` / `validation` arms
</important>
