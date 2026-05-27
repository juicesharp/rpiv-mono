export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
}

export interface FetchResponse {
	text: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
}

export interface SearchProvider {
	readonly name: string;
	readonly label: string;
	readonly envVar: string;
	search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse>;
	fetch(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse>;
}

// ---------------------------------------------------------------------------
// PROVIDER_META + per-provider configure() contract
// ---------------------------------------------------------------------------

// User input from a ProviderConfigUi prompt. Both `null` and `undefined`
// indicate the user cancelled (different UI implementations may return
// either); use isCancellation() to test instead of comparing manually.
export type UserInput = string | null | undefined;

export function isCancellation(input: UserInput): input is null | undefined {
	return input == null;
}

// Minimal UI surface a provider's configure() helper is allowed to depend on.
// Intentionally narrow so providers/ stays free of web-tools internals (no
// circular import) and so the contract can grow deliberately if a future
// provider needs more.
export interface ProviderConfigUi {
	input(label: string, placeholder: string): Promise<UserInput>;
}

// What the orchestrator hands to configure(): the provider's currently
// persisted state (if any).
export interface ProviderConfigCurrent {
	baseUrl?: string;
	apiKey?: string;
}

// What configure() returns for the orchestrator to merge into WebToolsConfig.
// `null` apiKey = "leave unset"; absent baseUrl = "this provider has no URL
// knob"; whole-result `null` = "user cancelled, do not persist".
export interface ProviderConfigChange {
	baseUrl?: string;
	apiKey?: string | null;
}

// Per-provider metadata declared alongside each provider's class. Drives
// generic dispatch in web-tools.ts so adding a new provider doesn't require
// touching the orchestrator.
//
//   envVar          — the API-key env var (omit if the provider has no key)
//   baseUrlEnvVar   — the URL env var (set for self-hosted providers)
//   defaultBaseUrl  — fallback URL when neither env nor config supplies one
//   configure       — interactive setup; if present, /web-tools
//                     dispatches here instead of the default single-key prompt
export interface ProviderMeta {
	name: string;
	label: string;
	envVar?: string;
	baseUrlEnvVar?: string;
	defaultBaseUrl?: string;
	configure?(ui: ProviderConfigUi, current: ProviderConfigCurrent): Promise<ProviderConfigChange | null>;
}
