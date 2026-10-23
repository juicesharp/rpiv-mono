import type { SessionShutdownEvent } from "../../types/events.ts";
import { msToNs } from "./keys.ts";
import type { MlflowSpanRegistry } from "./span-registry.ts";

export function onSessionShutdown(registry: MlflowSpanRegistry, event: SessionShutdownEvent): void {
	registry.endAllForSession(event.sessionId, msToNs(event.timestamp));
}
