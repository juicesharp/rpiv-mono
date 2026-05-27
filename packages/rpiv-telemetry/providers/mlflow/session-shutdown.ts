import type { LiveSpan } from "@mlflow/core";
import type { SessionShutdownEvent } from "../../types/events.js";
import { sessionPrefix } from "./keys.js";
import { msToNs } from "./trace-session-shim.js";

/** End every span in `spans` whose key begins with `prefix`. */
export function endSpansForSession(spans: Map<string, LiveSpan>, prefix: string, endTimeNs: number): void {
	for (const [key, span] of spans) {
		if (key.startsWith(prefix)) {
			span.end({ endTimeNs });
			spans.delete(key);
		}
	}
}

export function onSessionShutdown(
	activeTurnSpans: Map<string, LiveSpan>,
	activeToolSpans: Map<string, LiveSpan>,
	activeLlmSpans: Map<string, LiveSpan>,
	latestLlmSpanBySession: Map<string, LiveSpan>,
	event: SessionShutdownEvent,
): void {
	const endTimeNs = msToNs(event.timestamp);
	const turnSpan = activeTurnSpans.get(event.sessionId);
	if (turnSpan) {
		turnSpan.end({ endTimeNs });
		activeTurnSpans.delete(event.sessionId);
	}
	const prefix = sessionPrefix(event.sessionId);
	endSpansForSession(activeToolSpans, prefix, endTimeNs);
	endSpansForSession(activeLlmSpans, prefix, endTimeNs);
	latestLlmSpanBySession.delete(event.sessionId);
}
