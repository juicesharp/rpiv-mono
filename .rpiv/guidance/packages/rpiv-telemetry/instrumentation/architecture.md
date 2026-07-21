# instrumentation/

## Responsibility
The Pi-binding / adapter layer — the **only** part of `rpiv-telemetry` that touches the Pi runtime. Subscribes to two distinct event sources (Pi lifecycle hooks + the pi-subagents EventBus), normalizes every raw payload into the canonical `TelemetryEvent` union, and hands events to the runtime-agnostic dispatcher. Owns all process-wide instrumentation state and the shutdown teardown sequence. Contains **no transport logic** — queueing/providers live in `../dispatcher.ts` + `../providers/`.

## Dependencies
- **`@earendil-works/pi-coding-agent`** (peer): `ExtensionAPI`/`ExtensionContext` — type-only except `pi.on(...)`, `pi.events.on(...)`, `ctx.sessionManager`
- **`typebox`** (`Type`, `Static`, `Value`): runtime payload validation — used **only** on the untyped EventBus boundary
- Inward to siblings: `../config`, `../dispatcher`, `../providers`, `../types/events` (the `TelemetryEvent` union). Direction is strictly inward — nothing downstream imports back in

## Consumers
- **`../extension.ts`** — the thin Pi entry; calls `initInstrumentation(pi)` (kept thin so loading the extension never evaluates the MLflow re-export)
- **`../index.ts`** (package barrel) — re-exports only `teardownTelemetry` for embedders + tests

## Module Structure
```
index.ts             — Composition root: loops PI_HANDLERS → pi.on, SUBAGENT_HANDLERS → pi.events.on; re-exports teardown
pi-handlers.ts       — Pi lifecycle source. PI_HANDLERS: readonly PiHandlerSpec[]
subagent-handlers.ts — EventBus source. SUBAGENT_HANDLERS + handleSubAgentBusEvent (validate→gate→track→dispatch)
schemas.ts           — TypeBox Type.Object schemas + Static<> types, one per EventBus channel (bus boundary only)
state.ts             — Shared session state: live-binding `let` + setters; inflight map; teardownTelemetry
finalize.ts + orphan-flush.ts — Ordered teardown pipeline (one step per file)
payload-summary.ts   — Pure, defensive payload extractors (detect/summarize, never throw)
```

## Dual Event-Source Handler Tables (data, not control flow)
One declarative spec array per source; the wiring loop is source-aware. Adding an event is a new row, not new wiring.
```ts
interface PiHandlerSpec   { piEvent: string; build: (e: any, ctx) => TelemetryEvent; postDispatch?: (e, ctx) => Promise<void>; }
interface SubAgentHandlerSpec { channel: string; schema: TSchema; map: (data: unknown, sessionId: string) => TelemetryEvent; }

for (const h of PI_HANDLERS)       pi.on(h.piEvent, async (e, ctx) => { dispatchTelemetryEvent(h.build(e, ctx)); await h.postDispatch?.(e, ctx); });
for (const h of SUBAGENT_HANDLERS) eventBusUnsubscribers.push(pi.events.on(h.channel, (data) => handleSubAgentBusEvent(h, data)));
```
Pi handlers carry an `ExtensionContext` (sessionId from `ctx`); EventBus handlers have none and read `currentSessionId` from shared state. Both converge on the single `TelemetryEvent` sink — though EventBus events must first clear the three gates below. Every `build`/`map` return ends in `satisfies <X>Event` — raw `any`/`unknown` in, stable union out. Handlers register unconditionally even with zero providers; the no-provider gate lives in the dispatcher.

## Validate-Then-Dispatch at the Untyped Bus Boundary
EventBus payloads are untyped, so each is TypeBox-checked before `map` runs; a failure is **dropped with one warning, never coerced**. Pi lifecycle payloads get no runtime check (rely on `satisfies`).
```ts
function handleSubAgentBusEvent(h, data): void {
  if (!currentSessionId) {                        // gate 1: pre-session_start (would ship sessionId:"")
    console.warn(`[rpiv-telemetry] dropping ${h.channel} event with no active session`); return;
  }
  if (!Value.Check(h.schema, data)) {             // gate 2: validated before dispatch
    console.warn(`[rpiv-telemetry] dropping ${h.channel}: ${firstError(h.schema, data)}`); return;
  }
  const mapped = h.map(data, currentSessionId);
  if (mapped.kind === "subagent_started"          // gate 3: started with no prior created = FOREGROUND
      && !inflightSubAgents.has(key(mapped))) return; // — suppressed silently, never dispatched
  updateInflightTracker(mapped);                  // set on created, refresh startedAtMs on background started, delete on completed/failed
  dispatchTelemetryEvent(mapped);
}
```
Gate 3 exists because pi-subagents emits `subagents:created` **only for background runs** (`spawn_subagent`), while `subagents:started` fires for both; foreground completion already arrives via the parent's `tool_execution_end`, so a lone foreground `subagent_started` span would be pure noise (0s duration, no counterpart).

## In-Flight Tracker + Ordered Finalize Teardown
`inflightSubAgents` is keyed by composite `` `${sessionId}\0${agentId}` `` (NUL separator avoids cross-session collision). At shutdown, survivors get a synthetic `subagent_failed` so no orphan "started" spans leak. The teardown ordering is encoded as a named (testable) function, not a comment:
```ts
async function finalizeTelemetrySession() {
  flushOrphanSubAgents();              // 1. BEFORE shutdown — dispatcher's `shuttingDown` guard drops late events
  await shutdownTelemetryDispatcher(); // 2. drain queue, flush + shutdown providers
  teardownTelemetry();                 // 3. unsubscribe bus disposers, clear maps, reset dispatcher singleton
}
```
Runs from the `session_shutdown` handler's `postDispatch` (the only spec that uses it) — Pi awaits it.

## Architectural Boundaries
- **NO transport / provider knowledge** — emits `TelemetryEvent`s to the dispatcher; never opens spans or talks to a sink
- **NO reassigning an imported `let`** across modules — mutate shared state only through its `set*` setter (`state.ts`)
- **Validation asymmetry is intentional** — only the untyped EventBus is schema-checked; Pi lifecycle payloads are not
- **`teardownTelemetry` is the single reset path** — called from shutdown AND from tests for isolation

<important if="you are adding a new instrumented event to rpiv-telemetry">
## Adding an Instrumented Event
1. Add the `kind` + fields to the `TelemetryEvent` union in `../types/events.ts`
2. **Pi lifecycle hook** → add a `PiHandlerSpec` row to `PI_HANDLERS`: set `piEvent`, write `build(event, ctx)` returning `{ kind, sessionId: sid(ctx), …, timestamp: Date.now() } satisfies <X>Event`. Read the payload defensively (`?.`, `?? 0`). Add `postDispatch` only for shutdown-ordered side effects (mirrors `session_shutdown`)
3. **EventBus event** → add a `Type.Object` schema (+ `Static<>` type) in `schemas.ts`, then a `SubAgentHandlerSpec` row to `SUBAGENT_HANDLERS` (`channel`, `schema`, `map(data, sessionId)`). No `index.ts` change — the loop auto-subscribes and captures the disposer
4. If the event affects sub-agent lifetime, extend the inflight branch in `handleSubAgentBusEvent` and confirm `orphan-flush.ts` still synthesizes the right terminal kind
5. Cover the gates in a test (valid → dispatched; invalid → dropped+warned; pre-session → dropped+warned; `subagent_started` without prior created → suppressed silently)
</important>
