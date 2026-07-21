# providers/mlflow/

## Responsibility
Translates the provider-agnostic `TelemetryEvent` stream into an MLflow trace **span-tree** — one root span per agent turn with nested `tool`, `llm-request`, and `subagent` child spans — built on `@mlflow/core`. Owns the full span lifecycle (create on `*_start`, attribute-decorate, end on `*_end`) plus teardown, and isolates the heavy SDK behind a lazy-load boundary so the provider catalog can advertise MLflow without paying the ~325ms cold-start.

## Dependencies
- **`@mlflow/core`**: `init`, `flushTraces`, `startSpan`, `SpanType`, `SpanStatusCode`, `LiveSpan` — imported by every file **except `meta.ts`** (see Lazy-Load Boundary). Plus one unofficial deep import in `trace-session-shim.ts`
- **`../../config`**: `MlflowConfig`, `resolveMlflowConfig`
- **`../../types/{events,provider}`**: the `TelemetryEvent` union + the `TelemetryProvider` interface this implements

## Consumers
- **`../index.ts`** (provider catalog): lists MLflow in `BUILT_IN_PROVIDERS` via `meta.ts` only, then loads the impl through a fire-and-forget `import("./mlflow/index.js")` — **only when `providers.mlflow` is configured**
- **`../../index.ts`** (package barrel): re-exports `MlflowProvider` directly for standalone embedders (accepts the SDK cost — not the Pi extension path)

## Module Structure
```
index.ts             — @mlflow/core-backed MlflowProvider (implements TelemetryProvider) + the dispatch(event.kind) switch
*-spans.ts           — Span builders by domain: turn-spans, tool-spans, llm-spans, subagent-spans. Export on<Event>(registry, event)
attribute-events.ts  — Decorates the turn span for child-less kinds (turn_*, model_select, …) — no new span
span-registry.ts     — MlflowSpanRegistry: span-lifecycle hub; four sessionId-keyed maps + endAllForSession
keys.ts + meta.ts    — Helpers: keys.ts is ONLY msToNs (time conv., NOT attribute constants); meta.ts is the @mlflow-free metadata twin
trace-session-shim.ts + pi-subagents-tool-bridge.ts — Vendored shims reconciling Pi's model to MLflow's
session-shutdown.ts  — Bulk-ends every live span for a session (orphan flush)
```

## Lazy-Load Boundary (`meta.ts` stays `@mlflow/core`-free)
The catalog must list MLflow without the SDK eval cost. Metadata (cold, dependency-free) is split from impl (hot); the impl loads lazily.
```ts
// meta.ts — the COLD half. MUST NOT import @mlflow/core (keeps BUILT_IN_PROVIDERS cheap).
export const MLFLOW_PROVIDER_META: TelemetryProviderMeta = { name: "mlflow", label: "MLflow", envVars: [...] };

// ../index.ts — catalog imports ONLY meta; defers the heavy module behind a dynamic import.
if (config.providers.mlflow !== undefined)
  void import("./mlflow/index.js").then(({ MlflowProvider }) => registerTelemetryProvider(new MlflowProvider(...)));
```

## TelemetryProvider Impl — Lazy-Once Init + Per-Kind Failure Isolation
Init defers to the first event and runs at most once; failures degrade to "silently drop" and warn **once per `kind`** — telemetry never throws into the host.
```ts
async trackEvent(event): Promise<void> {
  this.ensureInit();                       // initAttempted guard; no trackingUri → initialized=false → drop
  if (!this.initialized) return;
  try { this.dispatch(event); this.failedKinds.delete(event.kind); }
  catch (err) { if (!this.failedKinds.has(event.kind)) { this.failedKinds.add(event.kind); console.warn(...); } }
}
```
`dispatch()` is one exhaustive `switch (event.kind)`: spanned kinds → `on<X>(registry, event)`; child-less kinds collapse to `onAttributeEvent`; sub-agent kinds collapse to `onSubAgentEvent` (no registry).

