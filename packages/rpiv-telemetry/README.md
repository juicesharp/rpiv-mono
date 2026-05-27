# rpiv-telemetry

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-telemetry">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-telemetry/docs/cover.png" alt="rpiv-telemetry cover" width="50%">
    </picture>
  </a>
</div>

MLflow observability for [Pi Agent](https://github.com/badlogic/pi-mono). `rpiv-telemetry` auto-instruments Pi lifecycle events and sub-agent activity and dispatches them to one or more configured providers through a bounded async pipeline that never blocks the agent.

## Providers

| Provider | Env vars | Notes |
|---|---|---|
| `mlflow` | `MLFLOW_TRACKING_URI`, `MLFLOW_EXPERIMENT_ID`, `MLFLOW_TRACKING_TOKEN` | Bring your own tracking server. Without `MLFLOW_TRACKING_URI` (or `providers.mlflow.trackingUri` in config) the provider registers but silently drops events. See [§Running MLflow locally with Docker](#running-mlflow-locally-with-docker). |
| `console` | — | Pretty-prints events to stderr. Useful while wiring things up. |

## Install

```bash
pi install npm:@juicesharp/rpiv-telemetry
```

Then restart your Pi session.

## Configure

Env-first, file-second.

1. Environment variables — `MLFLOW_TRACKING_URI`, `MLFLOW_EXPERIMENT_ID`, `MLFLOW_TRACKING_TOKEN`. Set these and you don't need a config file.
2. `~/.config/rpiv-telemetry/config.json`:

```json
{
  "providers": {
    "mlflow": {
      "trackingUri": "http://localhost:5001"
    },
    "console": {}
  },
  "events": "*",
  "llmPayload": "off",
  "dispatcher": {
    "maxQueueSize": 100
  }
}
```

### `providers`

Only the built-in keys `mlflow` and `console` are accepted. Unknown keys (typos like `mflow`) are reported on stderr and ignored. Custom providers register at runtime via `registerTelemetryProvider`, not through the config file.

### `events`

| Value | Behavior |
|---|---|
| omitted *(default)* | All events forwarded. |
| `"*"` | All events forwarded (explicit form). |
| `[]` | No events forwarded. |
| `string[]` | Allowlist; entries are validated against the known event kinds — unknown entries are warned and dropped. |

### `dispatcher.maxQueueSize`

Maximum number of events buffered before backpressure drops the oldest. Defaults to `100`. Raise for sessions with long sub-agent fan-outs or heavy tool churn when MLflow latency spikes; lower if memory pressure matters more than event completeness.

`llmPayload` controls how much of the raw `before_provider_request` body is recorded on each `llm-request` span:

| Mode | Behavior |
|---|---|
| `"off"` *(default)* | Span timing + status only. Zero payload bytes recorded. |
| `"summary"` | Records a small inspectable summary (`model`, `messageCount`, `toolCount`, `systemBytes`, `temperature`, `maxTokens`, `stream`). |
| `"full"` | Records the unmodified provider request body. Large — can include full conversation history. |

## Running MLflow locally with Docker

The minimal local MLflow that `rpiv-telemetry` can talk to is a single container with **proxied artifacts** and the security middleware in permissive mode for local dev. Works identically on Docker Desktop and OrbStack.

```yaml
# ~/docker/mlflow/compose.yml
services:
  mlflow:
    image: ghcr.io/mlflow/mlflow:latest
    container_name: mlflow
    ports:
      - "5001:5000"   # macOS AirPlay Receiver squats on :5000 — use 5001
    volumes:
      - ./data:/mlflow
    command: >
      mlflow server --host 0.0.0.0 --port 5000
      --backend-store-uri sqlite:////mlflow/mlflow.db
      --artifacts-destination /mlflow/artifacts
      --default-artifact-root mlflow-artifacts:/
      --serve-artifacts
      --allowed-hosts "*"
      --cors-allowed-origins "*"
    restart: unless-stopped
```

```bash
mkdir -p ~/docker/mlflow/data && cd ~/docker/mlflow
docker compose up -d

# Sanity check — HTTP 200 means it's wired correctly
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:5001/
```

Then point rpiv-telemetry at it:

```bash
export MLFLOW_TRACKING_URI=http://localhost:5001
```

OrbStack also exposes `http://<container_name>.orb.local` automatically (here: `http://mlflow.orb.local`) — handy when you don't want to remember a port.

### Why `mlflow-artifacts:/` instead of a path

The artifact location each experiment exposes to clients **must be a parseable URL**. A bare filesystem path like `/mlflow/artifacts` makes the Node SDK throw `ERR_INVALID_URL` at `new URL(...)` when it tries to upload trace data. `--default-artifact-root mlflow-artifacts:/` + `--serve-artifacts` tells MLflow to hand clients a `mlflow-artifacts:` URL and proxy bytes to disk via `--artifacts-destination`. Clients never need to know where artifacts physically land.

### Artifact location is stamped per-experiment

MLflow records the artifact location on each experiment row **when the experiment is created**, not at request time. If you ever boot the server with a broken `--default-artifact-root`, every experiment created during that window keeps the broken value forever — changing flags later only affects *new* experiments. Wipe the DB to recover:

```bash
docker compose down
rm -rf data/mlflow.db data/artifacts
docker compose up -d

# Confirm the auto-created default experiment now uses the proxy scheme
curl -s 'http://localhost:5001/api/2.0/mlflow/experiments/get?experiment_id=0' \
  | jq -r .experiment.artifact_location
# → mlflow-artifacts:/0
```

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
