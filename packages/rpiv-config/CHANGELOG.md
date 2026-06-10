## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

### Added
- `modelKey` and `parseModelKey` are now exported from `@juicesharp/rpiv-config` (consolidated out of `rpiv-advisor`) so all consumers share one model-key codec.

### Changed
- `parseModelKey` now accepts both `provider/modelId` (canonical slash form) and `provider:modelId` (legacy colon form), preferring slash when both separators are present.
- `modelKey()` now emits only the canonical slash form (`provider/modelId`); it previously emitted `provider:modelId`. Paired with the tolerant read, persisted colon-form keys auto-migrate to slash on the next save by any consumer that re-serialises through the codec.

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

## [1.15.0] - 2026-05-28

### Added
- `GuidanceFieldsSchema` — TypeBox form of the existing `GuidanceFields` interface. For consumers composing larger TypeBox-validated config objects that need to declare a guidance subtree without redeclaring the leaf shape. Used internally by `rpiv-web-tools` Phase 4 config consolidation.

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
