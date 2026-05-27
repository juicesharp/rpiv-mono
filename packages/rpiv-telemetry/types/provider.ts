import type { TelemetryEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Provider interface + metadata
// ---------------------------------------------------------------------------

export interface TelemetryProviderMeta {
	readonly name: string;
	readonly label: string;
	readonly envVars?: string[];
}

export interface TelemetryProvider {
	readonly name: string;
	readonly meta: TelemetryProviderMeta;
	trackEvent(event: TelemetryEvent): Promise<void>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}
