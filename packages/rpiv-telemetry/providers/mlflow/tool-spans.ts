import { SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "../../types/events.ts";
import { msToNs } from "./keys.ts";
import { AGENT_TOOL_NAME, extractAgentToolDetails } from "./pi-subagents-tool-bridge.ts";
import type { MlflowSpanRegistry } from "./span-registry.ts";

export function onToolExecutionStart(registry: MlflowSpanRegistry, event: ToolExecutionStartEvent): void {
	const parentSpan = registry.getTurnSpan(event.sessionId);
	const span = startSpan({
		name: event.toolName,
		parent: parentSpan,
		spanType: SpanType.TOOL,
		inputs: { toolCallId: event.toolCallId, args: event.args },
		startTimeNs: msToNs(event.timestamp),
	});
	registry.setToolSpan(event.sessionId, event.toolCallId, span);
}

export function onToolExecutionEnd(registry: MlflowSpanRegistry, event: ToolExecutionEndEvent): void {
	const span = registry.getToolSpan(event.sessionId, event.toolCallId);
	if (!span) return;

	// pi-subagents `Agent` tool: lift sub-agent identity onto span attributes
	// so MLflow's trace list surfaces them without expanding `outputs`.
	// agentId is the link key from this parent tool span to the sub-agent's
	// own agent-turn trace.
	if (event.toolName === AGENT_TOOL_NAME) {
		const details = extractAgentToolDetails(event.result);
		if (details?.agentId !== undefined) span.setAttribute("subagent.agent_id", details.agentId);
		if (details?.type !== undefined) span.setAttribute("subagent.type", details.type);
		if (details?.status !== undefined) span.setAttribute("subagent.status", details.status);
	}

	span.end({
		outputs: { isError: event.isError, result: event.result },
		status: event.isError ? SpanStatusCode.ERROR : undefined,
		endTimeNs: msToNs(event.timestamp),
	});
	registry.deleteToolSpan(event.sessionId, event.toolCallId);
}
