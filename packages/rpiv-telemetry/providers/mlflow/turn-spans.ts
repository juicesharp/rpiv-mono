import { SpanType, startSpan } from "@mlflow/core";
import type { AgentEndEvent, AgentStartEvent } from "../../types/events.ts";
import { msToNs } from "./keys.ts";
import type { MlflowSpanRegistry } from "./span-registry.ts";
import { setTraceSession } from "./trace-session-shim.ts";

export function onAgentStart(registry: MlflowSpanRegistry, event: AgentStartEvent): void {
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
	registry.setTurnSpan(event.sessionId, span);
}

export function onAgentEnd(registry: MlflowSpanRegistry, event: AgentEndEvent): void {
	const span = registry.getTurnSpan(event.sessionId);
	if (!span) return;
	span.end({ endTimeNs: msToNs(event.timestamp) });
	registry.deleteTurnSpan(event.sessionId);
}
