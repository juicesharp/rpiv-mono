# rpiv-telemetry

## Monorepo Context
**Private** Pi extension in `rpiv-mono` (`"private": true` — bumped lockstep with the `@juicesharp/rpiv-*` family but **skipped at publish**). Not a sibling: absent from `siblings.ts`, not peer-pinned in `rpiv-pi`, never suggested by `/rpiv-setup`. Rides shared check/test/release infrastructure purely through filesystem auto-discovery (`packages/*` glob). MLflow observability for Pi Agent — auto-instruments lifecycle events and sub-agent activity.

## Responsibility
A telemetry pipeline: it subscribes to Pi lifecycle + pi-subagents EventBus events, normalizes them into a provider-agnostic `TelemetryEvent` stream, and fans that stream out to configured sinks (console for debug, MLflow for real tracing). The central, non-obvious design constraint is **lazy-load cold-start discipline** — the Pi extension path must never eagerly evaluate `@mlflow/core` (~325ms).

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`, lifecycle events + EventBus
- **`typebox`** (runtime dep): config schema + EventBus payload validation
- **`@juicesharp/rpiv-config`** (runtime dep): `loadJsonConfigWithLegacyFallback` reads config XDG-first (`XDG_CONFIG_HOME`) with a one-way fallback to the legacy `~/.config` path when the XDG file is absent; `configPath` remains only for the save path (`saveJsonConfig`)
- **`@mlflow/core`** (runtime dep): trace/span primitives — loaded lazily, never at extension start

## Module Structure
```
extension.ts   — Thin Pi entry (pi.extensions: ["./extension.ts"]); calls initInstrumentation(pi). Deliberately thin so loading
                 the extension never evaluates the MLflow re-export
index.ts       — Package barrel (teardownTelemetry, MlflowProvider) for standalone embedders — NOT the Pi entry
config.ts      — TypeBox-validated config, loaded XDG-first with one-way legacy fallback; the provider schema is the single source of truth for the provider key set
dispatcher.ts  — Bounded async dispatcher: provider registry, queue/backpressure, no-provider + per-kind config gates, warn-once posture
instrumentation/ — Pi-binding layer: events → TelemetryEvent → dispatcher. See .rpiv/guidance/packages/rpiv-telemetry/instrumentation/architecture.md
providers/     — Provider catalog + console (dev/debug) sink; providers/mlflow/ is the real backend. See .rpiv/guidance/packages/rpiv-telemetry/providers/mlflow/architecture.md
types/         — Shared contract: events.ts (TelemetryEvent union), provider.ts (TelemetryProvider interface)
```

Flow: `extension.ts → instrumentation/ (capture+normalize) → dispatcher.ts (gate+queue) → providers/ → providers/mlflow/`. Type-check via root `tsc --noEmit`; tests via root Vitest (`vitest run`); `ship-manifest.test.ts` guards that `package.json` `files` stays in sync with source.

## Lazy-Load Cold-Start Invariant
The package-wide rule that shapes its file layout: the Pi entry is `extension.ts`, **not** the `index.ts` barrel, because the barrel value-re-exports `MlflowProvider` (which pulls `@mlflow/core`). Any heavy-SDK provider keeps an `@mlflow`-free `meta.ts` twin in the catalog and loads its impl behind a dynamic `import()`. Lightweight providers (console) register eagerly. See the provider mechanism in `.rpiv/guidance/packages/rpiv-telemetry/providers/mlflow/architecture.md`.

## Config-Driven Provider Registry
`registerConfiguredProviders(config)` walks the config and registers a provider only when its key is present (`config.providers.<name> !== undefined`). The dispatcher gates twice: it drops everything when **no** providers are registered, and filters per-event via the config's enabled-event set. Failures are isolated per provider with a warn-once / recover-once posture — a broken sink never stalls or crashes the agent loop.

## Architectural Boundaries
- **Telemetry never throws into the host** — every failure path (init, dispatch, flush, shutdown) degrades to drop + warn-once
- **The Pi entry stays thin** — `extension.ts` only calls `initInstrumentation`; it must not import anything that transitively pulls `@mlflow/core`
- **`TelemetryEvent` is the only cross-layer vocabulary** — instrumentation produces it, the dispatcher routes it, providers consume it; no layer reaches around it
- **Teardown ordering is load-bearing** — orphan-flush → dispatcher shutdown → state reset (documented in the instrumentation layer)

<important if="you are adding a new telemetry provider (sink) to rpiv-telemetry">
## Adding a Provider (cross-layer)
1. Add the provider's config sub-schema to `config.ts` (TypeBox) — the provider schema is the source of truth for the key set
2. Implement `TelemetryProvider` (`meta`, `trackEvent`, `flush`, `shutdown`) in `providers/<name>.ts` (or a `<name>/` subdir if it warrants decomposition like `mlflow/`)
3. Add its `<NAME>_PROVIDER_META` to `BUILT_IN_PROVIDERS` in `providers/index.ts`
4. Register it in `registerConfiguredProviders`, gated on `config.providers.<name> !== undefined`
5. **Heavy SDK only** → split an SDK-free `meta.ts` twin from the impl and load via dynamic `import()` (see the MLflow provider file). Lightweight providers register eagerly — no split needed
6. The provider must never throw into the host — swallow + warn-once, mirroring the dispatcher's `failedProviders` posture
</important>

<important if="you are instrumenting a new event end-to-end (capture → span)">
## Vertical Slice
1. Add the `kind` + fields to the `TelemetryEvent` union in `types/events.ts`
2. Capture it — Pi hook or EventBus handler: see `.rpiv/guidance/packages/rpiv-telemetry/instrumentation/architecture.md` ("Adding an Instrumented Event")
3. Render it — map the new `kind` to an MLflow span/attribute: see `.rpiv/guidance/packages/rpiv-telemetry/providers/mlflow/architecture.md` ("Adding a Span Type")
</important>
