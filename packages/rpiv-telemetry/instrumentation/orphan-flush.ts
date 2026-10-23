import { dispatchTelemetryEvent } from "../dispatcher.ts";
import type { SubAgentFailedEvent } from "../types/events.ts";
import { inflightSubAgents } from "./state.ts";

/**
 * Synthesize `subagent_failed` events for any in-flight sub-agent at shutdown.
 * Must run BEFORE the dispatcher shuts down — once the dispatcher enters its
 * shutting-down state, `dispatchTelemetryEvent()` rejects further events. The
 * ordering invariant is owned by `finalizeTelemetrySession` in `finalize.ts`.
 */
export function flushOrphanSubAgents(): void {
	if (inflightSubAgents.size === 0) return;
	const now = Date.now();
	for (const info of inflightSubAgents.values()) {
		dispatchTelemetryEvent({
			kind: "subagent_failed",
			sessionId: info.sessionId,
			agentId: info.agentId,
			status: "aborted",
			error: "session_shutdown",
			durationMs: now - info.startedAtMs,
			timestamp: now,
		} satisfies SubAgentFailedEvent);
	}
	inflightSubAgents.clear();
}
