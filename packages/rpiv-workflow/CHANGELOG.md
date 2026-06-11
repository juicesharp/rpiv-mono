# @juicesharp/rpiv-workflow

## [Unreleased]

### Added
- `Judge` is now a first-class type with a valid-by-construction `judge({ skill | prompt, outcome })` factory. A judge names a dispatchable grading session — `skill` (`/skill:<skill> <producerHandle>`, producer artifact auto-injected) XOR `prompt` (raw text) — whose verdict is validated by `outcome` and published to its own dedicated `state.named` channel. The collector must materialize ≥1 artifact (zero is a fatal halt). `judgeShapeIssues` is the single shape-rule source shared by the factory and load-time validation.
- Structured unit-row JSONL fields (`parent` / `role` / `unitId` / `unitIndex`) on every loop-unit row, plus a `{type:"loop-cap"}` telemetry row (`appendLoopCap` / `readLoopCaps`) written when an `onCap: "advance"` soft-stop trips. Readers shape-filter on `stageNumber`, so the new rows are skipped by existing stage/telemetry readers.
- Unit-generic lifecycle hooks `onLoopStart` / `onUnitStart` / `onUnitEnd` / `onLoopCap` (payloads `LoopStartInfo` / `UnitEvent` / `LoopCapInfo`). `onUnitStart` fires uniformly for produce AND judge units — the race-free seam (units run strictly sequentially) a model-override listener flips the model on, resolving per-unit models through the existing `models.json` `skills.<name>` cascade.
- **`verify` — per-stage post-condition judge.** A `produces` stage can declare `verify: verify({ judge, pass, feedForward?, maxAttempts? })`: after each attempt, the judge session grades the attempt's artifact and `pass(verdict)` gates advancement — fail retries with `feedForward` feedback up to `maxAttempts` (default 1 = gate-only), then halts with "verification failed" (a pass on the final attempt is a normal completion). Implemented as a desugar into the unified loop driver (`done: pass`, `onCap: "halt"`, `result: "last"`), so verify inherits the pair-restore, per-attempt snapshot, and crash-resume machinery (pending verify re-runs; recovered verdicts recompute `pass`; predicate drift refuses). New exports: `verify()`, `verifyShapeIssues`, `judgeSpecOf`, `type VerifySpec`, `type JudgeSpec`. Attempts/verdicts land as unit rows (`role: "produce"` / `role: "verify"`, labels `a{n}·attempt` / `a{n}·verify`); the verdict publishes to its own `state.named[judge.outcome.name]` channel for declarative fallback routing; preview decorates `verify(skill:<name>)` / `verify(prompt)`; `StageShape` gains a `verify` projection.

### Changed
- **BREAKING** — the three organically-grown loop primitives are replaced by ONE `loop:` field on `StageDef`, authored via the `fanout()` / `iterate()` / `assess()` constructors. The old `fanout:` / `iterate:` / `assess:` `StageDef` fields and the `fanoutOver(spec)` / `iterateOver(spec)` wrappers are **removed**. Every unit now runs the identical stage-session path with a structured unit identity; one declared `result` projection (`"entry"` / `"last"`) replaces three implicit state semantics; one async resume fold with a full-row drift guard replaces three folds + three re-entry modules. `loopSpecOf(stage.loop)` is the single introspection channel; `describeFlow` reports `control.mode: "single" | "fanout" | "iterate" | "assess"` from the `loop` field. Constructors validate at construction (`max` must be an integer ≥ 1; assess defaults `max` to 8, `onCap` to `"advance"`); the same rules are re-checked at load for hand-rolled literals.
- **BREAKING** — the `onFanoutStart` / `onFanoutUnitStart` / `onFanoutUnitEnd` lifecycle hooks are removed; observe loops via `onLoopStart` / `onUnitStart` / `onUnitEnd` / `onLoopCap`. TS consumers of the removed hooks get compile errors (intended).
- One resume contract for all loop kinds: a unit source must be deterministic w.r.t. the fold-replayed run state + this generation's accumulated outputs. The resume fold re-checks every folded unit and refuses (terminal failure) rather than re-run a different unit than the run recorded.
- Preflight checks now run uniformly for every loop kind before unit 1: `ensureNamedReads` + `ensureSkillRegistered` for all loops, plus `ensureUpstreamArtifact` and the judge-skill registry check for assess. A fanout/iterate stage with a missing named read or an unregistered skill now halts at preflight where it previously attempted execution (behavior tightening).
- `UnitRole` gains `"verify"` and `LoopStartInfo.kind` gains `"verify"` (additive union extensions; verified stages follow loop semantics — `onLoopStart` reports `kind: "verify"`, units fire `onUnitStart`/`onUnitEnd`, no `onStageEnd`).
- `assess` no longer rejects `reads:` (the v1 restriction is lifted) — round-0 producer args are now derived by a single authority (`stageEntryArgs`) and frozen by the resume fold at loop-generation open, so labelled-flag projections survive resume for every assess-kind loop.
- Load validation now recognizes judge verdict channels (from `loop` and `verify`) as published names — `reads:` of a verdict channel no longer false-errors, and a signed judge skill's contract joins the named-channel compat adjudication.

