# Running MLflow locally with Docker

A minimal local MLflow tracking server that `rpiv-telemetry` can send traces to,
plus the two artifact-configuration traps that cost the most time to diagnose.

The setup is a single container with **proxied artifacts** and the security
middleware in permissive mode for local development. It works identically on
Docker Desktop and OrbStack.

## The compose file

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

## Boot it

```bash
mkdir -p ~/docker/mlflow/data && cd ~/docker/mlflow
docker compose up -d

# Sanity check — HTTP 200 means it's wired correctly
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:5001/
```

OrbStack also exposes `http://<container_name>.orb.local` automatically (here:
`http://mlflow.orb.local`), which is handy when you would rather not remember a
port.

## Point rpiv-telemetry at it

The MLflow provider is constructed only when its config key exists, so the file
is required even if you set the environment variable:

```json
{
  "providers": {
    "mlflow": { "trackingUri": "http://localhost:5001" }
  }
}
```

Write that to `~/.config/rpiv-telemetry/config.json` (or
`$XDG_CONFIG_HOME/rpiv-telemetry/config.json`). The environment variable
overrides the file's value when both are set:

```bash
export MLFLOW_TRACKING_URI=http://localhost:5001
```

Traces land under experiment `"0"` — MLflow's auto-created default — unless you
set `experimentId` or `MLFLOW_EXPERIMENT_ID`.

To confirm instrumentation is firing before you trust the server wiring, add
`"console": {}` to `providers` and watch stderr for `[rpiv-telemetry] …` lines.

## Why `mlflow-artifacts:/` and not a filesystem path

The artifact location an experiment exposes to clients **must be a parseable
URL**. A bare filesystem path like `/mlflow/artifacts` makes the Node SDK throw
`ERR_INVALID_URL` at `new URL(...)` when it tries to upload trace data.

`--default-artifact-root mlflow-artifacts:/` combined with `--serve-artifacts`
tells MLflow to hand clients an `mlflow-artifacts:` URL and proxy the bytes to
disk via `--artifacts-destination`. Clients never need to know where artifacts
physically land.

## Artifact location is stamped per experiment

MLflow records the artifact location on each experiment row **when the experiment
is created**, not at request time. If you ever boot the server with a broken
`--default-artifact-root`, every experiment created during that window keeps the
broken value forever — changing the flags later only affects *new* experiments.

Wipe the database to recover:

```bash
docker compose down
rm -rf data/mlflow.db data/artifacts
docker compose up -d

# Confirm the auto-created default experiment now uses the proxy scheme
curl -s 'http://localhost:5001/api/2.0/mlflow/experiments/get?experiment_id=0' \
  | jq -r .experiment.artifact_location
# → mlflow-artifacts:/0
```
