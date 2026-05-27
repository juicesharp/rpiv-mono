import { configPath, loadJsonConfig, readEnvVar, saveJsonConfig, validateConfig } from "@juicesharp/rpiv-config";
import { type Static, Type } from "typebox";
import { TELEMETRY_EVENT_KINDS, type TelemetryEventKind } from "./types/events.js";

const CONFIG_PATH = configPath("rpiv-telemetry");

const DEFAULT_MAX_QUEUE_SIZE = 100;

// ---------------------------------------------------------------------------
// TypeBox schema — provider-enable map + optional event allowlist
// ---------------------------------------------------------------------------

const MlflowProviderConfig = Type.Object(
	{
		trackingUri: Type.Optional(Type.String({ description: "MLflow tracking server URI" })),
		experimentId: Type.Optional(Type.String({ description: "MLflow experiment ID" })),
		trackingToken: Type.Optional(Type.String({ description: "Bearer token for MLflow auth" })),
	},
	{ additionalProperties: false },
);

const ConsoleProviderConfig = Type.Object({}, { additionalProperties: false });

const LlmPayloadModeSchema = Type.Union([Type.Literal("full"), Type.Literal("summary"), Type.Literal("off")]);

/**
 * Provider keys are enumerated rather than open-ended so a typo (`mflow:`)
 * fails loudly at load time instead of silently dropping all events. Built-in
 * providers live in one place: this schema + `PROVIDER_FACTORIES` in
 * `providers/index.ts`. Custom providers register via `registerTelemetryProvider`,
 * not through the config file.
 */
const ProvidersConfigSchema = Type.Object(
	{
		mlflow: Type.Optional(MlflowProviderConfig),
		console: Type.Optional(ConsoleProviderConfig),
	},
	{ additionalProperties: false },
);

/** Built-in provider keys — kept in sync with `ProvidersConfigSchema` keys above. */
const BUILT_IN_PROVIDER_KEYS = ["mlflow", "console"] as const;

const DispatcherConfigSchema = Type.Object(
	{
		maxQueueSize: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Max events buffered before backpressure drops. Defaults to 100.",
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * `events` accepts:
 *   - omitted (the field is absent) → all events enabled.
 *   - `"*"` → all events enabled (explicit form).
 *   - `[]` → no events enabled.
 *   - `string[]` → allowlist; entries are validated against `TELEMETRY_EVENT_KINDS`.
 */
const EventsConfigSchema = Type.Union([Type.Literal("*"), Type.Array(Type.String())]);

const TelemetryConfigSchema = Type.Object(
	{
		providers: Type.Optional(ProvidersConfigSchema),
		events: Type.Optional(EventsConfigSchema),
		llmPayload: Type.Optional(LlmPayloadModeSchema),
		dispatcher: Type.Optional(DispatcherConfigSchema),
	},
	{ additionalProperties: false },
);

type TelemetryConfigSchema = Static<typeof TelemetryConfigSchema>;
export type LlmPayloadMode = Static<typeof LlmPayloadModeSchema>;

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

export type MlflowConfig = Static<typeof MlflowProviderConfig>;

export interface DispatcherConfig {
	/** Max events buffered before backpressure drops. Defaults to 100. */
	maxQueueSize: number;
}

export interface TelemetryConfig {
	providers: Record<string, Record<string, string>>;
	/** `"*"` → all events enabled; `[]` → none enabled; allowlist → only listed kinds. */
	events: "*" | TelemetryEventKind[];
	/** Controls how much of the raw provider-request body is recorded. Defaults to `"off"`. */
	llmPayload: LlmPayloadMode;
	dispatcher: DispatcherConfig;
}

// ---------------------------------------------------------------------------
// Load / save / resolve
// ---------------------------------------------------------------------------

export function loadTelemetryConfig(): TelemetryConfig {
	const raw = loadJsonConfig<TelemetryConfigSchema>(CONFIG_PATH);
	warnOnUnknownProviderKeys(raw);
	const validated = validateConfig(TelemetryConfigSchema, raw);

	return {
		providers: (validated.providers as Record<string, Record<string, string>>) ?? {},
		events: validateEventAllowlist(validated.events),
		llmPayload: validated.llmPayload ?? "off",
		dispatcher: {
			maxQueueSize: validated.dispatcher?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
		},
	};
}

export function saveTelemetryConfig(config: TelemetryConfig): boolean {
	return saveJsonConfig(CONFIG_PATH, config);
}

/** Env-first, config-second resolution for MLflow credentials. */
export function resolveMlflowConfig(providerConfig: Record<string, string>): MlflowConfig {
	return {
		trackingUri: readEnvVar("MLFLOW_TRACKING_URI") || providerConfig.trackingUri,
		experimentId: readEnvVar("MLFLOW_EXPERIMENT_ID") || providerConfig.experimentId,
		trackingToken: readEnvVar("MLFLOW_TRACKING_TOKEN") || providerConfig.trackingToken,
	};
}

// ---------------------------------------------------------------------------
// Event allowlist helpers
// ---------------------------------------------------------------------------

export function validateEventAllowlist(events: "*" | string[] | undefined): "*" | TelemetryEventKind[] {
	if (events === undefined || events === "*") return "*";
	if (events.length === 0) return [];
	const valid = new Set<string>(TELEMETRY_EVENT_KINDS);
	const filtered: TelemetryEventKind[] = [];
	const rejected: string[] = [];
	for (const e of events) {
		if (valid.has(e)) filtered.push(e as TelemetryEventKind);
		else rejected.push(e);
	}
	if (rejected.length > 0) {
		console.warn(`[rpiv-telemetry] unknown event kinds in config: ${rejected.join(", ")}`);
	}
	// All entries invalid → [] (allow none), preserving the I1 distinction
	// against undefined ("*", allow all).
	return filtered;
}

/** Check if a TelemetryEvent kind passes the config allowlist. */
export function isEventEnabled(kind: TelemetryEventKind, allowedEvents: "*" | TelemetryEventKind[]): boolean {
	if (allowedEvents === "*") return true;
	return allowedEvents.includes(kind);
}

// ---------------------------------------------------------------------------
// Provider-key warning (Value.Clean would silently strip unknown keys)
// ---------------------------------------------------------------------------

function warnOnUnknownProviderKeys(raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const providers = (raw as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
	const known = new Set<string>(BUILT_IN_PROVIDER_KEYS);
	const rejected = Object.keys(providers as Record<string, unknown>).filter((k) => !known.has(k));
	if (rejected.length > 0) {
		console.warn(
			`[rpiv-telemetry] unknown provider keys in config (ignored): ${rejected.join(", ")}. ` +
				`Built-in providers: ${BUILT_IN_PROVIDER_KEYS.join(", ")}.`,
		);
	}
}
