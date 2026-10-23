# runner/

## Responsibility
Stage-execution heart of `rpiv-workflow`. Owns graph traversal (`start → edges → next`), the run-budget system (backward-jump cap + absolute lap ceiling + iteration cap, with `progress`-hook waivers), the per-stage preflight + mode-dispatch pipeline, the script-stage runtime, chain-advance with route notes, and the resume / run-by-name subsystem. The launcher ctx is NEVER swapped: `detachExecutor` (runner.ts) — the shared detach both `runWorkflow` and `resumeWorkflow` route through — builds the executor host from `getWorkflowExecutionProvider()`, threads provider `resolveModel` + abort signal, and returns a `dispose()` the entries call in `finally`; every stage (and loop unit) runs in its own detached child session via `ctx.spawnChild`, and `executeRun` prunes orphaned child-session files at run end (`referencedSessionIds`). Pi session lifecycle + collector/parser orchestration live in `../sessions/`; the unit-loop driver family is `../loop.ts` + `../loop-kinds.ts` + `../loop-parallel.ts` / `../loop-waves.ts` / `../semaphore.ts`; the runner orchestrates.

## Dependencies
- **`../api`, `../types`, `../host`**: `Workflow`, `StageDef`, `ScriptContext`, `RunContext`, `RunWorkflowOptions/Result`, `WorkflowHostContext`; **`../execution-host`**: `getWorkflowExecutionProvider`
- **`../sessions/index`**: `executeStageSession`, `continueStageSession`, `reattachStageSession`, `locateSessionFile`, `pruneOrphanedChildSessions`; **`../sessions/spawn`**: `forkChildSession` / `reattachChildSession` (detached children)
- **`../loop` / `../loop-kinds` / `../loop-waves`**: `runLoop` / `runFanoutResume` / `pendingFanoutIndices` (driver), `LoopDeps` + `buildLoopEntry` / `freshCursor` / `sequentialStrategyOf` / `foldFanoutCompletion` (kind vocabulary + strategies), `ensureUnitDeps`
- **`../loop-constructors`, `../judge`, `../failure-memos`, `../worktree-digest`** (retry steering, verdict slots, memo suffixes, validation-retry digests)
- **`../state/index`**: `generateRunId`, `appendHeader`, `appendRoutingDecision`, `readAllStagesForResume`, `STATE_SCHEMA_VERSION`; **`../validate-output`**: `validateOutputData` + `runValidationRetryLoop` (shared retry policy); **`../audit` / `../audit-rows`**: terminal-outcome orchestration / pure row persistence + `persistStageSuccess`; **`../chain-state`**: artifact/arg authorities; **`../events`**: `lifecycleCtxFor` + `StageRef` refs

## Consumers
- `runner/index.ts` barrel re-exports `runWorkflow`, `runWorkflowByName`, `resumeWorkflow`, `resumeWorkflowByRunId` (+ their `*Options`), `RunWorkflowResult` (from `../types`), `MAX_BACKWARD_JUMPS`, `MAX_LAPS`, `MAX_ITERATIONS`, `RunBudgetOptions`, `validateRunBudgets`, `StagePreflightError` (from `errors.ts`). `../command-run.ts` (`/wf`) calls `runWorkflow(...)` / `resumeWorkflowByRunId(...)` threading flag-parsed caps

## Module Structure (imports point strictly DOWNWARD — zero value-import cycles, guarded by `dependency-cycles.test.ts`)
```
index.ts, runner.ts  — Barrel + entries (runWorkflow / resumeWorkflow / detachExecutor / executeRun shared tail)
run-stage.ts   — dispatchStage (mode switch) + guarded entries (dispatchStageOrRecordFailure, resumeStageWithSession) + THE WALK COMPOSITION: wires ChainDeps/LoopDeps/advance by injection + gateValidationRedispatch
chain-advance.ts     — Post-stage routing; decision-edge audit; route notes; the backward-jump guard (cap + ceiling, progress-waived); onRoute `stop`/next arms
resolve-stage.ts     — ResolvedStage: mode ("loop"|"script"|"prompt"|"skill") + dispatch derived ONCE
preflight.ts, input-validation.ts — Runtime + schema-backed preflights (throw StagePreflightError via haltPreflight/invariantPreflight)
script-stage.ts      — Skillless TS-stage runtime; advance injected via AdvanceFn
failure.ts           — ChainOutcome + withStageEntryGuard + recordEntryThrow/recordAbortedAtSeam + finalizeWorkflow (leaf)
run-context.ts       — buildRunContext (budgets: revisits + laps ledgers + progressTrail ring; `visited` reconstructed on resume drives the backward-jump guard) + freshRunState + budget validation
errors.ts            — Re-export shim over ../stage-errors.ts (StagePreflightError lives at the package root so ../loop can throw it; also re-exports haltPreflight/invariantPreflight)
resume.ts, resume-entry.ts, resume-loop.ts — reconstructState (pure RunState fold from the JSONL trail; schema-version gate); trailer → re-entry thunk (structured `parent`/`session` dispatch) + refusal rendering; loop-trailer re-entry (budget-aware fanout re-dispatch; announce probe via loop-kinds strategies)
by-name.ts, by-run-id.ts — name/run-id entry points
```

