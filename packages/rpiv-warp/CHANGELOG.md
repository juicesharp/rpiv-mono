# Changelog

All notable changes to `@juicesharp/rpiv-warp` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.15] - 2026-05-02

## [1.0.14] - 2026-05-01

### Changed
- Cover redesigned as a macOS-style terminal-window screenshot demonstrating the extension's hero feature.

## [1.0.13] - 2026-05-01

### Added
- `docs/vertical-cover.{svg,png}` — portrait-orientation hero artwork (1280×800 canvas; PNG downscaled to 320×711).
- Best-effort Windows transport: `writeOSC777` writes the OSC 777 byte sequence to `process.stdout` (gated on `isTTY`) when `/dev/tty` is unavailable, relying on ConPTY to forward unrecognized OSCs to Warp.
- Warp tab-title spinner: animates the first character of the terminal window title with a 4-frame braille rotation at 160ms cadence during agent loops, wrapped in xterm `CSI 22;0t` / `CSI 23;0t` push/pop so Pi's `π - <repo>` title is restored verbatim on stop.
- `title-spinner.ts` module plus `writeOSC0`, `pushTitleStack`, `popTitleStack` emitters that share `writeOSC777`’s transport path (so they also flow through `process.stdout` on Windows).
- Test coverage for the title-spinner emitters on Windows transport.

### Changed
- Cover canvas extended from 1280×640 to 1280×800 with refreshed crop marks/footer.
- README hero swapped from `docs/cover.png` to `docs/vertical-cover.png`, rendered at `width="160"`. The `<a>` wrapper around the `<picture>` was removed so the image is no longer a clickable link to the package directory.
- README edge-case table updated to flag the Windows transport as untested in the wild.
- Internal: renamed "OSC byte sequence" section to "Escape-sequence constants" to cover the new CSI additions; split formatters into their own section to mirror `payload.ts`’s Constants → Builders separation; restated the 160ms frame cadence in module headers.

## [1.0.12] - 2026-05-01

### Added
- `docs/cover.png` — package hero (rasterized from `docs/cover.svg` via `rsvg-convert`, 1280×640).
- `session_start` payload emission on `agent_start` so Warp learns the project context at agent boot, before any tool call.
- Client-side protocol-version negotiation: parse `WARP_CLI_AGENT_PROTOCOL_VERSION` and gate emission on the negotiated version, replacing the prior hard-coded broken-build check.
- Config-driven blocking-tool flow: subscribes to `question_asked` / `tool_complete`, drives the OSC 777 envelope from a per-tool config table instead of the inline `NOTIFY_TOOL_NAMES` allowlist. Adds `ask_user_question` as the initial blocking-tool entry.

### Changed
- README now opens with a `<picture>`-wrapped `cover.png` hero so GitHub renders friendly artwork at the top of the package page.
- `package.json` now carries `"private": true` to gate npm publish — the package joins lockstep + shared CI infrastructure but does not publish until explicitly opted in.
- Agent-start emission switched from `session_start` to `prompt_submit` so Warp's UI cues fire on user-prompt cadence rather than session boot.

## [1.0.11] - 2026-04-30

### Added
- Initial release. New standalone Pi extension that subscribes to four Pi lifecycle events (`session_start`, `agent_end`, `tool_call`, `turn_end`) and emits Warp's structured `OSC 777` escape sequence to `/dev/tty` so Warp renders native OS-level toast notifications. Filters `session_start` to `reason === "startup"` only, and `tool_call` to a configurable `NOTIFY_TOOL_NAMES` set (initial entry: `ask_user_question`). Detects Warp via `TERM_PROGRAM === "WarpTerminal"` plus `WARP_CLI_AGENT_PROTOCOL_VERSION`; falls back to silent no-op outside Warp, on broken Warp builds (per-channel hard-coded thresholds), or when `/dev/tty` is unreachable. Standalone — not registered as a sibling, not auto-installed by `/rpiv-setup`. Install via `pi install npm:@juicesharp/rpiv-warp`.
