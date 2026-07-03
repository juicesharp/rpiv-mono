# Changelog

All notable changes to `@juicesharp/rpiv-todo` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Configurable overlay height via the `maxWidgetLines` field in `~/.config/rpiv-todo/config.json`. Defaults to `12`; values below `3` and non-numeric values fall back to the default. Takes effect on the next repaint — no `/reload` required (#101).

### Fixed
- A no-effect `update` — `status` set to its current value, or any field re-sent unchanged — now reports `No change: #N …` instead of `Updated #N`, so it is no longer indistinguishable from a real mutation. This prevents a model from re-issuing the same no-op update in a loop.
- Moved `typebox` from `peerDependencies` to `dependencies` (`^1.1.24`, matching the Pi host's range) so the tool's parameter schema resolves under installers that don't materialise peer deps. Fixes `ERR_MODULE_NOT_FOUND: typebox` on standalone consumer installs (#79).

## [1.20.0] - 2026-06-15

### Added
- Chinese (`zh`) translations (`locales/zh.json`) (#68).

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

### Fixed
- The todos overlay renders a trailing blank line so its last row no longer sits flush against the input box. (#65)

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

### Fixed
- Stale extension context after auto-compaction no longer causes spurious warnings during overlay replay.

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

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

### Changed
- Relocate npm + MIT badges from the cover area to the License section in README.

## [1.10.2] - 2026-05-20

### Changed
- Refresh npm cover (`docs/cover.{svg,png}`) to share the unified card layout used across the `@juicesharp/rpiv-*` family.

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

## [1.9.2] - 2026-05-19

### Changed
- Adding a translated locale no longer requires editing the extension entry — drop `locales/<code>.json` next to the existing files and it loads automatically on next start.

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

### Added
- Configurable LLM guidance overrides via package config.

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

### Changed
- Overlay UX: completed todo items now stay visible until the next agent response starts, then disappear from later overlay renders. Replay-driven lifecycle events (`session_start`, `session_compact`, `session_tree`) reset that per-overlay display memory so replayed completed items can be shown once again.

## [1.1.4] - 2026-05-03

### Added
- Localized TUI chrome (overlay heading, `/todos` section headers, status words) via `@juicesharp/rpiv-i18n`. 8 locales out of the box (de, en, es, fr, pt, pt-BR, ru, uk). LLM-facing strings (response envelope, reducer errors) stay English.

### Changed
- `@juicesharp/rpiv-i18n` is now a soft optional peer (`peerDependenciesMeta.optional: true`). The bridge and module-init `registerStrings` call use a dynamic `await import()` inside try/catch, so a standalone install of just `rpiv-todo` no longer fails with `Cannot find module '@juicesharp/rpiv-i18n'` — the extension stays online with English-only UI when the SDK isn't present, and lights up localization automatically when it is.

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

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot mimicking the real `Todos (2/7)` overlay.

## [1.0.13] - 2026-05-01

### Added
- `docs/vertical-cover.{svg,png}` — portrait-orientation hero artwork (1280×800 canvas; PNG downscaled to 320×711).

### Changed
- Cover canvas extended from 1280×640 to 1280×800 with refreshed crop marks/footer.
- README hero swapped from `docs/cover.png` to `docs/vertical-cover.png`, rendered at `width="160"`. The `<a>` wrapper around the `<picture>` was removed so the image is no longer a clickable link to the package directory.

## [1.0.12] - 2026-05-01

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