## Run Budgets (three, pre-flight-validated)
`RunBudgetOptions { maxBackwardJumps, maxLaps, maxIterations }` with module defaults `MAX_BACKWARD_JUMPS = 3`, `MAX_LAPS = 8`, `MAX_ITERATIONS = 32`; `validateRunBudgets` refuses NaN/negative/malformed budgets in BOTH entries BEFORE any row is written. Embedders widen a single run via options; `/wf --max-jumps` / `--max-laps` thread through `command-run.ts`. Budgets are FRESH PER INVOCATION — a resume re-opens with empty `revisits`/`laps`/`progressTrail` ledgers.

## The Backward-Jump Guard (cap + ceiling, ceiling-first)
Two ledgers on `RunContext`: `revisits` (waive-aware cap arm) and `laps` (absolute, verdict-proof). On decision-edge re-entry, `evaluateBackwardJumpGuard` (chain-advance.ts) invokes the stage's `progress` hook (fail-soft, only on whole-lap re-entry; verdict ring `PROGRESS_VALUES = improved|unchanged|regressed|unknown`, trail depth 3 rides the halt text), then arbitrates CEILING-FIRST: the `laps` count vs `maxLaps` always halts regardless of verdicts; `"improved"` waives ONLY the `revisits` cap arm. Deterministic cycle edges (A→B→A with stable routing) are not counted. `state.telemetry.backwardJumps` stays cumulative-only telemetry — decisions read the ledgers.

## Route Notes (named defer evidence)
`setRouteNote` (routing-dsl, exported) attaches a note to the current route decision; `takeRouteNote` is the read-and-clear read side. Guard notes compose `"; "`-joined after the edge note on re-entry rows; a NOTED decision-stop routes to a blocked `FAIL_GATE_STOP` halt instead of finalize. Notes ride every recap (`RunRecap.routingNotes`).

## Mode dispatch (derived once — no slot-probing ladder)
```ts
// resolve-stage.ts: mode = effectiveLoopOf(def) ? "loop" : run ? "script" : prompt ? "prompt" : "skill"
export async function dispatchStage(hostCtx, currentName, idx, run): Promise<ChainOutcome> {  // run-stage.ts
  const stage = resolveStage(currentName, idx, run);
  switch (stage.mode) {
    case "loop":   return runLoopStage(hostCtx, stage, idx, run);   // empty fanout ⇒ single-stage fall-through; ensureUnitDeps halts dep cycles pre-dispatch
    case "script": await ensureInputValid(stage, run); return runScript(hostCtx, stage, idx, run, advance);
    case "prompt": case "skill": return runSingleStage(hostCtx, stage, idx, run); // preflights → prompt → validate → snapshot → detached child session
  }
}
```

## ChainOutcome + injection composition
```ts
// failure.ts: type ChainOutcome = "halted" | "completed" | "dispatched" — every walk arm RETURNS one; halt idiom: `return haltChain(...)`.
// run-stage.ts — the ONE composition site for the walk's mutual recursion:
const CHAIN_DEPS: ChainDeps = { runNext: dispatchStageOrRecordFailure };
export function advance(ctx, name, idx, run) { return advanceChain(ctx, name, idx, run, CHAIN_DEPS); }
// chain-advance takes ChainDeps; script-stage takes AdvanceFn; loop.ts takes LoopDeps — NO engine module imports the composition site back.
```

## Stage-entry guard (uniform JSONL failure row)
```ts
// failure.ts — the ONE classify-then-record policy; both guarded entries (dispatchStageOrRecordFailure live +
// resumeStageWithSession session-resume — DISJOINT scopes) are one-liners delegating here:
export async function withStageEntryGuard(hostCtx, name, run, inner): Promise<ChainOutcome> {
  if (run.signal?.aborted) return recordAbortedAtSeam(hostCtx, name, run);
  try { return await inner(); } catch (e) {
    if (isAbortError(e)) return recordAbortedAtSeam(hostCtx, name, run); // mid-stage WorkflowAbortError ⇒ abort row
    return recordEntryThrow(hostCtx, name, run, e); // StagePreflightError | generic ⇒ terminal failure row
  }
}
```

## Detached sessions + resume seams

