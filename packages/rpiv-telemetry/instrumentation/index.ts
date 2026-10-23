import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTelemetryConfig } from "../config.ts";
import { dispatchTelemetryEvent } from "../dispatcher.ts";
import { registerConfiguredProviders } from "../providers/index.ts";
import { PI_HANDLERS } from "./pi-handlers.ts";
import { eventBusUnsubscribers, setLlmPayloadMode } from "./state.ts";
import { handleSubAgentBusEvent, SUBAGENT_HANDLERS } from "./subagent-handlers.ts";

export { teardownTelemetry } from "./state.ts";

/**
 * Wire rpiv-telemetry into Pi.
 *
 * Loads config, registers configured providers, then subscribes one handler
 * per Pi lifecycle event (`PI_HANDLERS`) and one handler per sub-agent
 * EventBus channel (`SUBAGENT_HANDLERS`). Handlers are always registered,
 * even when no providers are configured — late-bound providers (via
 * `registerTelemetryProvider`) must receive events from the moment they
 * join; the no-providers gate lives in the dispatcher.
 */
export function initInstrumentation(pi: ExtensionAPI): void {
	const config = loadTelemetryConfig();
	setLlmPayloadMode(config.llmPayload);
	registerConfiguredProviders(config);

	for (const h of PI_HANDLERS) {
		pi.on(h.piEvent as any, async (event: any, ctx: ExtensionContext) => {
			dispatchTelemetryEvent(h.build(event, ctx));
			if (h.postDispatch) await h.postDispatch(event, ctx);
		});
	}

	for (const h of SUBAGENT_HANDLERS) {
		const unsub = pi.events.on(h.channel, (data: unknown) => {
			handleSubAgentBusEvent(h, data);
		});
		eventBusUnsubscribers.push(unsub);
	}
}
