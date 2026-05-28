import { type LiveSpan, SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "../../types/events.js";
import { msToNs, toolSpanKey } from "./keys.js";

export function onToolExecutionStart(
	activeTurnSpans: Map<string, LiveSpan>,
	activeToolSpans: Map<string, LiveSpan>,
	event: ToolExecutionStartEvent,
): void {
	const parentSpan = activeTurnSpans.get(event.sessionId);
	const span = startSpan({
		name: event.toolName,
		parent: parentSpan,
		spanType: SpanType.TOOL,
		inputs: { toolCallId: event.toolCallId, args: event.args },
		startTimeNs: msToNs(event.timestamp),
	});
	activeToolSpans.set(toolSpanKey(event.sessionId, event.toolCallId), span);
}

export function onToolExecutionEnd(activeToolSpans: Map<string, LiveSpan>, event: ToolExecutionEndEvent): void {
	const key = toolSpanKey(event.sessionId, event.toolCallId);
	const span = activeToolSpans.get(key);
	if (!span) return;

	// For the pi-subagents `Agent` tool: lift sub-agent identity out of the
	// AgentToolResult details onto span attributes so MLflow's trace list
	// surfaces them without expanding `outputs`. agentId is the link key for
	// navigating from this parent span to the sub-agent's own agent-turn trace.
	if (event.toolName === "Agent") {
		const details = (
			event.result as { details?: { agentId?: unknown; type?: unknown; status?: unknown } } | undefined
		)?.details;
		if (details?.agentId !== undefined) span.setAttribute("subagent.agent_id", String(details.agentId));
		if (details?.type !== undefined) span.setAttribute("subagent.type", String(details.type));
		if (details?.status !== undefined) span.setAttribute("subagent.status", String(details.status));
	}

	span.end({
		outputs: { isError: event.isError, result: event.result },
		status: event.isError ? SpanStatusCode.ERROR : undefined,
		endTimeNs: msToNs(event.timestamp),
	});
	activeToolSpans.delete(key);
}
