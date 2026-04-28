# Changelog

All notable changes to `@juicesharp/rpiv-args` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
