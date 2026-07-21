# rpiv-workflow

## Monorepo Context
Published Pi extension in `rpiv-mono`. Lockstep version with the rest of the `@juicesharp/rpiv-*` family. Listed in `siblings.ts`; suggested by `/rpiv-setup` and pre-pinned in rpiv-pi's `peerDependencies`. Loaded by Pi via `pi.extensions: ["./extension.ts"]` — a thin entry pulling only the two registrars; the barrel `index.ts` stays the embedder API surface.

## Responsibility
Chain Pi skills into typed multi-stage workflows. Owns the `/wf` slash command, the jiti-based config loader, the runner + state JSONL writer, and the authoring DSL (`defineWorkflow`, `produces`/`acts`/`terminal`, `gate`, `defineRoute`, loop constructors `fanout`/`iterate`/`assess` + the `fanin()` read modifier). Execution is detached: every stage runs in its own spawned child session; the interactive session is launcher/observer only. Skill-agnostic — the runner dispatches `/skill:<name>` via Pi's native skill loader and ships ZERO built-in workflows. Sibling packages (`rpiv-pi`) contribute workflows via `registerBuiltIns(...)` / `registerBuiltInsProvider(...)`.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): structural host types only; no value imports
- **`@standard-schema/spec`** (peer): standard-schema interop for the validation surface
- **`typebox`** (dependency): `outputSchema` validation surface for `produces()` stages — declared directly (not a peer), so installs that don't materialize peers still validate `produces()` outputs (`typebox-adapter.ts`)
- **`jiti`** (dependency): loads user `.ts` overlays without a build step
- **`@juicesharp/rpiv-config`** (dependency): `configPath` for the user layer

## Consumers
- **`@juicesharp/rpiv-pi`** — registers a lazy provider via `registerBuiltInsProvider` from the `/startup` entry (`registerBuiltIns(builtInWorkflows)` = ship/arch/vet/polish/build, built on first `/wf`, not startup); auto-wires bucket-narrowed `rpivBucketOutcome(bucket)` onto contract-backed `produces()` stages at load time via `registerOutcomeDeriver` (`outcome-derivation.ts`); stages with explicit outcomes (e.g. the verdict outcomes in `built-in-workflows.ts`) keep theirs.

## Module Structure
```
.
├── api.ts (barrel) → stage-def.ts / stage-identity.ts / loop-def.ts / routing-dsl.ts,
│   loop-constructors.ts → loops/{constructors,derivations,introspection,panel,verify}.ts,
│   judge.ts, predicates.ts, output.ts/output-spec.ts
│                          — Authoring DSL: StageDef union + factories (stage-def), loop
│                            vocabulary (loop-def; constructors + panel/verify in loops/), EdgeFn/
│                            defineRoute/gate (routing-dsl), Judge/panel concept, predicate helpers;
│                            Output envelope. api.ts only re-exports — each concept has ONE home
├── command.ts, command-run.ts, preview.ts
│                          — `/wf` registration (lazy-imports the run path), run path
│                            (parse → loadWorkflows → runWorkflow), read-only pretty-printers
├── runner/, load/, state/, sessions/, outcomes/
│                          — Engine subsystems (each has its own architecture.md): stage lifecycle +
│                            resume, layered jiti loader, JSONL run log, session policy, bundled outcomes
├── host.ts, execution-host.ts, semaphore.ts
│                          — Detached-execution ports: `spawnChild`/`maxConcurrency` host ctx +
│                            launcher/session subtypes, executor-provider injection seam (rpiv-pi's
│                            `SdkWorkflowHost`), bounded-concurrency FIFO gate
├── registration.ts, startup.ts, extension.ts, index.ts
│                          — Runner-free public surface, ~9ms startup-registrar entry, Pi extension
│                            entry, public barrel (`registration` + runner)
├── skill-contract.ts + skill-contracts/, validate-workflow.ts + validate/, validate-output.ts,
│   validation-bounds.ts, json-schema.ts, schema-compat.ts, typebox-adapter.ts
│                          — Contract registry + static/runtime validation + schema interop.
│                            validate-workflow.ts is a thin orchestrator over validate/{issue,graph,
│                            stage-rules,contract-compat}.ts; every issue carries a machine-readable
│                            `code` + `params` (assert/filter on codes, never message text)
├── loop.ts, loop-kinds.ts, loop-parallel.ts, loop-waves.ts
│                          — THE unit-loop driver, per-kind strategy table, bounded-parallel
│                            dependency-ordered fanout dispatch, Kahn topological wave levels
├── events.ts, triggers.ts, routing.ts, audit.ts/audit-ctx.ts/audit-rows.ts, handle.ts,
│   transcript.ts, chain-state.ts, built-ins.ts, stage-errors.ts, layers.ts, messages.ts,
│   docs-protocol.ts, internal-utils.ts, types.ts
│                          — Runtime plumbing: lifecycle hooks, triggers, routing exec, audit
│                            layer (ctx/rows split), chain-state authorities, built-in registry,
│                            message constants, docs system-prompt protocol
└── internal.ts            — Test-only exports (getBuiltIns, recordStage, runsDir, stateFilePath, …)
                             reached via `@juicesharp/rpiv-workflow/internal`
```

