import { type LiveSpan, SpanType, startSpan } from "@mlflow/core";
import type { AgentEndEvent, AgentStartEvent, TelemetryEvent } from "../../types/events.js";
import { msToNs } from "./keys.js";
import { setTraceSession } from "./trace-session-shim.js";

export function onAgentStart(activeTurnSpans: Map<string, LiveSpan>, event: AgentStartEvent): void {
	const name = event.selfAgentType ? `subagent-turn[${event.selfAgentType}]` : "agent-turn";
	const span = startSpan({
		name,
		spanType: SpanType.AGENT,
		inputs: { sessionId: event.sessionId },
		startTimeNs: msToNs(event.timestamp),
	});
	span.setAttribute("session.id", event.sessionId);
	if (event.selfAgentType) span.setAttribute("subagent.type", event.selfAgentType);
	if (event.parentSessionId) span.setAttribute("parent.session.id", event.parentSessionId);
	// Group sub-agent traces under the parent session in MLflow's Session column
	// when Pi gave us a parent lineage; otherwise tag with own session.
	setTraceSession(span, event.parentSessionId ?? event.sessionId);
	activeTurnSpans.set(event.sessionId, span);
}

export function onAgentEnd(activeTurnSpans: Map<string, LiveSpan>, event: AgentEndEvent): void {
	const span = activeTurnSpans.get(event.sessionId);
	if (!span) return;
	span.end({ endTimeNs: msToNs(event.timestamp) });
	activeTurnSpans.delete(event.sessionId);
}

/** Set a generic attribute on the active turn span for events that carry no dedicated handler. */
export function onAttributeEvent(activeTurnSpans: Map<string, LiveSpan>, event: TelemetryEvent): void {
	const span = activeTurnSpans.get(event.sessionId);
	if (!span) return;
	span.setAttribute(`event.${event.kind}`, JSON.stringify(event));
}
