# Changelog

All notable changes to `@juicesharp/rpiv-telemetry` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
