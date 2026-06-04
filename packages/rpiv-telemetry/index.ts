/**
 * rpiv-telemetry — standalone observability SDK + public API barrel.
 *
 * Dispatches Pi lifecycle and sub-agent EventBus events to all configured
 * telemetry providers (MLflow, console) via a bounded async dispatcher. The Pi
 * extension `default` entry lives in the thin `./extension.ts` (not here), so
 * loading the extension doesn't evaluate this barrel's `MlflowProvider`
 * re-export. Standalone usage: import named exports without the Pi runtime.
 */

export {
	type ConsoleConfig,
	type DispatcherConfig,
	isEventEnabled,
	type LlmPayloadMode,
	loadTelemetryConfig,
	type MlflowConfig,
	type ProvidersConfig,
	resolveMlflowConfig,
	saveTelemetryConfig,
	type TelemetryConfig,
} from "./config.js";
export {
	dispatchTelemetryEvent,
	getProviders,
	registerTelemetryProvider,
	resetTelemetryDispatcher,
	shutdownTelemetryDispatcher,
} from "./dispatcher.js";
export { teardownTelemetry } from "./instrumentation/index.js";
export {
	BUILT_IN_PROVIDERS,
	CONSOLE_PROVIDER_META,
	ConsoleProvider,
	MLFLOW_PROVIDER_META,
} from "./providers/index.js";
// Pulled directly from the @mlflow/core-backed module to keep it in the embedder
// API. Paid only by embedders — this barrel is not the extension entry.
export { MlflowProvider } from "./providers/mlflow/index.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	LlmRequestEndEvent,
	LlmRequestStartEvent,
	MessageEndEvent,
	MessageRole,
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

// NOTE: the Pi extension `default` entry is `./extension.ts`, not this barrel.
