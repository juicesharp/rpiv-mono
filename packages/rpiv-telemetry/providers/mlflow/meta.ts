/**
 * MLflow provider metadata — split from `./index.ts` (which pulls `@mlflow/core`,
 * ~325ms) so `BUILT_IN_PROVIDERS` can list MLflow without loading the SDK. Zero
 * `@mlflow/core` dependency here; the provider class loads lazily when configured.
 */

import type { TelemetryProviderMeta } from "../../types/provider.js";

export const MLFLOW_PROVIDER_META: TelemetryProviderMeta = {
	name: "mlflow",
	label: "MLflow",
	envVars: ["MLFLOW_TRACKING_URI", "MLFLOW_EXPERIMENT_ID", "MLFLOW_TRACKING_TOKEN"],
};