## Layer Vocabulary
Two file roles per non-built-in layer, merged in this order (later overrides earlier):

| Role | Path (user layer) | Path (project layer) | Default-export shape |
|---|---|---|---|
| **Pack** files (`packs/*.ts`, alpha-sorted) | `~/.config/rpiv-workflow/packs/*.ts` | `<cwd>/.rpiv/workflows/packs/*.ts` | `Workflow \| Workflow[]` — envelope form rejected |
| **Config** file (the one hand-edited file) | `~/.config/rpiv-workflow/config.ts` | `<cwd>/.rpiv/workflows/config.ts` | `Workflow \| Workflow[] \| { workflows?, default?, skillAliases? }` — envelope with at least one of `workflows` / `default` / `skillAliases` (alias-only is valid) |

Within a layer the config file wins by workflow name. Only the config file may set the layer's `default` OR declare `skillAliases` (a `Record<string, string>` rewriting `stage.skill` at load time); pack files hard-reject both for the same reason — eliminates "who set this?" ambiguity across overlapping packs. Defaults cascade `project config > user config > first registered workflow`. Alias maps merge per-key with project winning ties; the merged map is applied to every workflow (built-ins included) BEFORE validation and surfaces as the required `LoadedWorkflows.skillAliases` field.

`OverlayPaths.configFile` + `OverlayPaths.packsDir` are the public-surface field names; `FileKind = "config" | "pack"` is the loader's internal kind discriminator.

## Detached Execution
Every stage runs in an isolated child session the host spawns via `WorkflowHostContext.spawnChild` (up to `maxConcurrency` in flight; `reattach`/`fork` reopen or fork a persisted session for resume and `sessionPolicy: "continue"`). The `/wf` handler receives the observer-only `WorkflowLauncherContext` (`Omit<WorkflowHostContext, "spawnChild" | "maxConcurrency">`) — Pi's `ExtensionCommandContext` satisfies it structurally; the SDK executor (`SdkWorkflowHost`, in rpiv-pi) is looked up through the `execution-host.ts` provider seam. Per-unit `ModelSelection` applies at child-session creation, never via global mutation; the UI contract is notify-only.

