import { SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import type { LlmRequestEndEvent, LlmRequestStartEvent, MessageEndEvent } from "../../types/events.ts";
import { msToNs } from "./keys.ts";
import type { MlflowSpanRegistry } from "./span-registry.ts";

export function onLlmRequestStart(registry: MlflowSpanRegistry, event: LlmRequestStartEvent): void {
	const parent = registry.getTurnSpan(event.sessionId);
	const span = startSpan({
		name: "llm-request",
		parent,
		spanType: SpanType.CHAT_MODEL,
		inputs: event.payload !== undefined ? { payload: event.payload } : {},
		startTimeNs: msToNs(event.timestamp),
	});
	if (event.summarized) span.setAttribute("llm.payload_mode", "summary");
	registry.setLlmSpan(event.sessionId, event.requestSeq, span);
	registry.setLatestLlmSpan(event.sessionId, span);
}

export function onLlmRequestEnd(registry: MlflowSpanRegistry, event: LlmRequestEndEvent): void {
	const span = registry.getLlmSpan(event.sessionId, event.requestSeq);
	if (!span) return;
	span.setAttribute("http.status_code", event.status);
	const requestId = event.headers["request-id"] ?? event.headers["x-request-id"];
	if (requestId) span.setAttribute("provider.request_id", requestId);
	span.end({
		outputs: { status: event.status, headers: event.headers },
		status: event.status >= 400 ? SpanStatusCode.ERROR : undefined,
		endTimeNs: msToNs(event.timestamp),
	});
	registry.deleteLlmSpan(event.sessionId, event.requestSeq);
	registry.clearLatestLlmSpanIfMatches(event.sessionId, span);
}

export function onMessageEnd(registry: MlflowSpanRegistry, event: MessageEndEvent): void {
	if (!event.usage) return;
	const target = registry.getLatestLlmSpan(event.sessionId) ?? registry.getTurnSpan(event.sessionId);
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
