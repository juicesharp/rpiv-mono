## [1.10.2] - 2026-05-20

## [1.10.1] - 2026-05-19

## [1.10.0] - 2026-05-19

## [1.9.2] - 2026-05-19

## [1.9.1] - 2026-05-19

## [1.9.0] - 2026-05-18

## [1.8.3] - 2026-05-18

## [1.8.2] - 2026-05-17

## [1.8.1] - 2026-05-17

### Added
- Shared config I/O library with `configPath`, `loadJsonConfig`, `saveJsonConfig`, `readEnvVar`, and `validateConfig` helpers, extracted from the rpiv sibling packages.
- `saveJsonConfig` returns a boolean indicating persist success; callers guard user-facing notifications on the result.
- `loadJsonConfig` emits a `console.warn` diagnostic on malformed JSON and rejects array-root values.
