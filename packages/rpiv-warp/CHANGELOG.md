# Changelog

All notable changes to `@juicesharp/rpiv-warp` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.16.0] - 2026-05-30

### Fixed
- Pressing ESC to refuse a blocking-tool prompt no longer leaves the Warp tab stuck on a stale "Waiting for your answer" badge. Aborted blocking calls now drain at `agent_end` to clear the badge before announcing the stop.

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

### Fixed
- "Waiting for your answer" toast renders skill invocations as `/skill:<name> <args>` instead of the raw skill-block markup. Applies to both prompt-submit and stop-query toasts.

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

### Added
- Idle prompt emission after agent turns complete, carrying the assistant summary.
- Configurable heartbeat re-emitting `prompt_submit` during active work (default 15 s, set `heartbeatMs` in config to override, `0` to disable).
- `session_shutdown` handler clearing all timers and spinner state.
- Blocking tool input capture attached to `tool_complete` payloads.
- `before_agent_start` handler capturing the user's query for accurate `prompt_submit` events.

## [1.5.0] - 2026-05-12

## [1.4.2] - 2026-05-11

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

## [1.3.0] - 2026-05-08

### Changed
- Package is now published to npm (previously `private: true`). The title-spinner module is included in the tarball.

## [1.2.1] - 2026-05-07

## [1.2.0] - 2026-05-07

## [1.1.5] - 2026-05-05

## [1.1.4] - 2026-05-03

## [1.1.3] - 2026-05-03

## [1.1.2] - 2026-05-03

## [1.1.1] - 2026-05-03

## [1.1.0] - 2026-05-03

## [1.0.19] - 2026-05-03

### Added
- README `Features` section listing customer-facing functionality: native OS toasts on Pi lifecycle events, live Warp tab badge, tab-title spinner, configurable blocking-tool allowlist, startup-only session notifications, silent-outside-Warp behavior, best-effort Windows support, and zero-tool footprint.

### Changed
- **Now publicly published on npm.** `package.json` no longer carries `"private": true`, so workspace publishes pick `@juicesharp/rpiv-warp` up alongside the rest of the family. Install with `pi install npm:@juicesharp/rpiv-warp`. The package is still opt-in: it is intentionally absent from `siblings.ts` and is NOT auto-installed by `/rpiv-setup`.

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
