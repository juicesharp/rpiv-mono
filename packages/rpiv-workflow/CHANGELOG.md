# @juicesharp/rpiv-workflow

## [Unreleased]

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
