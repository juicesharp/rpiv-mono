# Changelog

All notable changes to `@juicesharp/rpiv-args` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

## [1.0.19] - 2026-05-03

## [1.0.18] - 2026-05-02

## [1.0.17] - 2026-05-02

## [1.0.16] - 2026-05-02

## [1.0.15] - 2026-05-02

## [1.0.14] - 2026-05-01

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot demonstrating the extension's hero feature.

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
- README now opens with a `<picture>`-wrapped `cover.png` hero so pi.dev's package-card image extractor picks the friendly artwork instead of the npm version shield.

## [1.0.11] - 2026-04-30

### Changed
- README rewritten with a concrete usage example (`/skill:deploy api production` → `$1=api`, `$2=production`) and a friendlier opener. `package.json` `description` shortened from the implementation pitch to a one-liner: "pass shell-style $1 / $ARGUMENTS placeholders to your Pi skills".

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

### Fixed
- **Pi 0.70.0 compatibility**: `buildSkillIndex` now passes the new required `skillPaths: []` + `includeDefaults: true` options to `loadSkills()`. Pi 0.70.0 removed the defaults for these options — the old `loadSkills({ cwd })` call threw `skillPaths is not iterable` at `pi-coding-agent/dist/core/skills.js:374`, crashing every input-hook invocation in rpiv-args (`/skill:<name>` command routing). Behavior is otherwise unchanged — `includeDefaults: true` restores the previous "load user + project skill dirs" default.

## [0.11.7] - 2026-04-23

## [0.11.6] - 2026-04-22

## [0.11.5] - 2026-04-22

## [0.11.4] - 2026-04-21

## [0.11.3] - 2026-04-21

## [0.11.2] - 2026-04-21

## [0.11.1] - 2026-04-20

## [0.11.0] - 2026-04-20

## [0.10.0] - 2026-04-20

## [0.9.1] - 2026-04-20

## [0.9.0] - 2026-04-19

### Changed
- README expanded into a skill-author reference: full placeholder table with 1-indexed semantics and `${@:N[:L]}` clamping notes, `$ARGUMENTS` vs `$N` decision guide with a broken-positional counter-example, shell-style quoting behavior, collapsible end-to-end deploy example, and a Limitations matrix (no type validation, no flag parsing, literal substitution inside code blocks, `steer()`/`followUp()` bypass, no recursive substitution). Opening paragraph leads with the byte-identical-wrapper backward-compat guarantee.

## [0.8.3] - 2026-04-19

### Added
- Initial release. New sibling Pi extension that intercepts `/skill:<name> <args>` via the `input` hook and pre-emptively wraps the skill body in a `<skill …>…</skill>` block with opt-in `$N` / `$ARGUMENTS` / `$@` / `${@:N[:L]}` substitution. Byte-exact match of Pi's `parseSkillBlock` regex so downstream consumers (including `@tintinweb/pi-subagents`) round-trip cleanly. Zero-migration: bodies with no placeholders fall through to Pi's existing append-verbatim behavior.
