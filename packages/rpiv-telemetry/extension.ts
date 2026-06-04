/**
 * rpiv-telemetry — thin Pi extension entry. `package.json` `pi.extensions`
 * points here, NOT at `./index.ts`: the barrel re-exports `MlflowProvider`,
 * which pulls `@mlflow/core` (~325ms). This loads only `initInstrumentation`,
 * whose provider path imports MLflow lazily and only when configured — so an
 * unconfigured session never touches the SDK.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initInstrumentation } from "./instrumentation/index.js";

export default function (pi: ExtensionAPI): void {
	initInstrumentation(pi);
}
