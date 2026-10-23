# Changelog

All notable changes to `@juicesharp/rpiv-telemetry` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Fixed

- **`typebox` is declared as a `peerDependencies: "*"` entry, no longer a `dependencies` entry.** Pi provides `typebox` to extensions and aliases the bare specifier to its own bundled copy at load time, so the copy this manifest installed was dead weight at best and a second live instance at worst. Pi 0.99.1 warns at every startup about the old shape ("Host-provided extension packages must be declared in peerDependencies with a \"*\" range, not dependencies: typebox"); this clears it once the release is installed. Contributed in #282; reported in #266, #268, #272 and #277.

## [2.11.0] - 2026-09-21

## [2.10.1] - 2026-09-13

## [2.10.0] - 2026-09-12

## [2.9.0] - 2026-09-01

## [2.8.0] - 2026-08-29

## [2.7.1] - 2026-08-24

## [2.7.0] - 2026-08-21

## [2.6.4] - 2026-08-20

## [2.6.3] - 2026-08-20

## [2.6.2] - 2026-08-18

## [2.6.1] - 2026-08-17

## [2.6.0] - 2026-08-15

## [2.5.2] - 2026-08-14

## [2.5.1] - 2026-08-14

## [2.5.0] - 2026-08-13

## [2.4.0] - 2026-08-03

## [2.3.1] - 2026-07-31

## [2.3.0] - 2026-07-31

## [2.2.0] - 2026-07-29

## [2.1.0] - 2026-07-23

## [2.0.0] - 2026-07-21

### Added
- Configuration is now read from the XDG config directory (`XDG_CONFIG_HOME`), falling back to the legacy location when the new path is absent.

### Fixed
- Tools register correctly under package managers that do not install peer dependencies.

## [1.20.0] - 2026-06-15

## [1.19.1] - 2026-06-10

## [1.19.0] - 2026-06-09

## [1.18.2] - 2026-06-04

## [1.18.1] - 2026-06-04

## [1.18.0] - 2026-06-04

### Changed
- `@mlflow/core` now loads lazily — only when an MLflow provider is configured. `pi.extensions` points at a thin `extension.ts` so loading the extension no longer evaluates the MLflow provider (the heavy SDK, ~325ms); a session without MLflow telemetry never pays that cost. The package barrel remains the embedder API.

## [1.17.1] - 2026-06-01

## [1.17.0] - 2026-06-01

## [1.16.1] - 2026-05-30

## [1.16.0] - 2026-05-30

## [1.15.0] - 2026-05-28

## [1.14.7] - 2026-05-28

## [1.14.6] - 2026-05-28

## [1.14.5] - 2026-05-28

### Changed
- MLflow provider: extracted `MlflowSpanRegistry` to own per-session span maps with O(1) session lookup; replaced flat `${sessionId}\0${innerKey}` composite-string keys with nested maps.
- MLflow provider: replaced JSON-blob `event.<kind>` span attributes with typed per-kind attribute writers so dashboards can filter on individual fields (`turn.stop_reason`, `model.id`, `subagent.usage.total_tokens`, …).
- MLflow provider: named the pi-subagents `Agent` tool contract (`AGENT_TOOL_NAME`, `AgentToolDetails`) instead of inline magic-string + duck-type.
- MLflow provider: per-event-kind transition-based warning replaces blanket `console.debug` swallow on `trackEvent` failure.
- Dispatcher: backpressure warning now fires once on leading edge (saturation) and once on trailing edge (recovery) instead of every 10 drops.
- Dispatcher: `shutdown()` now awaits the in-flight batch before processing the post-batch tail — preserves FIFO ordering when shutdown lands mid-drain.
- Config: unknown provider keys are rejected by the TypeBox schema instead of warn-and-throw double-acting.

## [1.14.4] - 2026-05-28

## [1.14.3] - 2026-05-28

## [1.14.2] - 2026-05-28

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

### Added
- MLflow observability extension with auto-instrumented Pi lifecycle and sub-agent events, bounded async dispatcher, and per-provider span builders.
- Sub-agent lineage tracing: detects sub-agent type from `<active_agent>` tags and groups sub-agent turns under their orchestrator's session in MLflow.

### Changed
- Package marked `private` to skip npm publish.
