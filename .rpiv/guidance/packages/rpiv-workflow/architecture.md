# rpiv-workflow

## Monorepo Context
Published Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family. Listed in `siblings.ts`; suggested by `/rpiv-setup` and pre-pinned in rpiv-pi's `peerDependencies`. Loaded by Pi via `pi.extensions: ["./extension.ts"]` — a thin entry pulling only the two registrars; the barrel `index.ts` stays the embedder API surface.

## Responsibility
Chain Pi skills into typed multi-stage workflows. Owns the `/wf` slash command (flag grammar → parse → load → run), the jiti-based config loader, the runner + state JSONL writer, and the authoring DSL (`defineWorkflow`, `produces`/`acts`/`terminal`, `gate`, `defineRoute`, loop constructors `fanout`/`iterate`/`assess` + the `fanin()` read modifier, `progress` lap hooks). Execution is detached: every stage runs in its own spawned child session; the interactive session is launcher/observer only. Skill-agnostic — the runner dispatches `/skill:<name>` via Pi's native skill loader and ships ZERO built-in workflows. Sibling packages (`rpiv-pi`) contribute workflows via `registerBuiltIns(...)` / `registerBuiltInsProvider(...)`.

## `/wf` Command Surface (flag grammar)
`FLAG_EXTRACTORS` declares the flag set — `--name <run-name>`, `--max-jumps <n>` (backward-jump cap), `--max-laps <n>` (lap ceiling) — peeled from leading/trailing positions only via a fixpoint pass; a repeated flag keeps the FIRST-TYPED value in every slot (typed-offset arbitration) and warns (`MSG_FLAG_REPEATED`); a mid-position caps token is absorbed silently while a mid `--name` warns. `@resume` drops `--name` (`MSG_NAME_IGNORED_ON_RESUME`). The parsed `preview` kind is decided on the FLAG-STRIPPED residual, so `/wf <flags> <workflow>` previews that workflow. A cap at/above the lap ceiling warns (`MSG_JUMP_CAP_ABOVE_LAP_CEILING`). Caps thread into `runWorkflow`/`resumeWorkflowByRunId` options; malformed programmatic budgets are refused pre-flight (`validateRunBudgets`). The run-path module is memoized behind a pre-warm timer (`PREWARM_DELAY_MS`) and stale-context notifications drop silently.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): structural host types only, no value imports. **`@standard-schema/spec`** (peer): standard-schema interop for the validation surface
- **`typebox`** (`peerDependencies: "*"`, host-provided): `outputSchema` validation for `produces()` stages (`typebox-adapter.ts`). Pi supplies and aliases `typebox` at load time, so it is never a `dependencies` entry (v2.12.0, #282). **`jiti`** (dependency): loads user `.ts` overlays without a build step. **`@juicesharp/rpiv-config`** (dependency): `configPath` for the user layer

## Consumers
- **`@juicesharp/rpiv-pi`** — registers a lazy provider via `registerBuiltInsProvider` from the `/startup` entry (`registerBuiltIns(builtInWorkflows)` = build/vet/polish/ship, built on first `/wf`, not startup); auto-wires bucket-narrowed `rpivBucketOutcome(bucket)` onto contract-backed `produces()` stages at load time via `registerOutcomeDeriver` (`skill-contracts/extension-points.ts`, re-exported through `/registration` + `/startup`); stages with explicit outcomes (e.g. the verdict outcomes in rpiv-pi's `built-in-workflows.ts`) keep theirs

## Module Structure
```
api.ts (barrel) → stage-def.ts / loop-def.ts / routing-dsl.ts / output-spec.ts
      — Authoring DSL: StageDef union + factories, loop vocabulary, EdgeFn/defineRoute/gate + route notes,
        Output envelope. api.ts only re-exports — each concept has ONE home (stage-identity.ts is consumed
        by chain-state/validate/runner, not the barrel)
command.ts, command-run.ts, preview.ts
      — /wf registration (flag extractors, lazy pre-warmed run path), run path (parse → loadWorkflows →
        runWorkflow), read-only pretty-printers
runner/, load/, state/, sessions/, outcomes/, validate/, skill-contracts/
      — Engine subsystems (each has its own architecture.md): budgets + stage lifecycle + resume,
        layered jiti loader, JSONL run log, detached-session plumbing, bundled outcomes, static
        validation + contract registry extension points
host.ts, execution-host.ts, semaphore.ts
      — Detached-execution ports: `spawnChild`/`maxConcurrency` host ctx + launcher/session subtypes,
        executor-provider seam (rpiv-pi's `SdkWorkflowHost`), FIFO concurrency gate
registration.ts, startup.ts, extension.ts, index.ts
      — Runner-free public surface, ~9ms startup-registrar entry, Pi extension entry, barrel
skill-contract.ts, validate-workflow.ts (thin orchestrator over validate/), validate-output.ts,
   validation-bounds.ts, json-schema.ts, schema-compat.ts, typebox-adapter.ts
      — Contract registry + static/runtime validation + schema interop; every issue carries a `code` +
        `params` (assert/filter on codes, never message text)
loop.ts, loop-kinds.ts, loop-parallel.ts, loop-waves.ts
      — THE unit-loop driver, per-kind strategy table, bounded-parallel dependency-ordered fanout
        dispatch (retryHaltedUnits re-dispatch with per-attempt snapshots), Kahn topological wave levels
events.ts, triggers.ts, routing.ts, audit.ts/audit-ctx.ts/audit-rows.ts, handle.ts, chain-state.ts,
   built-ins.ts, stage-errors.ts, layers.ts, messages.ts, docs-protocol.ts, internal-utils.ts, types.ts,
   death-scene.ts, failure-memos.ts, worktree-digest.ts
      — Runtime plumbing: lifecycle hooks, triggers, routing exec, audit layer, chain-state authorities,
        built-in registry, message constants, docs system-prompt protocol; failure-path resilience below
└── internal.ts — Test-only exports (getBuiltIns, recordStage, runsDir, takeRouteNote, __resetStrikeBudgets, …)
                  reached via `@juicesharp/rpiv-workflow/internal`
```

## Layer Vocabulary
Two file roles per non-built-in layer, merged in this order (later overrides earlier):

| Role | Path (user layer) | Path (project layer) | Default-export shape |
|---|---|---|---|
| **Pack** files (`packs/*.ts`, alpha-sorted) | `~/.config/rpiv-workflow/packs/*.ts` | `<cwd>/.rpiv/workflows/packs/*.ts` | `Workflow \| Workflow[]` — envelope form rejected |
| **Config** file (the one hand-edited file) | `~/.config/rpiv-workflow/config.ts` | `<cwd>/.rpiv/workflows/config.ts` | `Workflow \| Workflow[] \| { workflows?, default?, skillAliases? }` — envelope with at least one of `workflows` / `default` / `skillAliases` (alias-only is valid) |

Within a layer the config file wins by workflow name. Only the config file may set the layer's `default` OR declare `skillAliases`; pack files hard-reject both — eliminates "who set this?" ambiguity. Defaults cascade `project config > user config > first registered workflow`. Alias maps merge per-key with project winning; the merged map applies to every workflow (built-ins included) BEFORE validation and surfaces as the required `LoadedWorkflows.skillAliases`.

## Detached Execution + Run Budgets
Every stage runs in an isolated child session the host spawns via `WorkflowHostContext.spawnChild` (up to `maxConcurrency` in flight; `reattach`/`fork` reopen or fork a persisted session for resume and `sessionPolicy: "continue"`). The `/wf` handler receives the observer-only `WorkflowLauncherContext`; the SDK executor is looked up through the `execution-host.ts` provider seam. Per-unit `ModelSelection` applies at child-session creation, never via global mutation; the UI contract is notify-only. Three run budgets govern backward edges: `maxBackwardJumps` (waive-aware cap — a stage's `progress: () => "improved"` verdict waives it on re-entry), `maxLaps` (absolute, verdict-proof ceiling), `maxIterations`; all fresh per invocation, validated pre-flight, overridable per run by flags or embedder options. Parallel fan-out: `fanout()` takes `concurrency`, `depArtifactFlag`, `retryHaltedUnits` (re-dispatch soft-halted units up to N more attempts, one collected row per attempt); units with `deps` dispatch in Kahn waves; results fold in DECLARED index order so `fanin` synthesis + resume stay deterministic. Route notes (`setRouteNote`) ride every recap (`RunRecap.routingNotes`).

## Failure-Path Resilience
Every stage/unit failure flows through a four-rung ladder — **recover → remember → preserve → gate**:

- **Recover (strikes-then-escalate).** A per-command bash watchdog tool-timeout is recoverable inside the abort-classification ladder (`sessions/` doc): bounded strikes (default 2, clamped `[1,5]` via `RPIV_BASH_TIMEOUT_STRIKES`), re-arm via `child.resetToolTimeout?.()`, re-prompt the SAME child, tail-recurse. Exhaustion escalates to the unchanged `haltStageOrSoftHalt({ kind: "timeout" })` seam. A recovered stage records additive optional `bashTimeoutStrikes` on its completed row.
- **Remember (additive prompt injection).** A bounded failure memo is appended at the two failure-record writers (`recordFatalFailure` / `recordUnitHalt` in `audit.ts`) and rendered as an additive prompt suffix at the two session-construction chokepoints — and re-entered from a collected row's `errMsg` during the budget-aware resume fold. ADDITIVE-ONLY: zero memos ⇒ `""` ⇒ byte-identical prompt.
- **Preserve (death-scene artifact).** On any transition to failed, a forensic Markdown artifact is written under `<cwd>/.rpiv/artifacts/failures/` immediately after the memo, sourced PURELY from the persisted session JSONL via the host-injected `readSessionBranch` reader. Synchronous, fail-soft, sidecar `.md` — never read by resume.
- **Gate (validation-retry).** A schema-validated `produces()` stage does not blind-retry against an unchanged worktree: mechanism-1 wraps each `askAgentToFix` retry with a worktree digest (tracked files AND `.rpiv/artifacts/`, minus the `failures/` subtree; git subprocess bounded at 10 s); mechanism-2 (`gateValidationRedispatch`) blocks a re-dispatch whose `lastGatedDispatch` matches (same stage, same digest, `stagesCompleted` unchanged). Both gates degrade to always-proceed when the digest is `undefined`; operator resume is excluded from mechanism-2.

The two failure-record writers in `audit.ts` are the load-bearing seam: a strike-exhausted failure picks up the memo and the death-scene artifact for FREE — the integration is structural, at the writer, not at the strike site.

## Public API (grouped by audience)

| Audience | Key exports |
|---|---|
| Authoring DSL (config + pack authors) | `defineWorkflow`, `produces`, `acts`, `terminal`, `defineRoute`, `gate`, `setRouteNote`, `fanout`/`iterate`/`assess`, `fanin`, `judge`/`panel`/`verify`, `match`/`majority`/`all`/`any`, `gt`/`gte`/`lt`/`lte`/`eq`, `READS_DATA`, `marksReadsData`, `Workflow`, `StageDef`, `StageKind`, `typeboxSchema`, `describeFlow`, `loopSpecOf`/`judgeSpecOf` |
| Programmatic embedders | `runWorkflow`, `runWorkflowByName`, `resumeWorkflow`, `resumeWorkflowByRunId` (+ `*Options` incl. `RunBudgetOptions`), `RunWorkflowResult`, `WorkflowHost`, `WorkflowHostContext`/`WorkflowSessionContext`, `ModelSelection`, `MAX_BACKWARD_JUMPS`/`MAX_LAPS`/`MAX_ITERATIONS`, `validateRunBudgets` |
| Loader consumers | `loadWorkflows`, `LoadedWorkflows` (carries required `skillAliases` + `skillContracts`), `Issue`, `LoadIssue`, `ConfigLayer`, `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`, `aliasSkills` |
| Sibling packages (via the ~9ms `/startup` entry) | `registerBuiltIns`, `registerBuiltInsProvider`, `registerLifecycle`, `registerWorkflowExecutionHost`, `registerSkillContracts(Provider)`, `registerOutcomeDeriver` (skill-contract extension points), `summarizeRun` |
| Custom outcome authors | `Outcome` (`OutputSpec` is its deprecated pre-rename alias), `ArtifactCollector`, `ArtifactParser`, `CollectContext`/`ParseContext`/`SnapshotContext`, `defineCollector`, `defineParser` |
| State inspection | `listRuns`, `readHeader`, `readLastStage`, `readLoopCaps`, `resolveRun`, `listArtifacts`, `summarizeRun`/`RunRecap`, `runFileFor` (the one OPAQUE path projection), `STATE_SCHEMA_VERSION` |
| Bundled outcomes catalog | `sideEffectOutcome`, `gitCommitOutcome`; collectors `transcriptPathCollector`, `toolCallCollector`, `workspaceDiffCollector`, `gitCommitCollector`, `directoryPathCollector`, `urlCollector`, `unionCollectors`, `noopCollector`; parsers `jsonBodyParser`, `gitCommitParser` |

## Architectural Boundaries
- **Skill-agnostic** — ZERO built-in workflows ship from this package; siblings register via `registerBuiltIns(...)`
- **Pi-coupling: structural only** — the public type surface names ZERO `@earendil-works/pi-coding-agent` types; `host.test.ts` carries a compile-time tripwire that fails if Pi's types drift below the port shape
- **Five export entries, no per-module deep imports** — the exports map exposes `.`, `./startup`, `./registration`, `./runner`, and the test-only `./internal`; startup-time siblings use `/startup` or `/registration` so they never drag the runner (~530ms) onto the startup path. Per-module deep imports (e.g. `/api.js`) are NOT supported
- **Detached, never swapped** — stages execute in spawned child sessions; the parent ctx stays valid. Host implementations must supply `spawnChild` + `maxConcurrency`; the UI contract is notify-only
- **State trails are schema-versioned** — rows record under `STATE_SCHEMA_VERSION` (currently 3); resuming a run recorded under any previous schema is refused with a version mismatch, never mis-replayed (no in-place migration)
- **No foreground/background lanes** — questions from any stage (parallel units included) defer through the relay instead of grabbing the live UI
- **Loader never throws to its caller** — every load + validation error flows through `LoadedWorkflows.issues`; the runner gates on `severity === "error"` issues
- **Legacy `.rpiv-workflow/` advisory** — when legacy layouts still exist, the loader emits one-shot advisories carrying migration shells (`load/legacy.ts`); the dashed directory is no longer read. Sunset target: ~3 release cycles post-1.0

<important if="you are extending the /wf command surface (new flag or parse kind)">
1. Add the flag to `FLAG_EXTRACTORS` in `command.ts` (name + extractor); peeling, repeat-arbitration, and warning plumbing are generic
2. Thread the parsed value through `command-run.ts` into the run options (and `validateRunBudgets` if it is a budget); cap-vs-ceiling cross-warnings live in `command-run.ts`
3. Cover the permutation shapes in `command.test.ts` (leading/trailing/repeated/mid-position) — an exhaustive permutation property already exists for repeats
4. Update `MSG_*` constants in `messages.ts` for any new user-facing warning; audit by substring pin
</important>
