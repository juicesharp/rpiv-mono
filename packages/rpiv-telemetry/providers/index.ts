import { registerTelemetryProvider } from "../dispatcher.js";
import type { TelemetryProvider, TelemetryProviderMeta } from "../types/provider.js";
import { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
import { MLFLOW_PROVIDER_META, MlflowProvider } from "./mlflow/index.js";

export { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
export { MLFLOW_PROVIDER_META, MlflowProvider } from "./mlflow/index.js";

/** Metadata for all built-in providers. */
export const PROVIDERS: readonly TelemetryProviderMeta[] = [MLFLOW_PROVIDER_META, CONSOLE_PROVIDER_META];

/**
 * Single source of truth for built-in provider factories. Adding a provider is
 * one map entry — the schema enumeration in `config.ts` mirrors these keys.
 */
const PROVIDER_FACTORIES: Record<string, (config: Record<string, string>) => TelemetryProvider> = {
	mlflow: (config) => new MlflowProvider(config),
	console: () => new ConsoleProvider(),
};

/**
 * Register all configured providers from the given config.
 * Called at extension load time by instrumentation.ts.
 */
export function registerConfiguredProviders(config: { providers: Record<string, Record<string, string>> }): void {
	for (const [name, providerConfig] of Object.entries(config.providers)) {
		const factory = PROVIDER_FACTORIES[name];
		if (!factory) {
			console.warn(`[rpiv-telemetry] unknown provider "${name}" in config`);
			continue;
		}
		registerTelemetryProvider(factory(providerConfig));
	}
}
