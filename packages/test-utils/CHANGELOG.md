# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

- `verifyShipManifest` now understands npm `files` negation patterns: a `!`-prefixed entry (e.g. `"!**/*.test.ts"`) is treated as an exclusion rule rather than a path, so it is no longer reported as `stale` and does not cover on-disk files (#80).
- New `createFakeConcurrentHost` fixture (`concurrent-host.ts`) — a `WorkflowHostContext` double with no Pi import, built to prove the parallel fan-out dispatcher's concurrency behavior end-to-end through `runWorkflow`. Its `spawnChild` records each call (`prompt`, `model`, `signal`, `reattach`, `fork`, `startOrder`/`endOrder`); tracks live in-flight count plus the observed peak (`maxActive`); supports a shared gate (`gate: true` + `release()`) to freeze a run with the first `maxConcurrency` children in flight for inspection; and exposes `waitForActive(n)` to await a given concurrency level being reached.
- `createMockCtx`/`MockCtxOptions` gains a `sessionId` option, threaded into `createMockSessionManager`, so tests can assert per-session isolation of state keyed off `ctx.sessionManager.getSessionId()`. `createMockCommandCtx`'s `spawnChild`-minted child ctx now defaults to a distinct `${sessionId}-child` session id instead of inheriting the parent's, so parent/child isolation tests actually exercise the partition rather than masking it (override via the new `childSessionId` option).
- `MockCtxOptions.mode` passthrough on `createMockCtx` — advertises the pi ≥0.79 host `mode` field (e.g. `"rpc"` for ACP hosts) for tests of RPC/ACP-host codepaths; omitted by default to match the pinned 0.74 peer types.
- `createMockSessionChain`'s `MockSessionStep` gains a `toolTimeout` field: when set, the spawned child ctx's `toolTimeout()` reports the given `{ reason }`, simulating a watchdog-equipped host that aborted a runaway bash tool call, for testing the soft-halt-gate routing.
- `createMockSessionChain`'s `MockSessionStep` gains a `sessionFile` field, and both it and `createFakeConcurrentHost` gain `fork` support alongside `reattach` — a step's child can report a real on-disk `getSessionFile()` so `sessionPolicy: "continue"` tests can exercise forking a predecessor's session.
- `createMockPi` now captures `pi.registerShortcut(keyId, opts)` registrations in a new `shortcuts: Map<string, CapturedShortcut>` bucket on `CapturedPi`.
- `createMockUI` gains a `setEditorComponent` mock, matching the `ExtensionUIContext` surface.

## [1.20.0] - 2026-06-15

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

### Fixed
- `verifyShipManifest` now treats a bare directory name in `package.json#files` (e.g. `"load"`) as recursive directory inclusion, matching npm's `files` semantics. Previously only trailing-slash entries (`"load/"`) were recognised, producing false-positive "missing" reports for packages using bare directory names.

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

## [1.14.4] - 2026-05-28

## [1.14.3] - 2026-05-28

## [1.14.2] - 2026-05-28

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

## [1.13.0] - 2026-05-25

## [1.12.0] - 2026-05-21

## [1.11.0] - 2026-05-20

## [1.10.2] - 2026-05-20

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

### Fixed
- `ExecResult` type aligned with the real Pi extension API (`code` instead of `exitCode`, added `killed` boolean).

## [1.9.2] - 2026-05-19

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

## [1.8.3] - 2026-05-18

## [1.8.2] - 2026-05-17

## [1.8.1] - 2026-05-17

## [1.8.0] - 2026-05-16

## [1.7.0] - 2026-05-15

## [1.6.1] - 2026-05-14

## [1.6.0] - 2026-05-14

## [1.5.2] - 2026-05-13

## [1.5.1] - 2026-05-13

## [1.5.0] - 2026-05-12

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

## [1.2.1] - 2026-05-07

## [1.2.0] - 2026-05-07

## [1.1.5] - 2026-05-05

## [1.1.4] - 2026-05-03

## [1.1.3] - 2026-05-03

## [1.1.2] - 2026-05-03

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
