import type { TelemetryEvent } from "./events.ts";

// ---------------------------------------------------------------------------
// Provider interface + metadata
// ---------------------------------------------------------------------------

export interface TelemetryProviderMeta {
	readonly name: string;
	readonly label: string;
	readonly envVars?: string[];
}

export interface TelemetryProvider {
	readonly meta: TelemetryProviderMeta;
	trackEvent(event: TelemetryEvent): Promise<void>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}
