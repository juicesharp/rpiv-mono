# @juicesharp/rpiv-workflow

## [Unreleased]

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
