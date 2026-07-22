# @juicesharp/rpiv-telemetry

Records what a [Pi Agent](https://github.com/badlogic/pi-mono) session did — every
turn, tool call, LLM request, and sub-agent run — as MLflow traces you can inspect
after the run ends. Internal to this repo: `"private": true`, never published to npm.

## Install

Inside this monorepo Pi loads it through the workspace symlink already. Elsewhere,
point Pi at the package directory of a checkout where `npm install` has run:

```sh
pi install ./packages/rpiv-telemetry
```

Restart your Pi session.

## Quick start

It stays inert until you write `~/.config/rpiv-telemetry/config.json` (or
`$XDG_CONFIG_HOME/rpiv-telemetry/config.json`). A provider is constructed only when
its key is present; with none, every event is dropped. Start with the console sink,
which needs no server:

```json
{ "providers": { "console": {} } }
```

Run a turn: every event pretty-prints to stderr as `[rpiv-telemetry] <ts> <kind> …`.
Then swap in `"mlflow": { "trackingUri": "http://localhost:5001" }`, which needs an
MLflow server listening at that URI — nothing does by default, so start one first
([`docs/mlflow-server-setup.md`](docs/mlflow-server-setup.md) runs it in Docker).
Env vars override the file's MLflow credentials ([`docs/configuration.md`](docs/configuration.md#environment-variables)).

## What it provides

- **A browsable trace tree per turn** — one root `agent-turn` span with nested `tool` and `llm-request` children.
- **Sub-agent lineage instead of orphans** — the sub-agent type is read from the `<active_agent name="..."/>` tag, and its trace groups under the parent session in MLflow's Session column.
- **Token counts and cost as filterable fields** — typed dotted attributes like `turn.usage.total_tokens` and `llm.cost.total_usd`, not JSON blobs.
- **A failure path that never reaches the agent** — provider, init, and flush errors all degrade to drop-and-warn-once, and the bounded queue (default 100) drops oldest under load.
- **Near-zero cost when unconfigured** — `@mlflow/core` (~325 ms) sits behind a dynamic `import()` fired only when `providers.mlflow` is set.
- **A zero-setup debug sink** — `"console": {}` pretty-prints every event to stderr with no MLflow server at all.

## Reference

- [`docs/configuration.md`](docs/configuration.md) — every config key and default, XDG path resolution, env-var precedence, the 20 valid `events` kinds.
- [`docs/mlflow-server-setup.md`](docs/mlflow-server-setup.md) — a local MLflow in Docker, and the two artifact-root traps that break trace upload.
- [`docs/mlflow-spans.md`](docs/mlflow-spans.md) — event-to-span mapping and the full span-attribute vocabulary.

## Used by

Its one sibling dependency is [`rpiv-config`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-config), for config load, save, and validation.
The root Vitest harness calls `teardownTelemetry()` before every test for isolation — a harness coupling, not a runtime one.

## Conventions

- **The Pi entry is `extension.ts`, not `index.ts`.** The barrel value-re-exports `MlflowProvider`, which pulls `@mlflow/core`; nothing reachable from `extension.ts` may import it transitively.
- **Telemetry never throws into the host.** Init, dispatch, flush, and shutdown all swallow and warn once.
- **`providers/mlflow/trace-session-shim.ts` deep-imports `@mlflow/core/dist/core/trace_manager.js`** — an unofficial path pending the upstream `mlflow.tracingContext` API. Re-check it on every `@mlflow/core` bump.
