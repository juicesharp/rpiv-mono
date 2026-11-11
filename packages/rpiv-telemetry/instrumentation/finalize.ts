import { shutdownTelemetryDispatcher } from "../dispatcher.ts";
import { flushOrphanSubAgents } from "./orphan-flush.ts";
import { teardownTelemetry } from "./state.ts";

/**
 * Final-event window during session shutdown. Order matters:
 *
 *  1. `flushOrphanSubAgents()` — synthesize terminal events for any sub-agent
 *     still in-flight. Must run BEFORE the dispatcher shuts down because the
 *     dispatcher's shutting-down guard rejects further dispatches.
 *  2. `shutdownTelemetryDispatcher()` — drain the queue, flush + shutdown all
 *     providers.
 *  3. `teardownTelemetry()` — unsubscribe EventBus handlers, reset module
 *     state, and reset the dispatcher singleton for the next session.
 *
 * Encoded as a named function (not a comment) so the ordering invariant
 * survives future edits and is unit-testable directly.
 */
export async function finalizeTelemetrySession(): Promise<void> {
	flushOrphanSubAgents();
	await shutdownTelemetryDispatcher();
	teardownTelemetry();
}
