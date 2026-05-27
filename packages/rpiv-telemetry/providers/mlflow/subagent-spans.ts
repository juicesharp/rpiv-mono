import { SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type {
	SubAgentCompactedEvent,
	SubAgentCompletedEvent,
	SubAgentCreatedEvent,
	SubAgentFailedEvent,
	SubAgentStartedEvent,
	SubAgentSteeredEvent,
} from "../../types/events.js";
import { msToNs, setTraceSession } from "./trace-session-shim.js";

type SubAgentEvent =
	| SubAgentCreatedEvent
	| SubAgentStartedEvent
	| SubAgentCompletedEvent
	| SubAgentFailedEvent
	| SubAgentCompactedEvent
	| SubAgentSteeredEvent;

export function onSubAgentEvent(event: SubAgentEvent): void {
	const endTimeNs = msToNs(event.timestamp);
	// Terminal events (completed/failed) carry the run's durationMs — back-fill
	// startTimeNs from it. Non-terminal events are instantaneous.
	const durationMs = "durationMs" in event ? event.durationMs : undefined;
	const startTimeNs = durationMs ? endTimeNs - durationMs * 1_000_000 : endTimeNs;
	const agentType = "agentType" in event ? event.agentType : undefined;
	const span = startSpan({
		name: `subagent.${event.kind.replace("subagent_", "")}`,
		spanType: SpanType.AGENT,
		inputs: { agentId: event.agentId, agentType },
		startTimeNs,
	});
	span.setAttribute("session.id", event.sessionId);
	setTraceSession(span, event.sessionId);
	span.setAttribute("telemetry.event", JSON.stringify(event));
	span.end({
		endTimeNs,
		outputs: terminalOutputs(event),
		status: event.kind === "subagent_failed" ? SpanStatusCode.ERROR : undefined,
	});
}

/**
 * Native span outputs for terminal sub-agent events so MLflow renders the
 * sub-agent's result/error directly in the trace UI instead of hiding it
 * inside the `telemetry.event` JSON attribute.
 */
function terminalOutputs(event: SubAgentEvent): Record<string, unknown> | undefined {
	if (event.kind === "subagent_completed") {
		return { status: event.status, result: event.result, usage: event.usage, toolUses: event.toolUses };
	}
	if (event.kind === "subagent_failed") {
		return { status: event.status, error: event.error };
	}
	return undefined;
}
