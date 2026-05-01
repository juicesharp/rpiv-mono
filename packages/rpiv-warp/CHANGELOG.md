# Changelog

All notable changes to `@juicesharp/rpiv-warp` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).

### Changed
- README now opens with a `<picture>`-wrapped `cover.png` hero so GitHub renders friendly artwork at the top of the package page.

## [1.0.11] - 2026-04-30

### Added
- Initial release. New standalone Pi extension that subscribes to four Pi lifecycle events (`session_start`, `agent_end`, `tool_call`, `turn_end`) and emits Warp's structured `OSC 777` escape sequence to `/dev/tty` so Warp renders native OS-level toast notifications. Filters `session_start` to `reason === "startup"` only, and `tool_call` to a configurable `NOTIFY_TOOL_NAMES` set (initial entry: `ask_user_question`). Detects Warp via `TERM_PROGRAM === "WarpTerminal"` plus `WARP_CLI_AGENT_PROTOCOL_VERSION`; falls back to silent no-op outside Warp, on broken Warp builds (per-channel hard-coded thresholds), or when `/dev/tty` is unreachable. Standalone — not registered as a sibling, not auto-installed by `/rpiv-setup`. Install via `pi install npm:@juicesharp/rpiv-warp`.
