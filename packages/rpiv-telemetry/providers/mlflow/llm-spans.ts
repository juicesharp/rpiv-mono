import { type LiveSpan, SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type { LlmRequestEndEvent, LlmRequestStartEvent, MessageEndEvent } from "../../types/events.js";
import { llmSpanKey, msToNs } from "./keys.js";

export function onLlmRequestStart(
	activeTurnSpans: Map<string, LiveSpan>,
	activeLlmSpans: Map<string, LiveSpan>,
	latestLlmSpanBySession: Map<string, LiveSpan>,
	event: LlmRequestStartEvent,
): void {
	const parent = activeTurnSpans.get(event.sessionId);
	const span = startSpan({
		name: "llm-request",
		parent,
		spanType: SpanType.CHAT_MODEL,
		inputs: event.payload !== undefined ? { payload: event.payload } : {},
		startTimeNs: msToNs(event.timestamp),
	});
	if (event.summarized) span.setAttribute("llm.payload_mode", "summary");
	activeLlmSpans.set(llmSpanKey(event.sessionId, event.requestSeq), span);
	latestLlmSpanBySession.set(event.sessionId, span);
}

export function onLlmRequestEnd(
	activeLlmSpans: Map<string, LiveSpan>,
	latestLlmSpanBySession: Map<string, LiveSpan>,
	event: LlmRequestEndEvent,
): void {
	const key = llmSpanKey(event.sessionId, event.requestSeq);
	const span = activeLlmSpans.get(key);
	if (!span) return;
	span.setAttribute("http.status_code", event.status);
	const requestId = event.headers["request-id"] ?? event.headers["x-request-id"];
	if (requestId) span.setAttribute("provider.request_id", requestId);
	span.end({
		outputs: { status: event.status, headers: event.headers },
		status: event.status >= 400 ? SpanStatusCode.ERROR : undefined,
		endTimeNs: msToNs(event.timestamp),
	});
	activeLlmSpans.delete(key);
	// Only clear the latest tracker when it currently points at the span we just ended —
	// preserves attribution to other still-open spans in the unlikely concurrent case.
	if (latestLlmSpanBySession.get(event.sessionId) === span) {
		latestLlmSpanBySession.delete(event.sessionId);
	}
}

export function onMessageEnd(
	activeTurnSpans: Map<string, LiveSpan>,
	latestLlmSpanBySession: Map<string, LiveSpan>,
	event: MessageEndEvent,
): void {
	if (!event.usage) return;
	const target = latestLlmSpanBySession.get(event.sessionId) ?? activeTurnSpans.get(event.sessionId);
	if (!target) return;
	target.setAttribute("llm.usage.input_tokens", event.usage.input);
	target.setAttribute("llm.usage.output_tokens", event.usage.output);
	if (event.usage.cacheRead !== undefined) target.setAttribute("llm.usage.cache_read_tokens", event.usage.cacheRead);
	if (event.usage.cacheWrite !== undefined)
		target.setAttribute("llm.usage.cache_write_tokens", event.usage.cacheWrite);
	target.setAttribute("llm.usage.total_tokens", event.usage.totalTokens);
	if (event.usage.cost !== undefined) target.setAttribute("llm.cost.total_usd", event.usage.cost);
	if (event.model) target.setAttribute("llm.model", event.model);
	if (event.provider) target.setAttribute("llm.provider", event.provider);
	if (event.stopReason) target.setAttribute("llm.stop_reason", event.stopReason);
}