- **`sessionPolicy: "continue"`** — `runSingleStage` forks the predecessor's persisted session (`run.state.lastSession` → `continueForkFile` → `forkChildSession` + `continueStageSession`, branch offset re-derived from the fork); no predecessor file ⇒ fresh dispatch + `MSG_CONTINUE_FALLBACK` notify
- **Session-backed resume** — a failed/aborted trailer carrying a structured `session` dispatches `resumeStageWithSession` (resume-entry.ts); `resumeWithSessionLadder` reattaches the persisted child (`reattachChildSession`, promotion → reattach, `branchOffset` from the persisted row); precondition misses degrade to a cold re-run — never a refusal (`MSG_RESUME_SESSION_FALLBACK` notify; the defensive mode-mismatch arm falls back silently); a gate-stop trailer re-measures side-effect outcomes instead of re-prompting
- **Resume schema gate** — `reconstructState` refuses any header `v !== STATE_SCHEMA_VERSION` (reason `"version-mismatch"`, rendered via `ERR_RESUME_VERSION_MISMATCH`) instead of mis-replaying an old trail; v1 and v2 trails both refuse against v3
- **Budget-aware fanout resume** — `resumeLoopStage` re-validates the recomputed DAG (`ensureUnitDeps`) then re-dispatches ONLY still-pending indices; a `collected:true` row whose `attemptOrdinal` is still under the `retryHaltedUnits` budget leaves its slot UNFILLED (no sentinel folded) so the unit re-dispatches, and its `errMsg` re-enters the failure-memo ledger so the retry prompt matches the live path; completed units replay from journaled slots, and closed fanout generations are trusted from recorded units (`scanClosedFanoutGenerations`) rather than recomputed
- **`gateValidationRedispatch`** — before re-dispatching a qualifying `produces` stage, mechanism-2 compares `lastGatedDispatch` (same stage + same worktree digest + `stagesCompleted` unchanged) and records a terminal failure on a no-edit re-dispatch; operator resume (`trigger.meta.resumedFrom`) is excluded

## Success persistence + retry policy are SHARED
`persistStageSuccess` / `applyStageSuccess` (`../audit-rows.ts`) — one success pipeline for the skill path (sessions), the script path, and (apply only) the resume fold; `runValidationRetryLoop` (`../validate-output.ts`) — one produce→validate→retry structure for extraction (re-prompts the agent) and script stages (re-invokes the fn).

## Architectural Boundaries
- **Zero value-import cycles** — `dependency-cycles.test.ts` (Tarjan over static imports, type-only excluded) locks the SCC dissolution; new back-edges must use injection (ChainDeps/LoopDeps precedent)
- **One classification policy** — `withStageEntryGuard` (failure.ts) is the only exception→JSONL translation; both guarded entries (live + session resume) delegate to it
- **Budgets validated pre-flight, fresh per invocation** — malformed budgets never write a row; a resumed run never inherits the prior invocation's counts
- **Ceiling is verdict-proof** — `progress: "improved"` can waive the jump cap, never the lap ceiling
- **Script stages bypass `../sessions/`** — audit rows omit `skill`; `recordFatalFailure` flagged `isScript: true`
- **Routing audit rows are telemetry, never fatal** — dropped writes recorded in `state.telemetry.droppedRoutingRows`; dropped FAILURE rows flag `droppedFailureRows` (resume-unsafe). `haltLoopWhenAllFailed` (`FAIL_FANOUT_ALL_FAILED`) halts a fanout whose slots all failed

<important if="you are adding a new stage kind (e.g. acts.delay, produces.stream)">
1. DSL accessor in `../stage-def.ts` (barrel-re-exported by `../api.ts`) — mirror the `produces` / `acts` / `terminal` factories; emit `StageDef { kind, ... }` (`gate` is a routing-DSL edge combinator, NOT a stage factory)
2. Validation rule in `../validate/stage-rules.ts` — extend the per-kind invariants; cover in `validate-workflow.test.ts`
3. Dispatch: extend `StageDispatch`/`StageMode` + `dispatchOf` in `runner/resolve-stage.ts`, add the `dispatchStage` switch arm in `run-stage.ts`; create `runner/xxx-stage.ts` mirroring `script-stage.ts` (takes the injected `advance`; returns `ChainOutcome`)
4. State record fields — add a `StageRef` arm in `../events.ts`; thread new `Output.meta` discriminators via `finalizeOutput` in `../output.ts`
5. Tests — clone `script-stage.test.ts` shape: JSONL row shape + lifecycle order + artifact-isolation regression
</important>

<important if="you are adding a new loop kind (e.g. panel)">
1. Extend the `LoopDef` union + `LOOP_KINDS` in `../loop-def.ts` (re-exported by `../api.ts`); add a constructor in `../loops/constructors.ts`
2. Add the strategy to `LOOP_STRATEGIES` in `../loop-kinds.ts` — base `LoopKindStrategy` carries only `parallelizable`; sequential kinds extend `SequentialStrategy` (`pull` / `guardExpectation` / `hasPending`), while fanout implements only the base and routes through the index-addressed parallel path (`runFanoutParallel` / `runFanoutResume` / `pendingFanoutIndices`). The `satisfies Record` shape makes omission a compile error
3. Per-kind generation-open bits (entryArgs rule, unit precompute) live at the two open sites: `runLoopStage` (run-stage.ts) and the fold's generation open (resume.ts)
4. Validator: kind-specific rules in `checkLoopInvariants` (`../validate/stage-rules.ts`; consumes `LOOP_KINDS`)
</important>
