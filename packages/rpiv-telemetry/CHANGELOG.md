# Changelog

All notable changes to `@juicesharp/rpiv-telemetry` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.1] - 2026-05-28

## [1.14.0] - 2026-05-28

### Added
- MLflow observability extension with auto-instrumented Pi lifecycle and sub-agent events, bounded async dispatcher, and per-provider span builders.
- Sub-agent lineage tracing: detects sub-agent type from `<active_agent>` tags and groups sub-agent turns under their orchestrator's session in MLflow.

### Changed
- Package marked `private` to skip npm publish.
