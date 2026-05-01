# Changelog

All notable changes to `@juicesharp/rpiv-todo` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).

### Changed
- README hero: open with a `<picture>`-wrapped `cover.png` above the shield badges so pi.dev's package-card image extractor picks the friendly artwork instead of the npm version shield. Existing `docs/overlay.jpg` screenshot retained below the description.

## [1.0.11] - 2026-04-30

### Changed
- Internal refactor: `todo.ts` split into layered modules under `state/`, `tool/`, and `view/`. The reducer, store, replay, task-graph, response envelope, schema, and view formatters each live in their own file; `todo.ts` is now a thin registration shell that re-exports the pre-refactor public surface so `index.ts`, the overlay, and existing tests keep importing from `./todo.js`. `package.json` `files` array updated to ship the new modules (16 production files in the tarball).
- README rewritten with a user-outcome opener and a new `## Features` section (live overlay, survives `/reload` and compaction, status states, dependency tracking with cycle detection, smart truncation). `package.json` `description` synced.

### Added
- `ship-manifest.test.ts` — verifies `package.json` `files` covers every production `.ts` module across the package tree, so future module additions can't silently fall out of the npm tarball.

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

## [0.10.0] - 2026-04-20

### Added
- Testability exports: `__resetState()` resets module-level `tasks` + `nextId` to their initial state; `getNextId()` exposes the current id counter alongside existing `getTodos()`. Follows the sibling reset convention (`invalidateSkillIndex`, `clearInjectionState`) used elsewhere in the monorepo. Production behaviour unchanged.
- Canonical reducer + replay test suites (`todo.reducer.test.ts`, `todo.replay.test.ts`) validating the full Vitest harness shape for downstream packages to follow.

## [0.9.1] - 2026-04-20

## [0.9.0] - 2026-04-19

## [0.8.3] - 2026-04-19

## [0.8.2] - 2026-04-19

## [0.8.1] - 2026-04-19

## [0.8.0] - 2026-04-19

## [0.7.0] - 2026-04-18

## [0.6.1] - 2026-04-18

## [0.6.0] — 2026-04-18

### Changed
- Consolidated into the `juicesharp/rpiv-mono` monorepo. Version aligned to the rpiv-pi family lockstep starting point. No runtime behavior change from `0.1.2`.
