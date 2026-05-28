# Changelog

All notable changes to `@juicesharp/rpiv-args` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `${SKILL_DIR}` now resolves to the skill's own directory instead of the extension package root, fixing relative shell command paths.

## [1.13.0] - 2026-05-25

## [1.12.0] - 2026-05-21

## [1.11.0] - 2026-05-20

### Changed
- Relocate npm + MIT badges from the cover area to the License section in README.

## [1.10.2] - 2026-05-20

### Changed
- Refresh npm cover (`docs/cover.{svg,png}`) to align with the unified card layout used across the `@juicesharp/rpiv-*` family.

## [1.10.1] - 2026-05-19

### Changed
- Refresh npm cover: combined two-panel layout demos both `$ARGUMENTS` and `` !`cmd` `` shell substitution.
- Update package `description` and `keywords` to mention shell substitution alongside argument placeholders.

## [1.10.0] - 2026-05-19

### Added
- Variable substitution (`${SKILL_DIR}`, `${SESSION_ID}`) and inline shell execution in skill bodies, with `shell-timeout` frontmatter and output truncation at 50 KB / 2 000 lines.

### Changed
- `handleInput` is now async and receives the Pi extension context and API objects.

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

### Fixed
- Load skill directories from cross-harness locations, fixing a case where installed skills were not discoverable.

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

## [1.2.1] - 2026-05-07

## [1.2.0] - 2026-05-07

### Fixed
- Skill-invocation protocol is now injected into the system prompt so the LLM treats trailing text after `</skill>` as argument input. Token path no longer appends arguments when the skill body already consumed them via `$ARGUMENTS` / `$N` placeholders.

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