Parallel fan-out rides on this: `fanout()` takes an optional `concurrency` ceiling (1 serializes) and `depArtifactFlag` (injects each dependency's artifact path into dependent prompts); units with `deps` dispatch in Kahn waves (`loop-waves.ts`); results fold in DECLARED index order so `fanin` synthesis + resume stay deterministic. Lifecycle: `onUnitHalt` fires on a collect-all soft-halt, `onRoute` receives a `bypassed` recovery-arms list, and `LifecycleContext.visited` is reconstructed from the trail on resume. Watchdog tool timeouts (`toolTimeout()` on the session ctx) route through the soft-halt gate instead of throwing `WorkflowAbortError` — resuming must not re-dispatch the runaway command.

## Public API (grouped by audience)

| Audience | Key exports |
|---|---|
| Authoring DSL (config + pack authors) | `defineWorkflow`, `produces`, `acts`, `terminal`, `defineRoute`, `gate`, `fanout`/`iterate`/`assess`, `fanin`, `judge`/`panel`/`verify`, `gt`/`gte`/`lt`/`lte`/`eq`, `READS_DATA`, `marksReadsData`, `Workflow`, `StageDef`, `StageKind`, `typeboxSchema` |
| Programmatic embedders | `runWorkflow`, `runWorkflowByName`, `resumeWorkflow`, `resumeWorkflowByRunId` (+ their `*Options`), `RunWorkflowResult`, `WorkflowHost`, `WorkflowHostContext`/`WorkflowSessionContext`/`WorkflowLauncherContext`, `ModelSelection` |
| Loader consumers | `loadWorkflows`, `LoadedWorkflows` (carries a required `skillAliases: Readonly<Record<string, string>>` — `{}` when no layer declared aliases), `Issue`, `LoadIssue`, `ConfigLayer`, `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`, `aliasSkills` (siblings apply the same remap to a built-in workflow before handing it to `runWorkflow`) |
| Sibling packages (via the ~9ms `/startup` entry) | `registerBuiltIns`, `registerBuiltInsProvider`, `registerLifecycle`, `registerWorkflowExecutionHost`, `registerSkillContracts(Provider)` |
| Custom outcome authors | `Outcome` (`OutputSpec` is its deprecated pre-rename alias), `ArtifactCollector`, `ArtifactParser`, `CollectCtx`/`ParseCtx`/`SnapshotCtx`, `defineCollector`, `defineParser` |
| State inspection | `listRuns`, `readHeader`, `readLastStage`, `readLoopCaps`, `resolveRun`, `listArtifacts`, `runFileFor` (the one OPAQUE path projection), `STATE_SCHEMA_VERSION` |
| Bundled outcomes catalog | `sideEffectOutcome`, `gitCommitOutcome`; collectors `transcriptPathCollector`, `toolCallCollector`, `workspaceDiffCollector`, `gitCommitCollector`, `directoryPathCollector`, `urlCollector`, `unionCollectors`, `noopCollector`; parsers `jsonBodyParser`, `gitCommitParser` |

## Architectural Boundaries
- **Skill-agnostic** — ZERO built-in workflows ship from this package; siblings register via `registerBuiltIns(...)`
- **Pi-coupling: structural only** — the public type surface names ZERO `@earendil-works/pi-coding-agent` types; `host.test.ts` carries a compile-time tripwire that fails if Pi's types drift below the port shape
- **Five export entries, no per-module deep imports** — the exports map exposes `.`, `./startup`, `./registration`, `./runner`, and the test-only `./internal`; startup-time siblings use `/startup` or `/registration` so they never drag the runner (~530ms) onto the startup path. Per-module deep imports (e.g. `/api.js`) are NOT supported
- **Detached, never swapped** — stages execute in spawned child sessions; the parent ctx stays valid (no session-swap methods exist). Host implementations must supply `spawnChild` + `maxConcurrency`; the UI contract is notify-only
- **State trails are schema-versioned** — rows record under `STATE_SCHEMA_VERSION`; resuming a run recorded under a previous schema is refused with a version mismatch, never mis-replayed (no in-place migration)
- **No foreground/background lanes** — the `interaction` skill-contract field and its fan-out validator are gone; questions from any stage (parallel units included) defer through the relay instead of grabbing the live UI
- **Loader never throws to its caller** — every load + validation error flows through `LoadedWorkflows.issues`; the runner gates on `severity === "error"` issues
- **Config file is the only `default` / `skillAliases` source** — pack files' `default` AND `skillAliases` fields are rejected at normalisation, eliminating "who set this?" ambiguity across overlapping packs
- **Legacy `.rpiv-workflow/` advisory** — when `<cwd>/.rpiv-workflow/` still exists, the loader emits a one-shot project-layer warning carrying the migration shell (`LEGACY_OVERLAY_NOTICE` in `load/legacy.ts`, beside the sibling `LEGACY_RUNS_NOTICE`); the dashed directory is no longer read. Sunset target: ~3 release cycles post-1.0 — remove the `existsSync` probe + the message constant + the co-located migration-shell test together.
