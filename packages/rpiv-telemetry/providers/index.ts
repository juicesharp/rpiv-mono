import type { ProvidersConfig } from "../config.js";
import { registerTelemetryProvider } from "../dispatcher.js";
import type { TelemetryProviderMeta } from "../types/provider.js";
import { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
// Light META only (no @mlflow/core); the heavy class loads lazily below.
import { MLFLOW_PROVIDER_META } from "./mlflow/meta.js";

export { CONSOLE_PROVIDER_META, ConsoleProvider } from "./console.js";
export { MLFLOW_PROVIDER_META } from "./mlflow/meta.js";
// MlflowProvider is NOT re-exported here — a value re-export would pull the
// ~325ms SDK at eval. Embedders get it from the package barrel.

/** Metadata catalog for the providers shipped with this package. */
export const BUILT_IN_PROVIDERS: readonly TelemetryProviderMeta[] = [MLFLOW_PROVIDER_META, CONSOLE_PROVIDER_META];

/**
 * Register every built-in provider present in the given config. Called at
 * extension load time by instrumentation.ts. The schema in `config.ts` is
 * the single source of truth for the provider key set — adding a built-in
 * provider means editing `ProvidersConfigSchema` and adding a branch below.
 */
export function registerConfiguredProviders(config: { providers: ProvidersConfig }): void {
	const { providers } = config;
	// Console is lightweight — register eagerly.
	if (providers.console !== undefined) {
		registerTelemetryProvider(new ConsoleProvider());
	}
	// MLflow pulls @mlflow/core (~325ms) — load it lazily, only when configured.
	// Fire-and-forget is safe: no events fire during sync load, and the
	// dispatcher gates on the live provider set.
	if (providers.mlflow !== undefined) {
		const mlflowConfig = providers.mlflow;
		void import("./mlflow/index.js")
			.then(({ MlflowProvider }) => registerTelemetryProvider(new MlflowProvider(mlflowConfig)))
			.catch((err) => console.error("[rpiv-telemetry] failed to load MLflow provider:", err));
	}
}
