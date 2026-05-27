# Changelog

All notable changes to `@juicesharp/rpiv-telemetry` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Event-wiring redesign: instrumentation's 20 near-identical handler blocks consolidated into declarative `PI_HANDLERS` + `SUBAGENT_HANDLERS` tables; the cross-cutting glue (`sessionId` injection, timestamp, dispatch) lives in a single loop.
- Sub-agent EventBus payloads are now typebox-validated at the boundary (`instrumentation/schemas.ts`). Previously, malformed payloads were silently coerced via `String(...)` / `Number(...)`; now they are dropped with a single `console.warn` and never reach providers.
- Built-in provider registration now goes through a `PROVIDER_FACTORIES` map; adding a built-in provider is one entry instead of an `import` + `switch` case.
- **Config schema (breaking on-disk shape)**: `events` is now `"*" | TelemetryEventKind[]`. The previous `undefined`/`[]` overload is gone — omit the field (or set `"*"`) for "all events"; `[]` continues to mean "no events". The runtime `TelemetryConfig.events` field is no longer optional.
- **Config schema (breaking on-disk shape)**: `providers` keys are now enumerated (`mlflow`, `console`). Unknown keys like `mflow:` (typos) are reported on stderr at load time and ignored instead of being silently accepted.
- **Config schema (additive)**: `dispatcher.maxQueueSize` knob exposes the queue cap that was previously hard-coded at 100. Default is still 100.

### Migration

- `~/.config/rpiv-telemetry/config.json` consumers that relied on `"events": []` to disable all events keep working unchanged.
- Consumers that intentionally wrote `"events": []` expecting "all events" (the pre-I1-fix behavior) need to either remove the field or set `"events": "*"`.
- Consumers with a typo'd provider key (e.g. `mflow`) will now see `[rpiv-telemetry] unknown provider keys in config (ignored): ...` on stderr — fix the spelling.
