import type { LlmPayloadMode } from "../config.ts";
import { resetTelemetryDispatcher } from "../dispatcher.ts";

/**
 * Module-level mutable state for instrumentation. Shared across `pi-handlers.ts`
 * (Pi lifecycle) and `subagent-handlers.ts` (sub-agent EventBus) — both files
 * import this module to read/write a single, process-wide view.
 *
 * The `let` exports below are live bindings under ESM: consumers see current
 * values but cannot mutate them — use the matching setter.
 */

/** Disposers returned by `pi.events.on(...)` for the sub-agent EventBus subscriptions. */
export const eventBusUnsubscribers: (() => void)[] = [];

/** Per-session monotonic counter — pairs `before_provider_request` ↔ `after_provider_response`. */
export const requestSeqBySession = new Map<string, number>();

/** Latest loaded `config.llmPayload`; consulted in the `before_provider_request` handler. */
export let llmPayloadMode: LlmPayloadMode = "off";
export function setLlmPayloadMode(mode: LlmPayloadMode): void {
	llmPayloadMode = mode;
}

/**
 * If this Pi process is running as a pi-subagents sub-agent, the agent type
 * detected from its system prompt's `<active_agent name="...">` tag. Each
 * sub-agent runs in its own Pi process with its own rpiv-telemetry instance,
 * so this is naturally scoped to "this sub-agent" — process-wide, set once.
 * Undefined in user-facing parent sessions.
 */
export let currentSubAgentType: string | undefined;
export function setCurrentSubAgentTypeIfUnset(t: string | undefined): void {
	if (currentSubAgentType === undefined) currentSubAgentType = t;
}

/**
 * Current Pi session id, captured on `session_start`. Sub-agent EventBus
 * handlers fire without an `ExtensionContext`, so they read sessionId from
 * here. Empty string before `session_start` fires — guarded at the handler.
 */
export let currentSessionId = "";
export function setCurrentSessionId(s: string): void {
	currentSessionId = s;
}

/**
 * In-flight sub-agents — populated on `subagents:created`/`started`, drained
 * on `subagents:completed`/`failed`. Anything left here at `session_shutdown`
 * never received a terminal EventBus event (the pi-subagents manager aborts
 * running agents during shutdown but those abort callbacks race the teardown
 * of our subscriptions). `orphan-flush.ts` synthesizes `subagent_failed` for
 * each survivor so MLflow always shows a terminal trace instead of orphan
 * "started" spans.
 *
 * Keyed by `${sessionId}\0${agentId}` so two sub-agents that happen to share
 * an `agentId` across sessions don't collide on the inner map.
 */
export interface InflightSubAgent {
	agentId: string;
	agentType?: string;
	startedAtMs: number;
	sessionId: string;
}
export const inflightSubAgents = new Map<string, InflightSubAgent>();
export function inflightKey(sessionId: string, agentId: string): string {
	return `${sessionId}\0${agentId}`;
}

/**
 * Shared teardown: unsubscribe EventBus handlers, reset dispatcher (also
 * clears registered providers). Called from both the `session_shutdown`
 * postDispatch (via `finalizeTelemetrySession`) and from tests for isolation.
 */
export function teardownTelemetry(): void {
	requestSeqBySession.clear();
	inflightSubAgents.clear();
	llmPayloadMode = "off";
	currentSubAgentType = undefined;
	currentSessionId = "";
	for (const unsub of eventBusUnsubscribers) {
		try {
			unsub();
		} catch {
			/* best-effort */
		}
	}
	eventBusUnsubscribers.length = 0;
	resetTelemetryDispatcher();
}