## Span Registry + Paired vs Atomic Builders
`MlflowSpanRegistry` owns all live spans in four `sessionId`-keyed maps (turn root, plus nested `sessionId→toolCallId` / `sessionId→requestSeq`, and a `latestLlmSpanBySession` side-index). Builders never hold span refs — they set/get/delete through the registry. Two builder shapes:
```ts
// Paired (tool/llm): start stows by identity, end retrieves + closes. Orphan end = no-op.
function onToolExecutionStart(r, e) { r.setToolSpan(e.sessionId, e.toolCallId, startSpan({ name: e.toolName,
  parent: r.getTurnSpan(e.sessionId), spanType: SpanType.TOOL, startTimeNs: msToNs(e.timestamp) })); }
function onToolExecutionEnd(r, e) { const s = r.getToolSpan(e.sessionId, e.toolCallId); if (!s) return;
  s.end({ status: e.isError ? SpanStatusCode.ERROR : undefined, endTimeNs: msToNs(e.timestamp) }); r.deleteToolSpan(...); }

// Atomic (subagent): already-completed events — back-fill startTimeNs from durationMs, open+end in one call. No registry.
```
`parent:` is what builds the tree. `status` is set **only** on error. `message_end` carries usage but no key → attaches to `latestLlmSpanBySession` (fallback: turn root). `endAllForSession` flushes orphans at session end; `shutdown()` flushes then `registry.clear()`.

## Vendored Shims (isolate Pi↔MLflow impedance mismatch)
Each wraps a fragile external assumption behind a typed function in one file with a documented exit plan.
- **`pi-subagents-tool-bridge.ts`** — names the magic `AGENT_TOOL_NAME = "Agent"` contract + `extractAgentToolDetails(result)` (defensively unwraps the untyped tool-result envelope). `tool-spans.ts` lifts `subagent.agent_id` (the link key to the sub-agent's own trace) onto the parent tool span
- **`trace-session-shim.ts`** — the **only** file that deep-imports `@mlflow/core/dist/...`. Mutates `mlflow.trace.session` so the MLflow UI groups traces by Pi session. **Temporary** — delete once `mlflow.tracingContext` ships on npm (mlflow#21620)

## Architectural Boundaries
- **`meta.ts` MUST NOT import `@mlflow/core`** — load it eagerly and the lazy-load contract breaks (~325ms regression on every extension start)
- **All span state goes through `MlflowSpanRegistry`** — builders never cache `LiveSpan` refs across calls
- **Dotted-namespace attribute keys are inlined string literals** at the call site (`turn.stop_reason`, `llm.usage.input_tokens`) so dashboards filter on typed fields — there is NO central keys table (`keys.ts` is only `msToNs`)
- **Deep imports are confined to `trace-session-shim.ts`** — never add another; provider never throws into the host (degrades to drop)

<important if="you are adding a new span type / mapping a new TelemetryEvent in the MLflow provider">
## Adding a Span Type
1. Confirm the `kind` + fields exist in `../../types/events.ts`
2. Pick the span model: **paired** (start+end, span lives across calls → new `*-spans.ts` like `tool-spans`) · **atomic** (one completed event → `subagent-spans` shape, no registry) · **attribute-only** (decorate the turn span → add a case to `attribute-events.ts` + the `AttributeOnlyEvent` union, no new file)
3. For paired spans, add `set/get/deleteXxxSpan` to `span-registry.ts` (mirror the nested-map shape) AND extend `endAllForSession` + `clear` so orphans flush at session end — easy to forget
4. Register the `case` in `dispatch()` (`index.ts`); group related kinds onto one handler
5. Emit individual dotted `xxx.*` attributes guarded with `!== undefined`; set `status` only on error; always `startTimeNs: msToNs(event.timestamp)`
6. Leave `meta.ts` untouched (only add `envVars` if the feature needs config); add a `provider.test.ts` case driving `trackEvent` and asserting the `startSpan({ name, spanType, parent })` shape
</important>
