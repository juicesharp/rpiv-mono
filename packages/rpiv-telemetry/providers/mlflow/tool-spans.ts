import { type LiveSpan, SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "../../types/events.js";
import { toolSpanKey } from "./keys.js";
import { msToNs } from "./trace-session-shim.js";

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
	span.end({
		outputs: { isError: event.isError },
		status: event.isError ? SpanStatusCode.ERROR : undefined,
		endTimeNs: msToNs(event.timestamp),
	});
	activeToolSpans.delete(key);
}
