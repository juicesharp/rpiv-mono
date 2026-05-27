/**
 * rpiv-telemetry — Pi extension + standalone observability SDK.
 *
 * Registers telemetry instrumentation for all Pi lifecycle and sub-agent
 * EventBus events, dispatching them to all configured telemetry providers
 * (MLflow, console) via a bounded async dispatcher.
 *
 * Standalone usage: import named exports (types, registry, dispatcher)
 * without Pi runtime — zero Pi SDK dependency at runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initInstrumentation } from "./instrumentation.js";

export {
	isEventEnabled,
	type LlmPayloadMode,
	loadTelemetryConfig,
	type MlflowConfig,
	resolveMlflowConfig,
	saveTelemetryConfig,
	type TelemetryConfig,
} from "./config.js";
export {
	Dispatcher,
	dispatchTelemetryEvent,
	getProviders,
	getTelemetryDispatcher,
	registerTelemetryProvider,
	shutdownTelemetryDispatcher,
} from "./dispatcher.js";
export {
	CONSOLE_PROVIDER_META,
	ConsoleProvider,
	MLFLOW_PROVIDER_META,
	MlflowProvider,
	PROVIDERS,
} from "./providers/index.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	LlmRequestEndEvent,
	LlmRequestStartEvent,
	MessageEndEvent,
	ModelSelectEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SubAgentCompactedEvent,
	SubAgentCompletedEvent,
	SubAgentCreatedEvent,
	SubAgentFailedEvent,
	SubAgentStartedEvent,
	SubAgentSteeredEvent,
	TelemetryEvent,
	TelemetryEventKind,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./types/events.js";
export { TELEMETRY_EVENT_KINDS } from "./types/events.js";
export type { TelemetryProvider, TelemetryProviderMeta } from "./types/provider.js";

export default function (pi: ExtensionAPI): void {
	initInstrumentation(pi);
}
