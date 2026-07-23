# runner/

## Responsibility
Stage-execution heart of `rpiv-workflow`. Owns graph traversal (`start → edges → next`), the per-stage preflight + mode-dispatch pipeline, the script-stage runtime, chain-advance with per-destination backward-jump budgets, and the resume / run-by-name subsystem. The launcher ctx is NEVER swapped: `detachExecutor` (runner.ts) — the shared detach both `runWorkflow` and `resumeWorkflow` route through — builds the executor host from `getWorkflowExecutionProvider()`, threads provider `resolveModel` + abort signal, and returns a `dispose()` the entries call in `finally`; every stage (and loop unit) runs in its own detached child session via `ctx.spawnChild`, and `executeRun` prunes orphaned child-session files at run end (`referencedSessionIds`). Pi session lifecycle + collector/parser orchestration live in `../sessions/`; the unit-loop driver family is `../loop.ts` + `../loop-kinds.ts` + `../loop-parallel.ts` / `../loop-waves.ts` / `../semaphore.ts` (bounded-parallel, dependency-ordered fanout waves); the runner orchestrates.

## Dependencies
- **`../api`, `../types`, `../host`**: `Workflow`, `StageDef`, `ScriptContext`, `RunContext`, `RunWorkflowOptions/Result` (now in `../types`), `WorkflowHostContext`; **`../execution-host`**: `getWorkflowExecutionProvider`
- **`../sessions/index`**: `runStageSession`, `continueStageSession`, `reattachStageSession`, `locateSessionFile`, `pruneOrphanedChildSessions`; **`../sessions/spawn`**: `forkChildSession` / `reattachChildSession` (detached children)
- **`../loop` / `../loop-kinds` / `../loop-waves`**: `runLoop` / `runFanoutResume` / `pendingFanoutIndices` (driver), `LoopDeps` + `buildLoopEntry` / `freshCursor` / `sequentialStrategyOf` / `foldFanoutCompletion` (kind vocabulary + strategies), `validateUnitDeps`
- **`../state/index`**: `generateRunId`, `writeHeader`, `appendRoutingDecision`, `readAllStagesForResume`, `STATE_SCHEMA_VERSION`; **`../validate-output`**: `validateOutputData` + `runValidationRetryLoop` (shared retry policy); **`../audit` / `../audit-rows`**: terminal-outcome orchestration / pure row persistence + `persistStageSuccess`; **`../chain-state`**: artifact/arg authorities; **`../events`**: `lifecycleCtxFor` + `StageRef` refs

## Consumers
- `runner/index.ts` barrel re-exports `runWorkflow`, `runWorkflowByName`, `resumeWorkflow`, `resumeWorkflowByRunId` (+ their `*Options`), `RunWorkflowResult` (from `../types`), `MAX_BACKWARD_JUMPS` (from `run-context.ts`), `StagePreflightError` (from `errors.ts`). `../command-run.ts` (`/wf`) calls `runWorkflow(...)` and `resumeWorkflowByRunId(...)`

## Module Structure (imports point strictly DOWNWARD — zero value-import cycles, guarded by `dependency-cycles.test.ts`)
```
index.ts, runner.ts  — Barrel + entries (runWorkflow / resumeWorkflow / detachExecutor / executeRun shared tail)
run-stage.ts   — runStage (mode switch) + guarded entries (runStageOrRecordFailure, resumeStageWithSession) + THE WALK COMPOSITION: wires ChainDeps/LoopDeps/advance by injection
chain-advance.ts     — Post-stage routing; decision-edge audit; per-destination jump budgets; onRoute `bypassed` arms
resolve-stage.ts     — ResolvedStage: mode ("loop"|"script"|"prompt"|"skill") + dispatch derived ONCE
preflight.ts, input-validation.ts — Runtime + schema-backed preflights (throw StagePreflightError)
script-stage.ts      — Skillless TS-stage runtime; advance injected via AdvanceFn
failure.ts           — ChainOutcome + withStageEntryGuard + recordEntryThrow/recordAbortedAtSeam + finalizeWorkflow (leaf)
run-context.ts       — buildRunContext (per-run `revisits` Map; reconstructed `visited` reaches lifecycleCtxFor) + freshRunState + caps
errors.ts            — Re-export shim over ../stage-errors.ts (StagePreflightError moved to the package root so ../loop can throw it)
resume.ts, resume-entry.ts, resume-loop.ts — reconstructState (pure RunState fold from the JSONL trail); trailer → re-entry thunk (structured `parent`/`session` dispatch) + refusal rendering; loop-trailer re-entry (pending-only fanout re-dispatch; announce probe via loop-kinds strategies)
by-name.ts, by-run-id.ts — name/run-id entry points
```

