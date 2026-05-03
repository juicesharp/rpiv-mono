# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

## [1.0.19] - 2026-05-03

## [1.0.18] - 2026-05-02

## [1.0.17] - 2026-05-02

## [1.0.16] - 2026-05-02

## [1.0.15] - 2026-05-02

## [1.0.14] - 2026-05-01

## [1.0.13] - 2026-05-01

## [1.0.12] - 2026-05-01

## [1.0.11] - 2026-04-30

## [1.0.10] - 2026-04-30

## [1.0.9] - 2026-04-30

## [1.0.8] - 2026-04-29

## [1.0.7] - 2026-04-29

## [1.0.6] - 2026-04-29

## [1.0.5] - 2026-04-29

## [1.0.4] - 2026-04-28

## [1.0.3] - 2026-04-28

## [1.0.2] - 2026-04-28

## [1.0.1] - 2026-04-28

## [1.0.0] - 2026-04-28

## [0.13.0] - 2026-04-28

## [0.12.7] - 2026-04-26

## [0.12.6] - 2026-04-26

## [0.12.5] - 2026-04-24

## [0.12.4] - 2026-04-24

## [0.12.3] - 2026-04-24

## [0.12.2] - 2026-04-24

## [0.12.1] - 2026-04-24

## [0.12.0] - 2026-04-24

## [0.11.7] - 2026-04-23

## [0.11.6] - 2026-04-22

## [0.11.5] - 2026-04-22

## [0.11.4] - 2026-04-21

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