### Fixed
- A user function throwing during loop resume (the `hasPendingUnit` probe or the driver's pull — iterate `next`, assess `done`/`feedForward`, dynamic judge prompts) now records a parent-attributed terminal failure row and returns the normal result envelope, instead of escaping `resumeWorkflow` as an unhandled rejection that skipped `onWorkflowEnd`. The route-onward resume entry (completed trailer) gets the same guard for throwing route predicates.
- A downstream stage reading an assess judge's verdict channel (`reads: ["<verdict>"]`) falsely errored at load ("no produces stage publishes it") even though the runtime preflight passed.

### Removed
- No migration for in-flight runs. Runs recorded before this version carry decorated `stage` keys with no `parent` field on their unit rows, so `reconstructState` refuses to resume them with the existing `stage-gone` message. JSONL run logs are debug artifacts — there is no on-disk migration.

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

### Added
- Control-flow as data — `fanoutOver(spec)` / `iterateOver(spec)` wrap a `FanoutFn`/`IterateFn` with a declarative `.spec` (`source` channel, `unit` selector `{ by, pattern }`, `max`, and `kind`/`dependsOnPrior`), attached structurally like `defineRoute`'s `.targets` so the runner still calls the function while introspectors read the pattern. `fanoutSpecOf`/`iterateSpecOf` read a stage's spec (`undefined` for a raw/opaque fn); `describeFlow(workflow)` projects each stage's control-flow mode (`single`/`fanout`/`iterate` + spec) and edge mode (`linear`/`route`/`terminal` + targets) from attached metadata alone. The framework ships no conventions — the `run` detector and the `unit.by` vocabulary stay consumer-owned; a raw `FanoutFn`/`IterateFn` keeps working and reads as opaque.
- `checkFanoutSource` load-time validation — WARNS (never errors) when a fanout/iterate `spec.source` channel is published by no `produces` stage in the workflow (same publisher model as `checkReadsReferences`). Its unique coverage is the `iterate`/closure-sourced case that declares no `reads:`; sources already in a stage's `reads` defer to `checkReadsReferences`, and raw fanouts (no `.spec`) degrade silently.
- Skill-contract registry — skills inject JSON-Schema-shaped `consumes`/`produces` contracts into the framework via a provider pattern. A load-time `checkEdgeSchemaCompat` pass WARNS on incompatible adjacent stages, and a runtime `ensureContractInputValid` mirror halts on a clean data-vs-schema mismatch while degrading on opaque/malformed contracts. Adds a `canCompose` / `legalNextSkills` query API and a contracts-coverage banner.
- Reads-channel compatibility is enforced at load time against *all* publishers of a channel (`checkReadsChannelCompat`), and per-channel composition comparators (`registerCompositionComparator`) let consumers adjudicate named-channel metadata (e.g. `artifactKind`) without the framework interpreting the ontology.
- `OutcomeDeriverFn` extension point — consumers can auto-wire `produces`-stage outcomes from the contract registry at load time, after `buildEffectiveContracts` and before validation.
- A `produces` stage with no explicit `outputSchema` now sources it from the dispatched skill's contract `produces.data` (`effectiveOutputSchema`), the input-side mirror of `ensureContractInputValid`; fail-soft when contracts are absent.
- `/wf --name <slug>` assigns a human-readable alias to a run, and `@<name>` resumes it. The alias is stored in the JSONL header and a sidecar `names.json` index under `.rpiv/workflows/runs/`; `resolveRun` resolves a name to its run in O(1) and falls back to a literal run-id lookup, so existing `@<run-id>` resumes are unchanged. Names must match `/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/`. Surfaced on `RunSummary.name` / `WorkflowHeader.name` (optional — legacy unnamed runs parse unchanged). `--name` is rejected on `@resume` (the ref already identifies the run, so it's ignored with a warning).
- `claimName(cwd, name, runId)` (state layer) — the single transactional door for reserving a name: validate → collision-check → persist, claimed before the JSONL header so the collision guard can never lag the header. Returns a tagged `ClaimResult` (`ok` / `invalid` / `collision` / `write-failed`) and writes nothing on failure. Also exports `isValidName`, `VALID_NAME`, `readNamesIndex`, `addNameToIndex`, and `rebuildIndex` (rebuilds the index from JSONL headers and warns on duplicate name claims). New `RunWorkflowOptions.name` is validated and collision-checked at the runner entry point, so programmatic callers get the same guarantees as `/wf`.

### Changed
- `resolveRun` (and therefore `/wf @<ref>`) now accepts a path to a run's JSONL, not just the bare run-id slug. The run-id fallback normalizes the ref to a slug — drops any directory prefix (`basename`) and strips a trailing `.jsonl` — so `@<id>`, `@<id>.jsonl`, and `@/abs/or/rel/path/.rpiv/workflows/runs/<id>.jsonl` resolve interchangeably, making the editor's `@` file-autosuggestion usable for resume. Name lookup still matches the raw ref (a run name is never a path). The `MSG_RESUME_USAGE` hint now reads `/wf @<run-id | name | path-to.jsonl>`.
- Schema-validation failures now name the offending value and the allowed enum values — e.g. `status: must be one of "ready" - got "done"` instead of `/status - must be equal to one of the allowed values` — via a shared `describeFailure` formatter across extraction, stage-lifecycle, and script-stage.

### Fixed
- Semantically-identical contracts registered via different code paths no longer raise a spurious cross-owner collision warning — a structural `deepEqual` replaces the key-order-dependent `JSON.stringify` compare.
- Root-level type mismatches between schemas (e.g. `string` vs `number`) are now flagged by `isSchemaCompatible` instead of silently passing.

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

### Added
- `runWorkflowByName` — one-shot helper that loads, finds, and runs a workflow by name: refuses on error-severity load issues and returns a failure envelope (never throws) when the name is unknown.
- `resumeWorkflowByRunId` — the resume-side counterpart to `runWorkflowByName`. Folds `resolveRun → loadWorkflows → findWorkflow → resumeWorkflow` into one call keyed on a run-id (the `<run-id>` slug from `RunSummary.runId`); returns a failure envelope (never throws) for an unresolvable run-id, error-severity load issues, or a workflow that's no longer registered. New exported type `ResumeWorkflowByRunIdOptions`.
- New exported types `WorkflowHostContext`, `WorkflowSessionContext`, and `RunWorkflowByNameOptions`.
- `RunWorkflowOptions.signal` / `ResumeWorkflowOptions.signal` — optional `AbortSignal` for cooperative cancellation. The runner checks it at the between-stage seam (before the start stage and before every routed next stage); an aborted signal records an `"aborted"` terminal row for the stage about to run and returns `{ success: false }`. It does not interrupt a stage already streaming (Pi owns the live session), so cancellation takes effect at the next stage boundary. Threads through `runWorkflowByName` / `resumeWorkflowByRunId` unchanged.
- Resuming a run that died inside an **iterate** stage. `reconstructState` folds the persisted iterate-unit rows back into accumulation (rolling primary, `state.named`, the trailing generation's `accumulated` prefix + frozen entry artifact), and a new `resumeIterateStage` re-enters `runIterate` at the next not-yet-completed unit — re-pulling the failed unit plus the units after it, then routing onward. A cleanly-finished iterate resumes as a no-op; a process that died between units resumes at the next pull. Resume guards the one checkable boundary: if the `IterateFn` recomputes a different unit than the run recorded at the resume point (a non-deterministic generator), it refuses with a terminal failure rather than running the wrong unit. (Replaces the previous "iterate is unsupported on resume" reconstruct refusal.)
- Resuming a **looped** fanout or iterate stage (a corrective back-edge that re-enters the stage) now continues only the **trailing** generation. The reconstruction fold tracks generations, so a stage that died mid-second-pass resumes that pass instead of comparing against a prefix concatenated across all passes.
- New package entry points: `@juicesharp/rpiv-workflow/registration` (the full public API minus the execution engine) and `@juicesharp/rpiv-workflow/startup` (the `registerLifecycle` / `registerBuiltIns` / `registerBuiltInsProvider` registrars only). Siblings that wire up at extension load import these to keep the ~530ms runner off the startup path. New `registerBuiltInsProvider(thunk)` contributes built-ins lazily — the thunk runs on the first `loadWorkflows` (first `/wf`), so a sibling's workflow definitions are constructed on first use rather than at registration.

### Changed
- The Pi extension entry is now a thin `extension.ts` (pointed to by `pi.extensions`) rather than the public API barrel, and `/wf` loads the runner + loader graph lazily on first invocation. Loading the extension no longer evaluates the execution engine (~530ms); the main `@juicesharp/rpiv-workflow` entry is unchanged for embedders.
- `resumeWorkflow` no longer self-notifies its reconstruct refusals (no-rows / stage-gone) — it returns a pure `RunWorkflowResult` envelope like `runWorkflow`'s pre-flight rejections, with `runId` absent on every no-JSONL refusal. The caller surfaces `result.error` (the `/wf` command notifies no-JSONL refusals via the `!result.runId` discriminator). This unifies the run and resume families on one notify contract. (`resumeWorkflow` is unreleased — no prior published behavior changes.)
- The `STOP` terminal-edge sentinel is now re-exported from the package entry, matching its long-standing mention in the authoring docstring. Authors can write `edges: { commit: STOP }` for a typed terminal edge; the bare `"stop"` literal remains valid (`EdgeTarget = string | typeof STOP | EdgeFn`).
- The workflow host-context type is unified under a single `WorkflowHostContext` port (re-exported from the package entry) and threaded through the runner, sessions, fanout, lifecycle, and `/wf` layers.

### Breaking / Upgrade Notes
- The exported `WorkflowContext` type is renamed to `WorkflowHostContext`. Update embedders that type host handles against `WorkflowContext`.

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

### BREAKING CHANGES
- Project workflow config moved from `.rpiv-workflow/` to the unified `.rpiv/workflows/` tree, and the three concerns now each have their own subfolder:
  - `.rpiv-workflow/workflows.config.ts` → `.rpiv/workflows/config.ts`
  - `.rpiv-workflow/workflows/*.ts` → `.rpiv/workflows/packs/*.ts`
  - run state `.rpiv/workflows/<run-id>.jsonl` → `.rpiv/workflows/runs/<run-id>.jsonl`

  The user layer's inner names are aligned for symmetry: `~/.config/rpiv-workflow/{config.ts, packs/}`. The new paths are the **only** locations read — there is no legacy fallback. One-time load-time warnings fire when a stale layout is detected (each advisory, never blocking): a legacy project `.rpiv-workflow/` directory, orphaned top-level `.rpiv/workflows/*.jsonl` run files written before the `runs/` relocation, and a legacy user-layer `~/.config/rpiv-workflow/workflows.config.ts`. Each points at the matching `mv`. Migrate:

  ```sh
  mkdir -p .rpiv/workflows
  mv .rpiv-workflow/workflows.config.ts .rpiv/workflows/config.ts
  mv .rpiv-workflow/workflows .rpiv/workflows/packs
  ```

- **`.rpiv/workflows/` is commonly gitignored** (it holds ephemeral run state), so the moved project `config.ts` + `packs/` may be **silently uncommittable** — `git add .rpiv/workflows/config.ts` is a no-op with no error. Teams that version-control their workflow config must un-ignore the config surface, e.g. add `!.rpiv/workflows/config.ts` and `!.rpiv/workflows/packs/` to `.gitignore`. The legacy-overlay load warning now carries this advisory inline.

- The public `workflowsDir` export is renamed `runsDir` and now points at `.rpiv/workflows/runs` (was `.rpiv/workflows`). Update any direct importers.

### Added
- New `skillAliases` config field — declaratively remap skill names across **all** workflows (built-in + user + project) at load time, without redeclaring any workflow or touching the runner. In `config.ts`:

  ```ts
  export default { skillAliases: { commit: "attributed-commit" } }
  ```

  Every dispatching stage whose effective skill (`stage.skill ?? stageName`) matches an alias key is remapped — implicit skills are materialised. One hop only (no transitive chains); `run`/`prompt` stages are skipped; aliases merge project-over-user per key. Surfaced in `/wf` preview as a `Skill aliases in effect: …` banner; an alias key matching no dispatched skill emits a load-time warning (no-op). The `{ workflows, default?, skillAliases? }` envelope now makes `workflows` optional (an alias-only config is valid); packs still reject the envelope. New export: `aliasSkills`; `LoadedWorkflows` gains `skillAliases` (the merged, applied map).

### Fixed
- The in-product legacy-`.rpiv-workflow/` migration shell now creates the destination directory and globs `packs/*.ts`, so the suggested commands succeed on a clean repo and the packs directory lands directly under `.rpiv/workflows/packs/` instead of being nested under `packs/workflows/`.
- A present-but-non-array `workflows` field in an envelope-shaped `config.ts` is now reported as a load error instead of crashing the loader with `TypeError`, restoring the "loader never throws" contract.

## [1.16.1] - 2026-05-30

### Fixed
- Add `iterate.ts` to the published `files` allowlist. It was introduced in 1.16.0 but omitted from the package manifest, so the published tarball shipped `runner/stage-lifecycle.ts` (which imports `../iterate.js`) without the module it requires. Loading the extension from an npm install failed with `Cannot find module '../iterate.js'`. Source builds and tests were unaffected because the file is git-tracked, which is why it slipped past CI.

## [1.16.0] - 2026-05-30

### Added
- Typed dispatch builders `produces.prompt({ … })` / `acts.prompt({ … })` (mirroring `produces.script`) — narrowed options that structurally omit `skill`/`run`/`fanout`/`iterate`/`reads`, so an invalid dispatch combo fails to compile instead of only failing load validation.
- New `prompt` stage dispatch — the third dispatch alongside skill (`/skill:<name>`) and script `run`. A stage with `prompt: string | PromptFn` sends raw text straight to the model with no skill body and no skill-registry check. Orthogonal to `kind` and to `sessionPolicy` — `continue` + `prompt` is a follow-up turn that builds on a session a prior stage populated. Validated at load + preflight. New export: `PromptFn`. See the authoring guide's "Prompt stages (raw-text dispatch)" section.
- New `iterate` stage mode — the sequential, accumulating dual of `fanout`. A `produces` stage with `iterate: IterateFn` pulls units one at a time, feeding each generator call the validated outputs of all prior units; each unit runs the stage's `outcome` collector and accumulates into `state.named[outcome.name]`. Validated at load + preflight. Backstopped by a run-wide `maxIterations` cap (default 32, configurable via `RunWorkflowOptions.maxIterations`). New exports: `IterateFn`, `IterateContext`, `IterateUnit`. See the authoring guide's "iterate (sequential accumulation)" section.

### Changed
- Document `prompt` stage dispatch and `iterate` mode in the authoring guide.

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

### Changed
- Clarify bundled workflow names in README to match actual `ship`, `build`, `arch`, and `vet` workflows.

### Fixed
- Align `/wf list` output into properly padded columns so names, stage counts, and layer tags line up correctly.

## [1.14.4] - 2026-05-28

## [1.14.3] - 2026-05-28

## [1.14.2] - 2026-05-28

### Fixed
- Promote `jiti` and `@juicesharp/rpiv-config` from `peerDependencies` to `dependencies`. Both are runtime value imports (`load/cache.ts` and `load/paths.ts`), but Pi's installer (`pi install`) does not auto-install peer dependencies into `~/.pi/agent/npm/node_modules`, so fresh installs failed with `Cannot find module 'jiti'` when the extension loaded.

## [1.14.1] - 2026-05-28

### Fixed
- Include `handle.ts` and `predicates.ts` in the published tarball. They were omitted from `package.json#files` in 1.14.0, breaking installs with `Cannot find module './handle.js'` when loaded as a Pi extension.

## [1.14.0] - 2026-05-28

### Added
- Initial release as a standalone Pi extension.
- Skill-agnostic workflow runtime — chain Pi skills into typed multi-stage workflows with audited JSONL state, predicate routing, and per-stage output validation.
- `/wf` command — preview, inspect, and run workflows.
- Layered config loader merging five layers (built-in → user packs → user config → project packs → project config) with jiti TypeScript loading.
- Config vs pack split — packs cannot set `default`, making installable workflow bundles safe to share.
- Authoring DSL: `defineWorkflow`, `produces`, `acts`, `terminal`, `gate`, `defineRoute`.
- Standalone predicate helpers (`gt`, `gte`, `lt`, `lte`, `eq`) — can also use a pure TS function in place of predicates.
- Multi-input stages via `reads:` and the named-publish registry (`OutputSpec.name`, `StageDef.reads`).
- Script stages (`produces.script`, `acts.script`, `terminal.script`) for stages that run TypeScript without a Pi session.
- User-supplied `FanoutFn` for custom fanout strategies.
- Continue session policy for stages that reuse the prior session.
- `registerLifecycle` for cross-package stage observers (widgets, metrics, side-effect bridges).
- Bundled collector catalog: transcript path, directory path, URL, tool call, workspace diff, git commit, union, and noop collectors.
- Bundled parser catalog: JSON body and git commit parsers.
- Handle constructors (`fs`, `url`, `opaque`, `inline`) and `handleToString` serialiser.
- Sync and async schema validator support (Standard Schema v1 — TypeBox, Zod, Valibot, ArkType, or hand-rolled).
- Workflow descriptions in `/wf` compact list view.