## Mode dispatch (derived once — no slot-probing ladder)

```ts
// resolve-stage.ts: mode = effectiveLoopOf(def) ? "loop" : run ? "script" : prompt ? "prompt" : "skill"
export async function runStage(curCtx, currentName, idx, run): Promise<ChainOutcome> {  // run-stage.ts
  const stage = resolveStage(currentName, idx, run);
  switch (stage.mode) {
    case "loop":   return runLoopStage(curCtx, stage, idx, run);   // empty fanout ⇒ single-stage fall-through; then validateUnitDeps halts dep cycles pre-dispatch
    case "script": await ensureInputValid(stage, run); return runScript(curCtx, stage, idx, run, advance);
    case "prompt": case "skill": return runSingleStage(curCtx, stage, idx, run); // preflights → prompt → validate → snapshot → detached child session
  }
}
```

## ChainOutcome + injection composition (T6 + G1)

```ts
// failure.ts: type ChainOutcome = "halted" | "completed" | "dispatched" — every walk arm RETURNS one; halt idiom: `return haltChain(...)`.
// run-stage.ts — the ONE composition site for the walk's mutual recursion:
const CHAIN_DEPS: ChainDeps = { runNext: runStageOrRecordFailure };
export function advance(ctx, name, idx, run) { return advanceChain(ctx, name, idx, run, CHAIN_DEPS); }
// chain-advance takes ChainDeps; script-stage takes AdvanceFn; loop.ts takes LoopDeps — NO engine module imports the composition site back.
```

## Stage-entry guard (uniform JSONL failure row)

```ts
// failure.ts — the ONE classify-then-record policy; both guarded entries (runStageOrRecordFailure live + resumeStageWithSession session-resume — DISJOINT scopes) are one-liners delegating here:
export async function withStageEntryGuard(curCtx, name, run, inner): Promise<ChainOutcome> {
  if (run.signal?.aborted) return recordAbortedAtSeam(curCtx, name, run);
  try { return await inner(); } catch (e) {
    if (isAbortError(e)) return recordAbortedAtSeam(curCtx, name, run); // mid-stage WorkflowAbortError ⇒ abort row
    return recordEntryThrow(curCtx, name, run, e); // StagePreflightError | generic ⇒ terminal failure row
  }
}
```

## Detached sessions + resume seams

- **`sessionPolicy: "continue"`** — `runSingleStage` forks the predecessor's persisted session (`run.state.lastSession` → `continueForkFile` → `forkChildSession` + `continueStageSession`, branch offset re-derived from the fork); no predecessor file ⇒ fresh dispatch + `MSG_CONTINUE_FALLBACK` notify
- **Session-backed resume** — a failed/aborted trailer carrying a structured `session` dispatches `resumeStageWithSession` (resume-entry.ts); `resumeWithSessionLadder` reattaches the persisted child (`reattachChildSession`, promotion → reattach, `branchOffset` from the persisted row); precondition misses degrade to a cold re-run — never a refusal (`MSG_RESUME_SESSION_FALLBACK` notify; the defensive mode-mismatch arm falls back silently)
- **Resume schema gate** — `reconstructState` refuses `header.v !== STATE_SCHEMA_VERSION` (reason `"version-mismatch"`, rendered via `ERR_RESUME_VERSION_MISMATCH`) instead of mis-replaying an old trail
- **Fanout resume** — `resumeLoopStage` re-validates the recomputed DAG (`validateUnitDeps`) then re-dispatches ONLY still-pending indices (`runFanoutResume` / `pendingFanoutIndices`); completed units replay from their journaled slots

