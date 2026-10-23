import { type LiveSpan, SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type {
	SubAgentCompactedEvent,
	SubAgentCompletedEvent,
	SubAgentCreatedEvent,
	SubAgentFailedEvent,
	SubAgentStartedEvent,
	SubAgentSteeredEvent,
} from "../../types/events.ts";
import { msToNs } from "./keys.ts";
import { setTraceSession } from "./trace-session-shim.ts";

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
	writeSubAgentAttributes(span, event);
	span.end({
		endTimeNs,
		outputs: terminalOutputs(event),
		status: event.kind === "subagent_failed" ? SpanStatusCode.ERROR : undefined,
	});
}

/**
 * Per-kind typed sub-agent attributes — replaces the prior `telemetry.event`
 * JSON-blob so MLflow dashboards can filter on individual fields.
 */
function writeSubAgentAttributes(span: LiveSpan, event: SubAgentEvent): void {
	span.setAttribute("subagent.agent_id", event.agentId);
	switch (event.kind) {
		case "subagent_created":
			span.setAttribute("subagent.type", event.agentType);
			if (event.description !== undefined) span.setAttribute("subagent.description", event.description);
			if (event.isBackground !== undefined) span.setAttribute("subagent.is_background", event.isBackground);
			return;
		case "subagent_started":
			span.setAttribute("subagent.type", event.agentType);
			return;
		case "subagent_completed":
			if (event.status !== undefined) span.setAttribute("subagent.status", event.status);
			span.setAttribute("subagent.duration_ms", event.durationMs);
			if (event.toolUses !== undefined) span.setAttribute("subagent.tool_uses", event.toolUses);
			if (event.usage) {
				span.setAttribute("subagent.usage.input_tokens", event.usage.input);
				span.setAttribute("subagent.usage.output_tokens", event.usage.output);
				span.setAttribute("subagent.usage.total_tokens", event.usage.totalTokens);
			}
			return;
		case "subagent_failed":
			if (event.status !== undefined) span.setAttribute("subagent.status", event.status);
			span.setAttribute("subagent.duration_ms", event.durationMs);
			span.setAttribute("subagent.error", event.error);
			return;
		case "subagent_compacted":
			span.setAttribute("subagent.type", event.agentType);
			if (event.reason !== undefined) span.setAttribute("subagent.compact.reason", event.reason);
			if (event.tokensBefore !== undefined) span.setAttribute("subagent.compact.tokens_before", event.tokensBefore);
			if (event.compactionCount !== undefined) span.setAttribute("subagent.compact.count", event.compactionCount);
			return;
		case "subagent_steered":
			span.setAttribute("subagent.steer.message", event.message);
			return;
	}
}

/**
 * Native span outputs for terminal sub-agent events so MLflow renders the
 * sub-agent's result/error directly in the trace UI.
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
