# MLflow trace and span reference

The shape of the traces `rpiv-telemetry` writes: which event becomes which span,
and the exact attribute names you can filter on in MLflow.

## Trace shape

One root span per agent turn, with tool and LLM-request spans nested under it:

```
agent-turn                       (SpanType.AGENT)   — one per agent_start/agent_end pair
├── <toolName>                   (SpanType.TOOL)    — one per tool_execution_start/end
├── llm-request                  (SpanType.CHAT_MODEL)
└── llm-request
```

Sub-agent turns get the same root span under a different name,
`subagent-turn[<type>]`, where `<type>` is read from the `<active_agent
name="..."/>` tag in the sub-agent's system prompt. The trace's session metadata
(`mlflow.trace.session`, the MLflow UI's **Session** column) is set to the
**parent** session ID when Pi supplied a lineage, so a sub-agent's traces group
under its orchestrator instead of floating loose.

Sub-agent EventBus events also emit their own standalone spans named
`subagent.<event>` — `subagent.created`, `subagent.started`,
`subagent.completed`, `subagent.failed`, `subagent.compacted`,
`subagent.steered`. Terminal events back-fill their start time from the run's
reported `durationMs`, so completed and failed runs render with real duration
rather than as instants.

## Event → span mapping

| Event kind | What it produces |
| --- | --- |
| `agent_start` | Opens the root `agent-turn` / `subagent-turn[<type>]` span |
| `agent_end` | Closes the root span |
| `tool_execution_start` / `_end` | Opens/closes a child span named after the tool |
| `llm_request_start` / `_end` | Opens/closes a child `llm-request` span |
| `message_end` | Writes usage attributes onto the most recent `llm-request` span (or the turn span if none is open) |
| `turn_start`, `turn_end`, `session_compact`, `before_agent_start`, `model_select` | Attributes only — written onto the open turn span, no span of their own |
| `subagent_*` (6 kinds) | A standalone `subagent.<event>` span |
| `session_shutdown` | Bulk-ends every span still live for that session |

## Turn-span attributes

| Attribute | Source |
| --- | --- |
| `session.id` | Always set on the root span |
| `subagent.type` | Set on sub-agent turns only |
| `parent.session.id` | Set when Pi supplied a parent lineage |
| `turn.index` | `turn_start`, `turn_end` |
| `turn.stop_reason` | `turn_end` |
| `turn.tool_result_count` | `turn_end` |
| `turn.usage.input_tokens`, `turn.usage.output_tokens`, `turn.usage.total_tokens`, `turn.usage.cost_usd` | `turn_end` |
| `session.compact.from_extension` | `session_compact` |
| `agent.prompt_length` | `before_agent_start` |
| `model.id`, `model.provider`, `model.select_source` | `model_select` |

## Tool-span attributes

Inputs carry `toolCallId` and `args`; outputs carry `isError` and `result`, and
the span status is set to `ERROR` when `isError` is true.

For the pi-subagents `Agent` tool, the sub-agent's identity is lifted onto the
parent tool span so MLflow's trace list surfaces it without expanding outputs:
`subagent.agent_id`, `subagent.type`, `subagent.status`. The `subagent.agent_id`
value is the link key from this parent tool span to the sub-agent's own
`subagent-turn` trace.

## LLM-span attributes

| Attribute | Source |
| --- | --- |
| `llm.payload_mode` | Set to `"summary"` when `llmPayload: "summary"` is active |
| `http.status_code` | `llm_request_end` |
| `provider.request_id` | From the `request-id` or `x-request-id` response header |
| `llm.usage.input_tokens`, `llm.usage.output_tokens`, `llm.usage.total_tokens` | `message_end` |
| `llm.usage.cache_read_tokens`, `llm.usage.cache_write_tokens` | `message_end`, when the provider reports them |
| `llm.cost.total_usd` | `message_end`, when cost is reported |
| `llm.model`, `llm.provider`, `llm.stop_reason` | `message_end` |

A response status of 400 or above sets the span status to `ERROR`.

## Sub-agent-span attributes

`subagent.agent_id` is set on every sub-agent span. The rest are per kind:

| Kind | Attributes |
| --- | --- |
| `subagent_created` | `subagent.type`, `subagent.description`, `subagent.is_background` |
| `subagent_started` | `subagent.type` |
| `subagent_completed` | `subagent.status`, `subagent.duration_ms`, `subagent.tool_uses`, `subagent.usage.input_tokens`, `subagent.usage.output_tokens`, `subagent.usage.total_tokens` |
| `subagent_failed` | `subagent.status`, `subagent.duration_ms`, `subagent.error` — span status `ERROR` |
| `subagent_compacted` | `subagent.type`, `subagent.compact.reason`, `subagent.compact.tokens_before`, `subagent.compact.count` |
| `subagent_steered` | `subagent.steer.message` |

Completed and failed spans also set native span outputs (status, result, usage,
tool uses / error) so the MLflow trace UI renders the sub-agent's outcome
directly.

## Why the attributes are dotted rather than JSON blobs

Every attribute above is a typed scalar written under a dotted key. An earlier
version recorded one `event.<kind>` JSON blob per event, which MLflow could store
but not filter. The flat vocabulary means a dashboard can query
`turn.stop_reason = "max_tokens"` or sort by `subagent.usage.total_tokens`
without unpacking anything.

## Session grouping is a temporary shim

`setTraceSession` writes `mlflow.trace.session` through an unofficial deep import
of `@mlflow/core/dist/core/trace_manager.js`. It inlines the mutation that the
upstream-merged `mlflow.tracingContext` API performs (mlflow/mlflow#21620), which
is unreleased on npm as of `@mlflow/core@0.2.0`. Treat any `@mlflow/core` upgrade
as a checkpoint for this file: once the official API ships, migrate to it and
delete `providers/mlflow/trace-session-shim.ts`.
