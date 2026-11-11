# Changelog

All notable changes to `@juicesharp/rpiv-voice` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.15.0] - 2026-10-24

## [2.14.2] - 2026-10-23

## [2.14.1] - 2026-10-23

## [2.14.0] - 2026-10-23

## [2.13.10] - 2026-10-23

## [2.13.9] - 2026-10-17

### Changed

- Faster extension startup: relative imports now name the published `.ts` files instead of nonexistent `.js` targets, so Pi's loader (jiti) no longer runs fallback resolution for each of them on every launch. Runtime behavior is unchanged. Thanks @ry4nyu for #306, and @szastupov for #304.

## [2.13.8] - 2026-10-12

## [2.13.7] - 2026-10-12

## [2.13.6] - 2026-10-12

## [2.13.5] - 2026-10-12

## [2.13.4] - 2026-10-11

## [2.13.3] - 2026-10-11

## [2.13.2] - 2026-10-11

## [2.13.1] - 2026-10-11

## [2.13.0] - 2026-10-11

## [2.12.0] - 2026-09-30

## [2.11.0] - 2026-09-21

## [2.10.1] - 2026-09-13

## [2.10.0] - 2026-09-12

### Fixed

- **The dictation UI no longer freezes while a decode runs.** `recognizer.decode()` ran Whisper inference synchronously on the shared event loop, so the TUI froze for the length of every decode. Recognizer construction and decode now ride napi async work (`OfflineRecognizer.createAsync` / `decodeAsync`), keeping the splash render and the overlay responsive. Because a final decode can now still be in flight when the user commits, the session drains the finals chain before pasting to the editor; the drain races a 10 s timeout that falls back to the reducer merge (leaving an `stt.drain` breadcrumb), and commit teardown orders drain-then-abort so a drain-time failure still reaches `errors.log`. Once the signal is aborted the pipeline skips stranded decode work outright, and post-abort rejections no longer land in the error log as failures.
- **Decodes serialize on the one native recognizer handle.** `SttEngine.recognize` FIFO-serializes calls, so a rolling partial and a chained final can no longer overlap on the handle sherpa holds no lock over.
- **A settings save no longer reverts JSON-only keys.** Save handlers merge the draft against `voice.json` as read at save time, so a mid-session hand edit of a key the settings screen does not own round-trips instead of silently reverting.

### Added

- **`numThreads` in `voice.json`** tunes the recognizer's decode threads (default 4, integer 1–16, clamped). It is JSON-only: the settings screen shows it read-only and passes it through on save. Decode calls leave `stt.decode` latency breadcrumbs in the diagnostic log, and the diagnostic-log table documents the new `stt.decode` / `stt.drain` rows.

## [2.9.0] - 2026-09-01

## [2.8.0] - 2026-08-29

## [2.7.1] - 2026-08-24

## [2.7.0] - 2026-08-21

## [2.6.4] - 2026-08-20

## [2.6.3] - 2026-08-20

## [2.6.2] - 2026-08-18

## [2.6.1] - 2026-08-17

### Added

- Package card cover on pi.dev: `package.json` now declares `pi.image` pointing at the package's `docs/cover.png`.

## [2.6.0] - 2026-08-15

## [2.5.2] - 2026-08-14

## [2.5.1] - 2026-08-14

## [2.5.0] - 2026-08-13

## [2.4.0] - 2026-08-03

## [2.3.1] - 2026-07-31

## [2.3.0] - 2026-07-31

## [2.2.0] - 2026-07-29

## [2.1.0] - 2026-07-23

### Changed
- README rewritten to follow the documentation standard shared across all packages.
- npm tarball now includes the versioned `docs/` reference and no longer ships cover or screenshot art.

## [2.0.0] - 2026-07-21

### Added
- Configuration is now read from the XDG config directory (`XDG_CONFIG_HOME`), falling back to the legacy location when the new path is absent.

## [1.20.0] - 2026-06-15

### Added
- Chinese (`zh`) translations (`locales/zh.json`), plus the matching English copy for the equalizer setting label/hint (#68).

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

### Added
- Voice-activity detection now tries Silero VAD first and falls back to an energy-based gate when the device can't capture at 16 kHz.

### Fixed
- Built-in microphone capture no longer stalls on macOS devices that don't support a 16 kHz sample rate.

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
- Refresh npm cover (`docs/cover.{svg,png}`): align with the unified card layout used across the `@juicesharp/rpiv-*` family and push the status row below the equalizer so the recording dot, timer, and hotkey hints no longer overlap the audio bars.

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

### Fixed
- Voice settings now persist to disk before applying in memory, preventing contradictory success/failure notifications on write failure.

## [1.8.0] - 2026-05-16

## [1.7.0] - 2026-05-15

## [1.6.1] - 2026-05-14

## [1.6.0] - 2026-05-14

## [1.5.2] - 2026-05-13

## [1.5.1] - 2026-05-13

## [1.5.0] - 2026-05-12

### Added
- Redesigned equalizer visualization with a centered bell silhouette, truecolor accent gradient, and audio-driven animation.

## [1.4.2] - 2026-05-11

### Changed
- Published to npm — install via `pi install npm:@juicesharp/rpiv-voice`.

## [1.4.1] - 2026-05-11

## [1.4.0] - 2026-05-10

## [1.3.1] - 2026-05-10

### Added
- Settings screen with ↑/↓ field navigation, equalizer toggle (default off), and auto-persist on close.
- Live audio-level equalizer bar in the overlay chrome.

### Changed
- README rewritten with feature overview, key-binding table, and configuration reference.

### Fixed
- Preflight stage tag preserved across voice-session initialization.

## [1.3.0] - 2026-05-08

### Added
- `/voice` command for local speech-to-text dictation backed by sherpa-onnx Whisper, with mic capture, live transcript overlay, and settings screen.
- Rolling partial transcript shown in real time while speaking.
- Download progress indicator with percent and byte counter on the model splash screen.
- Configurable keybinding support for the cancel action (no longer hardcoded to Escape).

### Changed
- Package marked `private: true` (opt-in install only; not part of the auto-install bundle).
- Internal constants and helper functions extracted for readability (magic numbers named, idioms centralized).

### Fixed
- Whisper spurious terminal punctuation reduced via longer VAD hangover and trailing-silence padding.
- Partial model installs are rolled back on failure; stale model directories detected and re-downloaded automatically.
- STT recognition failures logged to `~/.config/rpiv-voice/errors.log` instead of being silently swallowed.
- Download splash text uses a simplified Whisper model name.
