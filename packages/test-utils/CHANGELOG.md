# Changelog

All notable changes to this package will be documented in this file.

## [0.10.0] - 2026-04-20

### Added
- Initial internal test-fixture package (not published).
- `createMockPi`, `createMockCtx`, `createMockUI`, `createMockSessionManager`, `createMockModelRegistry` factory stubs for the Pi ExtensionAPI surface.
- `makeMessage*` / `buildSessionEntries` / `buildLlmMessages` factories for synthetic session branches.
- `assertToolContract` + `roundTripBranchState` contract helpers.
- `makeTheme` + `makeTui` deterministic rendering fixtures.