## Success persistence + retry policy are SHARED

- `persistStageSuccess` / `applyStageSuccess` (`../audit-rows.ts`) — one success pipeline for the skill path (sessions), the script path, and (apply only) the resume fold; `runValidationRetryLoop` (`../validate-output.ts`) — one produce→validate→retry structure for extraction (re-prompts the agent) and script stages (re-invokes the fn).

## Architectural Boundaries
- **Zero value-import cycles** — `dependency-cycles.test.ts` (Tarjan over static imports, type-only excluded) locks in the Phase-3 SCC dissolution; new back-edges must use injection (ChainDeps/LoopDeps precedent)
- **One classification policy** — `withStageEntryGuard` (failure.ts) is the only exception→JSONL translation; both guarded entries (live + session resume) delegate to it
- **Snapshot is best-effort** — `captureStageSnapshot` warns once per run, never halts; collectors must tolerate `ctx.snapshot === undefined`
- **Script stages bypass `../sessions/`** — audit rows omit `skill`; `recordTerminalFailure` flagged `isScript: true`
- **Routing audit rows are telemetry, never fatal** — dropped writes recorded in `state.telemetry.droppedRoutingRows`; dropped FAILURE rows flag `droppedFailureRows` (resume-unsafe). `state.telemetry.backwardJumps` is cumulative telemetry only — the halt decision reads `run.revisits`

<important if="you are adding a new stage kind (e.g. acts.delay, produces.stream)">
## Adding a Stage Kind
1. DSL accessor in `../stage-def.ts` (barrel-re-exported by `../api.ts`) — mirror the `produces` / `acts` / `terminal` factories; emit `StageDef { kind, ... }` (`gate` is a routing-DSL edge combinator, NOT a stage factory)
2. Validation rule in `../validate/stage-rules.ts` — extend `checkScriptStageInvariants` (or add peer `checkXxxInvariants`; `../validate-workflow.ts` is the thin orchestrator); cover in `validate-workflow.test.ts`
3. Dispatch: extend `StageDispatch`/`StageMode` + `dispatchOf` in `runner/resolve-stage.ts`, add the `runStage` switch arm in `run-stage.ts`; create `runner/xxx-stage.ts` mirroring `script-stage.ts` (takes the injected `advance`; returns `ChainOutcome`)
4. State record fields — add a `StageRef` arm in `../events.ts`; thread new `Output.meta` discriminators via `finalizeOutput` in `../output.ts`
5. Tests — clone `script-stage.test.ts` shape: JSONL row shape + lifecycle order + artifact-isolation regression
</important>

<important if="you are adding a new loop kind (e.g. panel)">
## Adding a Loop Kind
1. Extend the `LoopDef` union + `LOOP_KINDS` in `../loop-def.ts` (re-exported by `../api.ts`); add a constructor in `../loop-constructors.ts`
2. Add the strategy to `LOOP_STRATEGIES` in `../loop-kinds.ts` — base `LoopKindStrategy` carries only `parallelizable`; sequential kinds extend `SequentialStrategy` (`pull` / `guardExpectation` / `hasPending`), while fanout implements only the base and routes through the index-addressed parallel path (`runFanoutParallel` / `runFanoutResume` / `pendingFanoutIndices`). The `satisfies Record` shape makes omission a compile error
3. Per-kind generation-open bits (entryArgs rule, unit precompute) live at the two open sites: `runLoopStage` (run-stage.ts) and the fold's generation open (resume.ts)
4. Validator: kind-specific rules in `checkLoopInvariants` (`../validate/stage-rules.ts`; consumes `LOOP_KINDS`)
</important>
