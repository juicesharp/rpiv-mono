# Configuration reference

Every `rpiv-telemetry` config key, its default, how the config file is located,
and how environment variables interact with it.

## Config file location

The read path is resolved XDG-first, with a one-way fallback to the legacy
location (`loadJsonConfigWithLegacyFallback("rpiv-telemetry")`):

| Condition | Path read |
| --- | --- |
| `XDG_CONFIG_HOME` unset, empty, whitespace-only, relative, or in `~user` form | `~/.config/rpiv-telemetry/config.json` |
| `XDG_CONFIG_HOME` absolute (or `~` / `~/…`, tilde-expanded and then required to be absolute) | `$XDG_CONFIG_HOME/rpiv-telemetry/config.json` |
| XDG path resolved but the file is **missing** | falls back to `~/.config/rpiv-telemetry/config.json` |
| XDG path present but the JSON is **malformed** | warns and returns `{}` — it does **not** fall back to the legacy file, so corruption is surfaced rather than masked |

The **write** path (`saveTelemetryConfig`) has no legacy fallback: it always
writes to the XDG-resolved path.

`saveJsonConfig` chmods the file to `0600` (owner read/write). The chmod is
best-effort and never gates the return value — it can silently no-op on tmpfs,
network mounts, and Windows-style permissions. The save itself returns `false`
when the directory create or the write fails.

## Full example

```json
{
  "providers": {
    "mlflow": {
      "trackingUri": "http://localhost:5001",
      "experimentId": "0"
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

## Top-level keys

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `providers` | object | `{}` | Which sinks to construct. Only `mlflow` and `console` are accepted. With `{}` no provider registers and the dispatcher drops every event. |
| `events` | `"*"` \| `string[]` | `"*"` | Allowlist of event kinds to forward. |
| `llmPayload` | `"full"` \| `"summary"` \| `"off"` | `"off"` | How much of the raw provider-request body lands on each `llm-request` span. |
| `dispatcher.maxQueueSize` | integer ≥ 1 | `100` | Events buffered before backpressure drops the oldest. |

A provider is constructed only when its key is **present** in `providers`.
Environment variables supply credentials; they never cause a provider to be
registered. Without a config file there are no providers, and every event is
dropped at the dispatcher boundary.

Unknown keys are **silently stripped**, not rejected. Validation runs
`Value.Clean` + `Value.Create` against the TypeBox schema with
`additionalProperties: false`; there is no `Value.Check`/`Value.Assert` and no
warning. A typo like `"mflow"` disappears without a message, and the provider it
was meant to configure never registers — check for `"mlflow"` spelled exactly if
traces are not arriving.

## `providers.mlflow`

| Key | Default | Notes |
| --- | --- | --- |
| `trackingUri` | none | Required in practice. Without it the provider registers, warns once (`mlflow provider registered but MLFLOW_TRACKING_URI is not configured — events will be silently dropped`), and drops everything. |
| `experimentId` | `"0"` | Passed to MLflow `init()`. `"0"` is MLflow's auto-created default experiment. |
| `trackingToken` | none | Bearer token for MLflow **server** auth, passed as `trackingServerToken`. Omitted from `init()` when absent. This is not a model API key — no LLM is ever called by this package. |

## `providers.console`

Takes an empty object (`"console": {}`) and no options. It pretty-prints each
event to **stderr** as:

```
[rpiv-telemetry] <ISO-8601 timestamp> <kind> <summary>
```

The summary is per-kind: `reason=` for session events, `tool=` for tool
executions, `seq=`/`status=` for LLM requests, `role=`/`tokens=` for
`message_end`, `agent=`/`type=` for `subagent_created` and `subagent_started`,
and `agent=` alone for `subagent_completed` and `subagent_failed`. Every other
kind — including `subagent_compacted` and `subagent_steered` — prints an empty
summary, so the line ends after the kind. No MLflow server is needed, which
makes it the fastest way to confirm instrumentation is firing.

## Environment variables

| Variable | Effect | Precedence |
| --- | --- | --- |
| `MLFLOW_TRACKING_URI` | MLflow tracking server URI | Wins over `providers.mlflow.trackingUri` |
| `MLFLOW_EXPERIMENT_ID` | MLflow experiment ID | Wins over `providers.mlflow.experimentId` |
| `MLFLOW_TRACKING_TOKEN` | MLflow server bearer token | Wins over `providers.mlflow.trackingToken` |
| `XDG_CONFIG_HOME` | Relocates the config directory (see the table above) | — |

`resolveMlflowConfig` reads env first and falls back to the file value. Values
are trimmed, and a variable that is empty after trimming counts as unset.

## `events`

| Value | Behavior |
| --- | --- |
| omitted *(default)* | All events forwarded. |
| `"*"` | All events forwarded (explicit form). |
| `[]` | No events forwarded. |
| `string[]` | Allowlist. Entries are checked against the known kinds; unknown entries are warned (`unknown event kinds in config: …`) and dropped. |

An allowlist whose entries are **all** invalid resolves to `[]` — allow none, not
allow all. That keeps the "explicitly empty" and "absent" cases distinct.

The 20 valid entries:

```
session_start          session_compact        session_shutdown
before_agent_start     agent_start            agent_end
turn_start             turn_end
tool_execution_start   tool_execution_end
model_select           llm_request_start      llm_request_end
message_end
subagent_created       subagent_started       subagent_completed
subagent_failed        subagent_compacted     subagent_steered
```

These are the normalized `TelemetryEvent` kinds, not Pi's raw hook names. The
package subscribes to 14 Pi lifecycle hooks and 6 sub-agent EventBus channels
(`subagents:created`, `:started`, `:completed`, `:failed`, `:compacted`,
`:steered`) and maps both sources into this single vocabulary.

## `llmPayload`

Controls what the `before_provider_request` body contributes to each
`llm-request` span.

| Mode | Behavior |
| --- | --- |
| `"off"` *(default)* | Span timing and status only. Zero payload bytes recorded. |
| `"summary"` | Records `model`, `messageCount`, `toolCount`, `systemBytes`, `temperature`, `maxTokens`, `stream`, and sets the span attribute `llm.payload_mode = "summary"`. |
| `"full"` | Records the unmodified request body. Large — can include the entire conversation history. |

The summarizer is duck-typed and covers Anthropic-messages, OpenAI-responses,
and similar shapes; fields that are absent or the wrong type are simply omitted.

## `dispatcher.maxQueueSize`

The bounded queue length. When it saturates, the **oldest** event is shifted out
and a single warning fires on the leading edge; a second warning fires once the
queue drops back under capacity (hysteresis prevents warn-per-drop noise).

Raise it for sessions with long sub-agent fan-outs or heavy tool churn when
MLflow latency spikes. Lower it when memory pressure matters more than event
completeness.

## Lifecycle contract for embedders

Events emitted before any provider is registered are dropped at the dispatcher
boundary — there is no buffer and no replay. In the built-in Pi flow
`initInstrumentation` registers providers before it attaches any handler, but only
the console provider is constructed synchronously; the MLflow provider joins when
its lazy `import("./mlflow/index.js")` resolves, which is after the handlers are
attached — in practice before the first Pi event, though not guaranteed by
construction.

If you drive the package standalone (importing `dispatchTelemetryEvent` and
`registerTelemetryProvider` from the barrel without the Pi runtime), register
providers **before** you emit. Two further gates drop events unconditionally:
anything dispatched after `shutdownTelemetryDispatcher` begins, and any sub-agent
EventBus event arriving before `session_start` has established a session ID.
