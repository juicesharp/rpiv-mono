# Changelog

All notable changes to `@juicesharp/rpiv-args` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- README expanded into a skill-author reference: full placeholder table with 1-indexed semantics and `${@:N[:L]}` clamping notes, `$ARGUMENTS` vs `$N` decision guide with a broken-positional counter-example, shell-style quoting behavior, collapsible end-to-end deploy example, and a Limitations matrix (no type validation, no flag parsing, literal substitution inside code blocks, `steer()`/`followUp()` bypass, no recursive substitution). Opening paragraph leads with the byte-identical-wrapper backward-compat guarantee.

## [0.8.3] - 2026-04-19

### Added
- Initial release. New sibling Pi extension that intercepts `/skill:<name> <args>` via the `input` hook and pre-emptively wraps the skill body in a `<skill …>…</skill>` block with opt-in `$N` / `$ARGUMENTS` / `$@` / `${@:N[:L]}` substitution. Byte-exact match of Pi's `parseSkillBlock` regex so downstream consumers (including `@tintinweb/pi-subagents`) round-trip cleanly. Zero-migration: bodies with no placeholders fall through to Pi's existing append-verbatim behavior.
