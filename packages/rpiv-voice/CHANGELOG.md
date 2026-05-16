# Changelog

All notable changes to `@juicesharp/rpiv-voice` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
