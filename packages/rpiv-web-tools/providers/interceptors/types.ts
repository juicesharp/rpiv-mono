import type { FetchResponse } from "../types.ts";

// Generic URL specialist contract. A UrlInterceptor inspects a fetch target
// before the active search provider's fetch() runs; if it owns the URL it
// returns a FetchResponse, otherwise it returns null and the orchestrator
// falls through to the next interceptor (and ultimately to the provider).
// Cheap rejection (URL parse + host check) MUST be the common path so
// unrelated URLs don't pay for chain registration.
export interface UrlInterceptor {
	readonly name: string;
	intercept(url: string, opts: { raw: boolean; signal?: AbortSignal }): Promise<FetchResponse | null>;
}
