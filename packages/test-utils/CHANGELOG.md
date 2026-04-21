# Changelog

All notable changes to this package will be documented in this file.

## [0.11.3] - 2026-04-21

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

## [0.11.0] - 2026-04-20

### Added
- `stubFetch(matchers)` at `fetch.ts` — `globalThis.fetch` replacement matching by URL origin+pathname with full `Response`-shape returns and `AbortSignal` capture.
- `stubGitExec({branch, commit, user})` at `exec.ts` — `pi.exec` replacement returning the three `git rev-parse` / `git config` shapes for rpiv-core/git-context tests.
- `makeSpawnStub(script)` at `spawn.ts` — `EventEmitter`-shaped child-process stub for `vi.mock("node:child_process")` consumers.
- `writeGuidanceTree(projectDir, spec)` at `fs.ts` — materializes AGENTS/CLAUDE/architecture file ladders under a tmp dir for guidance-resolution tests.

## [0.10.0] - 2026-04-20

### Added
- Initial internal test-fixture package (not published).
- `createMockPi`, `createMockCtx`, `createMockUI`, `createMockSessionManager`, `createMockModelRegistry` factory stubs for the Pi ExtensionAPI surface.
- `makeMessage*` / `buildSessionEntries` / `buildLlmMessages` factories for synthetic session branches.
- `assertToolContract` + `roundTripBranchState` contract helpers.
- `makeTheme` + `makeTui` deterministic rendering fixtures.
