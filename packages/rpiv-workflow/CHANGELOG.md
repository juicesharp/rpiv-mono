# @juicesharp/rpiv-workflow

## [Unreleased]

### Added — named-publish registry for multi-input stages
- `state.named: Record<string, Output[]>` — every `produces` stage appends
  its `Output` envelope onto the slot keyed by
  `stage.outcome?.name ?? stage.<record-key>`. Slots are arrays so
  iteration history is preserved across backward-jump loops; the default
  read resolves to the most-recent entry. Multiple stages MAY share a
  slot on purpose (the outcome-name convergence pattern).
- `OutputSpec.name?: string` — optional categorical name carried by the
  outcome. The single mechanism for declaring "this outcome publishes
  under name X"; multiple stages wiring the same outcome converge.
- `StageDef.reads?: ReadonlyArray<string>` — names this stage consumes.
  When set, the runner builds a labelled-flag prompt
  (`/skill:<name> --<n1> <p1> --<n2> <p2> …`) reading the latest entry
  each name has accumulated; multi-artifact stages repeat the flag per
  artifact. Empty/unset → the default single-artifact prompt
  (`/skill:<name> <handle>`) is preserved bit-for-bit.
- `validateWorkflow` rejects `reads:` references whose name no produces
  stage publishes (typo / rename catch at load time).
- Runtime preflight `ensureNamedReads` halts the chain when a `reads:`
  slot is empty (`MSG_MISSING_NAMED_READ` / `ERR_MISSING_NAMED_READ`) —
  the "producer hasn't fired yet on this path" case.
- `ensureUpstreamArtifact` skips when `reads:` is set — multi-input
  stages opt out of the rolling-primary contract by declaration.

### Breaking — Pi types removed from public surface
- The public type surface no longer names any `@earendil-works/pi-coding-agent`
  type. Three workflow-owned host ports replace them in
  signatures: `WorkflowHost` (default export + continue-policy sender),
  `WorkflowCommandHost` (`runWorkflow`'s ctx + `RunContext.pi` /
  `RunWorkflowOptions.pi`), and `WorkflowSessionHost` (the replacement
  ctx delivered to `newSession`'s `withSession` callback).
- Pi's `ExtensionAPI` / `ExtensionCommandContext` structurally satisfy
  the new ports, so embedders pass their existing Pi handles to
  `runWorkflow` without any source change. A compile-time tripwire
  (`host.test.ts`) fails CI if Pi's API ever drifts below the port shape.
- `RunContext` is no longer exported from the barrel — it was internal
  to the runner and had no external consumers.
- `BaselineCtx.pi` / `ExtractCtx.pi` removed. The field was dead today
  (the runner never populated `ExtractCtx.pi`, and no bundled outcome
  read `BaselineCtx.pi`). Custom outcomes that need agent-level access
  should accept a narrow capability injection at construction time
  rather than reaching into the runtime ctx.

### Breaking — on-disk JSONL header
- `WorkflowHeader.preset` renamed to `workflow`. Audit files written by
  prior versions have a header row that no longer matches the current
  shape. Audit files are debug artifacts (per `state.ts`); no migration
  is provided. (L2-08 / T5-vocabulary-drift)

### Breaking — `Manifest` → `Output` envelope rename
- The inter-stage data channel `Manifest<K, D>` is now `Output<K, D>`;
  `ManifestMeta` is `OutputMeta`; the built-in aliases follow
  (`ArtifactsManifest` → `ArtifactsOutput`, `SideEffectManifest` →
  `SideEffectOutput`, `GitCommitManifest` → `GitCommitOutput`).
  `finalizeManifest` is `finalizeOutput`. The validation entrypoint
  `validateManifestData` is `validateOutputData` (now in
  `validate-output.ts`).
- `EdgeContext.manifest` is now `EdgeContext.output`; predicate bodies
  that destructured `{ manifest }` flip to `{ output }`, and
  `output?.data` / `output?.meta` replace the matching field reads.
- `RunState.manifest` is now `RunState.output`.
- **On-disk JSONL** `WorkflowStage` rows carry the field as `output`
  (was `manifest`). Audit files written by prior versions no longer
  satisfy the row shape — same debug-artifact policy as the header
  rename above.

### Added
- Initial release. Extracted from `@juicesharp/rpiv-pi` as a standalone Pi
  extension. The package is **skill-agnostic** — install it on its own
  and write workflows over your own `~/.pi/agent/skills/`, or pair with
  `@juicesharp/rpiv-pi` to use the bundled `mid`, `large`, `small`
  workflows over rpiv-pi's skills.
- `/wf` slash command — preview workflows (no-args), preview one workflow
  (`/wf <name>`), or run one (`/wf <name> <input>`).
- Layered jiti loader with canonical + drop-in convention:
  `~/.config/rpiv-workflow/workflows.config.ts` + `workflows/*.ts`;
  `<cwd>/.rpiv-workflow/workflows.config.ts` + `workflows/*.ts`.
- Programmatic API: `registerBuiltIns(workflows)` for sibling packages
  that want to contribute workflows at load time.
