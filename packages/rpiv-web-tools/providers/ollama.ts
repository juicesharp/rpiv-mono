import {
	type FetchResponse,
	isCancellation,
	type ProviderConfigChange,
	type ProviderConfigCurrent,
	type ProviderConfigUi,
	type ProviderMeta,
	type SearchProvider,
	type SearchResponse,
	type SearchResult,
} from "./types.js";

export const OLLAMA_API_KEY_ENV_VAR = "OLLAMA_API_KEY";
export const OLLAMA_HOST_ENV_VAR = "OLLAMA_HOST";
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

// Ollama API paths — cloud (ollama.com) uses stable /api/... paths,
// local instances use /api/experimental/... (at least through v0.24).
const CLOUD_SEARCH_PATH = "/api/web_search";
const CLOUD_FETCH_PATH = "/api/web_fetch";
const LOCAL_SEARCH_PATH = "/api/experimental/web_search";
const LOCAL_FETCH_PATH = "/api/experimental/web_fetch";

function isLocalHost(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "[::1]";
	} catch {
		return true; // default to local paths if URL is somehow invalid
	}
}

// Number of leading + trailing characters preserved when masking an API key
// in the config prompt. Mirrors API_KEY_MASK_VISIBLE_CHARS in web-tools.ts.
const MASK_VISIBLE_CHARS = 4;

export const OLLAMA_PROVIDER_META: ProviderMeta = {
	name: "ollama",
	label: "Ollama",
	envVar: OLLAMA_API_KEY_ENV_VAR,
	baseUrlEnvVar: OLLAMA_HOST_ENV_VAR,
	defaultBaseUrl: OLLAMA_DEFAULT_URL,
	configure: (ui, current) => configureOllama(ui, current),
};

// ---------------------------------------------------------------------------
// Vendor response types (file-private)
// ---------------------------------------------------------------------------

interface OllamaRawSearchResult {
	title?: string;
	url?: string;
	content?: string;
}

interface OllamaSearchResponse {
	results?: OllamaRawSearchResult[];
}

interface OllamaFetchResponse {
	title?: string;
	content?: string;
	links?: string[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeOllamaResults(raw: OllamaSearchResponse): SearchResult[] {
	return (raw.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function assertHttpUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${OLLAMA_HOST_ENV_VAR} is not a valid URL (got: ${url})`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`${OLLAMA_HOST_ENV_VAR} must use http:// or https:// (got: ${parsed.protocol.replace(":", "")}://)`,
		);
	}
}

// ---------------------------------------------------------------------------
// Network error handling
// ---------------------------------------------------------------------------

// Node's fetch wraps ECONNREFUSED in a TypeError. Detect the cause chain
// and re-throw with an actionable hint.
function isConnectionRefused(error: unknown): boolean {
	if (error instanceof TypeError) {
		const cause = (error as unknown as { cause?: { code?: string } }).cause;
		return cause?.code === "ECONNREFUSED";
	}
	return false;
}

function connectionRefusedError(host: string): Error {
	return new Error(`Could not connect to Ollama at ${host}. Make sure Ollama is running (ollama serve).`);
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

interface OllamaProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class OllamaProvider implements SearchProvider {
	readonly name = "ollama";
	readonly label = "Ollama";
	readonly envVar = OLLAMA_API_KEY_ENV_VAR;

	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly local: boolean;

	constructor(options: OllamaProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		const trimmed = stripTrailingSlashes(options.baseUrl?.trim() ?? "");
		if (trimmed) assertHttpUrl(trimmed);
		this.baseUrl = trimmed;
		this.local = isLocalHost(trimmed);
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		this.requireBaseUrl();
		const path = this.local ? LOCAL_SEARCH_PATH : CLOUD_SEARCH_PATH;
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify({ query, max_results: maxResults }),
				signal,
			});
			if (!res.ok) throw await this.formatError("Search", res);
			const raw = (await res.json()) as OllamaSearchResponse;
			return { query, results: normalizeOllamaResults(raw) };
		} catch (error) {
			if (isConnectionRefused(error)) throw connectionRefusedError(this.baseUrl);
			throw error;
		}
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		this.requireBaseUrl();
		const path = this.local ? LOCAL_FETCH_PATH : CLOUD_FETCH_PATH;
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.buildHeaders(),
				body: JSON.stringify({ url }),
				signal,
			});
			if (!res.ok) throw await this.formatError("Fetch", res);
			const data = (await res.json()) as OllamaFetchResponse;
			if (!data.content) {
				throw new Error(`${this.label} Fetch API error: no content returned for ${url}`);
			}
			return {
				text: data.content,
				title: data.title || undefined,
				contentType: "text/plain",
			};
		} catch (error) {
			if (isConnectionRefused(error)) throw connectionRefusedError(this.baseUrl);
			throw error;
		}
	}

	private requireBaseUrl(): void {
		if (!this.baseUrl) {
			throw new Error(
				`${OLLAMA_HOST_ENV_VAR} is not set. Run /web-search-config to configure, or export the env var.`,
			);
		}
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private async formatError(label: string, res: Response): Promise<Error> {
		const body = await res.text();
		const hint = hintForStatus(res.status);
		return new Error(`${this.label} ${label} API error (${res.status})${hint}: ${body}`);
	}
}

// ---------------------------------------------------------------------------
// Status hints
// ---------------------------------------------------------------------------

function hintForStatus(status: number): string {
	if (status === 401) {
		return " (run `ollama signin` to authenticate)";
	}
	if (status === 404) {
		return " (the Ollama instance may not support web search; ensure you are running a recent version)";
	}
	return "";
}

// ---------------------------------------------------------------------------
// /web-search-config helper
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
	const head = key.slice(0, MASK_VISIBLE_CHARS);
	const tail = key.slice(-MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

async function promptForBaseUrl(ui: ProviderConfigUi, current: string | undefined): Promise<string | undefined> {
	const existing = current?.trim();
	const input = await ui.input(
		"Ollama base URL",
		existing
			? `Press Enter to keep current (${existing}), or type new URL`
			: `Press Enter for default (${OLLAMA_DEFAULT_URL}), or type instance URL`,
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || OLLAMA_DEFAULT_URL;
}

async function promptForOptionalKey(
	ui: ProviderConfigUi,
	current: string | undefined,
): Promise<string | null | undefined> {
	const existing = current?.trim() || undefined;
	const input = await ui.input(
		"Ollama API key (optional — for direct cloud access; local Ollama authenticates via `ollama signin`)",
		existing
			? `Press Enter to keep current (${maskKey(existing)}), or type new key`
			: "Press Enter to leave unset, or type a key",
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || null;
}

/**
 * Prompts the user for the Ollama base URL and optional API key.
 * Returns `null` if the user cancels at either prompt.
 */
export async function configureOllama(
	ui: ProviderConfigUi,
	current: ProviderConfigCurrent,
): Promise<ProviderConfigChange | null> {
	const baseUrl = await promptForBaseUrl(ui, current.baseUrl);
	if (baseUrl === undefined) return null;

	const apiKey = await promptForOptionalKey(ui, current.apiKey);
	if (apiKey === undefined) return null;

	return { baseUrl, apiKey };
}
